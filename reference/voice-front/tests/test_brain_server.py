"""The front's server for its brains: `listen`, `say`, `hush`, each brain kept
to its own endpoints. GA-VOICE-19, GA-VOICE-21; brain, *The front*.

A fake brain calls through the real Streamable HTTP stack, in process. Each
case names the change that would redden it; the negative subjects it stands
for are named where they apply.
"""
import json
import uuid

import anyio
import httpx2
import pytest

from mcp_doubles import URL, OlderOnly, in_process
from voice_front import mcpwire
from voice_front.brain import BrainServer
from voice_front.schemas import schemas
from voice_front.store import Store, StoreUnavailable

pytestmark = pytest.mark.anyio

SECRETS = {"brain-local": "secret-local", "brain-cloud": "secret-cloud"}


@pytest.fixture
def anyio_backend():
    return "asyncio"


class Speech:
    def __init__(self):
        self.said: list[tuple[str, str, dict]] = []
        self.hushed: list[tuple[str, dict]] = []

    async def say(self, brain, say_id, request):
        self.said.append((brain, say_id, request))

    async def hush(self, brain, request):
        self.hushed.append((brain, request))


class Front:
    """The server with its store, its speech double and who serves what."""

    def __init__(self, store):
        self.served = {"ep-kitchen": "brain-local", "ep-hall": "brain-cloud", "ep-attic": None}
        self.speech = Speech()
        self.store = store
        self.server = BrainServer(self.store, self.speech, lambda: self.served, SECRETS)

    def utterance(self, endpoint="ep-kitchen", transcript="включи свет"):
        return {"utterance_id": str(uuid.uuid4()), "endpoint": endpoint, "transcript": transcript,
                "time": "2026-09-28T10:00:00+03:00", "available_at": "2026-09-28T10:00:01+03:00",
                "clock_epoch": "1", "addressed_by": "wake"}


@pytest.fixture
async def front(database, tmp_path):
    """A running server: its session manager runs once, for the whole test."""
    store = await Store.open(database, schema="voice_kitchen", audio_dir=tmp_path / "audio")
    # The store is closed whatever fails after it opens: a pool left open holds the run (no schemas, say).
    try:
        f = Front(store)
        async with in_process(f.server.mcp) as transport:
            f.transport = transport
            yield f
    finally:
        await store.close()


async def call(front, brain, tool, args, transport=None):
    async with mcpwire.connect(URL, SECRETS[brain], transport=transport or front.transport) as session:
        return await session.call(tool, args)


async def error_of(front, brain, tool, args):
    with pytest.raises(mcpwire.CallError) as e:
        await call(front, brain, tool, args)
    return e.value.code


async def test_an_utterance_reaches_only_the_brain_its_endpoint_names(front):
    """`tells-every-brain`: fails if delivery ignores `served_by`."""
    u = front.utterance("ep-kitchen")
    assert await front.server.deliver(u) == "brain-local"
    got = await call(front, "brain-local", "listen", {})
    assert got["utterances"] == [u]
    assert (await call(front, "brain-cloud", "listen", {}))["utterances"] == []


async def test_an_endpoint_no_brain_serves_delivers_nothing(front):
    assert await front.server.deliver(front.utterance("ep-attic")) is None
    for brain in SECRETS:
        assert (await call(front, brain, "listen", {}))["utterances"] == []


async def test_a_brain_that_takes_over_an_endpoint_reads_nothing_said_before(front):
    await front.server.deliver(front.utterance("ep-kitchen"))
    front.served["ep-kitchen"] = "brain-cloud"
    assert (await call(front, "brain-cloud", "listen", {}))["utterances"] == []


async def test_a_caller_with_no_credential_gets_401_and_nothing(front):
    """`serves-any-caller`: fails if the server answers without a credential."""
    await front.server.deliver(front.utterance())
    async with httpx2.AsyncClient(transport=front.transport) as http:
        r = await http.post(URL, content=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                                     "params": {"name": "listen", "arguments": {}}}),
                            headers={"Content-Type": "application/json", "MCP-Protocol-Version": "2026-07-28",
                                     "Accept": "application/json, text/event-stream"})
    assert r.status_code == 401
    assert "включи" not in r.text


