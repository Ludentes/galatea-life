"""The `speaking` frames, end to end through handle_stream.

⛔ Marking only. Nothing withholds a segment from dispatch, and these tests
assert the opposite where it matters: a marked segment is still sent to the
client exactly as before.
"""
import asyncio
import json
import logging

import numpy as np

from voice_front.links import browser
from voice_front.speech.asr import Transcript
from voice_front.speech.vad import EndpointResult

from measured_rule import MEASURED


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


class _OneShotEndpointer:
    """One closed segment on the first AUDIO push, then quiet. at=12.0 with
    1.2 s of speech puts the honest interval at 10.2 .. 11.4."""

    def __init__(self):
        self._fired = False

    def push(self, samples):
        if self._fired:
            return None
        self._fired = True
        return EndpointResult(reason="silence", speech_seconds=1.2, at=12.0), \
            np.zeros(16000, dtype=np.float32)


class _StubAsr:
    def __init__(self, text):
        self.text = text

    def transcribe(self, samples):
        return Transcript(text=self.text, audio_seconds=2.0, decode_seconds=0.01)


SPEAKING = json.dumps({"type": "speaking", "phrase_id": "no_command",
                       "asr_expected": "не поняла повторите",
                       "loose": 0.34, "strict": 0.12}, ensure_ascii=False)
END = json.dumps({"type": "speaking_end"})
AUDIO = b"\x00\x00" * 2048


def _run(messages, *, transcript="привет ника включи свет", clock=10.5):
    # The frames deliberately carry no timestamps -- the front stamps
    # arrival -- so the clock is what a test has to pin.
    ws = _FakeWs(messages)
    asyncio.run(browser.handle_stream(
        ws, asr=_StubAsr(transcript), rules=(MEASURED,),
        make_endpointer=_OneShotEndpointer, clock=lambda: clock))
    return ws


def _debug(caplog):
    return caplog.at_level(logging.DEBUG, logger="voice-front")


HEARD_DURING = "segment heard during playback"


def test_a_segment_heard_during_a_window_is_marked_and_still_dispatched(caplog):
    """⭐ Marking only: the segment is MARKED, and it is dispatched anyway.
    Suppression does not exist."""
    with _debug(caplog):
        ws = _run([SPEAKING, AUDIO])
    assert HEARD_DURING in caplog.text
    assert json.loads(ws.sent[-1])["text"] == "включи свет"


def test_a_window_still_open_when_the_segment_ends_reaches_that_end(caplog):
    """⛔ An open window is still making sound, so it extends to the segment's
    own endpoint, not to whenever the frame arrived. The window opens at 7.5
    and is still open (not yet expired) at the endpoint, 12.0; the honest
    speech interval is 10.2 .. 11.4, which only the open end reaches."""
    with _debug(caplog):
        ws = _run([SPEAKING, AUDIO], clock=7.5)
    assert HEARD_DURING in caplog.text
    assert "force-closed" not in caplog.text
    assert json.loads(ws.sent[-1])["text"] == "включи свет"


def test_a_segment_with_no_window_anywhere_is_not_marked(caplog):
    with _debug(caplog):
        ws = _run([AUDIO])
    assert HEARD_DURING not in caplog.text
    assert json.loads(ws.sent[-1])["text"] == "включи свет"


def test_a_refused_speaking_frame_opens_no_window_and_keeps_serving(caplog):
    """⭐ A clip whose expected text would wake the machine is a loop. The
    connection survives -- the refusal is a defect to see, not a reason to
    stop serving."""
    bad = json.dumps({"type": "speaking", "phrase_id": "x",
                      "asr_expected": "привет ника", "loose": 0.3,
                      "strict": 0.1}, ensure_ascii=False)
    with _debug(caplog):
        ws = _run([bad, AUDIO])
    assert HEARD_DURING not in caplog.text
    assert json.loads(ws.sent[-1])["text"] == "включи свет"
    assert "wake material" in caplog.text


def test_a_stuck_window_is_force_closed_before_the_next_segment_is_marked(caplog):
    """⛔ The failure that looks like clean data: a window whose speaking_end
    never arrives marks every remaining segment of the session as playback.
    The window opens at 0.0; the segment's endpoint is at 12.0, more than
    MAX_SPEAKING_MS later, so the window is closed first and marks nothing."""
    with _debug(caplog):
        ws = _run([SPEAKING, AUDIO], clock=0.0)
    assert "force-closed a playback window" in caplog.text
    assert HEARD_DURING not in caplog.text
    assert json.loads(ws.sent[-1])["text"] == "включи свет"


def test_the_log_at_info_says_nothing_about_the_room(caplog):
    """⛔ Counting speech during playback is an observation about who was
    speaking in the room, so it stays at DEBUG."""
    with caplog.at_level("INFO"):
        _run([SPEAKING, AUDIO, END])
    assert "during playback" not in caplog.text
    assert "spoken replies" not in caplog.text
