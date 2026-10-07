"""The speech interval the output frame carries, for cross-device suppression.

⛔ The front sends this and does nothing with it. The test it feeds runs on
the far side of the link, because that is the only place that can see two
devices at once -- this process knows nothing about any other machine, and
the whole reason the interval travels rather than the decision is to keep it
that way.
"""
from voice_front.links.browser import heard_ages
from voice_front.speech.vad import MIN_SILENCE_S


def test_the_end_is_the_end_of_SPEECH_not_the_endpointer_stamp():
    """⛔ The correction this function exists for, and the one it shipped without.

    `Endpointer` stamps `result.at` only after MIN_SILENCE_S of silence, so the
    stamp sits ~600 ms past the last audible word. Sending it unadjusted makes
    the interval 600 ms too long at the far end -- and a consumer overlapping it
    against a speaking window then refuses a real command that ended within
    600 ms BEFORE a clip started.

    That is the fail-closed direction, and it is the likeliest interaction in the
    whole feature: success is silent, so every clip anybody hears is a failure
    message, and the natural response is to speak again at once.
    """
    speech_seconds = 1.5
    ended_at = 100.0                      # the endpointer's stamp
    onset = ended_at - speech_seconds - MIN_SILENCE_S
    got = heard_ages(onset, ended_at, now=ended_at)

    # The interval's length is the SPEECH, not the speech plus the hangover.
    assert got["onset_ms_ago"] - got["ended_ms_ago"] == round(speech_seconds * 1000)
    # And its far end is the hangover ago, not now.
    assert got["ended_ms_ago"] == round(MIN_SILENCE_S * 1000)


def test_both_ends_travel_together():
    got = heard_ages(onset=100.0, ended_at=102.65, now=102.65)
    assert got == {"onset_ms_ago": 2650, "ended_ms_ago": 600}


def test_the_interval_keeps_its_length_however_late_it_is_sent():
    """The ages grow together, so the utterance does not stretch while it waits."""
    early = heard_ages(onset=100.0, ended_at=102.65, now=102.65)
    late = heard_ages(onset=100.0, ended_at=102.65, now=103.0)
    assert late["onset_ms_ago"] - late["ended_ms_ago"] == early["onset_ms_ago"] - early["ended_ms_ago"]
    assert late["onset_ms_ago"] > early["onset_ms_ago"]


def test_a_backwards_clock_never_produces_an_age_in_the_future():
    """⚠️ Small boxes settle NTP after boot, so a backwards step is real. A
    negative age reads downstream as speech that has not happened yet."""
    got = heard_ages(onset=100.0, ended_at=102.05, now=99.0)
    assert got == {"onset_ms_ago": 0, "ended_ms_ago": 0}


def test_a_hangover_longer_than_the_speech_never_inverts_the_interval():
    """⚠️ Reachable on a very short utterance, where the subtraction would
    otherwise put the end before the onset. Every consumer refuses an inverted
    pair outright, so this would silently disable the mechanism rather than
    widen it."""
    ended_at = 100.0
    onset = ended_at - 0.1          # less speech than the hangover
    got = heard_ages(onset, ended_at, now=ended_at)
    assert got["ended_ms_ago"] <= got["onset_ms_ago"]
