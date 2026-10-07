"""Silero VAD used to decide when the speaker has stopped talking.

The thresholds and the accumulation logic are unchanged from the code they
were taken from.

Everything here runs on-device. There is no upload path and none may be
added -- audio never leaves this machine.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

TARGET_RATE = 16_000
MIN_SILENCE_S = 0.6


@dataclass
class EndpointResult:
    """A VAD-closed utterance boundary."""

    reason: str  # "silence" | "max_duration" | "no_speech" | "eof"
    speech_seconds: float
    at: float


class Endpointer:
    """Silero VAD used to decide when the speaker has stopped talking."""

    def __init__(
        self,
        model: Path,
        threshold: float = 0.5,
        min_silence_s: float = MIN_SILENCE_S,
        min_speech_s: float = 0.2,
        max_utterance_s: float = 12.0,
        clock=time.time,
    ) -> None:
        import sherpa_onnx

        model = Path(model)
        if not model.exists():
            raise FileNotFoundError(
                f"missing VAD model at {model}\nrun ./fetch-models.sh first"
            )

        cfg = sherpa_onnx.VadModelConfig()
        cfg.silero_vad.model = str(model)
        cfg.silero_vad.threshold = threshold
        cfg.silero_vad.min_silence_duration = min_silence_s
        cfg.silero_vad.min_speech_duration = min_speech_s
        cfg.silero_vad.max_speech_duration = max_utterance_s
        cfg.sample_rate = TARGET_RATE
        cfg.validate()
        self.window = cfg.silero_vad.window_size
        self.max_utterance_s = max_utterance_s
        self.min_silence_s = min_silence_s
        self._clock = clock
        self._vad = sherpa_onnx.VoiceActivityDetector(
            cfg, buffer_size_in_seconds=max_utterance_s + 5
        )
        self._tail = np.zeros(0, dtype=np.float32)
        self._segment = np.zeros(0, dtype=np.float32)
        self._saw_speech = False
        self._speech_samples = 0
        self._silence_samples = 0
        self._total_samples = 0

    def reset(self) -> None:
        self._vad.reset()
        self._tail = np.zeros(0, dtype=np.float32)
        self._segment = np.zeros(0, dtype=np.float32)
        self._saw_speech = False
        self._speech_samples = 0
        self._silence_samples = 0
        self._total_samples = 0

    def push(
        self, samples: np.ndarray
    ) -> tuple[EndpointResult, np.ndarray] | None:
        """Feed 16 kHz mono float32 audio.

        Returns the (result, segment-audio) pair the first time an utterance
        boundary closes, or None while still accumulating.
        """
        now = self._clock()
        self._tail = np.concatenate([self._tail, samples])
        while len(self._tail) >= self.window:
            w = self._tail[: self.window]
            self._tail = self._tail[self.window :]
            self._segment = np.concatenate([self._segment, w])
            self._vad.accept_waveform(w)
            self._total_samples += self.window
            if self._vad.is_speech_detected():
                self._saw_speech = True
                self._speech_samples += self.window
                self._silence_samples = 0
            else:
                self._silence_samples += self.window

            speech_s = self._speech_samples / TARGET_RATE
            silence_s = self._silence_samples / TARGET_RATE
            total_s = self._total_samples / TARGET_RATE

            if self._saw_speech and silence_s >= self.min_silence_s:
                segment, result = self._segment, EndpointResult(
                    "silence", speech_s, now
                )
                self.reset()
                return result, segment
            if total_s >= self.max_utterance_s:
                reason = "max_duration" if self._saw_speech else "no_speech"
                segment, result = self._segment, EndpointResult(
                    reason, speech_s, now
                )
                self.reset()
                return result, segment
        return None

    def flush(self) -> tuple[EndpointResult, np.ndarray] | None:
        """Close whatever segment is pending, e.g. at end of a fixture file.

        A live microphone stream is expected to end in silence, which
        `push` closes on its own. A short recording -- a fixture WAV that
        simply stops after the command -- may never cross that threshold,
        so callers that know the stream has ended (not just paused) should
        call this once after the last `push`. Returns None if nothing was
        accumulated (no speech was ever seen).
        """
        now = self._clock()
        if not self._saw_speech:
            return None
        speech_s = self._speech_samples / TARGET_RATE
        segment, result = self._segment, EndpointResult("eof", speech_s, now)
        self.reset()
        return result, segment
