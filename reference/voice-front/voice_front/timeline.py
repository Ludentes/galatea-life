"""Where speech happened, on the front's own clock. standard/voice.md, *Where
speech happened*; GA-VOICE-8.

Two parts:

- `Stream` places a device's audio on the front's MONOTONIC clock from sample
  positions and arrivals, never from the device's timestamps: a front MUST NOT
  compare timestamps from two machines.
- `WallClock` maps that monotonic clock to wall time for `time` and
  `ended_at`, and counts up `clock_epoch` at every new mapping, never reusing
  one, restarts included.

No socket and no model. The clocks are injected, so a test drives them.
"""
from __future__ import annotations

import json
import time
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from voice_front.atomic import write_atomic

SAMPLE_RATE = 16_000
ANCHOR_WINDOW_S = 10.0      # voice, *Constants*
CLOCK_TOLERANCE_S = 1.0     # the steward's, *Constants*


class Stream:
    """One device stream: sample positions to times on the front's clock.

    A frame's sample position is the number of samples the device captured
    before it in the stream, after the buffered head. The anchor is the least,
    over the trailing anchor window, of a frame's arrival less its position: a
    frame never arrives before it was captured, so the least is the frame that
    waited least. A stall shorter than the window only delays arrivals and does
    not move the anchor; a device clock that runs fast or slow is corrected as
    old frames leave the window.

    The head (`head_samples`) is audio the device captured before the stream
    began (a tap's or a wake's pre-roll, and the word): it sits at negative
    positions.
    """

    def __init__(self, *, head_samples: int = 0, rate: int = SAMPLE_RATE,
                 window_s: float = ANCHOR_WINDOW_S) -> None:
        if head_samples < 0:
            raise ValueError("a head cannot be negative")
        self.head_samples = head_samples
        self.rate = rate
        self.window_s = window_s
        # (arrival, arrival - position / rate), offsets increasing: the front
        # is the least in the window.
        self._offsets: deque[tuple[float, float]] = deque()
        self._last_arrival: float | None = None

    def frame(self, position: int, arrival: float) -> None:
        """Record a frame that starts at `position` and arrived at `arrival`."""
        if self._last_arrival is not None and arrival < self._last_arrival:
            raise ValueError("arrivals are on a monotonic clock and never go back")
        self._last_arrival = arrival
        offset = arrival - position / self.rate
        while self._offsets and self._offsets[-1][1] >= offset:
            self._offsets.pop()
        self._offsets.append((arrival, offset))
        while self._offsets[0][0] < arrival - self.window_s:
            self._offsets.popleft()

    @property
    def anchor(self) -> float:
        if not self._offsets:
            raise ValueError("no frame yet: the stream has no anchor")
        return self._offsets[0][1]

    def at(self, position: int) -> float:
        """When the sample at `position` was captured, on the front's clock, by
        the anchor as it now stands."""
        return self.anchor + position / self.rate


def reported(arrival: float, duration_ms: int, ended_ago_ms: int) -> tuple[float, float]:
    """A stretch a device buffered and reported as `{ duration_ms,
    ended_ago_ms }`, placed on the front's clock at its arrival: it ended
    `ended_ago_ms` before arrival and began `duration_ms` before that."""
    if duration_ms < 0 or ended_ago_ms < 0:
        raise ValueError("a reported stretch has no negative part")
    end = arrival - ended_ago_ms / 1000
    return end - duration_ms / 1000, end


class EpochStoreError(RuntimeError):
    """The epoch store cannot be read or written. The front must not start:
    without it, it could reuse an epoch."""


@dataclass(frozen=True)
class Mapping:
    since: float        # monotonic time the mapping took effect
    offset: float       # wall = monotonic + offset
    epoch: int


class WallClock:
    """The front's monotonic clock mapped to wall time, with `clock_epoch`.

    Each start opens a new mapping and so a new epoch: the monotonic clock of
    the last run is gone, and nothing it wrote may be compared across the
    restart. The epoch is written to `store` before it is used.
    """

    def __init__(self, store: Path, *, mono: Callable[[], float] = time.monotonic,
                 wall: Callable[[], float] = time.time,
                 tolerance_s: float = CLOCK_TOLERANCE_S) -> None:
        self._store = Path(store)
        self._mono, self._wall = mono, wall
        self.tolerance_s = tolerance_s
        self._mappings: list[Mapping] = []
        self._anchor(self._read_epoch() + 1)

    def _read_epoch(self) -> int:
        try:
            doc = json.loads(self._store.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return -1
        except (OSError, ValueError) as exc:
            raise EpochStoreError(f"{self._store}: {exc}") from exc
        epoch = doc.get("epoch") if isinstance(doc, dict) else None
        if not isinstance(epoch, int) or isinstance(epoch, bool) or epoch < 0:
            raise EpochStoreError(f"{self._store}: no epoch in {doc!r}")
        return epoch

    def _write_epoch(self, epoch: int) -> None:
        try:
            write_atomic(self._store, json.dumps({"epoch": epoch}))
        except OSError as exc:
            raise EpochStoreError(f"{self._store}: {exc}") from exc

    def _anchor(self, epoch: int) -> None:
        self._write_epoch(epoch)
        mono = self._mono()
        self._mappings.append(Mapping(since=mono, offset=self._wall() - mono, epoch=epoch))

    @property
    def epoch(self) -> int:
        return self._mappings[-1].epoch

    def check(self) -> bool:
        """Re-anchor if the wall clock and the mapping have diverged by more
        than the tolerance, by a step or by drift. True if it re-anchored."""
        current = self._mappings[-1]
        if abs(self._wall() - (self._mono() + current.offset)) <= self.tolerance_s:
            return False
        self._anchor(current.epoch + 1)
        return True

    def mapping_at(self, mono: float) -> Mapping:
        """The mapping in force when `mono` happened. An instant before this
        run's first mapping takes the first."""
        for m in reversed(self._mappings):
            if m.since <= mono:
                return m
        return self._mappings[0]

    def rfc3339(self, mono: float) -> tuple[str, int]:
        """`mono` as RFC 3339 with an offset, and the epoch that wrote it.

        The caller must call `check()` before stamping, so a stepped or drifted
        wall clock is re-anchored first (stage 2d wires this)."""
        m = self.mapping_at(mono)
        stamp = datetime.fromtimestamp(mono + m.offset, tz=timezone.utc)
        return stamp.isoformat(timespec="milliseconds"), m.epoch
