"""The `address` frame: parsing, and the tap window's semantics through handle_stream.

Collaborators are injected, not patched: a scripted endpointer, a stub
recogniser and a fixed clock.
"""
import asyncio
import json

import numpy as np

from voice_front.links import browser
from voice_front.speech.asr import Transcript
from voice_front.speech.vad import EndpointResult

from measured_rule import MEASURED


def _frame(**kw):
    return json.dumps({"type": "address", **kw})


def test_a_well_formed_frame_parses_to_seconds():
    got = browser.parse_address(_frame(ttl_ms=6000))
    assert got == browser.Address(ttl_s=6.0, clamped=False)


def test_another_frame_type_is_not_an_address_frame():
    """⛔ None, not a refusal. Every other parser on this socket returns None for
    a frame that is not its own, and the loop tries the next parser."""
    assert browser.parse_address(json.dumps({"type": "speaking"})) is None
    assert browser.parse_address("not json at all") is None
    assert browser.parse_address(json.dumps(["address"])) is None


def test_a_missing_ttl_is_refused_rather_than_defaulted():
    """⛔ The client owns the timeout so the two sides cannot disagree about when
    the window shut. Inventing one here re-creates exactly that disagreement."""
    assert isinstance(browser.parse_address(_frame()), str)


def test_a_boolean_ttl_is_refused():
    """bool is a subclass of int in Python, so `true` would arrive as 1.0 and
    clamp to the floor -- a window nobody asked for."""
    assert isinstance(browser.parse_address(_frame(ttl_ms=True)), str)
    assert isinstance(browser.parse_address(_frame(ttl_ms="6000")), str)


def test_an_out_of_range_ttl_is_clamped_not_refused():
    """Shape errors are refused; range errors are clamped. A client sending a
    slightly wrong number still gets a correctly bounded window rather than a
    desynchronised one -- the precedent parse_speaking already sets."""
    assert browser.parse_address(_frame(ttl_ms=100)) == browser.Address(
        ttl_s=browser.MIN_TTL_MS / 1000.0, clamped=True)
    assert browser.parse_address(_frame(ttl_ms=600000)) == browser.Address(
        ttl_s=browser.MAX_TTL_MS / 1000.0, clamped=True)
    assert browser.parse_address(_frame(ttl_ms=-1)) == browser.Address(
        ttl_s=browser.MIN_TTL_MS / 1000.0, clamped=True)


class _FakeWs:
    remote_address = ("127.0.0.1", 0)

    def __init__(self, messages):
        self._messages = messages
        self.sent = []

    def __aiter__(self):
        async def gen():
            for m in self._messages:
                yield m
        return gen()

    async def send(self, data):
        self.sent.append(data)


class _Endpointer:
    """Closes one segment per AUDIO push, at the `at` values given.

    MIN_SILENCE_S is 0.6 and speech_seconds is 1.2, so the onset the serving
    path computes is `at - 1.8`.
    """

    def __init__(self, ats):
        self._left = list(ats)

    def push(self, samples):
        if not self._left:
            return None
        at = self._left.pop(0)
        return EndpointResult(reason="silence", speech_seconds=1.2, at=at), \
            np.zeros(16000, dtype=np.float32)


class _StubAsr:
    def __init__(self, text):
        self.text = text

    def transcribe(self, samples):
        return Transcript(text=self.text, audio_seconds=2.0, decode_seconds=0.01)


AUDIO = b"\x00\x00" * 2048
# Carries no wake material at all: only a tap can address it.
TAP_TEXT = "включи свет на кухне"


def _run(messages, *, transcript="привет ника включи свет", ats=(12.0,), clock=10.5):
    ws = _FakeWs(messages)
    asyncio.run(browser.handle_stream(
        ws, asr=_StubAsr(transcript), rules=(MEASURED,),
        make_endpointer=lambda: _Endpointer(ats), clock=lambda: clock))
    return ws


def _texts(ws):
    return [json.loads(m).get("text") for m in ws.sent
            if "text" in json.loads(m)]


