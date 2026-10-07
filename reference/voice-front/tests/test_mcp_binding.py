"""The MCP binding: revisions served and used, credentials, the schemas.
GA-VOICE-21; applier, *The MCP binding*.

Each case names the change that would redden it. The server here is a
stand-in with the brain's three tools; `test_brain_server.py` tests the real
ones.
"""
import json

import httpx2
import pytest
from mcp_types import CallToolResult, TextContent

from mcp_doubles import URL, Failing, OlderOnly, Recorder, _answer, _body, _replay, in_process
from voice_front import mcpwire
from voice_front.schemas import schemas

pytestmark = pytest.mark.anyio

BRAIN = "brain-local"
SECRET = "s3cret-brain-local"


@pytest.fixture
def anyio_backend():
    return "asyncio"


def server() -> mcpwire.ToolServer:
    async def listen(caller, args):
        if args.get("cursor") == "boom":
            raise mcpwire.ToolError("cursor_expired", "older than the front keeps")
        return {"utterances": [], "played": [], "cursor": caller}

    async def say(caller, args):
        return {"say_id": "s-1"}

    async def hush(caller, args):
        return {}

    return mcpwire.ToolServer("front", [
        mcpwire.Tool("listen", listen, "brain/listen.request.json", "brain/listen.response.json", read_only=True),
        mcpwire.Tool("say", say, "brain/say.request.json", "brain/say.response.json"),
        mcpwire.Tool("hush", hush, "brain/hush.request.json", "brain/hush.response.json"),
    ], mcpwire.Credentials({BRAIN: SECRET}), schemas())


async def test_a_modern_server_is_reached_at_2026_07_28_and_knows_the_caller():
    s = server()
    async with in_process(s) as transport:
        async with mcpwire.connect(URL, SECRET, transport=transport) as session:
            assert session.revision == "2026-07-28"
            assert (await session.call("listen", {}))["cursor"] == BRAIN


@pytest.mark.parametrize("older", ["2025-11-25", "2025-06-18"])
async def test_a_server_that_predates_it_is_reached_through_the_handshake(older):
    s = server()
    async with in_process(s, OlderOnly(s.asgi(), older)) as transport:
        async with mcpwire.connect(URL, SECRET, transport=transport) as session:
            assert session.revision == older
            assert (await session.call("listen", {}))["cursor"] == BRAIN


async def test_a_server_answering_an_older_handshake_is_refused():
    """Fails if the client takes whatever the handshake answers."""
    s = server()
    app = OlderOnly(s.http_app(), "2024-11-05")     # no revision gate
    async with in_process(s, app) as transport:
        with pytest.raises(mcpwire.RevisionRefused):
            async with mcpwire.connect(URL, SECRET, transport=transport):
                pass


@pytest.mark.parametrize("status", [401, 500, 503])
async def test_a_refusal_or_a_failure_is_no_reason_to_fall_back(status):
    """`calls-the-steward-at-2025`: fails if an error at discover leads to the
    handshake with a server that serves 2026-07-28."""
    s = server()
    rec = Recorder(Failing(s.asgi(), status))
    async with in_process(s, rec) as transport:
        with pytest.raises(mcpwire.Unavailable):
            async with mcpwire.connect(URL, SECRET, transport=transport):
                pass
    assert rec.methods() == ["server/discover"]


async def test_a_wrong_credential_reaches_nothing():
    s = server()
    rec = Recorder(s.asgi())
    async with in_process(s, rec) as transport:
        with pytest.raises(mcpwire.Unavailable):
            async with mcpwire.connect(URL, "not-a-credential", transport=transport):
                pass
    assert "initialize" not in rec.methods()


async def _post(transport, body, headers):
    async with httpx2.AsyncClient(transport=transport) as http:
        return await http.post(URL, content=json.dumps(body), headers={
            "Authorization": f"Bearer {SECRET}", "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream", **headers})


