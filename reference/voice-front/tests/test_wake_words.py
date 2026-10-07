"""Wake words from the endpoint's record, the "begins with" rule, and the tap
window on the sample clock. GA-VOICE-1, GA-VOICE-4. Every line is scripted.
"""
import pytest

from voice_front.addressing import (EARLY_S, LATE, READ, SPENT, UNDER_WAY,
                                    Phrase, TapWindow, Tuning,
                                    begins_with_wake_word, checks_for, key)
from voice_front.wake.transcript import WakeRule, leading_span

RATE = 16_000
TUNING = {"галатея": Tuning(inflections=frozenset({"галатеи", "галатее"}))}


def test_the_key_drops_marks_and_case():
    assert key("Привет, Галатея!") == "привет галатея"


def test_one_word_is_the_bare_branch():
    (check,) = checks_for(["Галатея"], TUNING)
    assert check.rule == WakeRule(word="галатея", inflections=frozenset({"галатеи", "галатее"}))


def test_two_words_are_carrier_and_word_with_no_bare_branch():
    (check,) = checks_for(["Привет, Галатея"])
    assert check.rule == WakeRule(word="галатея", carrier="привет", bare=False)


def test_three_words_are_heard_exactly():
    (check,) = checks_for(["Окей гугл старт"])
    assert check.rule == Phrase(("окей", "гугл", "старт"))


def test_a_word_with_no_letters_checks_nothing():
    assert checks_for(["!!!"]) == ()


def test_a_bare_rule_needs_a_carrier_to_be_turned_off():
    with pytest.raises(ValueError):
        WakeRule(word="галатея", bare=False)


@pytest.mark.parametrize("words,text,found", [
    (["Галатея"], "галатея включи свет", "Галатея"),
    (["Галатея"], "галатея галатея включи свет", "Галатея"),
    (["Галатея"], "включи свет галатея", None),        # hardcoded-anywhere fails here
    (["Галатея"], "а ваша галатея умеет", None),       # a mention addresses nothing
    (["Галатея"], "галатеи нет дома", None),           # an inflection is a mention
    (["Галатея"], "галатия включи свет", None),        # the bare branch is exact
    (["Галатея"], "", None),
    (["Привет, Галатея"], "привет галатея включи свет", "Привет, Галатея"),
    (["Привет, Галатея"], "привет галатия включи свет", "Привет, Галатея"),  # anchored tolerance
    (["Привет, Галатея"], "приветгалатея включи", "Привет, Галатея"),       # fused
    (["Привет, Галатея"], "галатея включи свет", None),  # the word alone was not configured
    (["Привет, Галатея"], "ну привет галатея", None),
    (["Окей гугл старт"], "окей гугл старт музыка", "Окей гугл старт"),
    (["Окей гугл старт"], "окей гугл", None),
    # The record's order decides between words that both fire.
    (["Привет, Галатея", "Галатея"], "привет галатея", "Привет, Галатея"),
])
def test_begins_with_wake_word(words, text, found):
    assert begins_with_wake_word(text, checks_for(words, TUNING)) == found


def test_leading_span_runs_over_the_repeats():
    rule = WakeRule(word="галатея")
    assert leading_span("галатея галатея включи", rule) == (0, 1)
    assert leading_span("включи галатея", rule) is None


def window(**kw):
    return TapWindow(opened_at=10 * RATE, **kw)


def at(seconds):
    """A sample position `seconds` after the tap."""
    return 10 * RATE + int(seconds * RATE)


@pytest.mark.parametrize("start_s,verdict", [
    (0.0, READ),
    (-EARLY_S / 2, READ),       # sherpa's onset falls a little early
    (-0.5, UNDER_WAY),          # began in the pre-roll: someone else's speech
    (7.9, READ),
    (8.1, LATE),
])
def test_judge(start_s, verdict):
    assert window().judge(at(start_s)) == verdict


def test_one_tap_one_utterance():
    w = window()
    assert w.judge(at(1.0)) == READ
    assert w.judge(at(3.0)) == SPENT


def test_speech_under_way_does_not_spend_the_window():
    """Fails if the tail of someone else's sentence uses up the tapper's tap."""
    w = window()
    assert w.judge(at(-0.8)) == UNDER_WAY
    assert w.judge(at(1.5)) == READ


def test_a_quiet_window_expires_after_its_length():
    w = window()
    assert not w.expired(at(7.99), speech_since=None)
    assert w.expired(at(8.0), speech_since=None)


def test_speech_begun_inside_runs_to_its_end_up_to_the_limit():
    w = window()
    assert not w.expired(at(20.0), speech_since=at(7.0))
    assert w.expired(at(37.0), speech_since=at(7.0))


def test_speech_begun_before_the_tap_does_not_hold_the_window_open():
    w = window()
    assert w.expired(at(8.0), speech_since=at(-0.9))


@pytest.mark.parametrize("words,text,found", [
    (["Галатея"], "Галатея, включи свет", "Галатея"),
    (["Окей Гугл Старт"], "Окей, гугл, старт музыка", "Окей Гугл Старт"),
    (["Галатея"], "Галатея… включи", "Галатея"),
    (["Компьютер"], "Ком-пьютер включи", "Компьютер"),   # the second reading
    (["Галатея"], "включи свет, Галатея", None),
])
def test_the_transcript_is_read_by_the_standards_normalisation(words, text, found):
    assert begins_with_wake_word(text, checks_for(words, TUNING)) == found


def test_the_key_is_the_standards_normalisation():
    from voice_front.text import normalise_standard
    assert key("Окей") == normalise_standard("Окей") == "окей"


def test_a_tuning_is_found_by_the_key():
    t = {key("Эй Компьютер"): Tuning(inflections=frozenset({"Компьютеры"}), max_trigger=1)}
    (check,) = checks_for(["Эй, Компьютер"], t)
    assert check.rule.inflections == frozenset({"компьютеры"})
    assert check.rule.max_trigger == 1


def test_a_tuning_keyed_by_the_word_as_written_is_found():
    t = {"Эй, Компьютер": Tuning(inflections=frozenset({"Компьютеры"}), max_trigger=1)}
    (check,) = checks_for(["Эй, Компьютер"], t)
    assert check.rule.inflections == frozenset({"компьютеры"})
    assert check.rule.max_trigger == 1


def test_a_segment_starting_exactly_at_the_ttl_is_late():
    """Consistent with `expired()`, which is true at exactly the ttl."""
    assert window().judge(at(8.0)) == LATE
