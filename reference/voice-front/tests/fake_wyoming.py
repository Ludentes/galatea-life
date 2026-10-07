"""A fake Wyoming server for the synthesiser's tests: a raw asyncio server on
127.0.0.1, on a free port, that answers each request with what the test
scripts. Not a test, and not a synthesiser: it makes no speech.

Raw, not `wyoming.server.AsyncServer`, so a script can send what no real
server would: a malformed line, a stall, a close in the middle of a piece.
"""
from __future__ import annotations

import asyncio
import socket
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import AsyncIterator, Callable, Iterable

from wyoming.audio import AudioChunk, AudioStart, AudioStop
from wyoming.event import Event, async_read_event, async_write_event

HANG = object()         # stop answering; hold the connection until the client leaves


@dataclass(frozen=True)
class Pause:
    """Wait this long before the next step: a server that trickles."""
    seconds: float


Step = Event | bytes | Pause | object
Script = Callable[[Event], Iterable[Step]]       # a generator may go on for ever


def pcm_of(seconds: float, rate: int = 22050, channels: int = 1) -> bytes:
    """Silent 16-bit PCM of a length: the tests need a duration, not a sound."""
    return bytes(2 * channels * round(seconds * rate))


def piece(pcm: bytes, rate: int = 22050, width: int = 2, channels: int = 1,
          chunk: int = 4096) -> list[Event]:
    """What a synthesiser answers for a piece: start, chunks, stop."""
    out = [AudioStart(rate=rate, width=width, channels=channels).event()]
    out += [AudioChunk(rate=rate, width=width, channels=channels, audio=pcm[i:i + chunk]).event()
            for i in range(0, len(pcm), chunk)]
    return out + [AudioStop().event()]


class FakeWyoming:
    def __init__(self, script: Script):
        self.script = script
        self.received: list[Event] = []
        self.uri = ""
        self._writers: set[asyncio.StreamWriter] = set()

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._writers.add(writer)
        try:
            event = await async_read_event(reader)
            if event is None:
                return
            self.received.append(event)
            for step in self.script(event):
                if step is HANG:
                    await reader.read()
                    return
                if isinstance(step, Pause):
                    await asyncio.sleep(step.seconds)
                elif isinstance(step, bytes):
                    writer.write(step)
                    await writer.drain()
                elif isinstance(step, Event):
                    await async_write_event(step, writer)
        except ConnectionError:
            pass
        finally:
            self._writers.discard(writer)
            writer.close()


@asynccontextmanager
async def serving(script: Script) -> AsyncIterator[FakeWyoming]:
    fake = FakeWyoming(script)
    server = await asyncio.start_server(fake._handle, host="127.0.0.1", port=0)
    fake.uri = f"tcp://127.0.0.1:{server.sockets[0].getsockname()[1]}"
    try:
        yield fake
    finally:
        server.close()
        for writer in list(fake._writers):     # a HANG holds its connection open
            writer.close()
        await server.wait_closed()


@asynccontextmanager
async def unaccepting() -> AsyncIterator[str]:
    """A loopback port whose listen queue is already full, so a connect
    waits and never completes: the connect timeout's case."""
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(0)
    port = listener.getsockname()[1]
    _, filler = await asyncio.open_connection("127.0.0.1", port)
    try:
        yield f"tcp://127.0.0.1:{port}"
    finally:
        filler.close()
        listener.close()
