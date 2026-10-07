"""The browser link: `ws://127.0.0.1:8765/stream`.

Audio in, text out. This process holds no knowledge of devices or of what a
command means -- no vocabulary beyond the configured wake words. Whatever is
on the other end of the link turns the text this emits into actions; keeping
that vocabulary out of here is the point, not an oversight.

Protocol
--------
The client sends 16 kHz mono ``int16`` PCM frames as binary websocket
messages, any chunk size. The front accumulates them, runs Silero VAD to find
utterance boundaries, and for every VAD-closed segment: decodes it with
GigaAM-v3 CTC, decides whether it was addressed to the device, and -- only if
it was -- emits one JSON text message::

    {"text": "включи свет", "seconds": 1.84, "rtf": 0.031,
     "onset_ms_ago": 2050, "ended_ms_ago": 12}

A segment is addressed either because a configured wake word is in the
transcript, or because the client opened a bounded address window by
sending::

    {"type": "address", "ttl_ms": 6000}

The two are independent: the wake rule decides exactly what it decided
before, and a tap is additive.

Segments that were not addressed to the device (silence, background speech,
a wake word mentioned mid-sentence) produce no message at all: this is a
"push" channel, not a full transcript feed, and the consumer on the other end
should never have to filter out noise itself.

The client also announces the machine's own speech with ``speaking`` and
``speaking_end`` frames (see `voice_front.marking`). Any other text frame is
ignored.

Audio never leaves the machine this process runs on. There is no upload
path, no telemetry, no cloud call, and none may be added.
"""
from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from typing import Callable, Sequence

import numpy as np
import websockets

from voice_front.addressing import TAP, address
from voice_front.marking import Playback, is_speaking_end, parse_speaking
from voice_front.speech.vad import MIN_SILENCE_S, Endpointer
from voice_front.wake.transcript import WakeRule

PATH = "/stream"

MIN_TTL_MS = 2000
MAX_TTL_MS = 15000

log = logging.getLogger("voice-front")


@dataclass(frozen=True)
class Address:
    ttl_s: float
    clamped: bool


def parse_address(message: str) -> "Address | str | None":
    """An `address` frame, a refusal reason, or None if this is another frame.

    ⛔ `ttl_ms` is REQUIRED and is never defaulted here. The client sends it so
    that exactly one timeout exists in the system and the two sides cannot
    disagree about when the window shut; a server-side default re-creates
    precisely that disagreement, silently.

    Out-of-range values are CLAMPED and in-band errors REFUSED, following
    parse_speaking: a client sending a slightly wrong number still gets a
    correctly bounded window instead of a desynchronised one.
    """
    try:
        d = json.loads(message)
    except (ValueError, TypeError):
        return None
    if not isinstance(d, dict) or d.get("type") != "address":
        return None
    raw = d.get("ttl_ms")
    # bool is a subclass of int: `true` would otherwise arrive as 1.0 and clamp
    # to the floor, opening a window nobody asked for.
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return "ttl_ms must be a number"
    ms = float(raw)
    clamped = False
    if ms < MIN_TTL_MS:
        ms, clamped = float(MIN_TTL_MS), True
    elif ms > MAX_TTL_MS:
        ms, clamped = float(MAX_TTL_MS), True
    return Address(ttl_s=ms / 1000.0, clamped=clamped)


def pcm16_to_float32(data: bytes) -> np.ndarray:
    """int16 PCM bytes -> float32 samples in [-1, 1)."""
    usable = len(data) - (len(data) % 2)
    return np.frombuffer(data[:usable], dtype="<i2").astype(np.float32) / 32768.0


