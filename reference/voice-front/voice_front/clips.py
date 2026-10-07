"""The installation's fixed clips: the only words the front speaks that a
brain did not `say` (voice, *Speaking*, "Only these words"; GA-VOICE-11).

Each clip is a WAV file, 16-bit PCM, with the text it speaks; the front
declares every clip's text in `front_status`. The clips the standard names:

- `cannot_answer`, «Не могу ответить», when the brain is silent. Required.
- `earcon`, the sound at a wake or a tap. No words, so its text is empty.
- `not_in_time`, «Не успела ответить», for a skill (stage 3).
- `not_recognised`, for a recognition failure.

A clip is checked for wake words like any piece (GA-VOICE-20); `speaking`
does that, whenever the words change.
"""
from __future__ import annotations

import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Sequence

from voice_front.synth import SAMPLE_WIDTH, Audio
from voice_front.text import first_wake_word

CANNOT_ANSWER = "cannot_answer"
EARCON = "earcon"
NOT_IN_TIME = "not_in_time"
NOT_RECOGNISED = "not_recognised"
NAMES = (CANNOT_ANSWER, EARCON, NOT_IN_TIME, NOT_RECOGNISED)
REQUIRED = (CANNOT_ANSWER,)
WORDLESS = (EARCON,)


class ClipError(ValueError):
    """A clip cannot be used. The message names the clip and its file."""


@dataclass(frozen=True)
class ClipEntry:
    """A clip as the configuration names it; its audio is not read yet."""
    name: str
    path: Path
    text: str


@dataclass(frozen=True)
class Clip:
    name: str
    text: str
    audio: Audio


def read_wav(path: Path) -> Audio:
    """16-bit PCM, mono or stereo: what every link plays. Raises `ClipError`."""
    try:
        with wave.open(str(path), "rb") as w:
            width, rate, channels = w.getsampwidth(), w.getframerate(), w.getnchannels()
            frames = w.getnframes()
            pcm = w.readframes(frames)
    except FileNotFoundError:
        raise ClipError(f"{path}: no such file") from None
    except (OSError, EOFError, wave.Error) as e:
        raise ClipError(f"{path}: not a PCM WAV file ({e})") from None
    if width != SAMPLE_WIDTH:
        raise ClipError(f"{path}: {width * 8}-bit audio; a clip is 16-bit PCM")
    if rate <= 0 or channels not in (1, 2):
        raise ClipError(f"{path}: {rate} Hz, {channels} channels; a clip is mono or stereo")
    if not pcm:
        raise ClipError(f"{path}: no audio")
    if len(pcm) != frames * width * channels:       # the header claims more than the file holds
        raise ClipError(f"{path}: the audio is cut short ({len(pcm)} of {frames * width * channels} bytes)")
    return Audio(pcm, rate, width, channels)


def check(entries: Sequence[ClipEntry]) -> None:
    """Raises `ClipError` for an unknown or repeated name, a wordless clip
    with words or a clip of words with none, or a missing required clip.
    Reads no audio."""
    seen: set[str] = set()
    for e in entries:
        if e.name not in NAMES:
            raise ClipError(f"clip {e.name!r}: not one of {', '.join(NAMES)}")
        if e.name in seen:
            raise ClipError(f"clip {e.name!r}: named twice")
        seen.add(e.name)
        if (e.name in WORDLESS) != (not e.text.strip()):
            raise ClipError(f"clip {e.name!r}: " + ("a sound, with no text" if e.name in WORDLESS
                                                    else "its text is what it says, and cannot be empty"))
    missing = [n for n in REQUIRED if n not in seen]
    if missing:
        raise ClipError(f"clip {missing[0]!r} is required")


def load_clips(entries: Sequence[ClipEntry]) -> dict[str, Clip]:
    """Every clip, checked and read. Raises `ClipError`."""
    check(entries)
    return {e.name: Clip(e.name, e.text, read_wav(e.path)) for e in entries}


def declared(clips: Mapping[str, Clip]) -> list[dict[str, str]]:
    """What `front_status` declares: each clip's name and text."""
    return [{"name": c.name, "text": c.text} for c in clips.values()]


def blocked(clips: Mapping[str, Clip], words: Sequence[str]) -> dict[str, str]:
    """The clips that name a wake word, each with the word: never played
    while those are the words (GA-VOICE-20)."""
    return {name: w for name, c in clips.items() if (w := first_wake_word(c.text, words)) is not None}
