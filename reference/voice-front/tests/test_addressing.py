"""The one place that answers 'was this addressed to us'.

⛔ These tests must never assert anything about WHICH utterances the wake rule
accepts. That is `test_wake_transcript.py`'s job and `test_wake_golden.py`'s
guard. What is asserted here is only how the two producers compose.
"""
from voice_front.addressing import TAP, WAKE, Addressed, address
from voice_front.wake.transcript import WakeRule

from measured_rule import MEASURED


def test_a_wake_fire_with_no_window_is_addressed_by_wake():
    got = address("привет ника включи свет", (MEASURED,), tap_open=False)
    assert got == Addressed(command="включи свет", by=WAKE, wake_fired=True, word="ника")


def test_no_wake_and_no_window_is_not_addressed_at_all():
    assert address("надо бы включить свет на кухне", (MEASURED,),
                   tap_open=False) is None


def test_a_tap_addresses_a_transcript_the_wake_rule_would_have_dropped():
    got = address("включи свет на кухне", (MEASURED,), tap_open=True)
    assert got == Addressed(command="включи свет на кухне", by=TAP,
                            wake_fired=False, word=None)


def test_a_tap_wins_over_the_wake_rule_but_records_that_the_rule_also_fired():
    """⭐ The measurement prize. `by` says what authorised dispatch; `wake_fired`
    says, independently, whether the wake rule would have caught this utterance.
    Folding the second into the first loses the only perfectly labelled
    wake-recall set the programme will ever get."""
    got = address("привет ника включи свет", (MEASURED,), tap_open=True)
    assert got == Addressed(command="включи свет", by=TAP, wake_fired=True, word="ника")


def test_habitual_wake_material_inside_a_window_is_stripped_not_dispatched():
    """Someone who taps and still says the phrase out of habit must not have
    «привет ника» handed to the resolver as command words."""
    got = address("привет ника пауза музыка", (MEASURED,), tap_open=True)
    assert got.command == "пауза музыка"


def test_a_wake_fire_with_nothing_after_it_is_addressed_with_an_empty_command():
    """⛔ '' is an addressed wake fire, not a miss. The consumer's empty-command
    reply is the one that teaches the carrier."""
    got = address("привет ника", (MEASURED,), tap_open=False)
    assert got is not None and got.command == "" and got.by == WAKE and got.word == "ника"


def test_a_tap_with_nothing_said_is_addressed_with_an_empty_command():
    got = address("   ", (MEASURED,), tap_open=True)
    assert got == Addressed(command="", by=TAP, wake_fired=False, word=None)


def test_the_tap_command_is_normalised_the_same_way_the_wake_command_is():
    """Both paths hand the resolver the same shape of string: lower case, ё
    folded, whitespace collapsed. A tap path that skipped this would send the
    resolver text the wake path never produces."""
    assert address("Включи  Свет на Кухне", (MEASURED,),
                   tap_open=True).command == "включи свет на кухне"
    assert address("Ёлка", (MEASURED,), tap_open=True).command == "елка"


def test_a_trailing_vocative_inside_a_window_keeps_its_command():
    """⛔ «включи свет, Ника» is ordinary Russian, and a button labelled
    «Сказать команду» makes a trailing address MORE likely, not less. The wake
    rule extracts after the LAST trigger token anywhere in the transcript, so
    taking its answer here would hand the resolver "" — a recognised command
    thrown away, and the tap spent on it. Inside a window the strip is only
    applied when the wake material LEADS the utterance."""
    got = address("включи свет ника", (MEASURED,), tap_open=True)
    assert got == Addressed(command="включи свет ника", by=TAP, wake_fired=True, word="ника")


def test_a_mid_sentence_mention_inside_a_window_does_not_truncate_the_command():
    """An authored name containing «ника» lands mid-sentence. Stripping after
    it would leave the resolver the tail alone."""
    got = address("выключи свет в ника комнате", (MEASURED,), tap_open=True)
    assert got.command == "выключи свет в ника комнате"
    assert got.wake_fired is True


def test_the_wake_path_is_untouched_by_the_leading_match_rule():
    """⛔ The window rule must not reach the wake path. Without a tap, a trailing
    trigger is still an addressed utterance with an empty command — that is the
    shipped rule and the golden cases guard it."""
    got = address("включи свет ника", (MEASURED,), tap_open=False)
    assert got == Addressed(command="", by=WAKE, wake_fired=True, word="ника")


def test_a_restart_inside_a_window_is_still_stripped():
    """⛔ «ника ника выключи свет» is the restart branch A exists to handle.
    The leading run of wake material is wake material however long it is, so it
    must not reach the resolver just because it repeats."""
    got = address("ника ника выключи свет", (MEASURED,), tap_open=True)
    assert got == Addressed(command="выключи свет", by=TAP, wake_fired=True, word="ника")


def test_two_words_the_first_that_fires_is_reported():
    rules = (WakeRule(word="галатея"), WakeRule(word="дом"))
    got = address("дом включи свет", rules, tap_open=False)
    assert got == Addressed(command="включи свет", by=WAKE, wake_fired=True, word="дом")


def test_no_rules_means_only_a_tap_addresses():
    assert address("галатея включи свет", (), tap_open=False) is None
    assert address("включи свет", (), tap_open=True) == Addressed(
        command="включи свет", by=TAP, wake_fired=False, word=None)
