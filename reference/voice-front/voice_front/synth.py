"""The synthesiser: a `say` piece's text to audio, over Wyoming (voice,
*Speaking*; the stage 2c rulings in the voice front design).

Wyoming is a JSON-lines protocol with binary payloads. A piece is one
`synthesize` event, answered by `audio-start`, `audio-chunk`s and
`audio-stop`, or by `error`. The client reads the whole piece before it
returns: the brain already splits a reply into pieces for latency, so
streaming within a piece is not needed yet.

Wyoming has no authentication and no encryption, so the synthesiser runs on
this host: the configuration takes only `tcp://` to loopback or `unix://`
(voice, *Links, security and retention*).

Anything but a clean answer is `SynthFailed`, and the piece is dropped:
never a partial piece played as if whole. A piece has a deadline as a whole,
and a cap on its audio, so a server that trickles, or talks of other things,
cannot hold an endpoint's queue.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import anyio
from wyoming.audio import AudioChunk, AudioStart, AudioStop
from wyoming.client import AsyncClient
from wyoming.error import Error
from wyoming.info import Describe, Info
from wyoming.tts import Synthesize, SynthesizeVoice

CONNECT_S = 2.0
READ_S = 10.0           # between two events; a piece still being made sends none
DEADLINE_S = 30.0       # a whole piece, or a description, from connecting to the last event
LONGEST_PIECE_S = 30.0  # of audio: more is not a piece a brain split for speaking
SAMPLE_WIDTH = 2        # 16-bit PCM: what every link plays
# What the client, the stream and the event parser raise on a server that is
# gone, slow or malformed (a short payload is IncompleteReadError, an EOFError).
CLIENT_ERRORS = (OSError, TimeoutError, EOFError, ValueError, TypeError, KeyError, AttributeError)


class SynthFailed(Exception):
    """No audio for the piece: the synthesiser could not be reached, timed
    out, refused it, or answered something that is not a whole piece."""


@dataclass(frozen=True)
class Audio:
    """Interleaved signed 16-bit little-endian PCM."""
    pcm: bytes
    rate: int
    width: int
    channels: int

    @property
    def frame_bytes(self) -> int:
        return self.width * self.channels

    @property
    def duration_s(self) -> float:
        return len(self.pcm) / (self.rate * self.frame_bytes)


def _format(event: AudioStart | AudioChunk) -> tuple[int, int, int]:
    return event.rate, event.width, event.channels


class Synthesiser:
    """One Wyoming TTS server. Each call opens a connection of its own."""

    def __init__(self, uri: str, voice: str | None = None, *, connect_s: float = CONNECT_S,
                 read_s: float = READ_S, deadline_s: float = DEADLINE_S):
        if urlsplit(uri).scheme not in ("tcp", "unix"):
            raise ValueError("a synthesiser is reached by tcp:// or unix://")
        self.uri = uri
        self.voice = voice
        self._connect_s = connect_s
        self._read_s = read_s
        self._deadline_s = deadline_s

    def _client(self) -> AsyncClient:
        return AsyncClient.from_uri(self.uri, connect_timeout=self._connect_s, read_timeout=self._read_s)

    async def synthesise(self, text: str) -> Audio:
        """The whole piece. Raises `SynthFailed`."""
        voice = SynthesizeVoice(name=self.voice) if self.voice else None
        try:
            with anyio.fail_after(self._deadline_s):
                async with self._client() as client:
                    await client.write_event(Synthesize(text=text, voice=voice).event())
                    return await self._read_piece(client)
        except CLIENT_ERRORS as e:
            raise SynthFailed(f"{type(e).__name__}: {e}") from e

    async def _read_piece(self, client: AsyncClient) -> Audio:
        fmt: tuple[int, int, int] | None = None
        chunks: list[bytes] = []
        size = cap = 0
        while True:
            event = await client.read_event()
            if event is None:
                raise SynthFailed("the synthesiser closed before the piece ended")
            if Error.is_type(event.type):
                raise SynthFailed(f"the synthesiser refused: {Error.from_event(event).text}")
            try:
                if AudioStart.is_type(event.type):
                    fmt = _format(AudioStart.from_event(event))
                    rate, width, channels = fmt
                    if width != SAMPLE_WIDTH:
                        raise SynthFailed(f"{width * 8}-bit audio; only 16-bit is played")
                    if rate <= 0 or channels <= 0:
                        raise SynthFailed(f"no such audio: {rate} Hz, {channels} channels")
                    cap = round(LONGEST_PIECE_S * rate) * width * channels
                elif AudioChunk.is_type(event.type):
                    chunk = AudioChunk.from_event(event)
                    if fmt is None:
                        raise SynthFailed("audio before audio-start")
                    if _format(chunk) != fmt:
                        raise SynthFailed(f"the format changed within a piece: {_format(chunk)} after {fmt}")
                    size += len(chunk.audio)
                    if size > cap:
                        raise SynthFailed(f"more than {LONGEST_PIECE_S:.0f} s of audio in one piece")
                    chunks.append(chunk.audio)
                elif AudioStop.is_type(event.type):
                    return self._whole(fmt, chunks)
            except (KeyError, TypeError) as e:     # a field missing or of the wrong kind
                raise SynthFailed(f"a malformed {event.type}: {e!r}") from None

    @staticmethod
    def _whole(fmt: tuple[int, int, int] | None, chunks: list[bytes]) -> Audio:
        pcm = b"".join(chunks)
        if fmt is None or not pcm:
            raise SynthFailed("the piece has no audio")
        rate, width, channels = fmt
        audio = Audio(pcm, rate, width, channels)
        if len(pcm) % audio.frame_bytes:
            raise SynthFailed("the audio is not whole frames")
        return audio

    async def describe(self) -> list[str]:
        """The names of the voices the synthesiser offers. Raises `SynthFailed`."""
        try:
            with anyio.fail_after(self._deadline_s):
                async with self._client() as client:
                    await client.write_event(Describe().event())
                    while True:
                        event = await client.read_event()
                        if event is None:
                            raise SynthFailed("the synthesiser closed before describing itself")
                        if Info.is_type(event.type):
                            return _voices(event.data)
        except CLIENT_ERRORS as e:
            raise SynthFailed(f"{type(e).__name__}: {e}") from e


def _voices(info: Any) -> list[str]:
    """Voice names from an `info` event's data, read leniently: servers differ
    in which of the artifact fields they fill."""
    names: list[str] = []
    programs = info.get("tts") if isinstance(info, dict) else None
    for program in programs if isinstance(programs, list) else []:
        voices = program.get("voices") if isinstance(program, dict) else None
        for v in voices if isinstance(voices, list) else []:
            if isinstance(v, dict) and isinstance(v.get("name"), str) and v.get("installed", True) is not False:
                names.append(v["name"])
    return names
