"""Speaking: a brain's `say` pieces played at their endpoints, in order, each
reported `played`; the fixed clips; the steward told who is speaking (voice,
*Speaking*; GA-VOICE-10, GA-VOICE-11, GA-VOICE-12, GA-VOICE-20; brain, *The
front*).

`Speaking` is the `Speech` that `brain.BrainServer` hands `say` and `hush`
to. Each endpoint has one queue, played in arrival order: a reply's pieces
arrive in order, because a brain names each piece's `say_id` in the next
one's `continues`, so arrival order is reply order. A piece is synthesised
whole, while the one before it plays, and handed to the endpoint's `Player`,
which the device link (stage 2d) provides.

Every piece gets exactly one `played` report. Reports go to the store through
a reporter task of their own, so a lost store delays reports and never
speech.

A piece that is cut or dropped breaks its chain: every piece that `continues`
it, queued or still to come, is dropped as `earlier_cut`. So does a piece
that was told to stop, however it ended: a device that buffered the whole
piece may finish it within the stop wait, and the reply still ends there.
`hush` and `cut` stop speech the same way: the device is told to stop, and a
device that has not stopped within `STOP_WAIT_S` is cut off.

A fixed clip plays through the same queue, with no `played`: it has no
`say_id`. «Не могу ответить» plays when the brain is silent: an utterance
addressed by `wake`, `tap` or `typed` at an endpoint that speaks, with no
reply, no reply to one it duplicates, and no `hush` by the failure bound plus
the clip slack (GA-VOICE-11).

The front's clock is monotonic and injected (`now`, `sleep`), as in
`timeline`; `stamp` maps it to wall time and `clock_epoch`
(`timeline.WallClock.rfc3339`, after `check()`).
"""
from __future__ import annotations

import logging
import math
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Mapping, Protocol

import anyio
from anyio.abc import TaskGroup, TaskStatus

from voice_front import clips as fixed
from voice_front.echo import Interval, Spoken
from voice_front.steward import FrontView
from voice_front.store import StoreUnavailable
from voice_front.synth import Audio
from voice_front.text import first_wake_word, normalise_standard

log = logging.getLogger("voice-front")

REPORT_DELAY_S = 1          # voice, *Constants*
CLIP_SLACK_S = 2            # voice, *Constants*
FAILURE_BOUND_S = 10        # brain, *Constants*
ARBITRATION_WINDOW_S = 2    # brain, *Constants*
DUCK_LIMIT_S = 60           # steward, *Constants*
HEARTBEAT_S = DUCK_LIMIT_S // 3     # `on: true` again well within the duck limit (GA-VOICE-12)
SPEAKING_OFF_GRACE_S = 0.5  # a reply's pieces do not flap the duck; `off` still within the report delay
PLAY_LOG_KEEP_S = 60        # the utterance limit plus delivery lag, as steward.SourceLog
MARK_KEEP_S = 60            # what is remembered of an utterance or a piece once it is done
STOP_WAIT_S = 0.5           # a device not stopped by then is cut off; well within the report delay
RETRY_S = (1, 2, 5, 10)     # after a lost store or steward, then every 10 s
TELL_S = 2                  # one `speaking` call; the steward's own transport would wait a minute
CLOSE_S = 2                 # what closing may take: `speaking` off, the last reports; see Player.play
ADDRESSED = ("wake", "tap", "typed")        # what the silent-brain clip answers


# ---- the link's seam --------------------------------------------------------

class DeviceGone(Exception):
    """The endpoint's device left, before the piece began or while it played."""


@dataclass(frozen=True)
class Playback:
    """What a device played, on the front's monotonic clock: a device that
    buffers reports `{ duration_ms, ended_ago_ms }`, which the link places
    with `timeline.reported`."""
    started: float | None       # its first audio; None if none was heard
    ended: float
    completed: bool             # played to its end; False when stopped


class Player(Protocol):
    """One endpoint's device, as the link (stage 2d) drives it."""

    async def play(self, audio: Audio, stop: anyio.Event, on_start: Callable[[float], None]) -> Playback:
        """Play `audio`; return when it has ended or, once `stop` is set,
        when the device has stopped. Call `on_start` with the time its first
        audio starts. Raises `DeviceGone`. It must honour cancellation: a
        device that does not stop is cut off by cancelling this call, and so
        is one still playing when the front stops. Closing's deadline covers
        `speaking` off and the last reports; a `play` that ignores
        cancellation delays the exit past it."""
        ...


