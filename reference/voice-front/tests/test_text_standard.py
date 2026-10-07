"""The standard's text rules (standard/voice.md, *Constants*), as tables.

Each case names the change that would redden it. Every line is scripted.
"""
import pytest

from voice_front import confusables
from voice_front.text import (cardinal, contains_wake_word, edit_distance,
                              normalise, normalise_standard, readings,
                              strip_leading, word_overlap)


@pytest.mark.parametrize("n,words", [
    (0, "ноль"),
    (7, "семь"),
    (12, "двенадцать"),
    (21, "двадцать один"),
    (100, "сто"),
    (215, "двести пятнадцать"),
    (1000, "одна тысяча"),              # fails if the thousands are masculine
    (2002, "две тысячи два"),
    (5000, "пять тысяч"),
    (11000, "одиннадцать тысяч"),       # fails if 11 takes the 1 form
    (21000, "двадцать одна тысяча"),
    (1_000_000, "один миллион"),
    (3_400_000_001, "три миллиарда четыреста миллионов один"),
])
def test_cardinal(n, words):
    assert cardinal(n) == words


def test_cardinal_refuses_what_it_cannot_say():
    with pytest.raises(ValueError):
        cardinal(10**12)
    with pytest.raises(ValueError):
        cardinal(-1)


@pytest.mark.parametrize("raw,normalised", [
    ("Ёлка", "елка"),
    ("за́мок", "замок"),                    # a stress mark
    ("Гала­тея", "галатея"),                # a soft hyphen
    ("Гала​тея", "галатея"),                # a zero-width space
    ("мой", "мой"),                              # fails if NFKD takes the breve off «й»
    ("Йод", "йод"),
    ("Bот", "вот"),                              # a Latin B, folded by its upper case
    ("bот", "вот"),                              # fails if the fold runs before lower case
    ("включи 25 ламп", "включи двадцать пять ламп"),
    ("в 007", "в ноль ноль семь"),               # fails if the zeros are lost
    ("Aлиса", "алиса"),                     # a Latin A
    ("С6ер", "сбер"),                            # a numeral touching letters folds
    ("Сбер 6", "сбер шесть"),                    # one touching none is a number
    ("Галатея, да!", "галатея да"),
    ("  много   пробелов ", "много пробелов"),
    ("", ""),
])
def test_normalise_standard(raw, normalised):
    assert normalise_standard(raw) == normalised


def test_the_measured_rule_keeps_its_own_normalisation():
    """⛔ Guards `normalise` and `lev`, the measured rule's internals: they must not
    take on the standard's rules. (The begins-with entry point in `addressing.py`
    reads the standard's readings by ruling; these two stay as measured.)"""
    assert normalise("мой") == "мой"


def test_the_fold_table_is_generated_from_the_pinned_version():
    assert confusables.UNICODE_VERSION == "16.0.0"
    assert confusables.FOLD[ord("A")] == ord("А")
    assert confusables.FOLD[ord("6")] == ord("б")
    assert ord("а") not in confusables.FOLD       # a Russian letter is its own


@pytest.mark.parametrize("a,b", [
    ("OK Google", "ok google"),
    ("ТЕМА", "tema"),
    ("C6ЕР", "с6ер"),
])
def test_the_fold_ignores_case(a, b):
    assert normalise_standard(a) == normalise_standard(b)


@pytest.mark.parametrize("raw,normalised", [
    ("het", "нет"),          # Latin h, e, t fold by their upper case: wider, and meant
    ("kot", "кот"),
    ("γ", "г"),              # Greek gamma, by its upper case Γ
])
def test_lower_case_latin_folds_by_its_upper_case(raw, normalised):
    assert normalise_standard(raw) == normalised


def test_two_readings():
    assert readings("Гала-тея, приди") == ("гала тея приди", "галатея приди")
    # A mark not between letters is a space in both readings.
    assert readings("-галатея-") == ("галатея", "галатея")


@pytest.mark.parametrize("text,word,found", [
    ("Галатея, открой", "Галатея", True),
    ("Гала-тея, открой", "Галатея", True),            # the second reading
    ("А ваша Галатея умеет", "Галатея", True),        # anywhere, for the guard
    ("когда придешь", "да", False),                   # whole words only
    ("Алисаа", "Алиса", False),
    ("Aлиса, открой замок", "Алиса", True),      # a Latin A
    ("окей гугл", "Окей, Гугл", True),                # a word of two words
    ("окей и гугл", "Окей, Гугл", False),
    ("ok google, play", "OK Google", True),           # fails if the fold is case-sensitive
])
def test_contains_wake_word(text, word, found):
    assert contains_wake_word(text, word) is found


def test_strip_leading():
    words = ["Галатея", "Привет, Галатея"]
    assert strip_leading("галатея галатея включи свет", words) == "включи свет"
    assert strip_leading("привет галатея включи", words) == "включи"
    assert strip_leading("включи галатея", words) == "включи галатея"


@pytest.mark.parametrize("a,b,overlap", [
    ("включи свет", "включи свет", 1.0),
    ("включи свет", "включи свет на кухне", 0.5),
    ("да", "нет", 0.0),
    ("", "", 0.0),
])
def test_word_overlap(a, b, overlap):
    assert word_overlap(a, b) == overlap


@pytest.mark.parametrize("transcript,text,distance", [
    ("свет на кухне", "я включила свет на кухне", 0.0),
    ("свет на кухни", "я включила свет на кухне", 1 / 13),
    ("да", "когда придешь", 1.0),       # «да» is not inside «когда»
    ("", "что угодно", 1.0),
])
def test_edit_distance(transcript, text, distance):
    assert edit_distance(transcript, text) == pytest.approx(distance)