def heard_ages(onset: float, ended_at: float, now: float) -> dict[str, int]:
    """How long ago each end of this SPEECH was, in milliseconds.

    ⛔ `ended_at` is the ENDPOINTER's stamp, which is not the end of the speech:
    it fires only after MIN_SILENCE_S of silence has accumulated, so it sits
    ~600 ms past the last audible word. Sending it unadjusted makes the interval
    600 ms too long at the far end, and a consumer overlapping it against a
    speaking window then refuses any real command that ended within 600 ms
    BEFORE a clip began. That is the fail-closed direction, and it is the one
    interaction this feature makes most likely: success is silent, so every clip
    a person hears is a failure message, and the natural response is to speak
    again at once. The subtraction below is therefore load-bearing, not tidying.

    ⚠️ It is a floor, not an exact correction. On the `max_duration` path the
    12 s cap fires with no hangover elapsed, so this subtracts silence that never
    happened and the end lands early -- which NARROWS the interval, misses some
    real overlaps and invents none. Fail-open, which is the posture. A test
    fixture must use the endpointer's real stamp rather than assuming the
    constant.

    ⛔ Ages, not timestamps, so that no clock crosses a machine boundary. The
    consumer subtracts them from its own arrival stamp.

    ⛔ Both ends, always together. An interval needs two, and a consumer that
    receives one is required to ignore it rather than rebuild the other from
    MIN_SILENCE_S -- which is the constant everyone reaches for and which
    rebuilds the point test that provably cannot fire.

    ⚠️ Clamped at zero on both ends. `onset` is derived by subtraction and
    `ended_at` comes from `Endpointer.push`, so a clock that steps backwards
    mid-session -- NTP settling on a box that has just booted -- can put either
    fractionally in the future. A negative age would read downstream as an
    interval that has not happened yet.

    ⛔ Never widened here to "be safe". A wider interval overlaps speaking
    windows it never touched, which suppresses real commands -- the one
    direction this design forbids.
    """
    # Never past the onset: on a very short utterance the hangover can exceed the
    # speech, and an inverted interval is refused outright by every consumer.
    speech_ended_at = max(onset, ended_at - MIN_SILENCE_S)
    return {
        "onset_ms_ago": max(0, round((now - onset) * 1000)),
        "ended_ms_ago": max(0, round((now - speech_ended_at) * 1000)),
    }


