"""Manual, human-run check against a real recording.

    uv run python -m voice_front.selfcheck --config voice-front.toml path/to/file.wav

Runs the file through the *same* VAD -> CTC chain the front's own server
uses -- `Endpointer` finds utterance boundaries, `Asr` decodes each closed
segment, `match` checks whether it was addressed to the device (against the
configured wake rules) -- and prints, per segment: the raw transcript, what
`match` made of it, the audio duration, and the decode RTF.

This is the only point in the whole plan where real human speech reaches the
model chain: the wake-rule tests are pure text and need no audio at all, and
no fixture WAV or recorded speech lives in this repository to run this
against automatically. A synthetic tone proves the pipeline does not crash;
it proves nothing about whether the acoustic model, the VAD, or the wake
word actually work on someone saying it out loud. This script is how a human
verifies that, and it must fail loudly rather than fabricate a result.

Requires 16 kHz mono PCM WAV input -- the same format the server expects
over the websocket. Anything else is rejected with a clear error rather
than silently resampled or down-mixed: a mismatch here would misrepresent
what the server actually receives from a real client.

The models directory and the wake rules come from the same configuration
file the front itself runs with, loaded through `voice_front.config.load`.
"""
from __future__ import annotations

import argparse
import sys
import wave
from pathlib import Path
from typing import Sequence

import numpy as np

from voice_front.config import ConfigError, load
from voice_front.speech import GIGAAM_DIR_NAME, SILERO_FILE_NAME
from voice_front.speech.asr import Asr, Transcript
from voice_front.speech.vad import TARGET_RATE, EndpointResult, Endpointer
from voice_front.wake.transcript import WakeRule, match


def load_pcm16_mono_wav(path: Path) -> np.ndarray:
    """Read a 16 kHz mono PCM16 WAV file as float32 samples in [-1, 1).

    Raises SystemExit with a clear message if the file is missing or is not
    exactly the format the server expects -- this script never resamples or
    down-mixes on the caller's behalf.
    """
    if not path.exists():
        raise SystemExit(f"no such file: {path}")
    try:
        with wave.open(str(path), "rb") as w:
            channels = w.getnchannels()
            rate = w.getframerate()
            sampwidth = w.getsampwidth()
            frames = w.readframes(w.getnframes())
    except wave.Error as exc:
        raise SystemExit(f"{path} is not a readable WAV file: {exc}") from exc

    if rate != TARGET_RATE:
        raise SystemExit(
            f"{path} is {rate} Hz, expected {TARGET_RATE} Hz mono -- "
            "resample it before running this check; this script does not "
            "resample on your behalf."
        )
    if channels != 1:
        raise SystemExit(
            f"{path} has {channels} channels, expected 1 (mono) -- "
            "this script does not down-mix on your behalf."
        )
    if sampwidth != 2:
        raise SystemExit(
            f"{path} is {sampwidth * 8}-bit, expected 16-bit PCM."
        )

    return np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0


def run(path: Path, models: Path, rules: Sequence[WakeRule]) -> int:
    samples = load_pcm16_mono_wav(path)
    if samples.size == 0:
        raise SystemExit(f"{path} contains no audio")

    print("loading GigaAM-v3 CTC + Silero VAD ...")
    asr = Asr(models / GIGAAM_DIR_NAME)
    endpointer = Endpointer(models / SILERO_FILE_NAME)

    segments: list[tuple[EndpointResult, np.ndarray]] = []

    closed = endpointer.push(samples)
    if closed is not None:
        segments.append(closed)
    tail = endpointer.flush()
    if tail is not None:
        segments.append(tail)

    if not segments:
        print("no speech detected by the VAD -- nothing to transcribe")
        return 1

    exit_code = 0
    for result, segment in segments:
        transcript: Transcript = asr.transcribe(segment)
        hit = match(transcript.text, rules)
        print(f"--- segment ({result.reason}) ---")
        print(f"  raw transcript : {transcript.text!r}")
        print(f"  match          : {hit!r}")
        print(f"  duration       : {transcript.audio_seconds:.2f}s")
        print(f"  rtf            : {transcript.rtf:.4f}")
        if hit is None:
            print("  -> NOT addressed to the device")
            exit_code = 1
    return exit_code


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--config", required=True, type=Path,
                         help="the front's configuration file (models and wake words)")
    parser.add_argument("wav", type=Path, help="16 kHz mono PCM16 WAV file")
    args = parser.parse_args(argv)
    try:
        cfg = load(args.config)
    except ConfigError as exc:
        raise SystemExit(str(exc)) from exc
    return run(args.wav, cfg.models_dir, cfg.wake_rules)


if __name__ == "__main__":
    sys.exit(main())
