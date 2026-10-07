"""Doubles for `speaking`'s tests: a clock the test moves, a synthesiser and
players that take fake time, a store that can be lost. Not tests.

⛔ No audio: a fake piece's PCM is its text's bytes padded with zeros to its
duration, so a player can say which piece it played.
"""
from __future__ import annotations

import asyncio
import heapq
import itertools
from contextlib import asynccontextmanager
from dataclasses import replace
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Callable

import anyio

from voice_front.echo import Interval
from voice_front.listening import Record, WakeWord
from voice_front.speaking import DeviceGone, Playback, Speaking
from voice_front.steward import EndpointView, FrontView
from voice_front.store import StoreUnavailable
from voice_front.synth import Audio, SynthFailed

RATE = 1000             # a small rate keeps fake PCM small: 2000 bytes a second
BRAIN, OTHER_BRAIN = "brain-local", "brain-cloud"
EPOCH = 7
WALL = 1_790_000_000       # the wall clock at the fake monotonic zero


def stamp(mono: float) -> tuple[str, int]:
    """As `WallClock.rfc3339`, on one mapping."""
    return datetime.fromtimestamp(WALL + mono, tz=timezone.utc).isoformat(timespec="milliseconds"), EPOCH


def at(mono: float) -> str:
    return stamp(mono)[0]


async def settle() -> None:
    """Run every other task until each waits on something and nothing is
    scheduled: `anyio`'s `wait_all_tasks_blocked`, without its 0.1 s sleep
    per look, and counting the callbacks anyio delivers cancellation by.
    asyncio only."""
    this = asyncio.current_task()
    loop = asyncio.get_running_loop()
    for _ in range(100_000):
        await asyncio.sleep(0)
        if not loop._ready and all(t is this or (t._fut_waiter is not None and not t._fut_waiter.done())
                                   for t in asyncio.all_tasks()):
            return
    raise RuntimeError("the tasks never settled")


class FakeClock:
    """The front's monotonic clock, moved only by `advance`. Each sleeper
    wakes at its deadline, in deadline order, and everything it starts runs
    before the clock moves on."""

    def __init__(self, t: float = 1000.0):
        self.t = t
        self._sleepers: list[tuple[float, int, anyio.Event]] = []
        self._order = itertools.count()

    def now(self) -> float:
        return self.t

    async def sleep(self, seconds: float) -> None:
        entry = (self.t + max(0.0, seconds), next(self._order), anyio.Event())
        heapq.heappush(self._sleepers, entry)
        try:
            await entry[2].wait()
        finally:
            if entry in self._sleepers:         # cancelled before its time
                self._sleepers.remove(entry)
                heapq.heapify(self._sleepers)

    async def advance(self, seconds: float = 0.0) -> None:
        target = self.t + seconds
        await settle()
        while self._sleepers and self._sleepers[0][0] <= target:
            deadline, _, event = heapq.heappop(self._sleepers)
            self.t = max(self.t, deadline)
            event.set()
            await settle()
        self.t = target
        await settle()


def audio_of(text: str, seconds: float) -> Audio:
    n = 2 * round(seconds * RATE)
    return Audio(text.encode().ljust(n, b"\0")[:n], RATE, 2, 1)


def text_of(audio: Audio) -> str:
    return audio.pcm.rstrip(b"\0").decode(errors="replace")


class FakeSynth:
    """Each text takes `seconds` of audio (1 s unless set) and `delay` of fake
    time to make; a text in `failing` fails."""

    def __init__(self, clock: FakeClock):
        self.clock = clock
        self.seconds: dict[str, float] = {}
        self.delay = 0.0
        self.failing: set[str] = set()
        self.started: list[str] = []

    async def synthesise(self, text: str) -> Audio:
        self.started.append(text)
        if self.delay:
            await self.clock.sleep(self.delay)
        if text in self.failing:
            raise SynthFailed("the synthesiser refused")
        return audio_of(text, self.seconds.get(text, 1.0))


