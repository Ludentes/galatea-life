"""The wake rule with the measured carrier and tolerances, for the committed tests.

The carrier «привет» and the tolerances (`WakeRule`'s defaults) are the ones
the measured cases were generated with; the cases themselves hold real speech
and stay local (see `test_wake_golden.py`). The word is «ника», the public
scenarios' wake word, with its inflections: the measured word stays with the
local data, so the tests that only need the rule use this one.
"""
from voice_front.wake.transcript import WakeRule

MEASURED = WakeRule(
    word="ника",
    carrier="привет",
    inflections=frozenset({"ники", "нике", "нику", "никой", "никою", "ник"}),
)
