"""What the machine is saying, and when it said it.

The playback client owns the speaker; this process owns no audio device at
all. So the client tells it: one `speaking` frame when a clip starts, one
`speaking_end` when the audio has finished playing. This module holds the
interval bookkeeping that follows -- when a window is open, when it should be
force closed, and whether a captured segment overlapped one.

⛔ Marking only. Nothing here suppresses a segment, excises a word, or
changes what is sent to the consumer. The reason is measured, not assumed:
through the client's own tab, Chrome's echo canceller removes the machine's
voice before it reaches the socket -- 84 clips played, 0 captured, measured
with the code this module was taken from. A live gate that would delete words
from a user's command does not exist, and is deferred until the number this
module exists to produce -- how often the machine is heard at all -- says it
is needed.

⛔ The frames carry no timestamps, deliberately. The client's send time is not
the moment sound leaves the speaker, and neither is the moment the room echo
reaches the microphone. A timestamp from the client would encode a latency
estimate as if it were a measurement. The frames mean "starting now" /
"stopped now", this module stamps arrival, and CAPTURE_DELAY_MS absorbs the
hop and the output latency.
"""
from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Sequence

from voice_front.wake.transcript import WakeRule, match

# The microphone hears the clip LATER than the client started it: output
# latency, acoustic propagation, and the capture path -- the client fills a
# 4096-frame ScriptProcessor buffer (~85 ms at 48 kHz) before a single block
# is sent.
#
# ⛔ 600, not 300. A local loopback run with no room at all measured a floor of
# ~600 ms, because min_silence_s is applied TWICE: sherpa's VAD holds
# is_speech_detected() true for 0.6 s after speech stops, and only then does
# the Endpointer count its own 0.6 s. The honest speech interval subtracts one
# of them; the other is still in there. Measured in a loopback run of the code
# this VAD and endpointer were taken from, with the same thresholds.
CAPTURE_DELAY_MS = 600
# Room reverb and block quantisation, on both edges. ⛔ Not the same allowance
# as CAPTURE_DELAY_MS -- do not count the delay twice.
GUARD_BAND_MS = 300
# ⛔ A window that opens and never closes marks every later segment as
# playback and silently drops the rest of the session from the measurement --
# a failure that looks like clean data. `speaking_end` is sent from a `finally`
# in the client, and this is what covers the case where the client dies
# before its finally runs.
MAX_SPEAKING_MS = 5000

# Bounds on the `speaking` frame. The thresholds parameterise no gate yet; they
# are validated NOW so that a frame that may one day parameterise a mechanism
# that deletes words from user commands never had an unchecked shape.
MAX_LOOSE = 0.40
MAX_STRICT = 0.20
MAX_EXPECTED_CHARS = 80
MAX_EXPECTED_TOKENS = 8
MAX_PHRASE_ID_CHARS = 40

# How many closed windows stay reachable. A segment's endpoint fires ~0.6 s
# after the speech that produced it, so by the time a segment is marked its
# window has usually closed already -- marking against the open window alone
# would find nothing and report a clean session forever.
RECENT_WINDOWS = 16


@dataclass
class Window:
    """One spoken reply, as this front saw it.

    `opened` and `closed` are RAW arrival stamps with no band folded in. Every
    quantity that enters the overlap computation is kept beside them, so the
    overlap can be recomputed with a different band.
    """
    id: str
    phrase_id: str | None
    opened: float
    closed: float | None = None
    forced: bool = False
    guard_band_ms: float = GUARD_BAND_MS
    min_silence_ms: float = 0.0
    capture_delay_ms: float = CAPTURE_DELAY_MS
    asr_expected: str = ""
    loose: float = 0.0
    strict: float = 0.0


@dataclass(frozen=True)
class Speaking:
    """A validated `speaking` frame."""
    phrase_id: str
    asr_expected: str
    loose: float
    strict: float
    clamped: tuple[str, ...] = ()


