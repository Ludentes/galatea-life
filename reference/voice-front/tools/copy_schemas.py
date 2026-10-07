"""Copies the standard's schemas the front loads into its own package.

    uv run python tools/copy_schemas.py            # copy from ../../conformance/schemas
    uv run python tools/copy_schemas.py --check    # exit 1 if the copy differs

The front ships `voice_front/standard_schemas/` (common.json, brain/, steward/)
so it stands without the standard's folder beside it. The copy is committed:
the public code repository is exported from git, and the front's tests read it.
Run this whenever the standard's brain or steward schemas change; the test
`test_the_shipped_copy_is_the_standards_own` fails until then.
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
SOURCE = HERE.parents[1] / "conformance" / "schemas"
TARGET = HERE / "voice_front" / "standard_schemas"
DIRS = ("brain", "steward")


def listing(root: Path) -> list[str]:
    """The files the front loads under `root`, as relative paths, sorted."""
    if not root.is_dir():
        return []
    files = ["common.json"] if (root / "common.json").is_file() else []
    return files + sorted(f"{d}/{p.name}" for d in DIRS if (root / d).is_dir() for p in (root / d).glob("*.json"))


def drift(source: Path, target: Path) -> list[str]:
    """Each file missing, extra or different between the two, by relative path."""
    a, b = listing(source), listing(target)
    out = [f"missing {f}" for f in a if f not in b] + [f"extra {f}" for f in b if f not in a]
    out += [f"differs {f}" for f in a if f in b and (source / f).read_bytes() != (target / f).read_bytes()]
    return out


def copy(source: Path = SOURCE, target: Path = TARGET) -> None:
    files = listing(source)
    if "common.json" not in files:
        raise SystemExit(f"no schemas in {source}")
    shutil.rmtree(target, ignore_errors=True)
    for f in files:
        (target / f).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / f, target / f)


if __name__ == "__main__":
    if "--check" in sys.argv[1:]:
        problems = drift(SOURCE, TARGET)
        for p in problems:
            print(p)
        sys.exit(1 if problems else 0)
    copy()
    print(f"copied {len(listing(TARGET))} files into {TARGET.relative_to(HERE)}")