class Synthesises(Protocol):
    async def synthesise(self, text: str) -> Audio: ...


# ---- what was played, for echo ----------------------------------------------

class PlayLog:
    """Every playback the front made, on its clock: what `echo.is_echo` takes
    as `playing` (GA-VOICE-8). A playback appears when its audio starts, with
    no end while it plays, and is kept `keep_s` after it ends. `now` is the
    front's monotonic clock."""

    def __init__(self, now: Callable[[], float], keep_s: float = PLAY_LOG_KEEP_S):
        self._now = now
        self._keep_s = keep_s
        self._open: dict[object, tuple[float, str]] = {}
        self._ended: list[tuple[float, float, str]] = []

    def start(self, key: object, at: float, text: str) -> None:
        self._open[key] = (at, text)

    def end(self, key: object, at: float, started: float | None = None) -> None:
        """`started`, when the device reported it, replaces the start `on_start` gave."""
        start, text = self._open.pop(key)
        self.add(start if started is None else started, at, text)

    def add(self, start: float, end: float, text: str) -> None:
        """A playback whose start was learnt only once it had ended."""
        self._ended.append((start, end, text))
        self._ended = [e for e in self._ended if e[1] >= end - self._keep_s]

    def recent(self) -> list[Spoken]:
        self._ended = [e for e in self._ended if e[1] >= self._now() - self._keep_s]
        return ([Spoken(Interval(start, end), text) for start, end, text in self._ended]
                + [Spoken(Interval(start, math.inf), text) for start, text in self._open.values()])


# ---- the queues -------------------------------------------------------------

@dataclass(eq=False)
class _Piece:
    brain: str
    say_id: str
    endpoint: str
    text: str
    in_reply_to: str | None = None
    continues: str | None = None
    audio: Audio | None = None
    ready: anyio.Event | None = None            # set when synthesis has ended; None before it starts
    synth: anyio.CancelScope | None = None
    settled: bool = False                       # reported: never again
    latency_ms: int | None = None


@dataclass(eq=False)
class _Clip:
    clip: fixed.Clip
    endpoint: str
    continues = None                            # a clip is no reply's piece
    say_id = None

    @property
    def text(self) -> str:
        return self.clip.text


@dataclass(eq=False)
class _Playing:
    item: _Piece | _Clip
    stop: anyio.Event = field(default_factory=anyio.Event)
    done: anyio.Event = field(default_factory=anyio.Event)
    started: float | None = None
    over: bool = False                          # reported: a late `on_start` changes nothing
    cut_by: str | None = None
    scope: anyio.CancelScope | None = None


@dataclass(eq=False)
class _Lane:
    endpoint: str
    queue: deque[_Piece | _Clip] = field(default_factory=deque)
    playing: _Playing | None = None
    running: bool = False
    last_piece: _Piece | None = None            # the last piece to start playing: a cut between pieces ends its reply
    on: bool = False                            # speaking, as the steward should know it
    told: bool | None = None                    # what the steward last acknowledged; None: nothing yet
    on_sent: bool = False                       # an `on` was sent, or is out, and no `off` taken since
    beat_due: bool = False                      # `on` again, for the heartbeat
    nudge: anyio.Event = field(default_factory=anyio.Event)
    teller: anyio.CancelScope | None = None
    heartbeat: anyio.CancelScope | None = None
    grace: anyio.CancelScope | None = None


@dataclass(eq=False)
class _Delivered:
    endpoint: str
    speech: Interval
    at: float
    zone: str | None = None
    transcript: str = ""                        # normalised
    latency_given: bool = False

    def duplicates(self, other: "_Delivered") -> bool:
        """One sentence heard twice in a zone: the intervals overlap, or the
        same words within the arbitration window (GA-VOICE-11)."""
        return (self.zone is not None and self.zone == other.zone
                and (self.speech.overlaps(other.speech, slack=0)
                     or (self.transcript and self.transcript == other.transcript
                         and abs(self.speech.start - other.speech.start) <= ARBITRATION_WINDOW_S)))


def heard_chars(text: str, played_s: float, duration_s: float) -> int:
    """How much of `text` was heard, in proportion to the time it played:
    Wyoming gives no alignment of text to audio."""
    if duration_s <= 0:
        return 0
    return max(0, min(len(text), round(len(text) * played_s / duration_s)))