async def handle_stream(ws, *, asr, rules: Sequence[WakeRule],
                        make_endpointer: Callable[[], Endpointer],
                        clock: Callable[[], float] = time.time) -> None:
    """Serve one browser connection until it closes.

    Every collaborator is injected: the recogniser, the wake rules, an
    endpointer factory (one endpointer per connection) and the clock.
    """
    endpointer = make_endpointer()
    log.info("client connected: %s", ws.remote_address)
    # Per connection. ⛔ Scope is an accident, not a decision: a second
    # listening device in the same room has no window open on ITS connection,
    # so it dispatches the first machine's reply as ordinary speech.
    playback = Playback(min_silence_s=MIN_SILENCE_S)
    # The address window, per connection. Scope is deliberate, not accidental
    # like Playback's: a tap in one tab must not address another tab's segment,
    # and this is exactly what makes that true.
    tap_at: float | None = None
    tap_deadline: float | None = None
    leaks = 0

    try:
        async for message in ws:
            if not isinstance(message, (bytes, bytearray)):
                if not isinstance(message, str):
                    continue
                addr = parse_address(message)
                if isinstance(addr, str):
                    # A refusal, not a crash -- and said out loud, because a
                    # client that cannot open a window is a defect somebody has
                    # to see. No window opens.
                    log.warning("refused an address frame: %s", addr)
                    continue
                if addr is not None:
                    if addr.clamped:
                        log.warning("clamped ttl_ms on the address frame to "
                                    "%.0f ms", addr.ttl_s * 1000)
                    # A tap while a window is open RESTARTS the deadline.
                    # Forgiving and idempotent; there is no error case.
                    tap_at = clock()
                    tap_deadline = tap_at + addr.ttl_s
                    log.info("address window open for %.0f ms",
                             addr.ttl_s * 1000)
                    continue
                speaking = parse_speaking(message, rules)
                if isinstance(speaking, str):
                    # A refusal, not a crash. The client keeps playing the clip
                    # -- spoken feedback must not depend on this process
                    # agreeing to mark it -- but no window opens. Said out
                    # loud, because a client that cannot open a window is a
                    # defect somebody has to see.
                    log.warning("refused a speaking frame: %s", speaking)
                    continue
                if speaking is not None:
                    if speaking.clamped:
                        log.warning("clamped %s on the speaking frame for %r",
                                    ", ".join(speaking.clamped),
                                    speaking.phrase_id)
                    _, superseded = playback.open(speaking, now=clock())
                    if superseded is not None:
                        log.warning("a new clip started while %r was still "
                                    "open: the client's speaking_end never "
                                    "arrived", superseded.phrase_id)
                    continue
                if is_speaking_end(message):
                    playback.close(now=clock())
                continue

            samples = pcm16_to_float32(bytes(message))
            if samples.size == 0:
                continue
            closed = endpointer.push(samples)
            if closed is None:
                continue
            result, segment = closed
            if segment.size == 0:
                continue
            transcript = asr.transcribe(segment)

            # ⛔ Before the overlap test, never after: a window whose
            # speaking_end never arrived would otherwise mark every remaining
            # segment of the session as playback.
            expired = playback.expire(result.at)
            if expired is not None:
                log.warning("force-closed a playback window after %d ms: the "
                            "client never sent speaking_end for %r",
                            playback.max_speaking_ms, expired.phrase_id)

            ended_at = result.at
            onset = ended_at - result.speech_seconds - MIN_SILENCE_S
            if playback.overlaps(onset, ended_at, now=ended_at):
                # "Something was heard while the machine was speaking" -- NOT
                # yet "the clip leaked": a person talking over a clip lands
                # here too. ⛔ DEBUG only: it is an observation about who was
                # speaking in the room.
                leaks += 1
                log.debug("segment heard during playback (%d this connection)",
                          leaks)

            # ⛔ The tap rule is ONSET, never `ended_at`: a tap must not capture
            # an utterance that was already in progress. ⚠️ And `onset` is an
            # estimate with TWO error sources, both in the unsafe direction and
            # additive: speech_seconds counts only VAD-speech frames, so an
            # utterance with internal pauses computes an onset LATER than the
            # truth; and `result.at` is receive time inside Endpointer.push,
            # while `tap_at` is the clock at frame arrival with no audio
            # buffering ahead of it -- so client capture latency and block
            # buffering shift audio events later relative to the tap on top of
            # the speech_seconds error. This bounds the problem; it does not
            # make "tap, then talk" literally true.
            tap_open = (tap_deadline is not None
                        and onset >= tap_at
                        and ended_at <= tap_deadline)
            decision = address(transcript.text, rules, tap_open=tap_open)

            if decision is None:
                # The transcript never goes above DEBUG: at INFO it would write
                # ordinary conversation near the machine to a service log.
                log.debug("not addressed to the device: %r", transcript.text)
                # ⛔ The window is NOT closed here. It closes on the first
                # segment it ADDRESSES; an unrelated utterance must not consume
                # somebody's tap.
                continue
            if decision.by == TAP:
                # One tap, one command. This is what keeps a tap from
                # dispatching the rest of a conversation.
                tap_at = tap_deadline = None
            # ⛔ AGES, not timestamps, and the pair this process ALREADY holds:
            # `onset` and `ended_at` a few lines up, the same interval
            # `playback.overlaps` is given for the same-device case. Sent so the
            # far side can run that test across two DEVICES, which is the one
            # place it cannot be run here -- this process knows nothing about
            # any other machine, and that boundary is kept.
            #
            # ⛔ Ages because a timestamp would put the two ends of that test on
            # two different clocks. Measured against the clock at send, so the
            # client adds only the time it itself spends.
            #
            # ⛔ And an INTERVAL, both ends, never a point. The end alone cannot
            # work: `result.at` fires only after MIN_SILENCE_S of silence, so a
            # self-heard segment's end lands ~600 ms PAST the clip that caused
            # it, deterministically -- a point test against a speaking window
            # catches zero of them while reporting success.
            #
            # ⚠️ `onset` is a LOWER bound: speech_seconds counts only VAD-speech
            # frames, so an utterance with internal pauses yields an onset later
            # than the truth. That narrows the interval, so the overlap test
            # misses some real overlaps and invents none -- fail-open, which is
            # this design's posture. ⛔ It is the OPPOSITE correction from the
            # one the tap rule wants above: anyone who widens `onset` toward the
            # true extent to make tapping safer silently turns this test
            # fail-closed. Check both call sites.
            await ws.send(json.dumps({
                "text": decision.command,
                "seconds": round(transcript.audio_seconds, 3),
                "rtf": round(transcript.rtf, 4),
                **heard_ages(onset, ended_at, clock()),
            }))
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        if playback.windows():
            log.debug("spoken replies this connection: %d, segments heard "
                      "during one: %d", len(playback.windows()), leaks)
        log.info("client disconnected: %s", ws.remote_address)
