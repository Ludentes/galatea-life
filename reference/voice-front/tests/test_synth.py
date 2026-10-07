"""The synthesiser's Wyoming client: a whole piece, or `SynthFailed`. Voice,
*Speaking*; the stage 2c rulings (synthesis per piece, whole, before play).

A fake server on 127.0.0.1 answers as each test scripts. Each case names the
change that would redden it.
"""
import anyio
import pytest
from wyoming.audio import AudioChunk, AudioStart, AudioStop
from wyoming.error import Error
from wyoming.event import Event

from fake_wyoming import HANG, Pause, pcm_of, piece, serving, unaccepting
from voice_front.synth import Audio, SynthFailed, Synthesiser

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


def answer(*steps):
    return lambda event: steps


async def failed(synth: Synthesiser) -> str:
    with anyio.fail_after(5):
        with pytest.raises(SynthFailed) as e:
            await synth.synthesise("Свет на кухне включён.")
    return str(e.value)


async def test_a_piece_is_its_chunks_joined_in_order():
    pcm = bytes(range(256)) * 40            # distinct bytes, so an order change shows
    async with serving(answer(*piece(pcm, rate=22050, chunk=1000))) as fake:
        with anyio.fail_after(5):
            got = await Synthesiser(fake.uri, "ru_RU-irina-medium").synthesise("Свет на кухне включён.")
    assert got == Audio(pcm, 22050, 2, 1)
    assert got.duration_s == pytest.approx(len(pcm) / 2 / 22050)
    sent = fake.received[0]
    assert sent.type == "synthesize"
    assert sent.data["text"] == "Свет на кухне включён."
    assert sent.data["voice"] == {"name": "ru_RU-irina-medium"}


async def test_with_no_voice_the_server_chooses():
    """Fails if an empty voice name is sent, which a server reads as unknown."""
    async with serving(answer(*piece(pcm_of(0.1)))) as fake:
        with anyio.fail_after(5):
            await Synthesiser(fake.uri).synthesise("Готово.")
    assert "voice" not in fake.received[0].data


async def test_the_duration_counts_every_channel():
    got_pcm = pcm_of(0.5, rate=16000, channels=2)
    async with serving(answer(*piece(got_pcm, rate=16000, channels=2))) as fake:
        with anyio.fail_after(5):
            got = await Synthesiser(fake.uri).synthesise("Готово.")
    assert got.duration_s == pytest.approx(0.5)


async def test_an_error_event_fails_the_piece_even_after_audio():
    """Piper may send some audio, then `error`: fails if the partial piece is
    returned as if whole."""
    steps = piece(pcm_of(0.2))[:-1] + [Error(text="unknown voice").event()]
    async with serving(answer(*steps)) as fake:
        assert "unknown voice" in await failed(Synthesiser(fake.uri))


async def test_a_close_before_audio_stop_fails_the_piece():
    async with serving(answer(*piece(pcm_of(0.2))[:-1])) as fake:
        assert "closed" in await failed(Synthesiser(fake.uri))


async def test_audio_start_then_stop_with_no_chunk_fails():
    """Fails if an empty piece is played: silence is not a reply."""
    steps = [AudioStart(rate=22050, width=2, channels=1).event(), AudioStop().event()]
    async with serving(answer(*steps)) as fake:
        assert "no audio" in await failed(Synthesiser(fake.uri))


async def test_a_chunk_in_another_format_fails_the_piece():
    """Fails if a chunk at another rate is appended: it would play at the
    wrong speed."""
    steps = [AudioStart(rate=22050, width=2, channels=1).event(),
             AudioChunk(rate=22050, width=2, channels=1, audio=pcm_of(0.1)).event(),
             AudioChunk(rate=16000, width=2, channels=1, audio=pcm_of(0.1, rate=16000)).event(),
             AudioStop().event()]
    async with serving(answer(*steps)) as fake:
        assert "format changed" in await failed(Synthesiser(fake.uri))


async def test_audio_that_is_not_16_bit_fails():
    async with serving(answer(*piece(bytes(400), width=4))) as fake:
        assert "32-bit" in await failed(Synthesiser(fake.uri))


async def test_a_chunk_before_audio_start_fails():
    steps = [AudioChunk(rate=22050, width=2, channels=1, audio=pcm_of(0.1)).event(), AudioStop().event()]
    async with serving(answer(*steps)) as fake:
        assert "before audio-start" in await failed(Synthesiser(fake.uri))


async def test_audio_that_is_not_whole_frames_fails():
    steps = [AudioStart(rate=22050, width=2, channels=1).event(),
             AudioChunk(rate=22050, width=2, channels=1, audio=b"\x00\x01\x02").event(),
             AudioStop().event()]
    async with serving(answer(*steps)) as fake:
        assert "whole frames" in await failed(Synthesiser(fake.uri))


async def test_a_malformed_line_fails_the_piece():
    async with serving(answer(AudioStart(rate=22050, width=2, channels=1).event(), b"{not json\n")) as fake:
        await failed(Synthesiser(fake.uri))


