"""The update check must never be able to disturb the application."""

from __future__ import annotations

import asyncio

import pytest

from tautrack.config import Settings
from tautrack.update import UpdateChecker, UpdateState, parse_version, update_check_loop


@pytest.mark.parametrize(
    ("older", "newer"),
    [
        ("0.2.0", "0.2.1"),
        ("0.2.9", "0.3.0"),
        # String comparison gets this one backwards, which is the whole reason
        # versions are parsed into integers rather than compared as text.
        ("0.9.0", "0.10.0"),
        ("1.9.9", "10.0.0"),
        # Semver: a pre-release ranks below the release it precedes.
        ("0.3.0-rc1", "0.3.0"),
    ],
)
def test_version_ordering(older: str, newer: str) -> None:
    assert parse_version(newer) > parse_version(older)


@pytest.mark.parametrize("text", ["", None, "latest", "v", "1.2", "not-a-version"])
def test_unparseable_versions_are_none(text: str | None) -> None:
    assert parse_version(text) is None


def test_leading_v_is_ignored() -> None:
    """GitHub tags carry it; __version__ does not."""
    assert parse_version("v1.2.3") == parse_version("1.2.3")


def test_no_update_when_versions_match() -> None:
    assert not UpdateState(current="0.2.0", latest="0.2.0").available


def test_no_update_when_the_published_release_is_older() -> None:
    """A local build ahead of the registry must not be told to downgrade."""
    assert not UpdateState(current="0.3.0", latest="v0.2.1").available


def test_no_update_before_the_first_check() -> None:
    assert not UpdateState(current="0.2.0").available


def test_unparseable_release_tag_is_ignored() -> None:
    """A tag that is not a version must read as "nothing to do", not crash."""
    assert not UpdateState(current="0.2.0", latest="nightly").available


def test_snapshot_offers_a_pull_command_only_inside_a_container(monkeypatch) -> None:
    state = UpdateState(current="0.2.0", latest="0.2.1")
    monkeypatch.setattr("tautrack.update.in_container", lambda: True)
    assert state.snapshot("ghcr.io/x/y")["pull"] == "docker pull ghcr.io/x/y:0.2.1"
    monkeypatch.setattr("tautrack.update.in_container", lambda: False)
    assert "pull" not in state.snapshot("ghcr.io/x/y")


def test_snapshot_never_offers_a_pull_when_up_to_date(monkeypatch) -> None:
    monkeypatch.setattr("tautrack.update.in_container", lambda: True)
    state = UpdateState(current="0.2.1", latest="0.2.1")
    assert "pull" not in state.snapshot("ghcr.io/x/y")


def test_a_failed_check_leaves_the_state_untouched(monkeypatch) -> None:
    """No network is the normal case on an isolated instrument LAN, not an error."""

    def boom(*_a: object, **_k: object) -> None:
        raise OSError("no route to host")

    monkeypatch.setattr("tautrack.update.fetch_latest", boom)
    checker = UpdateChecker(Settings(), "0.2.0")
    asyncio.run(checker.refresh())
    assert checker.state.latest is None
    assert checker.state.checked_at is None
    assert not checker.state.available


def test_disabled_loop_returns_without_touching_the_network(monkeypatch) -> None:
    called = False

    def boom(*_a: object, **_k: object) -> None:
        nonlocal called
        called = True
        raise AssertionError("must not be called")

    monkeypatch.setattr("tautrack.update.fetch_latest", boom)
    settings = Settings()
    settings.update.enabled = False
    checker = UpdateChecker(settings, "0.2.0")

    async def run() -> None:
        await asyncio.wait_for(update_check_loop(checker, asyncio.Event()), timeout=2)

    asyncio.run(run())
    assert not called