def test_a_tap_dispatches_an_utterance_the_wake_rule_would_have_dropped():
    """The whole feature in one assertion. The transcript carries no wake
    material at all, and it resolves anyway."""
    ws = _run([_frame(ttl_ms=6000), AUDIO], transcript=TAP_TEXT, ats=[12.0], clock=10.0)
    assert _texts(ws) == [TAP_TEXT]


def test_an_utterance_already_under_way_at_the_tap_is_not_addressed():
    """⛔ THE test. Onset is 10.2 and the tap is at 11.0, so this is somebody
    else mid-sentence when the button was pressed. Implementing rule 2 as 'ends
    after the tap' passes every other test in this file and dispatches a side
    conversation."""
    ws = _run([_frame(ttl_ms=6000), AUDIO], transcript=TAP_TEXT, ats=[12.0], clock=11.0)
    assert _texts(ws) == []


def test_a_segment_that_ends_after_the_deadline_is_not_addressed():
    """Tap at 9.5 with a 2 s window closes at 11.5; the segment ends at 12.0."""
    ws = _run([_frame(ttl_ms=2000), AUDIO], transcript=TAP_TEXT, ats=[12.0], clock=9.5)
    assert _texts(ws) == []


def test_the_window_closes_on_the_first_segment_it_addresses():
    """One tap, one command. Both segments sit inside the TTL and both start
    after the tap; only the first may be dispatched, or a tap dispatches the
    rest of a conversation."""
    ws = _run([_frame(ttl_ms=6000), AUDIO, AUDIO], transcript=TAP_TEXT,
              ats=[12.0, 14.0], clock=10.0)
    assert _texts(ws) == [TAP_TEXT]


def test_an_unaddressed_segment_does_not_consume_the_window():
    """⛔ The window closes on the first segment it ADDRESSES, not on the first
    segment it sees. The tap at 11.0 lands mid-way through someone else's
    sentence (onset 10.2, not addressed); the user's own command arrives at
    16.0 (onset 14.2) and must still be theirs."""
    ws = _run([_frame(ttl_ms=6000), AUDIO, AUDIO], transcript=TAP_TEXT,
              ats=[12.0, 16.0], clock=11.0)
    assert _texts(ws) == [TAP_TEXT]


def test_with_no_window_the_wake_rule_still_decides_exactly_as_before():
    """⛔ Tap is ADDITIVE. Nothing that worked without a tap may stop working."""
    ws = _run([AUDIO], ats=[12.0], clock=10.0, transcript="привет ника включи свет")
    assert _texts(ws) == ["включи свет"]


def test_a_tap_with_the_wake_phrase_said_too_dispatches_the_command():
    """Someone taps AND says the phrase out of habit: the command is what the
    wake rule strips, and it is dispatched once."""
    ws = _run([_frame(ttl_ms=6000), AUDIO], ats=[12.0], clock=10.0,
              transcript="привет ника включи свет")
    assert _texts(ws) == ["включи свет"]


def test_a_refused_address_frame_opens_no_window():
    """A malformed frame must not take the connection down, and must not
    silently behave as though a window were open."""
    ws = _run([_frame(), AUDIO], transcript=TAP_TEXT, ats=[12.0], clock=10.0)
    assert _texts(ws) == []


def test_an_unrecognised_frame_is_still_ignored():
    """The compatibility property the whole wire design rests on: an OLD client
    sends no address frame, and a NEW client's frame reaching an old front
    falls through to a bare continue. Asserted from this side: an unknown frame
    does not open a window and does not crash the connection."""
    ws = _run([json.dumps({"type": "something_new"}), AUDIO], transcript=TAP_TEXT,
              ats=[12.0], clock=10.0)
    assert _texts(ws) == []


def test_a_segment_not_addressed_sends_nothing():
    ws = _run([AUDIO], transcript="просто разговор")
    assert ws.sent == []


def test_the_output_frame_has_exactly_these_keys():
    ws = _run([AUDIO])
    frame = json.loads(ws.sent[-1])
    assert set(frame) == {"text", "seconds", "rtf", "onset_ms_ago", "ended_ms_ago"}
    assert frame["text"] == "включи свет"
