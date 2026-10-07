"""Window bookkeeping for the machine's own voice.

⛔ Plan 1a is MARKING ONLY. There is deliberately no test here asserting that a
segment was suppressed, excised or withheld from dispatch, because none of that
exists: the live gate is plan 1b and is deferred behind the number this module
produces. A test asserting suppression would pass against a mechanism nobody
built.
"""
import json

import pytest

from voice_front.marking import (GUARD_BAND_MS, MAX_LOOSE, MAX_STRICT,
                                 Playback, is_speaking_end, parse_speaking)
from voice_front.wake.transcript import WakeRule

from measured_rule import MEASURED


def frame(**over):
    d = {"type": "speaking", "phrase_id": "no_command",
         "asr_expected": "не поняла повторите", "loose": 0.34, "strict": 0.12}
    d.update(over)
    return json.dumps(d, ensure_ascii=False)


def speaking(**over):
    got = parse_speaking(frame(**over), (MEASURED,))
    assert not isinstance(got, str), got
    assert got is not None
    return got


# ---------------------------------------------------------------- the frame

def test_another_frame_type_is_not_a_speaking_frame():
    assert parse_speaking('{"type": "hello", "sample_rate": 48000}', (MEASURED,)) is None
    assert parse_speaking("not json at all", (MEASURED,)) is None


def test_a_thresholds_out_of_range_frame_is_clamped_not_trusted():
    """⛔ /stream has no origin check. One stale tab sending loose: 1.0 would --
    once plan 1b exists -- mutate every command near a window."""
    got = speaking(loose=1.0, strict=0.9)
    assert got.loose == MAX_LOOSE and got.strict == MAX_STRICT
    assert "loose" in got.clamped and "strict" in got.clamped


def test_a_strict_looser_than_loose_is_pinned_to_loose():
    """strict is the NEAR-EXACT tier; a frame claiming otherwise is incoherent
    rather than merely out of range."""
    got = speaking(loose=0.10, strict=0.30)
    assert got.strict == got.loose == 0.10


def test_a_boolean_threshold_is_refused_not_read_as_one():
    """bool is a subclass of int in Python: an unguarded check reads true as
    1.0 -- which then clamps to the maximum instead of being refused."""
    assert isinstance(parse_speaking(frame(loose=True), (MEASURED,)), str)


def test_an_overlong_expected_text_is_refused():
    assert isinstance(parse_speaking(frame(asr_expected="а" * 200), (MEASURED,)), str)
    assert isinstance(parse_speaking(frame(asr_expected="сло " * 20), (MEASURED,)), str)
    assert isinstance(parse_speaking(frame(asr_expected="   "), (MEASURED,)), str)


def test_a_frame_whose_text_would_wake_the_machine_is_refused():
    """⭐ The self-trigger guard, enforced at RUNTIME rather than only at build
    time: a clip the machine could hear as its own wake word is a loop, whatever
    the phrase table said when the tests last ran."""
    got = parse_speaking(frame(asr_expected="привет ника"), (MEASURED,))
    assert isinstance(got, str) and "wake material" in got


def test_the_guard_can_fail():
    """⛔ The test above passes for free if match never matches anything. This
    is the mutation check on it."""
    assert parse_speaking(frame(asr_expected="не поняла повторите"), (MEASURED,)) is not None


def test_a_clip_is_refused_if_any_configured_word_would_fire_on_it():
    rules = (WakeRule(word="дом"), WakeRule(word="галатея"))
    frame_ = json.dumps({"type": "speaking", "phrase_id": "x",
                        "asr_expected": "галатея не поняла",
                        "loose": 0.3, "strict": 0.1}, ensure_ascii=False)
    assert isinstance(parse_speaking(frame_, rules), str)


def test_speaking_end_is_recognised_and_nothing_else_is():
    assert is_speaking_end('{"type": "speaking_end"}')
    assert not is_speaking_end('{"type": "speaking"}')
    assert not is_speaking_end("garbage")


# --------------------------------------------------------------- the window

def test_a_window_opens_and_closes_and_keeps_the_raw_stamps():
    """⭐ Raw arrival stamps with the band NOT folded in, and every quantity
    that enters the computation beside them -- or the overlap cannot be
    recomputed with a different band."""
    p = Playback(min_silence_s=0.6)
    w, superseded = p.open(speaking(), now=100.0)
    assert superseded is None
    p.close(now=101.7)
    assert w.opened == 100.0 and w.closed == 101.7
    assert w.forced is False
    assert w.guard_band_ms == GUARD_BAND_MS and w.min_silence_ms == 600
    assert w.asr_expected == "не поняла повторите"


def test_a_second_clip_force_closes_the_first():
    """The app promises never to overlap playback, so this means its `finally`
    did not run. ⛔ A window with no close is indistinguishable in the archive
    from one that ate the rest of the session."""
    p = Playback(min_silence_s=0.6)
    first, _ = p.open(speaking(), now=100.0)
    _, superseded = p.open(speaking(phrase_id="clarify"), now=101.0)
    assert superseded is first and first.forced and first.closed == 101.0


