"""Text primitives: the wake rule's, and the standard's.

Two normalisations live here, on purpose apart:

- `normalise` and `lev` are the wake rule's. ⛔ Kept exactly as they were when
  the rule was measured: changing them would change what the measurements mean.
- `normalise_standard`, `readings` and the comparisons below them are the voice
  standard's (*Constants*, "How text is compared"), used by echo and machine
  marking, merging and the wake-word guard. The begins-with entry point in
  `addressing.py` reads the transcript through the standard's two readings, by
  ruling; `normalise` and `lev` stay the measured rule's internals, unchanged,
  and no measured case changes (golden: 0 of 209 decisions differ).
"""
from __future__ import annotations

import re
import unicodedata
from typing import Iterable

from voice_front.confusables import FOLD


def normalise(text: str) -> str:
    return text.lower().replace("ё", "е")


def lev(a: str, b: str) -> int:
    if a == b:
        return 0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


# --- The standard's rules -------------------------------------------------

_UNITS = ("ноль", "один", "два", "три", "четыре", "пять", "шесть", "семь",
          "восемь", "девять")
_TEENS = ("десять", "одиннадцать", "двенадцать", "тринадцать", "четырнадцать",
          "пятнадцать", "шестнадцать", "семнадцать", "восемнадцать",
          "девятнадцать")
_TENS = ("", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят",
         "семьдесят", "восемьдесят", "девяносто")
_HUNDREDS = ("", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот",
             "семьсот", "восемьсот", "девятьсот")
# (scale, its forms for 1 / 2-4 / 5 and up, whether its count is feminine)
_SCALES = (
    (10**9, ("миллиард", "миллиарда", "миллиардов"), False),
    (10**6, ("миллион", "миллиона", "миллионов"), False),
    (10**3, ("тысяча", "тысячи", "тысяч"), True),
)
# Twelve digits reach 999 999 999 999; a longer run is read digit by digit.
_MAX_CARDINAL_DIGITS = 12


def _triple(n: int, feminine: bool) -> list[str]:
    words = []
    hundreds, rest = divmod(n, 100)
    if hundreds:
        words.append(_HUNDREDS[hundreds])
    if 10 <= rest < 20:
        words.append(_TEENS[rest - 10])
    else:
        tens, units = divmod(rest, 10)
        if tens:
            words.append(_TENS[tens])
        if units:
            words.append(("одна", "две")[units - 1] if feminine and units in (1, 2)
                         else _UNITS[units])
    return words


def _form(n: int, forms: tuple[str, str, str]) -> str:
    if 11 <= n % 100 <= 14:
        return forms[2]
    if n % 10 == 1:
        return forms[0]
    if 2 <= n % 10 <= 4:
        return forms[1]
    return forms[2]


def cardinal(n: int) -> str:
    """A cardinal number in words, in the nominative: 21 -> «двадцать один»."""
    if not 0 <= n < 10**_MAX_CARDINAL_DIGITS:
        raise ValueError(f"cardinal() takes 0 to 10**{_MAX_CARDINAL_DIGITS} - 1, got {n}")
    if n == 0:
        return _UNITS[0]
    words: list[str] = []
    for scale, forms, feminine in _SCALES:
        count, n = divmod(n, scale)
        if count:
            words += _triple(count, feminine) + [_form(count, forms)]
    words += _triple(n, False)
    return " ".join(words)


def _number_words(run: str) -> str:
    """⚠️ A run with a leading zero («007») or longer than twelve places is read
    one numeral at a time: as one number it would lose the zeros or overflow."""
    if (len(run) > 1 and run[0] == "0") or len(run) > _MAX_CARDINAL_DIGITS:
        return " ".join(_UNITS[int(d)] for d in run)
    return cardinal(int(run))


# A run of numerals touching no letter. A letter is a word character that is
# neither a numeral nor "_".
_LONE_NUMBER = re.compile(r"(?<![^\W\d_])\d+(?![^\W\d_])")


