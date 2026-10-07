"""The trigger tests, against the parameterised rule.

`MEASURED` is the rule with the measured carrier and tolerances, from
`measured_rule.py`, the same parameters the local cases of
`test_wake_golden.py` were generated with, and the word «ника» with its
inflections standing in for the measured word. `GALATEA` and
`GALATEA_GREETED` show the rule configured with a different word, to prove it
is data, not a hard-coded constant.
"""
import pytest

from voice_front.wake.transcript import WakeRule, match, strip_trigger, trigger_span

from measured_rule import MEASURED


def test_exact_trigger_is_stripped():
    assert strip_trigger("ника включи свет", MEASURED) == "включи свет"


def test_trigger_mid_utterance_still_triggers():
    # VAD segments on silence, so the trigger often lands mid-utterance, not
    # as the first word. It must still be recognised, and the command is the
    # tail after the trigger token.
    assert strip_trigger("эй ника выключи свет", MEASURED) == "выключи свет"


def test_absent_trigger_returns_none():
    assert strip_trigger("включи свет", MEASURED) is None


def test_trigger_only_returns_empty_string():
    assert strip_trigger("ника", MEASURED) == ""


def test_inflected_niku_is_rejected():
    # "нику" (accusative inflection) is edit-distance 1 from "ника" but is
    # not the exact wake token -- must not trigger.
    assert strip_trigger("нику включи свет", MEASURED) is None


def test_inflected_nike_is_rejected():
    # "нике" (dative/prepositional inflection) -- a mention, not an address.
    assert strip_trigger("нике включи свет", MEASURED) is None


def test_nik_is_rejected():
    # "ник" ("nickname") is a common, ordinary Russian word one edit from
    # "ника" (delete "а") -- must not trigger on edit-distance proximity
    # alone.
    assert strip_trigger("ник включи свет", MEASURED) is None


def test_common_word_nikak_is_rejected():
    # "никак" ("in no way") is a common Russian word one edit from the
    # trigger (insert "к") -- must not trigger.
    assert strip_trigger("никак включи свет", MEASURED) is None


def test_niva_is_rejected():
    # "нива" ("cornfield") is edit-distance 1 from "ника" (к -> в) -- must not
    # trigger.
    assert strip_trigger("нива включи свет", MEASURED) is None


def test_distance_two_word_is_rejected():
    # "рука" ("hand") is edit-distance 2 from "ника" and a real, common word.
    assert strip_trigger("рука включи свет", MEASURED) is None


def test_empty_input_returns_none():
    assert strip_trigger("", MEASURED) is None


# --- the anchored branch ------------------------------------------------
# The golden table checks WHETHER each case fires. It cannot check what command
# comes back, and a rule that fires with the wrong command dispatches the wrong
# action -- which is worse than not firing at all.

def test_anchored_branch_returns_the_command_after_a_damaged_trigger():
    # "тника": the /т/ of "привет" reattaching to the trigger, the corruption
    # the measured word showed most often behind its carrier.
    assert strip_trigger("привет тника включи свет", MEASURED) == "включи свет"


def test_anchored_branch_consumes_BOTH_glued_tokens():
    # ⛔ The command must not begin with the second half of the trigger. If the
    # glue consumed only one token, this returns "ка включи свет" and the
    # resolver is handed a command that starts with a fragment.
    assert strip_trigger("привет эни ка включи свет", MEASURED) == "включи свет"
    assert strip_trigger("привет тни ка включи свет", MEASURED) == "включи свет"


def test_fused_carrier_and_trigger_return_the_whole_command():
    assert strip_trigger("приветника включи свет", MEASURED) == "включи свет"


def test_bare_branch_still_refuses_a_mention_and_the_carrier_does_not():
    # the asymmetry, stated as a test: same word, opposite verdicts
    assert strip_trigger("всё это работает на нике сегодня", MEASURED) is None
    assert strip_trigger("привет ники включи свет", MEASURED) == "включи свет"


def test_bare_branch_gets_no_glue():
    # gluing is affordable only where the carrier has fixed the position
    assert strip_trigger("эни ка включи свет", MEASURED) is None
    assert strip_trigger("эника включи свет", MEASURED) is None


def test_the_regression_that_removed_a_carrier():
    # "случай" is one edit from "слушай", the fused split takes "случай"+"но",
    # and "но" folds within phonetic 2 of "ника": with "слушай" as the carrier,
    # any sentence containing «случайно» fires. Nothing but this test stops a
    # future carrier bringing it back.
    assert strip_trigger("это вышло совсем случайно", MEASURED) is None


def test_trigger_anywhere_in_the_segment_not_just_first():
    # the VAD segments on silence, so the trigger routinely lands mid-utterance
    assert strip_trigger("так привет ника включи свет", MEASURED) == "включи свет"


def test_a_restart_does_not_leave_a_stray_trigger_in_the_command():
    """An ordinary human restart: the speaker began the command, forgot what
    they wanted, then said it. First-occurrence extraction would hand on
    «ника выключи свет ...» with the trigger still in it."""
    assert strip_trigger("ника ника выключи свет на кухне", MEASURED) == (
        "выключи свет на кухне")