@pytest.mark.parametrize("named", ["2024-11-05", "2025-03-26", "2099-01-01"])
async def test_a_request_at_another_revision_is_refused(named):
    """Fails if the gate is removed: the SDK serves 2024-11-05 and 2025-03-26."""
    s = server()
    async with in_process(s) as transport:
        r = await _post(transport, {"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                        {"MCP-Protocol-Version": named})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == -32022


async def test_a_request_with_no_revision_is_read_as_2025_03_26_and_refused():
    s = server()
    async with in_process(s) as transport:
        r = await _post(transport, {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, {})
    assert r.status_code == 400


async def test_a_handshake_offering_an_older_revision_is_answered_with_2025_11_25():
    s = server()
    async with in_process(s) as transport:
        r = await _post(transport, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "clientInfo": {"name": "t", "version": "0"}}}, {})
    assert r.status_code == 200
    assert '"protocolVersion":"2025-11-25"' in r.text.replace(" ", "")


async def test_a_tool_error_carries_the_code():
    s = server()
    async with in_process(s) as transport:
        async with mcpwire.connect(URL, SECRET, transport=transport) as session:
            with pytest.raises(mcpwire.CallError) as e:
                await session.call("listen", {"cursor": "boom"})
    assert e.value.code == "cursor_expired"


async def test_arguments_the_schema_refuses_are_invalid_request():
    s = server()
    async with in_process(s) as transport:
        async with mcpwire.connect(URL, SECRET, transport=transport) as session:
            with pytest.raises(mcpwire.CallError) as e:
                await session.call("listen", {"wait_s": 31})
            with pytest.raises(mcpwire.CallError) as both:
                await session.call("hush", {"endpoint": "e", "say_id": "s"})
    assert e.value.code == both.value.code == "invalid_request"


async def test_the_tools_carry_their_schemas_whole():
    """A client reads each schema with no file of ours: no `$ref` is left."""
    tools = {t.name: t for t in await server().list_tools()}
    assert set(tools) == {"listen", "say", "hush"}
    listed = json.dumps([t.output_schema for t in tools.values()] + [t.input_schema for t in tools.values()])
    assert "$ref" not in listed
    assert tools["listen"].annotations.read_only_hint is True
    played = tools["listen"].output_schema["properties"]["played"]["items"]["properties"]["status"]
    assert played["enum"] == ["full", "cut", "dropped"]


# ---- what the SDK raises that is no MCPError --------------------------------

class BadOutput(mcpwire.ToolServer):
    """A server whose tool answers structured content its own output schema refuses."""

    async def call_tool(self, name, arguments, context=None):
        body = {"cursor": 7}
        return CallToolResult(content=[TextContent(type="text", text=json.dumps(body))], structured_content=body)


async def test_a_result_breaking_its_own_output_schema_is_unavailable():
    """Fails if the SDK's RuntimeError from `call_tool` escapes `Session.call`."""
    base = server()
    bad = BadOutput("front", list(base._tools.values()), mcpwire.Credentials({BRAIN: SECRET}), schemas())
    async with in_process(bad) as transport:
        async with mcpwire.connect(URL, SECRET, transport=transport) as session:
            with pytest.raises(mcpwire.Unavailable):
                await session.call("listen", {})


class Garbling:
    """A server that predates `2026-07-28` and answers `initialize` with `result`."""

    def __init__(self, app, result):
        self.app, self.result = app, result

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = {k.decode().lower(): v.decode() for k, v in scope["headers"]}
        if headers.get("mcp-protocol-version") == mcpwire.MODERN:
            await _answer(send, 400, {"jsonrpc": "2.0", "id": "server-error",
                                      "error": {"code": -32600, "message": "Bad Request: Missing session ID"}})
            return
        body = await _body(receive)
        request = json.loads(body) if body else None
        if isinstance(request, dict) and request.get("method") == "initialize":
            await _answer(send, 200, {"jsonrpc": "2.0", "id": request["id"], "result": self.result})
            return
        await self.app(scope, _replay(body, receive), send)


async def test_a_handshake_answering_an_unknown_revision_is_refused():
    """Fails if the SDK's RuntimeError for a revision outside its list escapes."""
    s = server()
    result = {"protocolVersion": "2099-01-01", "capabilities": {}, "serverInfo": {"name": "x", "version": "1"}}
    async with in_process(s, Garbling(s.http_app(), result)) as transport:
        with pytest.raises(mcpwire.RevisionRefused):
            async with mcpwire.connect(URL, SECRET, transport=transport):
                pass


async def test_a_handshake_answering_an_unreadable_result_is_unavailable():
    """Fails if pydantic's ValidationError from `initialize` escapes."""
    s = server()
    async with in_process(s, Garbling(s.http_app(), {"protocolVersion": 5})) as transport:
        with pytest.raises(mcpwire.Unavailable):
            async with mcpwire.connect(URL, SECRET, transport=transport):
                pass


# ---- the gate reads no more than the SDK would ------------------------------

class Reached:
    """An app that notes it was called, and answers 200."""

    def __init__(self):
        self.calls = 0

    async def __call__(self, scope, receive, send):
        self.calls += 1
        await _answer(send, 200, {})


def _post_gate(gate, **kwargs):
    client = httpx2.AsyncClient(transport=httpx2.ASGITransport(app=gate), base_url="http://127.0.0.1:8000")
    return client.post("/mcp", headers={"mcp-protocol-version": mcpwire.MODERN}, **kwargs)


async def test_a_body_declared_over_the_cap_is_refused_before_it_is_read():
    """Fails if the gate buffers a declared-too-large body before refusing."""
    inner, read = Reached(), []

    async def gate(scope, receive, send):
        async def spy():
            read.append(1)
            return await receive()
        await mcpwire.RevisionGate(inner)(scope, spy, send)

    response = await _post_gate(gate, content=b"x" * (mcpwire.MAX_BODY_BYTES + 1))
    assert response.status_code == 413
    assert (read, inner.calls) == ([], 0)


async def test_a_chunked_body_is_refused_once_it_passes_the_cap():
    """Fails if a body with no length is accumulated without limit."""
    inner = Reached()
    seen = 0

    async def chunks():
        nonlocal seen
        for _ in range(64):
            seen += 1
            yield b"x" * (256 * 1024)

    response = await _post_gate(mcpwire.RevisionGate(inner), content=chunks())
    assert response.status_code == 413
    assert inner.calls == 0
    assert seen < 64            # it stopped reading, it did not wait for the end
