"""The front as the steward's client (steward, *Listening*; GA-AUTH-8).

A front credential may call `describe`, `zone_sources`, `narrow`,
`front_status` and `speaking`, and nothing else. `describe` shows the front
only its own endpoints; the front waits on it for the next revision
(`since_revision`, `wait_s`), so a narrowing reaches it at once
(GA-VOICE-3). `zone_sources` lists what machines in the home are saying,
for marking a known machine's speech (GA-VOICE-9).

What `describe` shows a front is prose in the standard, not yet a schema;
`view_of` reads it as *Plan rulings* in the stage 2b plan say.
"""
from __future__ import annotations

import math
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Callable, Mapping, Sequence

import anyio

from voice_front import mcpwire
from voice_front.echo import Interval, Spoken
from voice_front.listening import ORDER, Narrowing, Record, WakeWord
from voice_front.schemas import SchemaError

WAIT_S = mcpwire.LONGEST_POLL_S
RETRY_S = (1, 2, 5, 10)                 # after a lost steward, then every 10 s
ANNOUNCE_HOLD_S = 30                    # voice, *Constants* (the steward's)
UTTERANCE_LIMIT_S = 30                  # voice, *Constants*; the 60 s hold below covers the
                                        # utterance limit plus delivery lag


# ---- what the front is shown ------------------------------------------------

@dataclass(frozen=True)
class NarrowingView:
    narrowing_id: str
    listening: str | None
    follow_up: bool | None
    until: str
    cause: Mapping[str, Any] | None

    def narrowing(self) -> Narrowing:
        return Narrowing(listening=self.listening, follow_up=self.follow_up)


@dataclass(frozen=True)
class EndpointView:
    id: str
    type: str | None
    person: str | None
    served_by: str | None
    record: Record
    heard_by: str | None
    narrowings: tuple[NarrowingView, ...] = ()
    skill_account: str | None = None
    skill_surface: str | None = None


@dataclass(frozen=True)
class FrontView:
    revision: int
    endpoints: Mapping[str, EndpointView]
    persons: frozenset[str] = frozenset()
    audio_retention_s: float = 0
    other_wake_words: tuple[str, ...] = ()
    skipped: tuple[str, ...] = field(default=())    # endpoints whose record could not be read

    def served_by(self) -> dict[str, str | None]:
        return {e.id: e.served_by for e in self.endpoints.values()}

    def settings(self) -> dict[str, tuple[Record, tuple[Narrowing, ...]]]:
        """Each endpoint's configured record and narrowings: what
        `listening.effective` takes and `listening.save_last` keeps."""
        return {e.id: (e.record, tuple(n.narrowing() for n in e.narrowings))
                for e in self.endpoints.values()}


class Unreadable(ValueError):
    pass


def _record(voice: Mapping[str, Any]) -> Record:
    listening = voice.get("listening")
    if listening not in ORDER:
        raise Unreadable(f"listening {listening!r}")
    words = voice.get("wake_words") or []
    if not isinstance(words, list) or not all(isinstance(w, Mapping) and isinstance(w.get("word"), str)
                                              and isinstance(w.get("model"), str) for w in words):
        raise Unreadable("wake_words")
    output = voice.get("output")
    if output not in (None, "speech"):
        raise Unreadable(f"output {output!r}")
    return Record(listening=listening, wake_words=tuple(WakeWord(w["word"], w["model"]) for w in words),
                  follow_up=voice.get("follow_up") is True, zone=voice.get("zone"), output=output)


def _narrowings(raw: Any) -> tuple[NarrowingView, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list):
        raise Unreadable("narrowings")
    return tuple(_narrowing(n) for n in raw)


def _narrowing(n: Any) -> NarrowingView:
    if not isinstance(n, Mapping):
        raise Unreadable("narrowing")
    listening = n.get("listening")
    if listening is not None and listening not in ORDER:
        raise Unreadable(f"narrowing listening {listening!r}")
    follow_up = n.get("follow_up")
    if follow_up is not None and not isinstance(follow_up, bool):
        raise Unreadable("narrowing follow_up")
    return NarrowingView(str(n["narrowing_id"]), listening, follow_up, str(n["until"]), n.get("cause"))


