"""GigaAM-v3 CTC decoding via sherpa-onnx. Offline (whole-utterance) decoding.

CTC, not RNN-T: GigaAM-v3 CTC's token set is a space, 32 Cyrillic letters and
a blank -- no punctuation, no case, no digits to normalise away, and it is
the variant whose speed has been measured (RTF ~= 0.03 on CPU, 4 threads).

Everything here runs on-device. There is no upload path and none may be
added -- audio never leaves this machine.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from voice_front.speech.vad import TARGET_RATE


@dataclass
class Transcript:
    text: str
    audio_seconds: float
    decode_seconds: float

    @property
    def rtf(self) -> float:
        """Real-time factor: decode time / audio duration. Lower is faster."""
        return self.decode_seconds / self.audio_seconds if self.audio_seconds else 0.0


class Asr:
    """GigaAM-v3 CTC via sherpa-onnx. Offline (whole-utterance) decoding."""

    def __init__(self, model_dir: Path, num_threads: int = 4) -> None:
        import sherpa_onnx

        model_dir = Path(model_dir)
        model = model_dir / "model.int8.onnx"
        tokens = model_dir / "tokens.txt"
        if not model.exists():
            raise FileNotFoundError(
                f"missing ASR model at {model}\nrun ./fetch-models.sh first"
            )
        self._rec = sherpa_onnx.OfflineRecognizer.from_nemo_ctc(
            model=str(model),
            tokens=str(tokens),
            num_threads=num_threads,
        )

    def transcribe(self, samples: np.ndarray) -> Transcript:
        t0 = time.time()
        s = self._rec.create_stream()
        s.accept_waveform(TARGET_RATE, samples)
        self._rec.decode_stream(s)
        return Transcript(
            text=s.result.text.strip(),
            audio_seconds=len(samples) / TARGET_RATE,
            decode_seconds=time.time() - t0,
        )
