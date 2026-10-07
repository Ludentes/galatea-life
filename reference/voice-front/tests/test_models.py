"""The model chain loads and runs. Needs ./fetch-models.sh; skipped without it.

No committed audio: silence is generated here, and speech comes from the
public GigaAM release's own `test_wavs/example.wav`, which `fetch-models.sh`
fetches alongside the model.
"""
import os
from pathlib import Path

import numpy as np
import pytest

from voice_front.speech import GIGAAM_DIR_NAME, SILERO_FILE_NAME
from voice_front.speech.vad import TARGET_RATE, Endpointer

MODELS = Path(os.environ.get("VOICE_FRONT_MODELS",
                             Path(__file__).resolve().parents[1] / "models"))
have_models = (MODELS / SILERO_FILE_NAME).exists() and (MODELS / GIGAAM_DIR_NAME).exists()
pytestmark = [pytest.mark.models,
              pytest.mark.skipif(not have_models, reason="run ./fetch-models.sh")]


def test_silero_v6_loads_and_hears_no_speech_in_silence():
    ep = Endpointer(MODELS / SILERO_FILE_NAME, max_utterance_s=1.0, clock=lambda: 5.0)
    out = None
    for _ in range(20):
        out = ep.push(np.zeros(1600, dtype=np.float32)) or out
    assert out is not None
    result, _segment = out
    assert result.reason == "no_speech"
    assert result.speech_seconds == 0.0
    assert result.at == 5.0


EXAMPLE = MODELS / GIGAAM_DIR_NAME / "test_wavs" / "example.wav"   # public release, fetched


def _example() -> np.ndarray:
    import wave
    with wave.open(str(EXAMPLE)) as w:
        assert w.getframerate() == TARGET_RATE and w.getnchannels() == 1
        return np.frombuffer(w.readframes(w.getnframes()), "<i2").astype(np.float32) / 32768


def test_silero_v6_closes_one_segment_around_speech():
    # Measured: sherpa's own VadModelConfig.min_silence_duration -- which
    # Endpointer sets to min_silence_s -- makes is_speech_detected() hold
    # True for roughly that same 0.6 s beyond the true speech offset before
    # it flips, on top of this module's own min_silence_s accumulation on
    # top of THAT. The 0.6 s is counted twice; this is the seed's design
    # (voice_front/marking.py's CAPTURE_DELAY_MS comment already records
    # it), not a property of Silero v6 itself. So 1.0 s of trailing silence
    # (the plan's original guess) never accumulates enough silence for
    # `push` to close the segment; it takes flush() instead. 1.5 s does.
    silence = lambda s: np.zeros(int(s * TARGET_RATE), dtype=np.float32)
    audio = np.concatenate([silence(1.5), _example()[:2 * TARGET_RATE], silence(1.5)])
    ep = Endpointer(MODELS / SILERO_FILE_NAME, clock=lambda: 0.0)
    closed = [c for i in range(0, len(audio), 2048)
              if (c := ep.push(audio[i:i + 2048])) is not None]
    assert len(closed) == 1
    result, segment = closed[0]
    assert result.reason == "silence"
    # Measured 2.432 s (the plan guessed <= 2.2 s): 2.0 s of real speech plus
    # sherpa's own ~0.6 s min_silence_duration hangover, minus the ~0.26 s
    # late onset flip -- the same double-counted min_silence_duration noted
    # above, folded into speech_samples.
    assert 1.0 <= result.speech_seconds <= 2.5


def test_gigaam_decodes_the_example_to_words():
    from voice_front.speech.asr import Asr
    t = Asr(MODELS / GIGAAM_DIR_NAME, num_threads=1).transcribe(_example())
    assert len(t.text.split()) >= 3


def test_gigaam_decodes_silence_to_nothing():
    from voice_front.speech.asr import Asr
    t = Asr(MODELS / GIGAAM_DIR_NAME, num_threads=1).transcribe(
        np.zeros(TARGET_RATE, dtype=np.float32))
    assert t.text == ""
    assert t.audio_seconds == pytest.approx(1.0)
