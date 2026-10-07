from voice_front.text import lev, normalise


def test_normalise_lowers_and_folds_yo():
    assert normalise("Ёлка ЕЛЬ") == "елка ель"


def test_lev():
    assert lev("привет", "привет") == 0
    assert lev("привет", "превед") == 2
    assert lev("", "да") == 2