class FakePlayer:
    """A device that plays in fake time. `gone` makes the next play raise at
    once; `leave()` makes the one playing raise. `deaf` ignores `stop`, as a
    device that has buffered the whole piece plays it out and reports it full.
    `lead` is how long it takes to make its first sound."""

    def __init__(self, clock: FakeClock):
        self.clock = clock
        self.played: list[str] = []
        self.gone = False
        self.deaf = False
        self.fail: Exception | None = None
        self.lead = 0.0
        self._left = anyio.Event()

    def leave(self) -> None:
        self._left.set()
        self._left = anyio.Event()

    async def _first(self, seconds: float, stop: anyio.Event) -> str:
        """"end" after `seconds`, "stop" once stopped, "left" once gone: whichever is first."""
        how: list[str] = []
        left = self._left
        async with anyio.create_task_group() as tg:
            async def until(name: str, wait) -> None:
                await wait()
                how.append(name)
                tg.cancel_scope.cancel()
            tg.start_soon(until, "end", lambda: self.clock.sleep(seconds))
            if not self.deaf:
                tg.start_soon(until, "stop", stop.wait)
            tg.start_soon(until, "left", left.wait)
        if how[0] == "left":
            raise DeviceGone()
        return how[0]

    async def play(self, audio: Audio, stop: anyio.Event, on_start: Callable[[float], None]) -> Playback:
        if self.gone:
            raise DeviceGone()
        if self.fail is not None:
            raise self.fail
        if self.lead and await self._first(self.lead, stop) == "stop":
            return Playback(None, self.clock.now(), completed=False)
        started = self.clock.now()
        on_start(started)
        self.played.append(text_of(audio))
        how = await self._first(audio.duration_s, stop)
        return Playback(started, self.clock.now(), completed=how == "end")


def endpoint(eid: str, *, served_by: str | None = BRAIN, output: str | None = "speech", zone: str = "kitchen",
             words: tuple[str, ...] = ("Компьютер",)) -> EndpointView:
    record = Record("wake_server", tuple(WakeWord(w, "transcript") for w in words), zone=zone, output=output)
    return EndpointView(id=eid, type="voice", person=None, served_by=served_by, record=record, heard_by="front-1")


class Front:
    """A running `Speaking` with its doubles. `reports` is what reached the
    store, in order; `down` makes the store unreachable. `told` is each
    `speaking` the steward took, with its time; `steward_down` makes it
    unreachable."""

    def __init__(self, **speaking: Any):
        self.clock = FakeClock()
        self.synth = FakeSynth(self.clock)
        self.players: dict[str, FakePlayer | None] = {
            "ep-kitchen": FakePlayer(self.clock), "ep-hall": FakePlayer(self.clock)}
        self.view = FrontView(revision=1, endpoints={
            "ep-kitchen": endpoint("ep-kitchen"),
            "ep-hall": endpoint("ep-hall", zone="hall", words=("Джарвис",)),
        }, other_wake_words=("Алиса", "Окей, Гугл"))
        self.reports: list[dict[str, Any]] = []
        self.attempts = 0
        self.down = False
        self.told: list[tuple[float, str, bool]] = []
        self.steward_down = False
        self._ids = itertools.count(1)
        self.speaking = Speaking(synthesiser=self.synth, players=self.players.get, report=self._report,
                                 view=lambda: self.view, stamp=stamp,
                                 speaking=self._speaking, now=self.clock.now, sleep=self.clock.sleep, **speaking)

    async def _speaking(self, endpoint: str, on: bool) -> None:
        if self.steward_down:
            raise OSError("the steward is away")
        self.told.append((self.clock.t, endpoint, on))

    async def _report(self, played: dict[str, Any]) -> bool:
        self.attempts += 1
        if self.down:
            raise StoreUnavailable("the store is away")
        self.reports.append(played)
        return True

    def change(self, eid: str, **fields: Any) -> None:
        e = self.view.endpoints[eid]
        record_fields = {k: fields.pop(k) for k in ("output", "zone") if k in fields}
        if "words" in fields:
            record_fields["wake_words"] = tuple(WakeWord(w, "transcript") for w in fields.pop("words"))
        e = replace(e, record=replace(e.record, **record_fields), **fields)
        self.view = replace(self.view, revision=self.view.revision + 1,
                            endpoints={**self.view.endpoints, eid: e})

    async def say(self, text: str, endpoint: str = "ep-kitchen", brain: str = BRAIN, **request: Any) -> str:
        say_id = f"s{next(self._ids)}"
        await self.speaking.say(brain, say_id, {"endpoint": endpoint, "text": text, **request})
        return say_id

    def delivered(self, utterance_id: str, speech: Interval, endpoint: str = "ep-kitchen", **kw: Any) -> None:
        self.speaking.delivered(utterance_id, endpoint, speech, **kw)

    def ons(self, endpoint: str = "ep-kitchen") -> list[tuple[float, bool]]:
        return [(t, on) for t, e, on in self.told if e == endpoint]

    def report(self, say_id: str) -> dict[str, Any]:
        found = [r for r in self.reports if r["say_id"] == say_id]
        assert len(found) == 1, f"{say_id} reported {len(found)} times: {self.reports}"
        return found[0]

    def statuses(self) -> list[tuple[str, str, str | None]]:
        return [(r["say_id"], r["status"], r.get("reason")) for r in self.reports]


@asynccontextmanager
async def running(**speaking: Any) -> AsyncIterator[Front]:
    """A front, speaking; every test is bounded in real time."""
    front = Front(**speaking)
    with anyio.fail_after(5):
        async with anyio.create_task_group() as tg:
            await tg.start(front.speaking.run)
            yield front
            tg.cancel_scope.cancel()