async def test_a_long_listen_returns_when_an_utterance_is_delivered(front):
    got = {}

    async def brain():
        got["r"] = await call(front, "brain-local", "listen", {"wait_s": 10})

    async with anyio.create_task_group() as tg:
        tg.start_soon(brain)
        await anyio.sleep(0.3)
        await front.server.deliver(u := front.utterance())
    assert got["r"]["utterances"] == [u]


async def test_an_expired_cursor_is_cursor_expired(front):
    assert await error_of(front, "brain-local", "listen", {"cursor": "elsewhere.7"}) == "cursor_expired"


async def test_listen_remembers_the_version_the_brain_names(front):
    await call(front, "brain-local", "listen", {"front_version": "0.6"})
    await call(front, "brain-cloud", "listen", {})
    assert front.server.front_version("brain-local") == "0.6"
    assert front.server.front_version("brain-cloud") is None


async def test_say_at_a_served_endpoint_is_queued_with_a_new_id(front):
    got = await call(front, "brain-local", "say", {"endpoint": "ep-kitchen", "text": "Свет включен."})
    brain, say_id, request = front.speech.said[0]
    assert (brain, say_id, request["text"]) == ("brain-local", got["say_id"], "Свет включен.")


async def test_say_at_another_brains_endpoint_is_refused_and_not_spoken(front):
    """GA-VOICE-19: fails if `say` is taken for any endpoint."""
    assert await error_of(front, "brain-local", "say", {"endpoint": "ep-hall", "text": "Привет"}) == "not_permitted"
    assert await error_of(front, "brain-local", "say", {"endpoint": "ep-attic", "text": "Привет"}) == "not_permitted"
    assert front.speech.said == []


async def test_a_reply_to_another_brains_utterance_is_refused(front):
    await front.server.deliver(u := front.utterance("ep-hall"))
    code = await error_of(front, "brain-local", "say",
                          {"endpoint": "ep-kitchen", "text": "Да", "in_reply_to": u["utterance_id"]})
    assert code == "not_permitted"


async def test_a_piece_continues_only_the_same_brains_piece_at_the_same_endpoint(front):
    first = await call(front, "brain-cloud", "say", {"endpoint": "ep-hall", "text": "Раз."})
    code = await error_of(front, "brain-local", "say",
                          {"endpoint": "ep-kitchen", "text": "Два.", "continues": first["say_id"]})
    assert code == "not_permitted"
    front.served["ep-kitchen"] = "brain-cloud"
    code = await error_of(front, "brain-cloud", "say",
                          {"endpoint": "ep-kitchen", "text": "Два.", "continues": first["say_id"]})
    assert code == "invalid_request"


async def test_hush_is_taken_only_for_what_the_brain_owns(front):
    theirs = await call(front, "brain-cloud", "say", {"endpoint": "ep-hall", "text": "Раз."})
    assert await error_of(front, "brain-local", "hush", {"endpoint": "ep-hall"}) == "not_permitted"
    assert await error_of(front, "brain-local", "hush", {"say_id": theirs["say_id"]}) == "not_permitted"
    await front.server.deliver(u := front.utterance("ep-hall"))
    assert await error_of(front, "brain-local", "hush", {"utterance_id": u["utterance_id"]}) == "not_permitted"
    assert front.speech.hushed == []


async def test_hush_of_its_own_is_passed_on_and_of_nothing_known_is_empty(front):
    mine = await call(front, "brain-local", "say", {"endpoint": "ep-kitchen", "text": "Раз."})
    assert await call(front, "brain-local", "hush", {"say_id": mine["say_id"]}) == {}
    assert await call(front, "brain-local", "hush", {"say_id": "gone"}) == {}
    assert front.speech.hushed == [("brain-local", {"say_id": mine["say_id"]})]


