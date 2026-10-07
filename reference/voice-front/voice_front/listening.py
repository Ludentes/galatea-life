"""What an endpoint may hear: the effective setting, what a mode admits, and
who may address. standard/voice.md, *The model*; GA-VOICE-1 to GA-VOICE-4.

Pure, like `addressing.py`: no socket, no clock, no model. The one exception is
the last setting kept on disk (`save_last`, `load_last`), which GA-VOICE-3
requires across restarts.

The configured record is the owner's, read from the steward. The effective one
is that, narrowed by every narrowing in force and by what the front can do. It
is never wider than the configured one: every step below only lowers the mode,
drops words or turns `follow_up` off.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Mapping, Sequence

from voice_front.atomic import write_atomic

OFF, TAP, WAKE_DEVICE, WAKE_SERVER = "off", "tap", "wake_device", "wake_server"
ORDER = (OFF, TAP, WAKE_DEVICE, WAKE_SERVER)
TRANSCRIPT = "transcript"

# The reasons, in the order the one reported is chosen: the first that holds.
OFFLINE, MUTED, NO_STEWARD, NO_MODEL, NARROWED, CONFIGURED = (
    "offline", "muted", "no_steward", "no_model", "narrowed", "configured")

# What opened the audio a frame belongs to.
TAP_WINDOW = "tap"          # a touch opened a tap window
DEVICE_WINDOW = "device"    # the device's own wake model opened a window

# `addressed_by` values this stage produces.
BY_TAP, BY_WAKE = "tap", "wake"


@dataclass(frozen=True)
class WakeWord:
    word: str
    model: str      # a wake model's name, or TRANSCRIPT


@dataclass(frozen=True)
class Record:
    """An endpoint's voice record, as far as listening goes."""
    listening: str
    wake_words: tuple[WakeWord, ...] = ()
    follow_up: bool = False
    zone: str | None = None
    output: str | None = None

    def __post_init__(self) -> None:
        if self.listening not in ORDER:
            raise ValueError(f"unknown listening {self.listening!r}")


@dataclass(frozen=True)
class Narrowing:
    """One narrowing in force. Either field may be absent."""
    listening: str | None = None
    follow_up: bool | None = None

    def __post_init__(self) -> None:
        if self.listening is not None and self.listening not in ORDER:
            raise ValueError(f"unknown listening {self.listening!r}")


@dataclass(frozen=True)
class Effective:
    record: Record
    reason: str


def lower(a: str, b: str) -> str:
    """The narrower of two modes."""
    return a if ORDER.index(a) <= ORDER.index(b) else b


def _checkable(record: Record, runnable: frozenset[str],
               device_models: frozenset[str]) -> tuple[Record, bool]:
    """The record with only the words something can check, and whether any
    word lost its model (GA-VOICE-4).

    - `wake_server`: a named model the box cannot run falls back to the
      transcript check, and the word is kept with `model: transcript`.
    - `wake_device`: only a model the device runs, and declared it sends the
      word with the pre-roll, checks a word; the transcript check needs all
      speech streamed. With no word left the endpoint falls back to `tap`.
    """
    if record.listening == WAKE_SERVER:
        words, lost = [], False
        for w in record.wake_words:
            if w.model == TRANSCRIPT or w.model in runnable:
                words.append(w)
            else:
                words.append(WakeWord(w.word, TRANSCRIPT))
                lost = True
        return replace(record, wake_words=tuple(words)), lost
    if record.listening == WAKE_DEVICE:
        words = tuple(w for w in record.wake_words if w.model in device_models)
        lost = len(words) < len(record.wake_words)
        if not words:
            return replace(record, listening=TAP, wake_words=()), True
        return replace(record, wake_words=words), lost
    return record, False


def effective(configured: Record | None, narrowings: Sequence[Narrowing] = (), *,
              online: bool = True, muted: bool = False, steward_lost: bool = False,
              runnable: frozenset[str] = frozenset(),
              device_models: frozenset[str] = frozenset()) -> Effective:
    """The effective record and its reason (GA-VOICE-2).

    `configured` None: nothing was ever read, so the endpoint is off
    (GA-VOICE-3). `steward_lost`: the caller passes the last record and the
    narrowings it last read, expired or not; the steward alone lifts them.
    `device_models`: the models the endpoint's device runs AND declared, when
    admitted, that it sends the word's audio with at least the minimum
    pre-roll; any other device model checks nothing.
    """
    if configured is None:
        return Effective(Record(OFF), NO_STEWARD)
    if not online:
        return Effective(replace(configured, listening=OFF), OFFLINE)
    if muted:
        return Effective(replace(configured, listening=OFF), MUTED)

    narrowed = configured
    for n in narrowings:
        if n.listening is not None:
            narrowed = replace(narrowed, listening=lower(narrowed.listening, n.listening))
        if n.follow_up is False:
            narrowed = replace(narrowed, follow_up=False)
    record, lost = _checkable(narrowed, runnable, device_models)

    if steward_lost:
        reason = NO_STEWARD
    elif lost:
        reason = NO_MODEL
    elif narrowed != configured:
        reason = NARROWED
    else:
        reason = CONFIGURED
    return Effective(record, reason)


def admits(mode: str, window: str | None) -> bool:
    """May a frame be read (GA-VOICE-1)? `window` is what opened the audio the
    frame belongs to, or None. A tap opens a window at every mode but `off`."""
    if mode == OFF:
        return False
    if mode == TAP:
        return window == TAP_WINDOW
    if mode == WAKE_DEVICE:
        return window in (TAP_WINDOW, DEVICE_WINDOW)
    if mode == WAKE_SERVER:
        return True
    raise ValueError(f"unknown listening {mode!r}")


_ADDRESSERS = {OFF: frozenset(), TAP: frozenset({BY_TAP}),
               WAKE_DEVICE: frozenset({BY_TAP, BY_WAKE}),
               WAKE_SERVER: frozenset({BY_TAP, BY_WAKE})}


def may_address(mode: str, by: str) -> bool:
    """May an utterance addressed so be kept and passed on at this mode?"""
    return by in _ADDRESSERS[mode]


# --- The last setting, kept across restarts (GA-VOICE-3) -----------------

LAST_VERSION = 1


def _record_from(d: Mapping) -> Record:
    return Record(listening=d["listening"],
                  wake_words=tuple(WakeWord(w["word"], w["model"]) for w in d["wake_words"]),
                  follow_up=d["follow_up"] is True, zone=d.get("zone"),
                  output=d.get("output"))


def save_last(path: Path, last: Mapping[str, tuple[Record, Sequence[Narrowing]]]) -> None:
    """Write each endpoint's configured record and narrowings, atomically: a
    crash mid-write leaves the previous file whole."""
    doc = {"version": LAST_VERSION, "endpoints": {
        endpoint: {"configured": asdict(record),
                   "narrowings": [asdict(n) for n in narrowings]}
        for endpoint, (record, narrowings) in last.items()}}
    write_atomic(Path(path), json.dumps(doc, ensure_ascii=False, sort_keys=True))


def load_last(path: Path) -> dict[str, tuple[Record, tuple[Narrowing, ...]]]:
    """The endpoints as last saved, or none.

    ⛔ A missing, unreadable or malformed file gives none, never a guess: with
    no setting and no steward the front listens nowhere (GA-VOICE-3).
    """
    try:
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
        if not isinstance(doc, dict):
            return {}
        if doc.get("version") != LAST_VERSION:
            return {}
        return {endpoint: (_record_from(e["configured"]),
                           tuple(Narrowing(**n) for n in e["narrowings"]))
                for endpoint, e in doc["endpoints"].items()}
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return {}
