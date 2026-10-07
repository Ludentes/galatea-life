"""Echoes and machine speech: is an utterance the house's own words, or a known
machine's? standard/voice.md, *Echoes and machine speech*; GA-VOICE-8,
GA-VOICE-9.

Overlap alone never marks anything: a barge-in overlaps the speech it
interrupts, so «Стоп», and a «нет» said over a question, stay a person's words.
An utterance is marked only when it overlaps the speech AND its words match it.

Pure: intervals are on the front's monotonic clock (`timeline`), texts are raw
and normalised here. Who played what, and what the steward listed, are the
caller's to collect.

⛔ The seed's `marking.py` is a different thing: the browser's own playback
frames, marked for measurement. It goes when the link is rebuilt.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence

from voice_front.text import (edit_distance, normalise_standard, strip_leading,
                              word_overlap)

INTERVAL_SLACK_S = 0.25     # voice, *Constants*
MERGE_AGREEMENT = 0.6
ECHO_MATCH = 0.15
ECHO_MINIMUM = 3            # words
SOURCE_DELAY_S = 1.0


@dataclass(frozen=True)
class Interval:
    start: float
    end: float = math.inf       # still going

    def overlaps(self, other: "Interval", slack: float = INTERVAL_SLACK_S) -> bool:
        """Do the two overlap once each is widened by `slack`?"""
        return (self.start - slack <= other.end + slack
                and other.start - slack <= self.end + slack)


@dataclass(frozen=True)
class Heard:
    """One utterance at one endpoint, before it is marked."""
    endpoint: str
    interval: Interval
    transcript: str
    wake_words: tuple[str, ...] = ()    # the endpoint's, stripped for comparing
    begins_with_wake: bool = False      # from addressing, not re-derived here

    @property
    def comparable(self) -> str:
        """Normalised, the endpoint's wake words removed from the start."""
        return strip_leading(normalise_standard(self.transcript), self.wake_words)

    @property
    def too_short(self) -> bool:
        """Under the echo minimum and not begun with a wake word: «нет», «стоп»,
        «да» are too short to tell from a fragment of a reply, and a person's
        short word must never be lost. «Компьютер, да» is never too short."""
        return (len(normalise_standard(self.transcript).split()) < ECHO_MINIMUM
                and not self.begins_with_wake)


@dataclass(frozen=True)
class Spoken:
    """Speech the utterance may be: a playback the front made anywhere in the
    home, or a source the steward listed."""
    interval: Interval
    text: str


def _matches(heard: Heard, spoken: Sequence[Spoken]) -> bool:
    c = heard.comparable
    return any(heard.interval.overlaps(s.interval)
               and edit_distance(c, normalise_standard(s.text)) <= ECHO_MATCH
               for s in spoken)


def is_echo(heard: Heard, playing: Sequence[Spoken],
            echoes: Sequence[Heard] = ()) -> bool:
    """GA-VOICE-8. `playing`: every playback the front made anywhere in the
    home; `echoes`: utterances already marked echo, at any device.

    A copy of an echo at another device (overlapping, at the merge agreement)
    is an echo whatever its length, so a satellite's garbled copy of the
    house's own words never passes for a person.
    """
    c = heard.comparable
    for e in echoes:
        if (e.endpoint != heard.endpoint and heard.interval.overlaps(e.interval)
                and word_overlap(c, e.comparable) >= MERGE_AGREEMENT):
            return True
    if heard.too_short:
        return False
    return _matches(heard, playing)


def is_machine(heard: Heard, sources: Sequence[Spoken]) -> bool:
    """GA-VOICE-9. `sources`: what the steward reported by the time the
    utterance is delivered (`zone_sources`), placed on the front's clock."""
    if heard.too_short:
        return False
    return _matches(heard, sources)


def release_at(heard: Heard, *, audio: bool = True) -> float | None:
    """When an utterance may be delivered, or None if it need not wait.

    GA-VOICE-9: an utterance heard as audio that begins with a wake word or has
    at least the echo minimum of words waits until the source delay after its
    speech began, to learn of a machine's speech it may be.
    """
    if not audio:
        return None
    if heard.begins_with_wake or len(normalise_standard(heard.transcript).split()) >= ECHO_MINIMUM:
        return heard.interval.start + SOURCE_DELAY_S
    return None