async def test_hush_of_its_own_utterance_is_passed_on(front):
    await front.server.deliver(u := front.utterance("ep-kitchen"))
    assert await call(front, "brain-local", "hush", {"utterance_id": u["utterance_id"]}) == {}
    assert front.speech.hushed == [("brain-local", {"utterance_id": u["utterance_id"]})]


async def test_hush_by_a_brain_that_no_longer_serves_the_endpoint_is_refused(front):
    """GA-VOICE-19: fails if ownership of the piece or utterance is enough."""
    mine = await call(front, "brain-local", "say", {"endpoint": "ep-kitchen", "text": "Раз."})
    await front.server.deliver(u := front.utterance("ep-kitchen"))
    front.served["ep-kitchen"] = "brain-cloud"
    assert await error_of(front, "brain-local", "hush", {"say_id": mine["say_id"]}) == "not_permitted"
    assert await error_of(front, "brain-local", "hush", {"utterance_id": u["utterance_id"]}) == "not_permitted"
    assert front.speech.hushed == []


async def test_say_is_refused_when_the_endpoint_moves_while_the_store_is_awaited(front, monkeypatch):
    """GA-VOICE-19: fails if `say` checks `served_by` only before it awaits the store."""
    real = front.store.note_say

    async def moving(*a, **k):
        await real(*a, **k)
        front.served["ep-kitchen"] = "brain-cloud"

    monkeypatch.setattr(front.store, "note_say", moving)
    code = await error_of(front, "brain-local", "say", {"endpoint": "ep-kitchen", "text": "Раз."})
    assert code == "not_permitted"
    assert front.speech.said == []


async def test_a_played_report_goes_to_the_brain_that_said_the_piece(front):
    mine = await call(front, "brain-local", "say", {"endpoint": "ep-kitchen", "text": "Раз."})
    report = {"say_id": mine["say_id"], "endpoint": "ep-kitchen", "status": "full",
              "ended_at": "2026-09-28T10:00:03+03:00", "clock_epoch": "1"}
    assert await front.server.report_played(report)
    assert (await call(front, "brain-local", "listen", {}))["played"] == [report]
    assert (await call(front, "brain-cloud", "listen", {}))["played"] == []
    assert not await front.server.report_played({**report, "say_id": "unknown"})


async def test_a_brain_on_an_older_revision_reads_the_same(front):
    await front.server.deliver(u := front.utterance())
    older = httpx2.ASGITransport(app=OlderOnly(front.server.mcp.asgi(), "2025-11-25"))
    async with mcpwire.connect(URL, SECRETS["brain-local"], transport=older) as session:
        assert session.revision == "2025-11-25"
        assert (await session.call("listen", {}))["utterances"] == [u]


async def test_what_listen_returns_is_what_the_schema_says(front):
    await front.server.deliver(front.utterance())
    async with mcpwire.connect(URL, SECRETS["brain-local"], transport=front.transport, schemas=schemas()) as s:
        await s.call("listen", {}, request="brain/listen.request.json", response="brain/listen.response.json")


@pytest.mark.parametrize("tool,args", [
    ("listen", {}),
    ("say", {"endpoint": "ep-kitchen", "text": "Раз."}),
    ("say", {"endpoint": "ep-kitchen", "text": "Раз.", "in_reply_to": "u-1"}),
    ("say", {"endpoint": "ep-kitchen", "text": "Раз.", "continues": "s-1"}),
    ("hush", {"say_id": "s-1"}),
    ("hush", {"utterance_id": "u-1"}),
])
async def test_a_store_that_cannot_be_reached_is_an_internal_error(front, monkeypatch, tool, args):
    """Storage design, *When the store is unreachable*: fails if an outage
    reaches a brain as a result it could act on, or as anything but -32603."""
    async def unreachable(*a, **k):
        raise StoreUnavailable("down")

    for name in ("after", "say_of", "brain_of", "utterance_owner", "note_say"):
        monkeypatch.setattr(front.store, name, unreachable)
    with pytest.raises(mcpwire.Unavailable) as e:
        await call(front, "brain-local", tool, args)
    assert e.value.__cause__.code == -32603
    assert front.speech.said == [] and front.speech.hushed == []
