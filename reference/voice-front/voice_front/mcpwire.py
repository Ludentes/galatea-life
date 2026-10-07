"""MCP as the standards bind it: tools named as the operations, each with the
operation's JSON Schema, a bearer credential on every request, and the
revision rule of GA-VOICE-21 (applier, *The MCP binding*).

Serving: revision `2026-07-28`, and `2025-11-25` and `2025-06-18` through
the older handshake; no other revision (`RevisionGate`).

Calling: `server/discover` at `2026-07-28` first. The older handshake is
used only when the server says it does not serve that revision: it does not
know the method (-32601, or 404 before a session), it wants the handshake
first (-32600), or it names only older revisions. An outage, a refused
credential or a server error is no verdict on the revision: the call fails
and is retried later, at `2026-07-28` again (`calls-the-steward-at-2025`).
The SDK's own `mode="auto"` falls back on any error, so it is not used.

Errors are tool results with `isError` and the body `{ error, message }`,
the code from the standards' `errorCode`.
"""
from __future__ import annotations

import copy
import hmac
import json
import ssl
from contextlib import AsyncExitStack, asynccontextmanager
from dataclasses import dataclass
from typing import Any, AsyncIterator, Awaitable, Callable, Mapping

import httpx2
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from mcp.server import MCPServer
from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.provider import AccessToken
from mcp.server.auth.settings import AuthSettings
from mcp.server.transport_security import DEFAULT_MAX_REQUEST_BODY_SIZE, TransportSecuritySettings
from mcp.shared.exceptions import MCPError
from mcp_types import (INVALID_REQUEST, METHOD_NOT_FOUND, UNSUPPORTED_PROTOCOL_VERSION,
                       CallToolResult, DiscoverResult, TextContent, ToolAnnotations)
from mcp_types import Tool as MCPTool
from pydantic import ValidationError
from starlette.responses import Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from voice_front.schemas import SchemaError, Schemas

MODERN = "2026-07-28"
HANDSHAKE = ("2025-11-25", "2025-06-18")
SERVED = (MODERN, *HANDSHAKE)
PATH = "/mcp"
MAX_BODY_BYTES = DEFAULT_MAX_REQUEST_BODY_SIZE    # the SDK's own cap (4 MiB), which the gate must not bypass
LONGEST_POLL_S = 30         # `wait_s` at most, everywhere (steward, brain)


# ---- serving ---------------------------------------------------------------

class Credentials:
    """Bearer credentials, each naming one caller. Compared in constant time;
    a credential is never logged or echoed."""

    def __init__(self, by_caller: Mapping[str, str]):
        self._pairs = [(secret.encode(), caller) for caller, secret in by_caller.items()]

    async def verify_token(self, token: str) -> AccessToken | None:
        found = None
        for secret, caller in self._pairs:
            if hmac.compare_digest(secret, token.encode()):
                found = caller
        return None if found is None else AccessToken(token=token, client_id=found, scopes=[])