class Speaking:
    """The `Speech` a `BrainServer` hands `say` and `hush` to (brain.py).

    `players(endpoint)` is the endpoint's device, or None when none is
    connected. `report` is `BrainServer.report_played`. `view` is the
    steward's latest view: who serves each endpoint, its output, its zone and
    every wake word. `speaking` is `steward.Steward.speaking`. Runs under
    `run`, in a task group of the caller's.
    """

    def __init__(self, *, synthesiser: Synthesises, players: Callable[[str], Player | None],
                 report: Callable[[dict[str, Any]], Awaitable[bool]],
                 view: Callable[[], FrontView | None], stamp: Callable[[float], tuple[str, int]],
                 speaking: Callable[[str, bool], Awaitable[None]],
                 clips: Mapping[str, fixed.Clip] | None = None,
                 now: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], Awaitable[None]] = anyio.sleep, close_s: float = CLOSE_S):
        self._synth = synthesiser
        self._players = players
        self._report = report
        self._view = view
        self._stamp = stamp
        self._speaking = speaking
        self._clips = dict(clips or {})
        self._now = now
        self._sleep = sleep
        self.play_log = PlayLog(now)
        self._lanes: dict[str, _Lane] = {}
        self._delivered: dict[str, _Delivered] = {}
        self._broken: dict[str, float] = {}         # say_id -> when it was cut or dropped
        self._hushed: dict[str, float] = {}         # utterance_id -> when a hush named it
        self._replies: dict[str, set[str]] = {}     # utterance_id -> say_ids in reply, none guarded
        self._unheard: dict[str, float] = {}        # say_id -> when it was dropped because the synthesiser failed, or after such a piece
        self._replied_at: dict[str, float] = {}     # utterance_id -> its first reply
        self._clip_words: tuple[str, ...] | None = None
        self._clip_blocked: dict[str, str] = {}
        self._close_s = close_s
        self._closed = False
        self._unfiled: dict[str, Any] | None = None     # the report being filed, until the store has it
        self._send, self._receive = anyio.create_memory_object_stream[tuple[int, dict[str, Any]]](math.inf)
        self._handed = 0
        self._filed = 0
        self._filed_changed = anyio.Event()
        self._tg: TaskGroup | None = None

    async def run(self, *, task_status: TaskStatus = anyio.TASK_STATUS_IGNORED) -> None:
        """Speak until cancelled. On the way out, within `close_s` in all:
        every endpoint still speaking is said to stop, first, so the home
        un-ducks; then the reports not yet filed are tried once more."""
        self._blocked_clips()
        deadline: float | None = None
        try:
            async with anyio.create_task_group() as tg:
                self._tg = tg
                tg.start_soon(self._reporter)
                task_status.started()
                try:
                    await anyio.sleep_forever()
                finally:
                    deadline = anyio.current_time() + self._close_s
                    self._closed = True
                    with anyio.CancelScope(shield=True, deadline=deadline):
                        await self._say_off()           # while the lanes wind down
        finally:
            self._tg = None
            self._closed = True
            self._filed_changed.set()                   # a cut waiting on the store waits no more
            if deadline is None:
                deadline = anyio.current_time() + self._close_s
            with anyio.CancelScope(shield=True, deadline=deadline):
                await self._file_the_rest()

    # ---- what the brain server calls ----------------------------------------

    async def say(self, brain: str, say_id: str, request: dict[str, Any]) -> None:
        """Queue the piece, or report it dropped at once; either way, return
        with no wait on synthesis or playback."""
        self._task_group()                              # not running: raise before any state changes
        self._prune(self._now())
        p = _Piece(brain, say_id, request["endpoint"], request["text"],
                   in_reply_to=request.get("in_reply_to"), continues=request.get("continues"))
        if self._guarded(p):
            return
        if p.in_reply_to is not None:                  # a reply, whatever becomes of it (GA-VOICE-11)
            self._replies.setdefault(p.in_reply_to, set()).add(say_id)
            self._replied_at.setdefault(p.in_reply_to, self._now())
        if p.continues in self._broken:
            self._settle(p, "dropped", reason="earlier_cut")
            return
        if self._served_by(p.endpoint) != p.brain:      # an endpoint no longer in the view, or moved on
            self._settle(p, "dropped", reason="not_served")
            return
        if self._output(p.endpoint) is None:
            self._settle(p, "dropped", reason="no_output")
            return
        self._queue(p)

    async def hush(self, brain: str, request: dict[str, Any]) -> None:
        """Stop the named speech and drop what is queued of it (GA-VOICE-10);
        or, for an utterance, mark it left unanswered on purpose. The brain
        server has checked that `brain` serves the endpoint."""
        now = self._now()
        self._prune(now)
        if "utterance_id" in request:
            self._hushed[request["utterance_id"]] = now
            return
        if "endpoint" in request:
            lane = self._lanes.get(request["endpoint"])
            if lane is None:
                return
            # Emptied before the stop is awaited, so nothing queued starts meanwhile.
            for item in list(lane.queue):
                if isinstance(item, _Piece):
                    self._settle(item, "dropped", reason="hush")
                else:
                    lane.queue.remove(item)
            between = lane.playing is None
            await self._stop(lane, None)
            if between and lane.last_piece is not None:     # as `cut`: the reply being made ends too
                self._break_chain(lane.last_piece.say_id)
            return
        say_id = request["say_id"]
        for lane in list(self._lanes.values()):
            if lane.playing is not None and lane.playing.item.say_id == say_id:
                await self._stop(lane, None)
                break
            queued = next((p for p in lane.queue if p.say_id == say_id), None)
            if queued is not None:
                self._settle(queued, "dropped", reason="hush")
                break
        # Played already, or played in full within the stop wait: its reply still ends here.
        self._break_chain(say_id)

    async def cut(self, endpoint: str, by: str | None = None) -> None:
        """Stop the piece playing at `endpoint`, as a wake word or a barge-in
        does, and drop the rest of its reply. `by` is the utterance that cut
        it. Returns once every report so far is filed in the store, so the
        utterance that cut it can be delivered after them (GA-VOICE-10)."""
        lane = self._lanes.get(endpoint)
        if lane is not None:
            # Between two pieces of a reply, nothing plays, or only a clip: the
            # reply of the last piece to play ends all the same (the next may
            # be in synthesis).
            playing = lane.playing.item if lane.playing is not None else None
            piece = playing if isinstance(playing, _Piece) else lane.last_piece
            await self._stop(lane, by)
            if piece is not None:
                self._break_chain(piece.say_id)
        await self._all_filed()

    # ---- what the rest of the front calls -----------------------------------

    def delivered(self, utterance_id: str, endpoint: str, speech: Interval, *,
                  addressed_by: str | None = None, transcript: str = "") -> None:
        """An utterance was made available to a brain, at about now. Its
        speech's end times the reply (`latency_ms`); one addressed by a wake
        word, a tap or typing, at an endpoint that speaks, starts the
        silent-brain clip's timer. Echoes and machines are not addressed, so
        never reach here. A second call for one utterance changes nothing."""
        self._task_group()                              # not running: raise before any state changes
        now = self._now()
        self._prune(now)
        if utterance_id in self._delivered:
            return
        e = self._endpoint(endpoint)
        d = self._delivered[utterance_id] = _Delivered(
            endpoint, speech, now, zone=None if e is None else e.record.zone,
            transcript=normalise_standard(transcript))
        if addressed_by in ADDRESSED:          # an endpoint that does not speak skips the clip at its turn
            self._task_group().start_soon(self._silent_brain, utterance_id, d)

    def play_clip(self, endpoint: str, name: str) -> None:
        """Queue a fixed clip at `endpoint`: the earcon, the recognition
        failure. A clip the installation lacks plays nothing; so does one
        that names a wake word when its turn comes."""
        self._task_group()                              # not running: raise before any state changes
        clip = self._clips.get(name)
        if clip is not None:
            self._queue(_Clip(clip, endpoint))

    async def _silent_brain(self, utterance_id: str, d: _Delivered) -> None:
        await self._sleep(FAILURE_BOUND_S + CLIP_SLACK_S)
        if self._answered(utterance_id, d):
            return
        log.info("no reply to %s: playing the silent-brain clip", utterance_id)
        self.play_clip(d.endpoint, fixed.CANNOT_ANSWER)

    def _answered(self, utterance_id: str, d: _Delivered) -> bool:
        if utterance_id in self._hushed or self._replies.get(utterance_id):
            return True
        return any(self._replies.get(u) and o.duplicates(d)
                   for u, o in self._delivered.items() if u != utterance_id)

    # ---- the view -----------------------------------------------------------

    def _words(self) -> tuple[str, ...]:
        """Every endpoint's wake words and the home's other ones (GA-VOICE-20)."""
        v = self._view()
        if v is None:
            return ()
        words = [w.word for e in v.endpoints.values() for w in e.record.wake_words]
        return tuple(dict.fromkeys(words + list(v.other_wake_words)))

    def _endpoint(self, endpoint: str):
        v = self._view()
        return None if v is None else v.endpoints.get(endpoint)

    def _blocked_clips(self) -> dict[str, str]:
        """The clips that name a wake word, read again whenever the words
        change (GA-VOICE-20)."""
        words = self._words()
        if words != self._clip_words:
            self._clip_words = words
            self._clip_blocked = fixed.blocked(self._clips, words)
            for name in self._clip_blocked:
                log.warning("clip %s names a wake word: not played while it does", name)
        return self._clip_blocked

    def _output(self, endpoint: str) -> str | None:
        e = self._endpoint(endpoint)
        return None if e is None else e.record.output

    def _served_by(self, endpoint: str) -> str | None:
        e = self._endpoint(endpoint)
        return None if e is None else e.served_by

    # ---- a lane -------------------------------------------------------------

    def _task_group(self) -> TaskGroup:
        if self._tg is None:
            raise RuntimeError("Speaking is not running: start `run` before anything is said or "
                               "delivered, and say nothing once it has stopped")
        return self._tg

    def _spawn(self, fn: Callable[..., Awaitable[Any]], *args: Any) -> anyio.CancelScope:
        scope = anyio.CancelScope()

        async def task() -> None:
            with scope:
                await fn(*args)
        self._task_group().start_soon(task)
        return scope

    def _guarded(self, p: _Piece) -> bool:
        """GA-VOICE-20, at `say` and again before synthesis: the words may
        have changed while the piece waited. A guarded piece is no reply."""
        word = first_wake_word(p.text, self._words())
        if word is None:
            return False
        log.warning("dropped piece %s: its text names a wake word", p.say_id)
        self._replies.get(p.in_reply_to, set()).discard(p.say_id)
        self._settle(p, "dropped", reason="wake_word")
        return True

    def _queue(self, item: _Piece | _Clip) -> None:
        lane = self._lanes.setdefault(item.endpoint, _Lane(item.endpoint))
        lane.queue.append(item)
        self._look_ahead(lane)
        if not lane.running:
            self._task_group().start_soon(self._run_lane, lane)
            lane.running = True                 # only once its task exists: else no one would clear it

    def _look_ahead(self, lane: _Lane) -> None:
        """Start synthesising the next piece to play, if it has not started:
        one piece ahead of the one playing. A clip needs none."""
        for p in list(lane.queue):
            if isinstance(p, _Clip) or p.settled:       # settled: dropped with a piece it continues
                continue
            if p.ready is not None:
                return
            try:
                if self._guarded(p):
                    continue
                served = self._served_by(p.endpoint)
            except Exception:       # a view that fails: this piece, never the lane
                log.exception("could not check piece %s at %s", p.say_id, p.endpoint)
                self._settle(p, "dropped", reason="no_device")
                continue
            if served != p.brain:
                self._settle(p, "dropped", reason="not_served")
                continue
            p.ready = anyio.Event()
            p.synth = self._spawn(self._synthesise, p)
            return

    async def _synthesise(self, p: _Piece) -> None:
        try:
            p.audio = await self._synth.synthesise(p.text)
        except Exception as e:      # SynthFailed, or a bug in the client: the piece, not the front
            log.warning("could not synthesise piece %s: %s", p.say_id, e)
            self._settle(p, "dropped", reason="synth_failed")
        finally:
            p.ready.set()

    async def _run_lane(self, lane: _Lane) -> None:
        try:
            while True:
                p: _Piece | _Clip | None = None
                try:
                    self._look_ahead(lane)
                    if not lane.queue:
                        return
                    head = lane.queue[0]
                    if isinstance(head, _Clip):
                        p = lane.queue.popleft()
                        player = self._players(p.endpoint)
                        if p.clip.name in self._blocked_clips():
                            log.warning("clip %s not played: it names a wake word", p.clip.name)
                        elif player is not None and self._output(p.endpoint) == "speech":
                            await self._play(lane, p, player)
                        continue
                    if not head.ready.is_set():
                        await head.ready.wait()
                        continue                    # anything may have changed: look again
                    p = lane.queue.popleft()
                    # From here to the player's first await, no await: what
                    # is checked is what holds when the piece starts (ruling 17).
                    if self._guarded(p):
                        continue
                    if self._served_by(p.endpoint) != p.brain:
                        self._settle(p, "dropped", reason="not_served")
                        continue
                    if self._output(p.endpoint) is None:
                        self._settle(p, "dropped", reason="no_output")
                        continue
                    player = self._players(p.endpoint)
                    if player is None:
                        self._settle(p, "dropped", reason="no_device")
                        continue
                    await self._play(lane, p, player)
                except Exception:       # a bug in a link or here: one item, never the lane
                    if p is None and lane.queue:
                        p = lane.queue.popleft()    # what the lane could not get past
                    log.exception("the lane at %s failed on %s", lane.endpoint, p)
                    if isinstance(p, _Piece):
                        self._settle(p, "dropped", reason="no_device")
        finally:
            lane.running = False
            if lane.on and not self._closed:
                if lane.grace is not None:
                    lane.grace.cancel()
                lane.grace = self._spawn(self._grace, lane)

    async def _stop(self, lane: _Lane, cut_by: str | None) -> None:
        """Stop what `lane` is playing, and return once it is reported."""
        playing = lane.playing
        if playing is None:
            return
        if playing.cut_by is None:                  # a hush may be stopping it already: a cut still names its utterance
            playing.cut_by = cut_by
        playing.stop.set()
        if not await self._within(playing.done, STOP_WAIT_S):
            log.warning("the device at %s did not stop; cut off", lane.endpoint)
            playing.scope.cancel()
            await playing.done.wait()

    async def _within(self, event: anyio.Event, seconds: float) -> bool:
        """Wait for `event`, at most `seconds` on the front's clock."""
        async with anyio.create_task_group() as tg:
            async def timeout() -> None:
                await self._sleep(seconds)
                tg.cancel_scope.cancel()
            tg.start_soon(timeout)
            await event.wait()
            tg.cancel_scope.cancel()
        return event.is_set()

    async def _play(self, lane: _Lane, p: _Piece | _Clip, player: Player) -> None:
        playing = lane.playing = _Playing(p)
        if isinstance(p, _Piece):
            lane.last_piece = p
        audio = p.audio if isinstance(p, _Piece) else p.clip.audio

        def on_start(at: float) -> None:
            if playing.started is None and not playing.over:
                playing.started = at
                self.play_log.start(playing, at, p.text)
                self._speaking_started(lane)
                if isinstance(p, _Piece):
                    p.latency_ms = self._latency(p, at)

        back: Playback | None = None
        try:
            with anyio.CancelScope() as playing.scope:
                self._look_ahead(lane)          # inside the try: `lane.playing` is never left set with no scope
                back = await player.play(audio, playing.stop, on_start)
        except DeviceGone:
            log.info("the device at %s left during piece %s", p.endpoint, p.say_id)
        except Exception:
            log.exception("the player at %s failed on piece %s", p.endpoint, p.say_id)
        finally:
            lane.playing = None
            try:
                self._played(lane, playing, back)
            except Exception:
                log.exception("could not report %s as played", p)
                if isinstance(p, _Piece):
                    self._settle(p, "dropped", reason="no_device")
            finally:
                playing.done.set()

    def _played(self, lane: _Lane, playing: _Playing, back: Playback | None) -> None:
        """Report the piece that was playing, as the device says it went. What
        was told to stop ends its reply here, before the lane takes its next
        piece, which may continue it; a clip told to stop ends the reply of
        the last piece."""
        playing.over = True
        p = playing.item
        if not isinstance(back, Playback):          # a bad answer is no answer: the play log must still close
            back = None
        started = back.started if back is not None and back.started is not None else playing.started
        ended = back.ended if back is not None else self._now()
        if playing.started is not None:
            self.play_log.end(playing, ended, started)
        elif started is not None:
            self.play_log.add(started, ended, p.text)
        if isinstance(p, _Clip):
            if playing.stop.is_set() and lane.last_piece is not None:
                self._break_chain(lane.last_piece.say_id)
            return
        if back is not None and back.completed:
            self._settle(p, "full", ended=ended)
        elif started is None and back is None and not playing.stop.is_set():
            self._settle(p, "dropped", reason="no_device")     # gone before a sound
        else:
            played_s = 0.0 if started is None else ended - started
            self._settle(p, "cut", heard=heard_chars(p.text, played_s, p.audio.duration_s), ended=ended,
                         cut_by=playing.cut_by)
        if playing.stop.is_set():
            self._break_chain(p.say_id)

    # ---- telling the steward (GA-VOICE-12) -------------------------------------

    def _speaking_started(self, lane: _Lane) -> None:
        if not lane.on:
            lane.on = True
            self._nudge(lane)
            lane.heartbeat = self._spawn(self._heartbeat, lane)

    async def _heartbeat(self, lane: _Lane) -> None:
        while True:
            await self._sleep(HEARTBEAT_S)
            lane.beat_due = True
            self._nudge(lane)

    def _nudge(self, lane: _Lane) -> None:
        """The steward should hear the lane's state: its teller wakes, and is
        started the first time."""
        lane.nudge.set()
        if lane.teller is None and not self._closed:
            lane.teller = self._spawn(self._tell, lane)

    async def _grace(self, lane: _Lane) -> None:
        """`off` once the endpoint has had nothing to play for a moment: the
        next piece of a reply starts within it. A queue still waiting on
        synthesis is still speaking."""
        await self._sleep(SPEAKING_OFF_GRACE_S)
        if lane.running or not lane.on:
            return
        lane.on = False
        lane.grace = None
        if lane.heartbeat is not None:
            lane.heartbeat.cancel()
            lane.heartbeat = None
        self._nudge(lane)

    async def _tell(self, lane: _Lane) -> None:
        """One endpoint's teller: bring the steward to the lane's latest
        state, and say `on` again at each heartbeat. States that pass while
        a call is out are not sent: only the latest. Each call is bounded,
        and one the steward does not take is tried again, backing off, so a
        lost `off` is never left for the duck limit; one stuck endpoint
        holds no other (GA-VOICE-12)."""
        failures = 0
        while True:
            await lane.nudge.wait()
            lane.nudge = anyio.Event()
            while lane.told != lane.on or (lane.on and lane.beat_due):
                on, lane.beat_due = lane.on, False
                lane.on_sent = lane.on_sent or on       # from the call's start: the steward may apply it late
                if await self._told(lane.endpoint, on):
                    lane.told = on
                    if not on:
                        lane.on_sent = False
                    failures = 0
                    continue
                lane.beat_due = lane.beat_due or on
                await self._sleep(RETRY_S[min(failures, len(RETRY_S) - 1)])
                failures += 1

    async def _told(self, endpoint: str, on: bool) -> bool:
        """One `speaking` call, within `TELL_S` on the front's clock: did the
        steward take it?"""
        took = False
        async with anyio.create_task_group() as tg:
            async def call() -> None:
                nonlocal took
                try:
                    await self._speaking(endpoint, on)
                    took = True
                except Exception as e:
                    log.warning("could not tell the steward %s is %sspeaking: %s", endpoint, "" if on else "not ", e)
                tg.cancel_scope.cancel()

            async def timeout() -> None:
                await self._sleep(TELL_S)
                log.warning("the steward did not answer `speaking` for %s in %s s", endpoint, TELL_S)
                tg.cancel_scope.cancel()
            tg.start_soon(call)
            tg.start_soon(timeout)
        return took

    async def _say_off(self) -> None:
        """Closing: every endpoint the steward may think speaking, told it
        is not, all at once."""
        async def off(endpoint: str) -> None:
            try:
                await self._speaking(endpoint, False)
            except Exception as e:
                log.warning("closing: could not tell the steward %s stopped speaking: %s", endpoint, e)
        async with anyio.create_task_group() as tg:
            # A teller's `on` still out is cancelled on this side only: if
            # the steward applies it after this `off`, its un-duck on a lost
            # connection, or the duck limit, covers it.
            for lane in self._lanes.values():
                if lane.on or lane.told or lane.on_sent:
                    lane.on = lane.told = lane.on_sent = False
                    tg.start_soon(off, lane.endpoint)

    async def _file_the_rest(self) -> None:
        """Closing: the report being filed, if the store had not taken it, and
        every one behind it, once each. Filing one twice is harmless: the
        store keeps one per say_id."""
        pending = [self._unfiled] if self._unfiled is not None else []
        self._unfiled = None
        while True:
            try:
                pending.append(self._receive.receive_nowait()[1])
            except anyio.WouldBlock:
                break
        for played in pending:
            try:
                await self._report(played)
            except Exception as e:
                log.warning("closing: piece %s left unreported: %s", played["say_id"], e)

    def _latency(self, p: _Piece, started: float) -> int | None:
        """On the first piece in reply to an utterance to start playing: from
        the end of its speech to the first audio."""
        d = self._delivered.get(p.in_reply_to) if p.in_reply_to is not None else None
        if d is None or d.latency_given or math.isinf(d.speech.end):
            return None
        d.latency_given = True
        return max(0, round((started - d.speech.end) * 1000))

    # ---- reports ------------------------------------------------------------

    def _settle(self, p: _Piece, status: str, *, reason: str | None = None, heard: int | None = None,
                ended: float | None = None, cut_by: str | None = None) -> None:
        """The piece's one `played` report, handed to the reporter now; the
        piece leaves its queue and its synthesis stops. A piece not played
        in full breaks its chain: what continues it is dropped after it. A
        report that cannot be built is logged and lost; the brain's failure
        bound covers a missing `played`."""
        if p.settled:
            return
        p.settled = True
        if reason == "synth_failed" or (reason == "earlier_cut" and p.continues in self._unheard):
            # No one will hear it, and no sound came of the reply: the silent-brain
            # clip still applies (spec, *The synthesiser fails*). A cut or a hush
            # of a piece that played is not this.
            self._unheard[p.say_id] = self._now()
            self._replies.get(p.in_reply_to, set()).discard(p.say_id)
        lane = self._lanes.get(p.endpoint)
        if lane is not None and p in lane.queue:
            lane.queue.remove(p)
        if p.synth is not None:
            p.synth.cancel()
        try:            # settling runs in handlers: a report that cannot be built or handed is lost, never the lane
            stamp, epoch = self._stamp(self._now() if ended is None else ended)
            played: dict[str, Any] = {"say_id": p.say_id, "endpoint": p.endpoint, "status": status,
                                      "clock_epoch": str(epoch)}
            if ended is not None:
                played["ended_at"] = stamp
            if reason is not None:
                played["reason"] = reason
            if heard is not None:
                played["heard_chars"] = heard
            if cut_by is not None:
                played["cut_by"] = cut_by
            if p.latency_ms is not None:
                played["latency_ms"] = p.latency_ms
            self._send.send_nowait((self._handed + 1, played))
            self._handed += 1               # counted once handed: `_all_filed` waits for none that is not
        except Exception:
            log.exception("could not report piece %s as played", p.say_id)
        if status != "full":
            self._break_chain(p.say_id)

    def _break_chain(self, say_id: str) -> None:
        """End the reply at `say_id`: every piece that continues it, queued
        now or said later, is dropped as `earlier_cut`, and so on down the
        chain (each drop breaks its own)."""
        self._broken.setdefault(say_id, self._now())
        for lane in list(self._lanes.values()):
            for q in list(lane.queue):
                if isinstance(q, _Piece) and q.continues == say_id and not q.settled:
                    self._settle(q, "dropped", reason="earlier_cut")

    async def _all_filed(self) -> None:
        """Wait until every report handed so far is filed, however long the
        store is away, or until speaking has stopped."""
        target = self._handed
        while self._filed < target and not self._closed:
            await self._filed_changed.wait()

    async def _reporter(self) -> None:
        """File each report in turn; a lost store is retried, backing off,
        and holds the reports behind it, never speech."""
        async for seq, played in self._receive:
            failures = 0
            self._unfiled = played
            while True:
                try:
                    await self._report(played)
                    break
                except StoreUnavailable as e:
                    log.warning("could not report piece %s: %s", played["say_id"], e)
                    await self._sleep(RETRY_S[min(failures, len(RETRY_S) - 1)])
                    failures += 1
                except Exception:
                    log.exception("the report of piece %s was refused", played["say_id"])
                    break
            self._unfiled = None
            self._filed = seq
            self._filed_changed.set()
            self._filed_changed = anyio.Event()

    def _prune(self, now: float) -> None:
        since = now - MARK_KEEP_S
        self._delivered = {u: d for u, d in self._delivered.items() if d.at >= since}
        self._broken = {s: at for s, at in self._broken.items() if at >= since}
        self._hushed = {u: at for u, at in self._hushed.items() if at >= since}
        self._unheard = {s: at for s, at in self._unheard.items() if at >= since}
        self._replied_at = {u: at for u, at in self._replied_at.items() if at >= since}
        self._replies = {u: s for u, s in self._replies.items() if u in self._replied_at}
