"""The fixed clips: read, declared, and refused when they name a wake word.
Voice, *Speaking*; GA-VOICE-11, GA-VOICE-20.

⛔ No audio is committed: each WAV is written into the test's tmp_path. Each
case names the change that would redden it.
"""
import wave

import pytest

from voice_front.clips import (CANNOT_ANSWER, EARCON, ClipEntry, ClipError, blocked, declared,
                               load_clips, read_wav)
from voice_front.text import first_wake_word


def wav(path, seconds=0.25, rate=16000, width=2, channels=1):
    with wave.open(str(path), "wb") as w:
        w.setsampwidth(width)
        w.setframerate(rate)
        w.setnchannels(channels)
        w.writeframes(bytes(width * channels * round(seconds * rate)))
    return path


def entries(tmp_path, **texts):
    return [ClipEntry(name, wav(tmp_path / f"{name}.wav"), text) for name, text in texts.items()]


def test_a_clip_is_its_audio_and_its_text(tmp_path):
    clips = load_clips([ClipEntry(CANNOT_ANSWER, wav(tmp_path / "c.wav", 1.5, rate=22050), "Не могу ответить")])
    c = clips[CANNOT_ANSWER]
    assert (c.name, c.text) == (CANNOT_ANSWER, "Не могу ответить")
    assert (c.audio.rate, c.audio.width, c.audio.channels) == (22050, 2, 1)
    assert c.audio.duration_s == pytest.approx(1.5)


def test_every_clip_is_declared_with_its_text(tmp_path):
    """GA-VOICE-11: fails if a clip's text, the earcon's empty one included,
    is left out of `front_status`."""
    clips = load_clips(entries(tmp_path, cannot_answer="Не могу ответить", earcon=""))
    assert declared(clips) == [{"name": "cannot_answer", "text": "Не могу ответить"},
                               {"name": "earcon", "text": ""}]


def test_cannot_answer_is_required(tmp_path):
    """Fails if a front starts with nothing to say when its brain is silent."""
    with pytest.raises(ClipError, match="'cannot_answer' is required"):
        load_clips(entries(tmp_path, earcon=""))


@pytest.mark.parametrize("name,text,why", [
    ("goodbye", "Пока", "not one of"),
    (EARCON, "Слушаю", "a sound"),
    ("not_recognised", "  ", "cannot be empty"),
])
def test_a_clip_the_standard_does_not_name_or_that_misdeclares_its_words_is_refused(tmp_path, name, text, why):
    """Fails if the front could speak words it has not declared (GA-VOICE-11)."""
    with pytest.raises(ClipError, match=why):
        load_clips([*entries(tmp_path, cannot_answer="Не могу ответить"),
                    ClipEntry(name, wav(tmp_path / "x.wav"), text)])


def test_a_name_given_twice_is_refused(tmp_path):
    e = entries(tmp_path, cannot_answer="Не могу ответить")
    with pytest.raises(ClipError, match="named twice"):
        load_clips(e + e)


def test_audio_that_is_not_16_bit_pcm_is_refused(tmp_path):
    with pytest.raises(ClipError, match="8-bit"):
        read_wav(wav(tmp_path / "c.wav", width=1))


def test_a_wav_at_zero_hertz_is_refused(tmp_path):
    """Fails if a clip with no rate is taken: its duration divides by it."""
    p = wav(tmp_path / "c.wav", rate=1)
    raw = bytearray(p.read_bytes())
    raw[24:28] = (0).to_bytes(4, "little")          # the fmt chunk's sample rate
    p.write_bytes(bytes(raw))
    with pytest.raises(ClipError, match="0 Hz"):
        read_wav(p)


def test_a_wav_of_more_than_two_channels_is_refused(tmp_path):
    with pytest.raises(ClipError, match="3 channels"):
        read_wav(wav(tmp_path / "c.wav", channels=3))


def test_a_file_that_is_not_a_wav_is_refused(tmp_path):
    (tmp_path / "c.wav").write_bytes(b"ID3 not a wave file")
    with pytest.raises(ClipError, match="not a PCM WAV"):
        read_wav(tmp_path / "c.wav")


def test_a_missing_file_is_refused_by_name(tmp_path):
    with pytest.raises(ClipError, match="no such file"):
        read_wav(tmp_path / "gone.wav")


def test_an_empty_wav_is_refused(tmp_path):
    with pytest.raises(ClipError, match="no audio"):
        read_wav(wav(tmp_path / "c.wav", seconds=0))


def test_a_clip_that_names_a_wake_word_is_blocked(tmp_path):
    """GA-VOICE-20: fails if a clip is matched by substring or by one reading
    only. «Окей, Гугл» is found through its punctuation; «компьютерный»
    is not «компьютер»."""
    clips = load_clips(entries(tmp_path, cannot_answer="Не могу ответить, окей гугл", earcon="",
                               not_recognised="Компьютерный сбой, повторите"))
    assert blocked(clips, ["Компьютер", "Окей, Гугл"]) == {"cannot_answer": "Окей, Гугл"}
    assert blocked(clips, []) == {}


def test_first_wake_word_reads_both_readings():
    assert first_wake_word("Ком-пьютер, свет", ["Алиса", "компьютер"]) == "компьютер"
    assert first_wake_word("Когда придёт", ["да"]) is None


def test_a_wav_whose_data_is_cut_short_is_refused(tmp_path):
    """Fails if a header that claims more frames than the file holds gives
    short audio without a word: the clip would play cut off, unnoticed."""
    path = wav(tmp_path / "c.wav")
    path.write_bytes(path.read_bytes()[:-1000])
    with pytest.raises(ClipError, match=r"c\.wav.*cut short"):
        read_wav(path)