def parse_speaking(message: str, rules: Sequence[WakeRule]) -> Speaking | str | None:
    """A `speaking` frame, a refusal reason, or None if this is another frame.

    ⛔ Validated server-side, and the realistic adversary is a bug rather than
    an attacker: the stream has no origin check, so one stale tab or a
    regression sending loose: 1.0 would -- once a live gate exists -- mutate
    every command near a window. Out-of-range thresholds are CLAMPED rather than
    refused, so a client that sends a slightly wrong number still gets a
    correctly bounded window instead of a desynchronised one; shape errors are
    refused outright.

    ⭐ A frame whose expected text any configured rule would fire on is
    refused. That enforces the self-trigger guard at RUNTIME, not merely at
    build time: a clip the machine could hear as its own wake word is a loop,
    whatever the phrase table said when the tests last ran.
    """
    import json
    try:
        d = json.loads(message)
    except (ValueError, TypeError):
        return None
    if not isinstance(d, dict) or d.get("type") != "speaking":
        return None

    phrase_id = d.get("phrase_id")
    if not isinstance(phrase_id, str) or not (
            0 < len(phrase_id) <= MAX_PHRASE_ID_CHARS):
        return f"phrase_id must be a string of 1..{MAX_PHRASE_ID_CHARS} chars"

    expected = d.get("asr_expected")
    if not isinstance(expected, str) or not expected.strip():
        return "asr_expected must be a non-empty string"
    if len(expected) > MAX_EXPECTED_CHARS:
        return f"asr_expected longer than {MAX_EXPECTED_CHARS} chars"
    if len(expected.split()) > MAX_EXPECTED_TOKENS:
        return f"asr_expected has more than {MAX_EXPECTED_TOKENS} tokens"
    if match(expected, rules) is not None:
        return "asr_expected contains wake material: the machine would hear itself"

    loose, strict = d.get("loose"), d.get("strict")
    if _bad_number(loose) or _bad_number(strict):
        return "loose and strict must be numbers"

    clamped: list[str] = []
    loose, was = _clamp(float(loose), MAX_LOOSE)
    if was:
        clamped.append("loose")
    strict, was = _clamp(float(strict), MAX_STRICT)
    if was:
        clamped.append("strict")
    if strict > loose:
        # strict is the NEAR-EXACT tier. A frame claiming the opposite is
        # incoherent rather than merely out of range, so it is pinned to loose
        # instead of being trusted to mean what it says.
        strict, clamped = loose, [*clamped, "strict"]
    return Speaking(phrase_id=phrase_id, asr_expected=expected.strip(),
                    loose=loose, strict=strict, clamped=tuple(clamped))


def is_speaking_end(message: str) -> bool:
    import json
    try:
        d = json.loads(message)
    except (ValueError, TypeError):
        return False
    return isinstance(d, dict) and d.get("type") == "speaking_end"


def _bad_number(v: Any) -> bool:
    """bool is a subclass of int in Python, so `true` would arrive as 1.0."""
    return isinstance(v, bool) or not isinstance(v, (int, float))


def _clamp(v: float, top: float) -> tuple[float, bool]:
    if v < 0.0:
        return 0.0, True
    if v > top:
        return top, True
    return v, False