class ToolError(Exception):
    """A request error: `code` is one of the standards' error codes."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


Handler = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]


@dataclass(frozen=True)
class Tool:
    name: str
    handler: Handler                # (caller, arguments) -> result
    request: str                    # schema ids
    response: str
    read_only: bool = False
    destructive: bool = False


def inlined(schemas: Schemas, schema_id: str) -> dict:
    """The schema with every `$ref` to another file replaced by what it names,
    so a client needs no file of ours to read it."""
    def resolve(ref: str, base: str) -> dict:
        file, _, pointer = ref.partition("#")
        target = _join(base, file) if file else base
        node: Any = schemas.schema(target)
        for part in [p for p in pointer.split("/") if p]:
            node = node[part]
        return walk(copy.deepcopy(node), target)

    def walk(node: Any, base: str) -> Any:
        if isinstance(node, dict):
            if "$ref" in node:
                rest = {k: walk(v, base) for k, v in node.items() if k != "$ref"}
                return {**resolve(node["$ref"], base), **rest}
            return {k: walk(v, base) for k, v in node.items() if k not in ("$id", "$schema")}
        if isinstance(node, list):
            return [walk(v, base) for v in node]
        return node

    return walk(copy.deepcopy(schemas.schema(schema_id)), schema_id)


def _join(base: str, ref: str) -> str:
    parts = base.split("/")[:-1]
    for p in ref.split("/"):
        if p == "..":
            parts.pop()
        elif p != ".":
            parts.append(p)
    return "/".join(parts)


def error_result(code: str, message: str) -> CallToolResult:
    body = {"error": code, "message": message}
    return CallToolResult(content=[TextContent(type="text", text=json.dumps(body))],
                          structured_content=body, is_error=True)


class ToolServer(MCPServer):
    """An MCP server whose tools are the standard's operations: each takes and
    returns what its schema says, and is called with the caller's id."""

    def __init__(self, name: str, tools: list[Tool], credentials: Credentials, schemas: Schemas,
                 *, allowed_hosts: list[str] | None = None):
        # issuer_url is required by the SDK even when no one issues tokens.
        super().__init__(name, token_verifier=credentials,
                         auth=AuthSettings(issuer_url="https://issuer.invalid", resource_server_url=None))
        self._security = (TransportSecuritySettings(enable_dns_rebinding_protection=True,
                                                    allowed_hosts=allowed_hosts)
                          if allowed_hosts is not None else None)
        self._tools = {t.name: t for t in tools}
        self._app: ASGIApp | None = None
        self._schemas = schemas

    async def list_tools(self) -> list[MCPTool]:
        return [MCPTool(name=t.name,
                        input_schema=inlined(self._schemas, t.request),
                        output_schema=inlined(self._schemas, t.response),
                        annotations=ToolAnnotations(read_only_hint=t.read_only,
                                                    destructive_hint=t.destructive))
                for t in self._tools.values()]

    async def call_tool(self, name: str, arguments: dict[str, Any], context: Any = None) -> CallToolResult:
        token = get_access_token()
        if token is None:           # unreachable behind the auth middleware
            return error_result("not_permitted", "no credential")
        tool = self._tools.get(name)
        if tool is None:
            return error_result("invalid_request", f"no tool {name!r}")
        try:
            self._schemas.check(tool.request, arguments)
        except SchemaError as e:
            return error_result("invalid_request", str(e))
        try:
            result = await tool.handler(token.client_id, arguments)
        except ToolError as e:
            return error_result(e.code, str(e))
        self._schemas.check(tool.response, result)      # ours: a failure is a bug
        return CallToolResult(content=[TextContent(type="text", text=json.dumps(result, ensure_ascii=False))],
                              structured_content=result)

    def http_app(self) -> ASGIApp:
        """The Streamable HTTP app at `/mcp`, with no revision gate; built once.
        Its lifespan runs the session manager; a test runs it with
        `async with server.session_manager.run()`."""
        if self._app is None:
            self._app = self.streamable_http_app(stateless_http=True, transport_security=self._security)
        return self._app

    def asgi(self) -> ASGIApp:
        """What is served: `http_app()` behind the revision gate."""
        return RevisionGate(self.http_app())


class RevisionGate:
    """Answers only `SERVED` (GA-VOICE-21).

    A request naming another revision in `MCP-Protocol-Version`, or a request
    with no such header after the handshake (which the older revisions read
    as `2025-03-26`), gets HTTP 400 with JSON-RPC -32022. An `initialize`
    offering an older revision is answered with `2025-11-25`, as the
    handshake says: a server answers with a revision it serves.
    """

    def __init__(self, app: ASGIApp, path: str = PATH):
        self.app = app
        self.path = path

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["path"] != self.path:
            await self.app(scope, receive, send)
            return
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
        named = headers.get("mcp-protocol-version")
        if named is not None and named not in SERVED:
            await _refuse(send, None, named)
            return
        if scope["method"] != "POST":
            await self.app(scope, receive, send)
            return
        declared = headers.get("content-length", "")
        if declared.isdigit() and int(declared) > MAX_BODY_BYTES:
            await _too_large(scope, receive, send)      # before reading a byte
            return
        received = bytearray()
        more = True
        while more:
            message = await receive()
            received += message.get("body", b"")
            if len(received) > MAX_BODY_BYTES:          # chunked, or a lying length
                await _too_large(scope, receive, send)
                return
            more = message.get("more_body", False)
        body = bytes(received)
        try:
            request = json.loads(body)
        except ValueError:
            request = None
        if isinstance(request, dict) and request.get("method") == "initialize":
            params = request.get("params") or {}
            if params.get("protocolVersion") not in SERVED:
                params["protocolVersion"] = HANDSHAKE[0]
                request["params"] = params
                body = json.dumps(request).encode()
        elif named is None and isinstance(request, dict) and "id" in request:
            await _refuse(send, request.get("id"), "2025-03-26")
            return

        replayed = False

        async def replay() -> Message:
            nonlocal replayed
            if not replayed:
                replayed = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        await self.app(scope, replay, send)


