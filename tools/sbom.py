#!/usr/bin/env python3
"""Generate a CycloneDX SBOM for tautrack's runtime dependency set.

    python tools/sbom.py                      # -> dist/tautrack-<version>.cdx.json
    python tools/sbom.py --out sbom.cdx.json

The SBOM describes what a user actually runs, not the development environment:

* tautrack is installed **non-editable, without the dev extra**, into a fresh virtual
  environment - the same install the container image performs from its wheel.
* The generator (``cyclonedx-py``) runs from a **separate** environment, so neither it
  nor its dependencies are mistaken for components of the application.

Run it with the interpreter the deployment uses (CI pins the container's Python):
environment markers mean the resolved set can differ between Python versions.

The timestamp comes from ``SOURCE_DATE_EPOCH`` if set, otherwise from the commit time
of ``HEAD``, so regenerating the SBOM for a given commit gives the same document.
The generator validates the output against the CycloneDX schema and fails if it is
invalid.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import tomllib
import venv
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
#: The generator's pinned version, kept in a requirements file so Dependabot updates it.
TOOL_REQUIREMENTS = ROOT / "tools" / "sbom-requirements.txt"
SPEC_VERSION = "1.6"


def _bin(env: Path, name: str) -> Path:
    sub = "Scripts" if os.name == "nt" else "bin"
    suffix = ".exe" if os.name == "nt" else ""
    return env / sub / f"{name}{suffix}"


def _make_env(path: Path) -> Path:
    venv.EnvBuilder(with_pip=True, clear=True).create(path)
    return _bin(path, "python")


def _pip(python: Path, *args: str) -> None:
    subprocess.run(
        [str(python), "-m", "pip", "--disable-pip-version-check", "-q", "install", *args],
        check=True,
    )


def _source_date_epoch() -> str | None:
    if epoch := os.environ.get("SOURCE_DATE_EPOCH"):
        return epoch
    try:
        out = subprocess.run(
            ["git", "-C", str(ROOT), "log", "-1", "--format=%ct"],
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return None  # not a git checkout: the generator omits the timestamp instead
    return out.stdout.strip() or None


def main() -> int:
    pyproject = ROOT / "pyproject.toml"
    version = tomllib.loads(pyproject.read_text(encoding="utf-8"))["project"]["version"]

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument(
        "--out",
        type=Path,
        default=ROOT / "dist" / f"tautrack-{version}.cdx.json",
        help="output file (default: dist/tautrack-<version>.cdx.json)",
    )
    args = ap.parse_args()

    with tempfile.TemporaryDirectory(prefix="tautrack-sbom-") as tmp:
        tmp_path = Path(tmp)

        print(f"installing tautrack {version} (runtime dependencies only)", file=sys.stderr)
        target = _make_env(tmp_path / "target")
        _pip(target, "--no-cache-dir", str(ROOT))

        print("installing the SBOM generator", file=sys.stderr)
        tool = _make_env(tmp_path / "tool")
        _pip(tool, "--no-cache-dir", "-r", str(TOOL_REQUIREMENTS))

        env = dict(os.environ)
        if epoch := _source_date_epoch():
            env["SOURCE_DATE_EPOCH"] = epoch

        args.out.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [
                str(_bin(tmp_path / "tool", "cyclonedx-py")),
                "environment",
                "--pyproject",
                str(pyproject),
                "--mc-type",
                "application",
                "--spec-version",
                SPEC_VERSION,
                "--output-format",
                "JSON",
                "--output-reproducible",
                "--validate",
                "--output-file",
                str(args.out),
                str(target),
            ],
            check=True,
            env=env,
        )

    bom = json.loads(args.out.read_text(encoding="utf-8"))
    root = bom["metadata"]["component"]
    if root.get("name") != "tautrack" or root.get("version") != version:
        print(
            f"unexpected root component: {root.get('name')} {root.get('version')}", file=sys.stderr
        )
        return 1
    print(
        f"wrote {args.out} - CycloneDX {bom['specVersion']}, "
        f"{len(bom.get('components', []))} components",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