def test_a_stuck_window_is_force_closed_and_says_so():
    """⛔ A window that opens and never closes marks every later segment as
    playback and silently deletes the rest of the session from the corpus -- a
    failure that looks like clean data."""
    p = Playback(min_silence_s=0.6, max_speaking_ms=5000)
    p.open(speaking(), now=100.0)
    assert p.expire(now=104.0) is None
    stuck = p.expire(now=106.0)
    assert stuck is not None and stuck.forced
    # ⛔ Closed where it became invalid, not where the expiry was noticed.
    assert stuck.closed == 105.0
    assert p.open_window is None


def test_expiry_stops_the_window_at_the_force_close_not_later():
    p = Playback(min_silence_s=0.6, max_speaking_ms=5000)
    p.open(speaking(), now=100.0)
    p.expire(now=106.0)
    # ⛔ The expiry was noticed at 106 and the window ends at 105 all the same.
    # Speech from 106.2 is past the stale window's shifted trailing edge
    # (105 + 0.6 + 0.3), so it is not swept up by a window that had already
    # gone invalid; closing at `now` instead would have marked it.
    assert not p.overlaps(106.2, 107.2, now=107.2)
    assert not p.overlaps(119.0, 120.0, now=120.0)


def test_closing_with_no_window_open_is_not_an_error():
    assert Playback().close(now=1.0) is None
    assert Playback().expire(now=1.0) is None


# ------------------------------------------------------------- the predicate

def test_a_segment_inside_the_window_is_marked():
    p = Playback(min_silence_s=0.6, capture_delay_ms=600)
    p.open(speaking(), now=100.0)
    p.close(now=102.0)
    # Speech from 101.0; endpoint at 102.6, so honest speech ends at 102.0.
    assert p.overlaps(101.0, 102.6, now=103.0)


def test_the_honest_interval_is_what_is_tested_not_the_row():
    """⛔ A segment's `end` carries MIN_SILENCE_S of hangover. Feeding the raw
    row to this predicate is what made v0.2's gate unable to fire on the
    machine's own voice: the machine's own segment ran past its own window.

    Here the clip is a hair over the guard band away from the raw end, and
    inside it once the hangover comes off.
    """
    p = Playback(min_silence_s=0.6, capture_delay_ms=0, guard_band_ms=0)
    p.open(speaking(), now=100.0)
    p.close(now=101.0)
    assert p.overlaps(100.2, 101.5)      # honest end 100.9, inside
    assert not p.overlaps(101.4, 102.2)  # honest span 101.4..101.6, after


def test_a_segment_nowhere_near_a_window_is_not_marked():
    p = Playback(min_silence_s=0.6)
    p.open(speaking(), now=100.0)
    p.close(now=102.0)
    assert not p.overlaps(120.0, 121.4, now=122.0)
    assert not p.overlaps(90.0, 91.4, now=92.0)


def test_a_window_that_closed_a_moment_ago_still_marks():
    """⛔ A segment's endpoint fires ~0.6 s after the speech that produced it,
    so by the time it is marked its window has usually closed. Checking only
    the open window would report a clean session forever."""
    p = Playback(min_silence_s=0.6)
    p.open(speaking(), now=100.0)
    p.close(now=101.0)
    assert p.overlaps(100.5, 102.2, now=102.2)


def test_a_still_open_window_marks_speech_happening_inside_it():
    p = Playback(min_silence_s=0.6)
    p.open(speaking(), now=100.0)
    assert p.overlaps(101.0, 102.2, now=102.2)


def test_a_missing_speech_onset_falls_back_to_the_end():
    """speech_onset is float | None. The live path always computes it; this
    keeps the predicate total rather than raising on a None it never expects."""
    p = Playback(min_silence_s=0.6)
    p.open(speaking(), now=100.0)
    p.close(now=102.0)
    assert p.overlaps(None, 102.5, now=103.0)


def test_windows_beyond_the_ring_fall_out_of_reach():
    """The ring is what keeps a long session's bookkeeping bounded. Old windows
    stop marking; they are already on disk, where plan 4 reads them."""
    p = Playback(min_silence_s=0.6)
    for i in range(40):
        p.open(speaking(), now=100.0 + i)
        p.close(now=100.5 + i)
    assert len(p.windows()) <= 16
    assert not p.overlaps(100.2, 100.9, now=140.0)


def test_a_forced_close_is_capped_however_late_it_is_noticed():
    """⛔ The cap lives in close(), not only in expire(). A connection that
    opens a window, never sends speaking_end, and then goes quiet for minutes
    before the socket drops would otherwise archive a multi-minute window for a
    two-second clip -- and every offline consumer honours a non-null `closed`
    verbatim. `expire` running before every archived segment is an ordering
    accident, not a guarantee."""
    p = Playback(min_silence_s=0.6, max_speaking_ms=5000)
    p.open(speaking(), now=100.0)
    stranded = p.close(now=400.0, forced=True)      # the socket died 5 min later
    assert stranded is not None and stranded.closed == 105.0


def test_an_ordinary_close_is_not_capped():
    """A clip longer than max_speaking_ms would be a bug elsewhere, but a
    NORMAL close reports what the app said, not what this module assumed."""
    p = Playback(min_silence_s=0.6, max_speaking_ms=5000)
    p.open(speaking(), now=100.0)
    closed = p.close(now=102.0)
    assert closed is not None and closed.closed == 102.0 and not closed.forced
