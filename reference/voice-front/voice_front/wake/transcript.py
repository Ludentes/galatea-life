"""The wake rule: whether a transcript addresses this front, and what follows.

Pure: no audio, no models, no I/O. The rule is data (`WakeRule`), not a
hard-coded word, so the front can be configured with any wake word --
though only one word's tolerances have ever been measured; see the note at
the foot of this docstring.

THE TWO-BRANCH RULE. Measured on 2.30 hours of real office speech, recorded
while the device was listening for commands (83 command attempts, 457
non-command segments), and on 35 scripted local attempts, for the word this
rule was designed around:

    branch A alone (the exact token only)                   46/83 = 55%
    both branches                                           55/83 = 66%
    both branches, when the carrier was actually said       45/45 = 100%
                                                            (95% CI 92-100%)
    false accepts, both branches            1 in 457 -- and that one is someone
                                            saying a corrupted form of the word
                                            aloud while describing the system,
                                            which no rule avoids.

THE ASYMMETRY IS THE DESIGN, and losing it breaks the rule.

Branch A is BARE and gets no tolerance, because it is matched against the
whole spoken language. The measured word is absent from the top 50 000
spoken words, which is exactly why it is safe -- and edit distance 1 from it
reaches an ordinary, common word at 171 ppm ("сошёл с ума", "ума не
приложу"). Phonetic distance 2 reaches 41 099 ppm, four percent of
everything anyone says. So branch A matches the phonetic KEY exactly:
corrupted recognitions of the word fold together; unrelated words and the
word's own inflections do not. It also refuses the word's inflected
paradigm outright -- an inflected form sitting mid-sentence is a mention,
not an address. Firing on it acts on something that was said but not said
to the device: someone talking ABOUT it, whose next words happen to read as
a command, has the light switched off under them.

Branch B is ANCHORED and can afford what branch A cannot, because the
carrier has already fixed the position: the material after it is not being
matched against the whole language, it is being matched inside a slot where
nothing else belongs. Behind that anchor, phonetic distance 2 costs zero
observed false accepts.

Branch B deliberately has NO inflection guard. Nobody greets a genitive, so
a carrier followed by an inflected form is someone addressing the front and
the recogniser inflecting what it heard. Refusing it spends recall against
an utterance nobody produces.

Branch B glues up to `max_join` following tokens. A whitespace failure is
not a recognition failure: the decoder can put the same phonemes down as
one token or as two, purely because of where it placed a space.

The phonetic fold (`phonkey`) was built from one word's recognition errors
in the field: nasals merged, velars merged, akanye folded, ё/й folded,
paired vowels reduced, soft and hard signs dropped. It is coarse
manner-and-place folding, not a G2P and not backed by a phone inventory.

A new word's tolerances are UNMEASURED until its own cases exist to measure
them against. `max_carrier`, `max_trigger` and `max_join` default to the
numbers that word was measured with; configuring a different word borrows
those defaults, not a second measurement.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Sequence

from voice_front.text import lev, normalise

# Coarse manner-and-place folding, built from the corruptions the recogniser
# actually produced for the measured word, in recorded field speech: nasals м/н merged ("...ка" -> "...Nка"), velars к/г/х
# merged, akanye о/я -> а, ё/й folded into е/и, paired vowels reduced,
# soft/hard signs dropped.
# ⚠️ Not a G2P and no phone inventory behind it.
_FOLD = str.maketrans({
    "ё": "е", "й": "и", "ъ": "", "ь": "",
    "о": "а", "я": "а", "э": "е", "ю": "у",
    "м": "N", "н": "N",
    "г": "K", "к": "K", "х": "K",
    "б": "P", "п": "P", "в": "F", "ф": "F",
    "д": "T", "т": "T", "з": "S", "с": "S",
    "ж": "Z", "ш": "Z", "щ": "Z", "ч": "C",
})


def phonkey(s: str) -> str:
    """Fold a token to its phonetic key, collapsing repeated symbols."""
    out: list[str] = []
    for ch in s.translate(_FOLD):
        if not out or out[-1] != ch:
            out.append(ch)
    return "".join(out)


def _phonkey_version() -> str:
    """A stamp that changes whenever the folding does.

    ⛔ Not a hand-maintained constant. The failure this guards against is
    somebody editing the fold table and forgetting to note it, at which
    point every distance computed with the old table is silently
    incomparable with every later one. Derived from the table, so it cannot
    be forgotten.

    ⛔ The FOLD TABLE ONLY, not this module's source. A stamp derived from
    source text is unreproducible: a copy of this rule and its origin are
    behaviourally identical but not textually identical, so a source hash
    could never be recomputed to check one against the other. The table is
    the shared artefact, and it is what changes.

    ⚠️ The limit that buys: an edit to phonkey's ALGORITHM -- the
    collapse-repeats loop above -- moves behaviour without moving this
    stamp. The golden cases (asserted in `test_wake_golden.py`) are what
    catch that; this catches the table.
    """
    material = repr(sorted(_FOLD.items()))
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:12]


PHONKEY_VERSION = _phonkey_version()


def phonetic(a: str, b: str) -> int:
    return lev(phonkey(a), phonkey(b))


@dataclass(frozen=True)
class WakeRule:
    """One wake word and how loosely it may be heard. Data, not code."""

    word: str
    carrier: str | None = None
    inflections: frozenset[str] = frozenset()
    max_carrier: int = 1   # Levenshtein, on the carrier's spelling
    max_trigger: int = 2   # phonetic-key edits, behind the carrier only
    max_join: int = 2      # tokens the anchored branch may glue together
    # Branch A: the word alone. Off for a configured word that is carrier and
    # word together («привет компьютер»): the word alone was not configured.
    bare: bool = True

    def __post_init__(self) -> None:
        word = normalise(self.word).strip()
        if not word or len(word.split()) != 1:
            raise ValueError(f"a wake word is one word, got {self.word!r}")
        if min(self.max_carrier, self.max_trigger, self.max_join) < 0:
            raise ValueError("a tolerance cannot be negative")
        if not self.bare and self.carrier is None:
            raise ValueError("a rule with no bare branch needs a carrier, or it never fires")
        object.__setattr__(self, "word", word)
        if self.carrier is not None:
            carrier = normalise(self.carrier).strip()
            # An empty carrier is within `max_carrier` of any short token, so
            # the anchored branch would anchor on almost anything.
            if not carrier:
                raise ValueError("a carrier cannot be empty; leave it out for none")
            object.__setattr__(self, "carrier", carrier)
        object.__setattr__(self, "inflections",
                           frozenset(normalise(i).strip() for i in self.inflections))


def _branch_a(words: list[str], rule: WakeRule) -> tuple[int, int] | None:
    """Span of the LAST bare trigger token, or None. Zero tolerance on the key.

    ⛔ The LAST, not the first. A restart -- the word said twice, then the
    command -- is ordinary human behaviour, and first-occurrence extraction
    hands the consumer a command with the trigger still inside it. Worse,
    segmentation on silence means one segment can hold a conversation and two
    attempts. Measured on real speech: 4 of 30 wake fires carry more than one
    trigger token, and last-occurrence is strictly better on every adjudicated
    genuine attempt.

    ⚠️ This does not change WHETHER the rule fires, only where the command
    starts. The golden cases assert both, so a change to either is visible.
    """
    if not rule.bare:
        return None
    key = phonkey(rule.word)
    found = None
    for i, w in enumerate(words):
        if w not in rule.inflections and phonkey(w) == key:
            found = (i, i)
    return found


def _branch_b(words: list[str], rule: WakeRule) -> tuple[int, int] | None:
    """Span of the tokens consumed by an anchored match, or None.

    With no carrier configured, there is no anchor to match against, so this
    branch never fires.

    Where a carrier is configured, it is always the first token consumed, in
    every shape the branch matches: as its own token, fused with the trigger,
    or fused with a trigger that then glues across the following tokens.
    """
    if rule.carrier is None:
        return None
    for i in range(len(words)):
        hit = _branch_b_at(words, i, rule)
        if hit is not None:
            return (i, hit)
    return None


def _branch_b_at(words: list[str], i: int, rule: WakeRule) -> int | None:
    """Last index consumed by an anchored match whose carrier is token `i`, or
    None. `rule.carrier` is set."""
    assert rule.carrier is not None
    tok = words[i]
    span = max(1, rule.max_carrier)
    # the carrier as its own token, the trigger in the tokens after it
    if lev(tok, rule.carrier) <= rule.max_carrier:
        hit = _trigger_from(words, i + 1, rule)
        if hit is not None:
            return hit
    # carrier and trigger fused into one token, including a split across
    # the token boundary
    for cut in range(max(1, len(rule.carrier) - span),
                     min(len(tok), len(rule.carrier) + span + 1)):
        head, tail = tok[:cut], tok[cut:]
        if not tail or lev(head, rule.carrier) > rule.max_carrier:
            continue
        if phonetic(tail, rule.word) <= rule.max_trigger:
            return i
        hit = _trigger_from(words, i + 1, rule, prefix=tail)
        if hit is not None:
            return hit
    return None


def _trigger_from(words: list[str], i: int, rule: WakeRule, prefix: str = "") -> int | None:
    """Last index consumed if the trigger starts at `i`, gluing up to max_join."""
    for n in range(1, rule.max_join + 1):
        if i + n > len(words):
            break
        if phonetic(prefix + "".join(words[i:i + n]), rule.word) <= rule.max_trigger:
            return i + n - 1
    return None


def strip_trigger(text: str, rule: WakeRule) -> str | None:
    """The command after the wake material, or None if not addressed to us.

    ⛔ Matches anywhere in the transcript, not just at the start: segmentation
    on silence means the trigger routinely lands mid-utterance. The command is
    everything after the last token the match consumed.

    ⚠️ Branch A is tried first and wins ties. When the carrier is present AND
    the trigger is clean, both branches find the same token, so the order only
    matters for a damaged trigger -- where branch B is the one that fires.
    """
    span = trigger_span(text, rule)
    if span is None:
        return None
    return " ".join(normalise(text).split()[span[1] + 1:])


def trigger_span(text: str, rule: WakeRule) -> tuple[int, int] | None:
    """Token indices (first, last) the wake match consumed, or None.

    ⛔ This reports WHERE the rule matched. It does not decide anything: whether
    the rule fires, and which branch wins a tie, are unchanged and still the
    golden cases' to guard.

    ⚠️ Added for the address window, which needs to tell a LEADING match from a
    trailing one. `strip_trigger` alone cannot: it returns the text after the
    last consumed token, so a command that ends with the wake word and a
    greeting that starts with it both come back "" -- one a command to keep,
    the other wake material to drop.
    """
    words = normalise(text).split()
    at = _branch_a(words, rule)
    if at is None:
        return _branch_b(words, rule)
    # ⚠️ Branch A matches the BARE token and wins ties, so a greeting followed
    # by the trigger comes back as the trigger alone, with the carrier sitting
    # outside the span -- and a restart, the trigger said twice, comes back as
    # the second trigger with the first outside it. Anyone asking where the
    # wake material starts means the whole run of it.
    key = phonkey(rule.word)
    first = at[0]
    while first > 0:
        prev = words[first - 1]
        bare = prev not in rule.inflections and phonkey(prev) == key
        if rule.carrier is None:
            if not bare:
                break
        elif not bare and lev(prev, rule.carrier) > rule.max_carrier:
            break
        first -= 1
    return (first, at[1])


def leading_span(text: str, rule: WakeRule) -> tuple[int, int] | None:
    """Token indices (0, last) of the wake material a transcript BEGINS with,
    or None. GA-VOICE-4: only an utterance that begins with a wake word is
    addressed by it; a mention later in a sentence addresses nothing.

    The word may be said again straight after («компьютер компьютер включи»): the
    span runs over the repeats, as `trigger_span`'s does.
    """
    words = normalise(text).split()
    if not words:
        return None
    key = phonkey(rule.word)

    def bare(w: str) -> bool:
        return w not in rule.inflections and phonkey(w) == key

    last = None
    if rule.bare and bare(words[0]):
        last = 0
    elif rule.carrier is not None:
        last = _branch_b_at(words, 0, rule)
    if last is None:
        return None
    while last + 1 < len(words) and bare(words[last + 1]):
        last += 1
    return (0, last)


def match(text: str, rules: Sequence[WakeRule]) -> tuple[WakeRule, str] | None:
    """The first rule, in the order given, that fires, with its command."""
    for rule in rules:
        command = strip_trigger(text, rule)
        if command is not None:
            return rule, command
    return None