def view_of(described: Mapping[str, Any]) -> FrontView:
    """The front's view of a `describe` response. An endpoint with no voice
    record is not the front's; one whose record cannot be read is left out
    and named in `skipped`, so the front listens nowhere there."""
    endpoints: dict[str, EndpointView] = {}
    skipped: list[str] = []
    listed = described.get("endpoints")
    for e in listed if isinstance(listed, list) else []:
        if not isinstance(e, Mapping):
            continue                        # cannot even be named: dropped
        voice = e.get("voice")
        if not isinstance(voice, Mapping):
            continue
        try:
            endpoints[e["id"]] = EndpointView(
                id=e["id"], type=e.get("type"), person=e.get("person"), served_by=e.get("served_by"),
                record=_record(voice), heard_by=voice.get("heard_by"),
                narrowings=_narrowings(e.get("narrowings")),
                skill_account=voice.get("skill_account"), skill_surface=voice.get("skill_surface"))
        except (Unreadable, KeyError, TypeError, AttributeError, ValueError):
            skipped.append(str(e.get("id")))
    home = described.get("home")
    home = home if isinstance(home, Mapping) else {}
    raw_persons = described.get("persons")
    persons = frozenset(pid for pid in (p.get("id") if isinstance(p, Mapping) else p
                                        for p in (raw_persons if isinstance(raw_persons, list) else []))
                        if isinstance(pid, str))
    retention = home.get("audio_retention_s", 0)
    words = home.get("other_wake_words")    # not a list: none (a string is not its characters)
    return FrontView(
        revision=described["revision"], endpoints=endpoints, persons=persons,
        audio_retention_s=(retention if isinstance(retention, (int, float)) and not isinstance(retention, bool)
                           and retention > 0 else 0),
        other_wake_words=tuple(w for w in (words if isinstance(words, list) else []) if isinstance(w, str)),
        skipped=tuple(skipped))


# ---- the operations ---------------------------------------------------------