@dataclass
class Playback:
    """Per-connection window bookkeeping.

    ⛔ Keeping this per-connection is an accident of scope, not a decision:
    two listening devices in one room each keep their own bookkeeping, and
    neither knows the other's clip is playing. The real fix is a shared
    suppression mechanism across devices, and it does not exist yet.
    """
    min_silence_s: float = 0.0
    capture_delay_ms: float = CAPTURE_DELAY_MS
    guard_band_ms: float = GUARD_BAND_MS
    max_speaking_ms: float = MAX_SPEAKING_MS
    open_window: Window | None = None
    recent: deque[Window] = field(default_factory=lambda: deque(maxlen=RECENT_WINDOWS))
    _n: int = 0

    def open(self, speaking: Speaking, now: float | None = None) -> tuple[Window, Window | None]:
        """Open a window, closing any window still open.

        Returns (opened, superseded). The client promises never to overlap
        playback, so a superseded window means its `finally` did not run --
        it is closed as forced rather than dropped, because a window with no
        close is indistinguishable from one that ate the rest of the session.
        """
        now = time.time() if now is None else now
        superseded = self.close(now, forced=True) if self.open_window else None
        self._n += 1
        w = Window(
            id=f"p{self._n:04d}",
            phrase_id=speaking.phrase_id, opened=now,
            guard_band_ms=self.guard_band_ms,
            min_silence_ms=round(self.min_silence_s * 1000),
            capture_delay_ms=self.capture_delay_ms,
            asr_expected=speaking.asr_expected,
            loose=speaking.loose, strict=speaking.strict,
        )
        self.open_window = w
        return w, superseded

    def close(self, now: float | None = None, forced: bool = False) -> Window | None:
        """Close the open window, if there is one.

        ⛔ A FORCED close is capped at opened + max_speaking_ms, wherever it is
        called from. A connection that opens a window, never sends
        `speaking_end`, and then idles with no VAD segments -- so `expire` is
        never reached -- until the socket drops minutes later would otherwise
        leave a window claiming a multi-minute span for a two-second clip, and
        `overlaps` honours a non-null `closed` verbatim. Today `expire` runs
        before every segment is marked, so nothing can fall in that tail, but
        that is an ordering accident, not a guarantee.
        """
        now = time.time() if now is None else now
        w = self.open_window
        if w is None:
            return None
        if forced:
            now = min(now, w.opened + self.max_speaking_ms / 1000.0)
        w.closed = now
        w.forced = forced
        self.open_window = None
        self.recent.append(w)
        return w

    def expire(self, now: float | None = None) -> Window | None:
        """Force-close a window older than max_speaking_ms.

        ⛔ It closes at opened + max_speaking_ms, NOT at the moment the expiry
        was noticed. Expiry is only checked when a segment arrives, which in a
        quiet room can be minutes later; closing at `now` would hand the stuck
        window a span reaching all the way to that segment and mark it -- the
        very thing the force close exists to prevent. A stuck window must not
        go on eating real commands, and the bound is where it became invalid.
        """
        now = time.time() if now is None else now
        w = self.open_window
        if w is None or (now - w.opened) * 1000 <= self.max_speaking_ms:
            return None
        return self.close(now, forced=True)

    def overlaps(self, speech_onset: float | None, end: float,
                 now: float | None = None) -> bool:
        """Did the honest speech interval touch any window?

        ⛔ Both edges are the HONEST interval, never the raw endpoint time. A
        segment's `end` is the endpoint time and MIN_SILENCE_S of silence had
        to elapse before it could fire, so `end` sits ~600 ms past the last
        speech. Fed the raw endpoint, this predicate was measured unable to
        fire on the machine's own voice.

        ⚠️ speech_onset is a LOWER bound, not an onset: it is computed as end
        minus total accumulated speech minus the hangover, so an intra-segment
        pause pushes it earlier than the true onset. It is used as-is; the
        error is in the generous direction for marking, which is the
        direction marking should err in.
        """
        now = time.time() if now is None else now
        start = end if speech_onset is None else speech_onset
        stop = end - self.min_silence_s
        if stop < start:
            stop = start
        shift = self.capture_delay_ms / 1000.0
        band = self.guard_band_ms / 1000.0
        for w in self.windows():
            w_open = w.opened + shift - band
            # An open window is still making sound: it extends to now.
            w_close = (now if w.closed is None else w.closed) + shift + band
            if start <= w_close and stop >= w_open:
                return True
        return False

    def windows(self) -> list[Window]:
        out = list(self.recent)
        if self.open_window is not None:
            out.append(self.open_window)
        return out
