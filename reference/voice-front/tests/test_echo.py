"""Echo and machine marking, as tables. GA-VOICE-8, GA-VOICE-9.

Every line is scripted. Times are on the front's clock, in seconds.
"""
import pytest

from voice_front.echo import (INTERVAL_SLACK_S, Heard, Interval, Spoken,
                              is_echo, is_machine, release_at)

REPLY = Spoken(Interval(10.0, 14.0), "Свет на кухне включён, что-нибудь ещё?")


def heard(text, start=11.0, end=12.5, endpoint="ep-kitchen", **kw):
    return Heard(endpoint, Interval(start, end), text,
                 wake_words=("Галатея",), **kw)


@pytest.mark.parametrize("a,b,overlap", [
    (Interval(0, 1), Interval(1.2, 2), True),      # within twice the slack
    (Interval(0, 1), Interval(1.6, 2), False),
    (Interval(5, 6), Interval(0, 4.6), True),
    (Interval(5), Interval(100, 101), True),       # a playback still going
])
def test_overlap_widens_each_by_the_slack(a, b, overlap):
    assert INTERVAL_SLACK_S == 0.25
    assert a.overlaps(b) is overlap


def test_the_reply_heard_back_is_an_echo():
    assert is_echo(heard("свет на кухне включен"), [REPLY])


def test_overlap_alone_is_no_echo():
    """overlap-is-echo: fails if overlap without matching words marks it."""
    assert not is_echo(heard("выключи музыку в спальне"), [REPLY])


def test_matching_words_without_overlap_are_no_echo():
    assert not is_echo(heard("свет на кухне включен", start=20.0, end=21.5), [REPLY])


@pytest.mark.parametrize("text", ["нет", "стоп", "да ещё"])
def test_a_short_word_is_a_person(text):
    """A person's short word must never be lost, even inside a reply."""
    assert not is_echo(heard(text), [Spoken(Interval(10, 14), f"{text} {text} {text}")])


def test_a_short_utterance_that_begins_with_the_wake_word_can_be_an_echo():
    reply = Spoken(Interval(10, 14), "Галатея, да")
    assert is_echo(heard("галатея да", begins_with_wake=True), [reply])


def test_the_wake_word_is_stripped_before_matching():
    assert is_echo(heard("галатея свет на кухне включен", begins_with_wake=True), [REPLY])


def test_a_garbled_copy_of_an_echo_elsewhere_is_an_echo_whatever_its_length():
    marked = heard("свет на кухне", endpoint="ep-hall")
    copy = heard("свет кухне", endpoint="ep-kitchen")
    # «свет кухне» shares 2 of the 3 distinct words: 0.67, and is two words long
    assert is_echo(copy, [], echoes=[marked])


def test_an_echo_at_the_same_endpoint_is_not_a_copy():
    marked = heard("свет на кухне")
    assert not is_echo(heard("свет кухне"), [], echoes=[marked])


def test_a_source_the_steward_listed_marks_machine_speech():
    tv = Spoken(Interval(9.5), "В эфире новости: на кухне включен новый свет")
    assert is_machine(heard("на кухне включен новый свет"), [tv])
    assert not is_machine(heard("включи свет в спальне"), [tv])
    assert not is_machine(heard("да"), [Spoken(Interval(9.5), "да да да")])


@pytest.mark.parametrize("text,begins,audio,release", [
    ("включи свет на кухне", False, True, 12.0),   # three words or more
    ("галатея да", True, True, 12.0),               # begins with the wake word
    ("да", False, True, None),                      # waits for nothing
    ("включи свет на кухне", False, False, None),   # typed text is no audio
])
def test_release_at(text, begins, audio, release):
    h = heard(text, start=11.0, begins_with_wake=begins)
    assert release_at(h, audio=audio) == release


def test_a_wake_prefixed_short_answer_over_a_question_is_marked_echo():
    """The standard as written: a short utterance that begins with the wake
    word is matched like any other, and its words all occur in the house's own
    question. A person's «Галатея, да» said over such a question is lost; it
    fails safe. Raised for the next voice revision, not fixed here."""
    question = Spoken(Interval(10, 14), "Выключить свет везде? Скажите да или нет.")
    assert is_echo(heard("галатея да", begins_with_wake=True), [question])