class Steward:
    """The five operations a front credential may call, on one session."""

    def __init__(self, session: mcpwire.Session):
        self._s = session

    @property
    def revision(self) -> str:
        return self._s.revision

    async def _op(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        return await self._s.call(name, args, request=f"steward/{name}.request.json",
                                  response=f"steward/{name}.response.json")

    async def describe(self, since_revision: int | None = None, wait_s: float = 0) -> dict[str, Any]:
        args: dict[str, Any] = {"wait_s": wait_s}
        if since_revision is not None:
            args["since_revision"] = since_revision
        return await self._op("describe", args)

    async def zone_sources(self, cursor: str | None = None, wait_s: float = 0) -> dict[str, Any]:
        args: dict[str, Any] = {"wait_s": wait_s}
        if cursor is not None:
            args["cursor"] = cursor
        return await self._op("zone_sources", args)

    async def narrow(self, endpoint: str, *, listening: str | None = None, follow_up: bool | None = None,
                     until: str | None = None) -> dict[str, Any]:
        args: dict[str, Any] = {"endpoint": endpoint}
        for key, value in (("listening", listening), ("follow_up", follow_up), ("until", until)):
            if value is not None:
                args[key] = value
        return await self._op("narrow", args)

    async def front_status(self, *, models: list, clips: list, effective: dict, frames: dict,
                           skills: dict) -> None:
        await self._op("front_status", {"models": models, "clips": clips, "effective": effective,
                                        "frames": frames, "skills": skills})

    async def speaking(self, endpoint: str, on: bool) -> None:
        await self._op("speaking", {"endpoint": endpoint, "on": on})


Opener = Callable[[], Any]      # () -> async context manager yielding Steward


def opener(url: str, credential: str, **connect: Any) -> Opener:
    """A way to open a session with the steward, as often as it is lost."""
    @asynccontextmanager
    async def open_() -> AsyncIterator[Steward]:
        async with mcpwire.connect(url, credential, **connect) as session:
            yield Steward(session)
    return open_


# ---- watching ---------------------------------------------------------------

# A steward whose answer its schema refuses is not trusted either.
LOST = (mcpwire.Unavailable, mcpwire.CallError, mcpwire.RevisionRefused, SchemaError, TimeoutError, OSError)


def _is_lost(e: BaseException) -> bool:
    """A lost steward, alone or as the only kind of leaf in a group (a
    transport's drop may surface as one). Cancellation is never lost."""
    if isinstance(e, BaseExceptionGroup):
        return bool(e.exceptions) and all(_is_lost(x) for x in e.exceptions)
    return isinstance(e, LOST)


async def watch_describe(open_: Opener, on_view: Callable[[FrontView], Any],
                         on_lost: Callable[[BaseException], Any], *, wait_s: float = WAIT_S,
                         retry_s: Sequence[float] = RETRY_S) -> None:
    """Forever: wait on `describe` for each new revision and hand on the view;
    when the steward is lost, say so and try again, backing off. Runs until
    cancelled."""
    failures = 0
    revision: int | None = None
    while True:
        callback_error: Exception | None = None
        try:
            async with open_() as steward:
                while True:
                    described = await steward.describe(since_revision=revision, wait_s=wait_s)
                    failures = 0
                    if described["revision"] != revision:
                        revision = described["revision"]
                        view = view_of(described)
                        try:
                            on_view(view)
                        except Exception as e:      # ours, not a lost steward: leave the session, then raise
                            callback_error = e
                            break
        except BaseException as e:
            if not _is_lost(e):
                raise
            on_lost(e)
            revision = None                 # read the whole view again when it returns
            await anyio.sleep(retry_s[min(failures, len(retry_s) - 1)])
            failures += 1
        else:
            if callback_error is not None:
                raise callback_error


class SourceLog:
    """What machines in the home have said, on the front's clock (steward,
    `zone_sources`; GA-VOICE-9).

    An entry starts `speaking_for_ms` before the response that listed it,
    and ends when a response no longer lists it. Ended entries are kept while
    an utterance could still overlap them."""

    def __init__(self, keep_s: float = ANNOUNCE_HOLD_S + UTTERANCE_LIMIT_S):
        self._keep_s = keep_s
        self._open: dict[tuple[str, str], float] = {}
        self._ended: list[tuple[float, float, str]] = []

    def update(self, sources: Sequence[Mapping[str, Any]], now: float) -> None:
        seen: dict[tuple[str, str], float] = {}
        for s in sources:
            if s.get("speech") is None:
                continue
            key = (s["target"], s["speech"])
            seen[key] = self._open.get(key, now - s["speaking_for_ms"] / 1000)
        for key, start in self._open.items():
            if key not in seen:
                self._ended.append((start, now, key[1]))
        self._open = seen
        self._ended = [e for e in self._ended if e[1] >= now - self._keep_s]

    def close(self, now: float) -> None:
        """The steward was lost, so it reports nothing: end every open entry
        at `now`, the last good response."""
        self._ended += [(start, now, text) for (_, text), start in self._open.items()]
        self._open = {}
        self._ended = [e for e in self._ended if e[1] >= now - self._keep_s]

    def spoken(self) -> list[Spoken]:
        return ([Spoken(Interval(start, end), text) for start, end, text in self._ended]
                + [Spoken(Interval(start, math.inf), text) for (_, text), start in self._open.items()])


async def watch_sources(open_: Opener, log: SourceLog, *, now: Callable[[], float],
                        on_lost: Callable[[BaseException], Any] = lambda e: None,
                        wait_s: float = WAIT_S, retry_s: Sequence[float] = RETRY_S) -> None:
    """Forever: keep `log` up to date from `zone_sources`. `now` is the
    front's monotonic clock."""
    failures = 0
    last_good = now()
    while True:
        cursor: str | None = None
        try:
            async with open_() as steward:
                while True:
                    listed = await steward.zone_sources(cursor, wait_s=wait_s)
                    failures = 0
                    last_good = now()
                    log.update(listed["sources"], last_good)
                    cursor = listed["cursor"]
        except BaseException as e:
            if not _is_lost(e):
                raise
            on_lost(e)
            log.close(last_good)            # a lost steward reports nothing: no source stays open
            await anyio.sleep(retry_s[min(failures, len(retry_s) - 1)])
            failures += 1
