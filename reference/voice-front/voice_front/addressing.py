"""Was this utterance addressed to us, and what is the command?

Two producers of *addressed* live behind this one interface: the wake rule,
and a tap on a button in a client. Before this module existed, `strip_trigger`
was answering both questions at once -- *was this addressed?* and *what is
the command text?* -- and that conflation is why a second producer did not
fit: a tap answers the first and has nothing to say about the second.

⛔ The wake rule is NOT reimplemented here. `match` (and, through it,
`strip_trigger`) is called on BOTH paths, including inside a tap window,
where it is applied opportunistically: someone who taps and still says the
wake phrase out of habit must not have that material handed to the consumer
as command words.

⛔ `by` and `wake_fired` are separate fields and must stay separate. `by` says
what authorised dispatch; `wake_fired` says whether the wake rule ALSO
matched. A tap session is therefore a perfectly labelled set on which
per-attempt wake recall can be measured without anyone adjudicating audio by
ear -- which is a larger prize than the feature, and it is lost silently if
the two are folded together.

Pure. No clock, no socket, no timer: the address window's deadline lives on the
caller's connection state and arrives here as a bool.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Mapping, Sequence

from voice_front.text import normalise, normalise_standard, readings
from voice_front.timeline import SAMPLE_RATE
from voice_front.wake.transcript import WakeRule, leading_span, match, trigger_span

WAKE = "wake"
TAP = "tap"


@dataclass(frozen=True)
class Addressed:
    command: str      # may be "" -- addressed, but no command followed
    by: str           # WAKE | TAP
    wake_fired: bool  # did the wake rule ALSO match?
    word: str | None  # the rule's word that fired, or None


def address(text: str, rules: Sequence[WakeRule], *, tap_open: bool) -> Addressed | None:
    """The command addressed to us in this transcript, or None.

    ⛔ Three-valued at the call site too: `None` is "not addressed", and an
    `Addressed` whose command is "" is "addressed, nothing said". `if not
    result` collapses those two and reclassifies a genuine fire as a miss.
    """
    hit = match(text, rules)
    wake_fired = hit is not None
    word = hit[0].word if hit is not None else None
    if tap_open:
        # The tap authorised this, whether or not a wake rule was also said --
        # but habitual wake material still comes out of the command text.
        #
        # ⛔ Only when it LEADS. The wake rule extracts after the LAST trigger
        # token found anywhere, which is right for the wake path -- there, the
        # trigger is what addressed us, so nothing before it was meant for us.
        # Inside a window nothing needs addressing, so a trigger that is not at
        # the front is part of what was said: a trailing vocative or a mention
        # mid-sentence. Taking the strip there would hand the consumer a
        # truncated command -- a recognised command silently thrown away, and
        # the tap spent on it.
        if hit is not None:
            rule, stripped = hit
            span = trigger_span(text, rule)
            if span is not None and span[0] == 0:
                command = stripped
            else:
                command = " ".join(normalise(text).split())
        else:
            command = " ".join(normalise(text).split())
        return Addressed(command=command, by=TAP, wake_fired=wake_fired, word=word)
    if hit is None:
        return None
    _, command = hit
    return Addressed(command=command, by=WAKE, wake_fired=True, word=word)


# --- Wake words from the endpoint's record (GA-VOICE-4) --------------------
#
# `address` above is the seed's: the link calls it until the link is rebuilt,
# and then it goes. What follows is the standard's.


@dataclass(frozen=True)
class Tuning:
    """How loosely the transcript rule hears one word: the installation's, kept
    in the front's configuration and keyed by the word as the record names it.
    ⚠️ The defaults are the tolerances one word was measured with; for any
    other word they are unmeasured."""
    inflections: frozenset[str] = frozenset()
    max_carrier: int = 1
    max_trigger: int = 2
    max_join: int = 2


@dataclass(frozen=True)
class Phrase:
    """A word of three or more words, heard only exactly: the transcript rule's
    tolerances were measured on one word and a carrier, not on phrases."""
    tokens: tuple[str, ...]

    def leading(self, text: str) -> bool:
        words = normalise(text).split()
        return tuple(words[:len(self.tokens)]) == self.tokens


@dataclass(frozen=True)
class WordCheck:
    word: str                   # as the record names it
    rule: WakeRule | Phrase


def key(word: str) -> str:
    """The key a word's tuning is found by: the standard's normalisation, its
    first reading, tokens joined by single spaces («Привет, Компьютер» ->
    «привет компьютер»)."""
    return normalise_standard(word)


def checks_for(words: Sequence[str], tuning: Mapping[str, Tuning] | None = None) -> tuple[WordCheck, ...]:
    """The transcript checks for an endpoint's words, in the record's order.

    - one word («Компьютер»): the word alone, the rule's bare branch;
    - two words («Привет, Компьютер»): the first is the carrier and the second
      the word, the anchored branch only, since the word alone was not
      configured;
    - three or more: exactly, as a `Phrase`.

    A word with no letters checks nothing and is left out.
    """
    tuning = {key(k): v for k, v in (tuning or {}).items()}
    out = []
    for word in words:
        tokens = key(word).split()
        t = tuning.get(key(word), Tuning())
        if len(tokens) == 1:
            out.append(WordCheck(word, _rule(tokens[0], None, t)))
        elif len(tokens) == 2:
            out.append(WordCheck(word, _rule(tokens[1], tokens[0], t)))
        elif tokens:
            out.append(WordCheck(word, Phrase(tuple(tokens))))
    return tuple(out)


def _rule(word: str, carrier: str | None, t: Tuning) -> WakeRule:
    return WakeRule(word=word, carrier=carrier, bare=carrier is None,
                    inflections=frozenset(normalise_standard(i) for i in t.inflections), max_carrier=t.max_carrier,
                    max_trigger=t.max_trigger, max_join=t.max_join)


def begins_with_wake_word(text: str, checks: Sequence[WordCheck]) -> str | None:
    """The first word, in the record's order, the transcript begins with, as the
    record names it; or None. The transcript is read by the standard's
    normalisation, in both of its readings. A mention later in a sentence
    addresses nothing."""
    texts = readings(text)
    for check in checks:
        for t in texts:
            if isinstance(check.rule, Phrase):
                if check.rule.leading(t):
                    return check.word
            elif leading_span(t, check.rule) is not None:
                return check.word
    return None


# --- The tap window, on the sample clock (GA-VOICE-1) ---------------------

TAP_WINDOW_S = 8.0          # voice, *Constants*
UTTERANCE_LIMIT_S = 30.0    # voice, *Constants*
# How far before the tap a segment's start may fall and still be the tapper's:
# sherpa placed an onset 12 ms early on the model release's example clip
# (2026-09-28, sherpa-onnx 1.13.7, Silero v6.0). ⚠️ Chosen, not measured.
EARLY_S = 0.1

READ, UNDER_WAY, LATE, SPENT = "read", "under_way", "late", "spent"


@dataclass
class TapWindow:
    """One tap window, timed by the audio inside it, never by the wall clock,
    so a stalled link cannot lengthen it and a test can drive it.

    Positions are sample positions in the device's stream (`timeline.Stream`),
    where the tap is at `opened_at`; the pre-roll sits before it. The pre-roll
    reaches the endpointer only, so a segment that began in it has a start
    before the tap: that is speech already under way (the seed's pre-roll rule),
    and it is never transcribed.
    """
    opened_at: int
    ttl_s: float = TAP_WINDOW_S
    rate: int = SAMPLE_RATE
    _spent: bool = field(default=False, repr=False)

    def judge(self, start: int) -> str:
        """READ, UNDER_WAY, LATE or SPENT, for a segment that starts at `start`.

        Called on a complete segment's start. One tap, one utterance: the
        first segment READ spends the window, and after READ every call is
        SPENT. A segment starting exactly `ttl_s` after the tap is LATE, as
        `expired()` counts the window over at that instant.
        """
        if self._spent:
            return SPENT
        offset = (start - self.opened_at) / self.rate
        if offset < -EARLY_S:
            return UNDER_WAY
        if offset >= self.ttl_s:
            return LATE
        self._spent = True
        return READ

    def expired(self, position: int, speech_since: int | None) -> bool:
        """Is the window over at `position`? `speech_since` is where speech
        now in progress began, or None.

        Speech that began inside the window is streamed to its end, up to the
        utterance limit; otherwise the window lasts `ttl_s`.
        """
        if self._spent:
            return True
        early = self.opened_at - EARLY_S * self.rate
        if (speech_since is not None
                and early <= speech_since <= self.opened_at + self.ttl_s * self.rate):
            return position - speech_since >= UTTERANCE_LIMIT_S * self.rate
        return position - self.opened_at >= self.ttl_s * self.rate