def _prepared(text: str) -> str:
    """Every step of the normalisation before non-letters become spaces.

    Dropping combining marks folds «ё» to «е», as the standard says; the breve
    of «й» is kept, so «мой» and «мои» stay two words. The fold reads lower
    case, so it cannot depend on how a word was capitalised.
    """
    s = unicodedata.normalize("NFKD", text).replace("и\u0306", "й").replace("И\u0306", "Й")
    s = "".join(c for c in s
                if unicodedata.category(c) != "Cf"
                and not unicodedata.category(c).startswith("M"))
    s = unicodedata.normalize("NFKC", s)
    s = _LONE_NUMBER.sub(lambda m: f" {_number_words(m.group())} ", s)
    return "".join(map(_folded, s.lower())).replace("ё", "е")


def _folded(c: str) -> str:
    """A lower-case character's Russian look-alike, by its upper case first
    («b» as «B», «в»), then by itself; in lower case."""
    up = c.upper()
    letter = FOLD.get(ord(up)) if len(up) == 1 else None
    if letter is None:
        letter = FOLD.get(ord(c))
    return c if letter is None else chr(letter).lower()


def _is_kept(c: str) -> bool:
    return c.isalpha() or c.isspace()


def _joined(s: str) -> str:
    """Delete each run of non-letters that stands between two letters; any
    other run becomes a space."""
    out: list[str] = []
    i, n = 0, len(s)
    while i < n:
        if _is_kept(s[i]):
            out.append(s[i])
            i += 1
            continue
        j = i
        while j < n and not _is_kept(s[j]):
            j += 1
        if not (i > 0 and s[i - 1].isalpha() and j < n and s[j].isalpha()):
            out.append(" ")
        i = j
    return "".join(out)


def _spaced(s: str) -> str:
    return " ".join("".join(c if _is_kept(c) else " " for c in s).split())


def readings(text: str) -> tuple[str, str]:
    """The two readings a wake-word check makes: non-letters as spaces, and
    non-letters between letters deleted («Ком-пьютер» -> «ком пьютер», «компьютер»)."""
    s = _prepared(text)
    return _spaced(s), _spaced(_joined(s))


def normalise_standard(text: str) -> str:
    """The standard's normalisation: the first reading."""
    return readings(text)[0]


def _has_run(words: list[str], run: list[str]) -> bool:
    k = len(run)
    return k > 0 and any(words[i:i + k] == run for i in range(len(words) - k + 1))


def contains_wake_word(text: str, word: str) -> bool:
    """Does `text` contain `word` as whole words, in either reading?

    The floor of GA-VOICE-20: nothing is removed from `text` first, and «да» is
    never found inside «когда».
    """
    run = normalise_standard(word).split()
    return any(_has_run(reading.split(), run) for reading in readings(text))


def first_wake_word(text: str, words: Iterable[str]) -> str | None:
    """The first of `words` that `text` contains (`contains_wake_word`), or
    None: what the front's guard refuses to play (GA-VOICE-20)."""
    return next((w for w in words if contains_wake_word(text, w)), None)


def strip_leading(normalised: str, words: Iterable[str]) -> str:
    """A normalised transcript without the wake words it begins with, for
    merging and echo marking. Repeats: «компьютер компьютер включи» -> «включи»."""
    tokens = normalised.split()
    runs = [r for r in (normalise_standard(w).split() for w in words) if r]
    stripped = True
    while stripped:
        stripped = False
        for run in runs:
            if tokens[:len(run)] == run:
                tokens = tokens[len(run):]
                stripped = True
    return " ".join(tokens)


def word_overlap(a: str, b: str) -> float:
    """The Jaccard overlap of the distinct words of two normalised texts; 0.0
    when both are empty."""
    wa, wb = set(a.split()), set(b.split())
    union = wa | wb
    return len(wa & wb) / len(union) if union else 0.0


def edit_distance(transcript: str, text: str) -> float:
    """The Levenshtein distance, in characters, from a normalised transcript to
    the run of whole words of a normalised text closest to it, over the
    transcript's length. An empty transcript is 1.0: it matches nothing.

    A run longer than the transcript by more than the best distance so far
    cannot beat it, so each start stops growing there.
    """
    if not transcript:
        return 1.0
    words = text.split()
    best = len(transcript)          # the distance to an empty run
    for i in range(len(words)):
        for j in range(i + 1, len(words) + 1):
            run = " ".join(words[i:j])
            if len(run) - len(transcript) > best:
                break
            best = min(best, lev(transcript, run))
    return best / len(transcript)