async def _too_large(scope: Scope, receive: Receive, send: Send) -> None:
    await Response("Request body too large", status_code=413)(scope, receive, send)


async def _refuse(send: Send, request_id: Any, named: str) -> None:
    body = json.dumps({"jsonrpc": "2.0", "id": request_id, "error": {
        "code": UNSUPPORTED_PROTOCOL_VERSION, "message": "Unsupported protocol version",
        "data": {"supported": list(SERVED), "requested": named}}}).encode()
    await send({"type": "http.response.start", "status": 400,
                "headers": [(b"content-type", b"application/json"),
                            (b"content-length", str(len(body)).encode())]})
    await send({"type": "http.response.body", "body": body})


# ---- calling ---------------------------------------------------------------

class Unavailable(Exception):
    """The server could not be reached, refused the credential, or failed:
    no verdict on its revision."""


class RevisionRefused(Exception):
    """The server serves none of the revisions this front may use."""


class CallError(Exception):
    """A tool result with `isError`: `code` is the body's `error`."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code


def _older_only(e: MCPError) -> bool:
    """Does this answer to `server/discover` say the server does not serve
    `2026-07-28`?"""
    if e.code in (METHOD_NOT_FOUND, INVALID_REQUEST):
        return True
    if e.code == UNSUPPORTED_PROTOCOL_VERSION:
        supported = (e.error.data or {}).get("supported") if isinstance(e.error.data, dict) else None
        return isinstance(supported, list) and MODERN not in supported
    return False


class Session:
    def __init__(self, client: Client, schemas: Schemas | None):
        self._client = client
        self._schemas = schemas

    @property
    def revision(self) -> str:
        return self._client.protocol_version

    async def call(self, name: str, arguments: dict[str, Any], *,
                   request: str | None = None, response: str | None = None) -> dict[str, Any]:
        """Call a tool; the result's body, checked against `response` if named.
        Raises `CallError` for a tool error, `Unavailable` for anything else
        that stops the call."""
        if self._schemas is not None and request is not None:
            self._schemas.check(request, arguments)
        try:
            result = await self._client.call_tool(name, arguments)
        except MCPError as e:
            raise Unavailable(f"{name}: {e}") from e
        except httpx2.HTTPError as e:
            raise Unavailable(f"{name}: {e!r}") from e
        except (RuntimeError, ValidationError) as e:
            # The SDK's own checks of a result: structured content that breaks
            # the tool's declared output schema, none where one is declared,
            # a schema it cannot resolve.
            raise Unavailable(f"{name}: {e}") from e
        body = result.structured_content
        if body is None and result.content and isinstance(result.content[0], TextContent):
            try:
                body = json.loads(result.content[0].text)
            except ValueError:
                body = None
        if not isinstance(body, dict):
            raise Unavailable(f"{name}: the result is not a JSON object")
        if result.is_error:
            raise CallError(str(body.get("error")), str(body.get("message", "")))
        if self._schemas is not None and response is not None:
            self._schemas.check(response, body)
        return body


def _single(group: BaseExceptionGroup) -> BaseException | None:
    """The one exception inside nested groups, or None if there are several."""
    leaves: list[BaseException] = []

    def walk(e: BaseException) -> None:
        if isinstance(e, BaseExceptionGroup):
            for x in e.exceptions:
                walk(x)
        else:
            leaves.append(e)
    walk(group)
    return leaves[0] if len(leaves) == 1 else None


@asynccontextmanager
async def connect(url: str, credential: str, *, verify: ssl.SSLContext | bool = True,
                  transport: httpx2.AsyncBaseTransport | None = None,
                  schemas: Schemas | None = None,
                  read_timeout_s: float = LONGEST_POLL_S + 30) -> AsyncIterator[Session]:
    """A session with the server at `url`, at `2026-07-28` where it serves it.

    `read_timeout_s` must outlast the longest `wait_s`: httpx's default of 5 s
    would cut every long poll. The SDK's task groups wrap what is raised
    inside them; a lone exception is raised as itself.
    """
    try:
        async with _connect(url, credential, verify, transport, schemas, read_timeout_s) as session:
            yield session
    except BaseExceptionGroup as group:
        lone = _single(group)
        if lone is None:
            raise
        if isinstance(lone, (httpx2.HTTPError, OSError)):
            raise Unavailable(f"{url}: {lone!r}") from lone
        lone.__suppress_context__ = True        # not `from None`: that would drop its own cause
        raise lone
    except (httpx2.HTTPError, OSError) as e:
        raise Unavailable(f"{url}: {e!r}") from e


@asynccontextmanager
async def _connect(url: str, credential: str, verify: ssl.SSLContext | bool,
                   transport: httpx2.AsyncBaseTransport | None, schemas: Schemas | None,
                   read_timeout_s: float) -> AsyncIterator[Session]:
    http_kwargs: dict[str, Any] = {
        "headers": {"Authorization": f"Bearer {credential}"},
        "timeout": httpx2.Timeout(10.0, read=read_timeout_s),
        "verify": verify,
    }
    if transport is not None:
        http_kwargs["transport"] = transport
    async with httpx2.AsyncClient(**http_kwargs) as http:
        try:
            async with Client(streamable_http_client(url, http_client=http), mode=MODERN) as client:
                # `mode=MODERN` adopts without asking, so `discover()` would
                # answer from a result the SDK made up; send the probe itself.
                try:
                    raw = await client.session.send_discover(MODERN)
                except MCPError as e:
                    if not _older_only(e):
                        raise Unavailable(f"server/discover: {e}") from e
                    raw = None
                if raw is not None:
                    try:
                        found = DiscoverResult.model_validate(raw)
                    except ValidationError as e:
                        raise Unavailable("server/discover: an unreadable result") from e
                    if MODERN in found.supported_versions:
                        yield Session(client, schemas)
                        return
        except httpx2.HTTPError as e:
            raise Unavailable(f"{url}: {e!r}") from e
        try:
            async with AsyncExitStack() as stack:
                try:
                    client = await stack.enter_async_context(
                        Client(streamable_http_client(url, http_client=http), mode="legacy"))
                except (BaseExceptionGroup, RuntimeError, ValidationError) as e:
                    failure = _handshake_failure(e)
                    if failure is None:
                        raise
                    raise failure from e
                if client.protocol_version not in HANDSHAKE:
                    raise RevisionRefused(client.protocol_version)
                yield Session(client, schemas)
        except MCPError as e:
            raise Unavailable(f"initialize: {e}") from e
        except httpx2.HTTPError as e:
            raise Unavailable(f"{url}: {e!r}") from e


def _handshake_failure(e: BaseException) -> Exception | None:
    """What the older handshake's failure means, if it is one the SDK raises
    for a server's answer: a revision outside its list (the server serves
    none we may use), or a result it cannot read. Anything else, and
    cancellation, is left as it is."""
    if isinstance(e, BaseExceptionGroup):
        lone = _single(e)
        return None if lone is None or isinstance(lone, BaseExceptionGroup) else _handshake_failure(lone)
    if isinstance(e, ValidationError):
        return Unavailable("initialize: an unreadable result")
    if isinstance(e, RuntimeError):
        if str(e).startswith("Unsupported protocol version"):
            return RevisionRefused(str(e))
        return Unavailable(f"initialize: {e}")
    return None
