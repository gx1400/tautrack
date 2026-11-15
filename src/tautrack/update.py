"""Check whether a newer release has been published.

Deliberately a background concern. The check runs on its own slow loop, never on the
request path, and every failure is swallowed: an instrument monitor on an isolated
network must behave exactly as it does on a connected one, minus the banner.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

#: Semantic version, with the leading "v" GitHub tags carry and an optional
#: pre-release or build suffix.
_VERSION = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(?:[-+](.+))?$")


def parse_version(text: str | None) -> tuple[int, int, int, int, str] | None:
    """Parse a version into a comparable tuple, or None if it is not one.

    String comparison is wrong here - "0.10.0" sorts below "0.9.0" - so versions are
    compared as integers. The fourth element encodes release-before-pre-release, so
    0.3.0 ranks above 0.3.0-rc1 as semver requires.
    """
    m = _VERSION.match((text or "").strip())
    if not m:
        return None
    pre = m.group(4)
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)), 0 if pre else 1, pre or "")


def in_container() -> bool:
    """Whether we are running inside a container, so the banner can say how to upgrade.

    The env var is set by our own image; the file is the fallback for everyone else's.
    """
    if os.environ.get("TAUTRACK_CONTAINER"):
        return True
    return Path("/.dockerenv").exists()


@dataclass
class UpdateState:
    """What the last check found. Shared with the web layer as a plain dict."""

    current: str
    latest: str | None = None
    url: str | None = None
    checked_at: int | None = None

    @property
    def available(self) -> bool:
        cur, new = parse_version(self.current), parse_version(self.latest)
        return bool(cur and new and new > cur)

    def snapshot(self, image: str) -> dict[str, Any]:
        out: dict[str, Any] = {
            "current": self.current,
            "latest": self.latest,
            "available": self.available,
            "url": self.url,
            "checked_at": self.checked_at,
        }
        # Only meaningful when there is something to upgrade to.
        if self.available and in_container():
            out["pull"] = f"docker pull {image}:{self.latest}"
        return out


def fetch_latest(repo: str, timeout: float) -> tuple[str, str] | None:
    """The newest published release, as (tag, url).

    Uses the releases endpoint rather than the tag list because it already excludes
    drafts and pre-releases, which is the behaviour wanted and saves filtering.
    """
    url = f"https://api.github.com/repos/{repo}/releases/latest"
    # Fixed https host, not caller-controlled.
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "tautrack",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.load(resp)
    tag = data.get("tag_name")
    if not tag:
        return None
    return str(tag), str(data.get("html_url") or "")


class UpdateChecker:
    """Holds the last result and refreshes it on a slow loop."""

    def __init__(self, settings: Any, current: str) -> None:
        self.settings = settings
        self.state = UpdateState(current=current)

    async def refresh(self) -> None:
        cfg = self.settings.update
        try:
            found = await asyncio.to_thread(fetch_latest, cfg.repo, cfg.timeout_seconds)
        except Exception as exc:
            # No network, rate limited, GitHub down: all the same non-event. Logged at
            # debug so an air-gapped install does not accrue warnings forever.
            log.debug("update check failed: %r", exc)
            return
        if found:
            self.state.latest, self.state.url = found
        self.state.checked_at = int(time.time())
        if self.state.available:
            log.info("update available: %s (running %s)", self.state.latest, self.state.current)


async def update_check_loop(checker: UpdateChecker, stop: asyncio.Event) -> None:
    """Check shortly after start, then on the configured interval."""
    cfg = checker.settings.update
    if not cfg.enabled:
        log.debug("update check disabled")
        return
    # A short initial delay keeps startup off the network path.
    with contextlib.suppress(TimeoutError, asyncio.TimeoutError):
        await asyncio.wait_for(stop.wait(), timeout=cfg.startup_delay_seconds)
    while not stop.is_set():
        await checker.refresh()
        with contextlib.suppress(TimeoutError, asyncio.TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=cfg.interval_hours * 3600)