def test_a_repeat_inside_one_segment_keeps_only_the_last_command():
    """The VAD segments on silence, so one long segment can hold two attempts
    with talk between them. First-occurrence extraction would hand on the
    broken first attempt and everything said after it."""
    got = strip_trigger(
        "ника включи свет на кух подожди нет не так "
        "ника включи свет на кухне", MEASURED)
    assert got == "включи свет на кухне"


def test_a_single_trigger_is_unchanged():
    """The common case must not move."""
    assert strip_trigger("ника включи свет", MEASURED) == "включи свет"
    assert strip_trigger("привет ника включи свет", MEASURED) == "включи свет"


def test_it_still_fires_on_exactly_the_same_utterances():
    """Only the extracted text changes; the decision does not."""
    assert strip_trigger("ника ника выключи свет", MEASURED) is not None
    assert strip_trigger("совершенно обычная русская фраза", MEASURED) is None


def test_the_known_false_accept_now_yields_no_command_at_all():
    """⭐ Stronger than "harms no false accept": it repairs one.

    The case: a corrupted form of the word («нико») said twice in one breath
    while talking ABOUT the system, with «свет» between the two. No wake rule
    avoids firing on it -- but first-occurrence extraction would hand on the
    words after the first mention, which contain «свет», so the false accept
    would also be a plausible spurious light action. Taking the LAST trigger
    leaves an empty command, which acts on nothing. The sentence below is
    invented, in the measured case's shape.
    """
    heard = ("смотри как нико сам включает свет "
             "и потом говорит нико")
    assert strip_trigger(heard, MEASURED) == ""


def test_trigger_span_reports_where_the_match_starts_and_ends():
    assert trigger_span("ника включи свет", MEASURED) == (0, 0)
    assert trigger_span("включи свет ника", MEASURED) == (2, 2)
    assert trigger_span("надо бы включить свет", MEASURED) is None


def test_trigger_span_covers_the_carrier_not_just_the_trigger():
    # Branch A matches the bare token and wins ties, so the carrier would
    # otherwise fall outside the span the caller is told about.
    assert trigger_span("привет ника включи свет", MEASURED) == (0, 1)


def test_trigger_span_covers_a_whole_leading_run_of_wake_material():
    assert trigger_span("ника ника выключи свет", MEASURED) == (0, 1)
    assert trigger_span("привет привет ника стоп", MEASURED) == (0, 2)


def test_trigger_span_agrees_with_what_strip_trigger_removed():
    # The two must not drift: strip_trigger's command is the tail after the
    # span's last token, by construction, and that is worth a guard.
    for text in ("ника включи свет", "привет ника пауза", "эй ника выключи свет",
                 "включи свет ника", "выключи свет в ника комнате"):
        span = trigger_span(text, MEASURED)
        assert span is not None
        assert strip_trigger(text, MEASURED) == " ".join(
            text.lower().split()[span[1] + 1:])


# --- the rule as data: a differently configured word ----------------------

GALATEA = WakeRule(word="галатея",
                   inflections=frozenset({"галатеи", "галатее", "галатею", "галатеей"}))
GALATEA_GREETED = WakeRule(word="галатея", carrier="привет")


@pytest.mark.parametrize("text, command", [
    ("галатея включи свет", "включи свет"),
    ("Галатея, включи свет", None),        # the comma stays on the token: normalise does not strip it
    ("галатеа включи свет", "включи свет"),  # я and а share a key
    ("скажи галатея включи", "включи"),     # anywhere, until stage 2's "begins with"
    ("галатею включи свет", None),          # an inflection is a mention
    ("гала тея включи свет", None),         # no carrier, no gluing
    ("привет гала тея включи свет", None),
])
def test_a_configured_word_without_a_carrier(text, command):
    assert strip_trigger(text, GALATEA) == command


def test_a_configured_carrier_glues_a_split_word():
    assert strip_trigger("привет гала тея включи свет", GALATEA_GREETED) == "включи свет"


def test_match_takes_the_first_rule_that_fires():
    rules = (GALATEA, WakeRule(word="дом"))
    assert match("дом включи свет", rules) == (rules[1], "включи свет")
    assert match("галатея дом включи", rules) == (GALATEA, "дом включи")
    assert match("включи свет", rules) is None


@pytest.mark.parametrize("bad", ["", "два слова", " "])
def test_a_rule_needs_one_word(bad):
    with pytest.raises(ValueError):
        WakeRule(word=bad)


@pytest.mark.parametrize("bad", ["", "  "])
def test_a_given_carrier_cannot_be_empty(bad):
    """An empty carrier is within `max_carrier` of any short token, so branch B
    would anchor on almost anything. No carrier is `None`, not ""."""
    with pytest.raises(ValueError):
        WakeRule(word="дом", carrier=bad)


def test_a_rule_refuses_a_negative_tolerance():
    with pytest.raises(ValueError):
        WakeRule(word="дом", max_trigger=-1)


def test_phonkey_version_matches_the_seed_fold_table():
    """The fold table must not have drifted from the seed's: same table,
    same stamp. Computed once from the seed and written here as a
    literal."""
    from voice_front.wake.transcript import PHONKEY_VERSION
    assert PHONKEY_VERSION == "fecc80138ff1"
