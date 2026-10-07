"""One atomic file write, for the files the front keeps across restarts."""
from __future__ import annotations

import os
from pathlib import Path


def write_atomic(path: Path, data: str) -> None:
    """Write `data` to `path` so a crash leaves the old file or the new, whole.

    The temp file sits in the same directory; it is flushed and synced, moved
    over `path`, and the directory is synced so the rename itself survives a
    power cut. A failed write removes the temp file and re-raises.
    """
    path = Path(path)
    tmp = path.with_name(path.name + ".tmp")
    try:
        with tmp.open("w", encoding="utf-8") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