async def test_an_audio_start_with_no_rate_fails():
    async with serving(answer(Event("audio-start", {"width": 2, "channels": 1}))) as fake:
        assert "malformed" in await failed(Synthesiser(fake.uri))


async def test_a_server_that_stops_answering_fails_within_the_read_timeout():
    """Fails if the read has no timeout: a stalled synthesiser would hold the
    endpoint's queue forever."""
    async with serving(answer(AudioStart(rate=22050, width=2, channels=1).event(), HANG)) as fake:
        started = anyio.current_time()
        await failed(Synthesiser(fake.uri, read_s=0.2))
    assert anyio.current_time() - started < 2


async def test_a_server_that_never_accepts_fails_within_the_connect_timeout():
    """Fails if the connect has no timeout of its own: the message says a
    timeout, not the overall deadline or a refusal."""
    async with unaccepting() as uri:
        started = anyio.current_time()
        assert "TimeoutError" in await failed(Synthesiser(uri, connect_s=0.2))
    assert anyio.current_time() - started < 2


async def test_a_server_that_trickles_fails_at_the_deadline_for_the_whole_piece():
    """Every event within the read timeout, the piece never done: fails if
    only the gap between events is bounded."""
    def trickle(event):
        yield AudioStart(rate=22050, width=2, channels=1).event()
        for _ in range(30):
            yield Pause(0.1)
            yield AudioChunk(rate=22050, width=2, channels=1, audio=pcm_of(0.01)).event()
    async with serving(trickle) as fake:
        started = anyio.current_time()
        await failed(Synthesiser(fake.uri, read_s=0.3, deadline_s=0.8))
    assert anyio.current_time() - started < 1.5


async def test_a_server_that_talks_of_other_things_fails_at_the_deadline():
    """Events the client does not know are skipped, and count against the
    deadline: fails if an endless stream of them holds the piece."""
    def chatter(event):
        while True:
            yield Pause(0.02)
            yield Event("ping", {})
    async with serving(chatter) as fake:
        started = anyio.current_time()
        await failed(Synthesiser(fake.uri, read_s=0.3, deadline_s=0.5))
        with anyio.fail_after(5), pytest.raises(SynthFailed):
            await Synthesiser(fake.uri, read_s=0.3, deadline_s=0.5).describe()
    assert anyio.current_time() - started < 2


async def test_more_audio_than_a_piece_holds_fails():
    """Fails if a runaway server's audio is gathered without end: the cap is
    30 s at the format audio-start declares."""
    steps = piece(pcm_of(30.2, rate=1000), rate=1000, chunk=2000)
    async with serving(answer(*steps)) as fake:
        assert "more than 30 s" in await failed(Synthesiser(fake.uri))


async def test_a_payload_shorter_than_it_says_fails_the_piece():
    """The stream ends inside a payload (IncompleteReadError): fails if that
    escapes as anything but SynthFailed."""
    header = b'{"type": "audio-start", "data": {"rate": 22050, "width": 2, "channels": 1}}\n'
    chunk = (b'{"type": "audio-chunk", "data": {"rate": 22050, "width": 2, "channels": 1}, '
             b'"payload_length": 100}\n' + bytes(10))
    async with serving(answer(header, chunk)) as fake:
        await failed(Synthesiser(fake.uri))


async def test_a_length_of_the_wrong_kind_fails_the_piece():
    async with serving(answer(b'{"type": "audio-start", "payload_length": "many"}\n')) as fake:
        await failed(Synthesiser(fake.uri))
    async with serving(answer(b'{"type": "info", "data_length": "many"}\n')) as fake:
        with anyio.fail_after(5), pytest.raises(SynthFailed):
            await Synthesiser(fake.uri).describe()


async def test_a_server_that_is_not_there_fails():
    async with serving(answer()) as fake:
        uri = fake.uri
    await failed(Synthesiser(uri))


def test_only_tcp_and_unix_are_reached():
    with pytest.raises(ValueError):
        Synthesiser("stdio://")


def info(*voices):
    return Event("info", {"tts": [{"name": "piper", "voices": list(voices)}]})


async def test_describe_names_the_installed_voices():
    steps = [info({"name": "ru_RU-irina-medium", "installed": True, "languages": ["ru_RU"]},
                  {"name": "ru_RU-denis-medium"},                     # no `installed`: a lenient server
                  {"name": "en_US-lessac-medium", "installed": False},
                  {"languages": ["ru_RU"]})]                          # no name: not a voice to ask for
    async with serving(answer(*steps)) as fake:
        with anyio.fail_after(5):
            assert await Synthesiser(fake.uri).describe() == ["ru_RU-irina-medium", "ru_RU-denis-medium"]
    assert fake.received[0].type == "describe"


async def test_describe_with_no_tts_names_none():
    async with serving(answer(Event("info", {"asr": []}))) as fake:
        with anyio.fail_after(5):
            assert await Synthesiser(fake.uri).describe() == []


async def test_describe_fails_on_a_close_before_info():
    async with serving(answer()) as fake:
        with anyio.fail_after(5), pytest.raises(SynthFailed):
            await Synthesiser(fake.uri).describe()
