"""The parameterised rule agrees with the measured cases, case for case."""
import json
import os
from pathlib import Path

import pytest

from voice_front.wake.transcript import WakeRule, strip_trigger

# The measured cases hold real overheard speech: they are local data, kept
# outside git. Point VOICE_FRONT_WAKE_CASES at your own copy.
CASES_PATH = Path(os.environ.get("VOICE_FRONT_WAKE_CASES")
                  or Path(__file__).parent / "cases" / "local" / "wake_cases_measured.json")
if not CASES_PATH.is_file():
    pytest.skip("measured cases are local data; see README", allow_module_level=True)

CASES = json.loads(CASES_PATH.read_text(encoding="utf-8"))
RULE = WakeRule(word=CASES["word"], carrier=CASES["carrier"],
                inflections=frozenset(CASES["inflections"]))


@pytest.mark.parametrize("case", CASES["cases"], ids=lambda c: c["text"])
def test_case(case):
    got = strip_trigger(case["text"], RULE)
    assert (got is not None) == case["fires"]
    assert got == case["command"]


def test_the_committed_rule_is_the_rule_the_cases_were_measured_with():
    """The other test modules use `measured_rule.MEASURED`, written out by
    hand; it must not drift from the carrier and tolerances of the local
    cases. Its word is the public stand-in, so the word is not compared."""
    from measured_rule import MEASURED

    def shape(r):
        return (r.carrier, r.max_carrier, r.max_trigger, r.max_join, r.bare)
    assert shape(MEASURED) == shape(RULE)


def test_the_cases_are_not_trivially_few():
    assert len(CASES["cases"]) >= 50


def test_the_table_still_has_both_kinds_of_case():
    """A table that had quietly gone all-negative would pass every case in
    `test_case` above while testing nothing at all: `strip_trigger` returning
    `None` for everything is indistinguishable from a rule that has stopped
    firing. This bounds the count away from both ends."""
    fires = sum(1 for c in CASES["cases"] if c["fires"])
    assert 20 <= fires <= len(CASES["cases"]) - 20, fires


def test_the_command_column_is_populated():
    """A table whose commands were all null -- or all empty -- would pass
    every case in `test_case` above while asserting nothing about command
    extraction, only about whether the rule fires."""
    firing = [c for c in CASES["cases"] if c["fires"]]
    assert len(firing) >= 20
    assert all(c["command"] is not None for c in firing)
    assert sum(1 for c in firing if c["command"]) >= 20
