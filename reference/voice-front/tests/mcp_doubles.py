"""Test doubles around an ASGI app, for the MCP binding's tests. Not tests.

`in_process` runs a `ToolServer` through the real Streamable HTTP stack
with no socket. `OlderOnly` makes a server look like one that predates
`2026-07-28`. `Recorder` lists what reached the app. `Failing` answers a
status of its choosing to the first requests.
"""
from __future__ import annotations

import json
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

import httpx2
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from voice_front import mcpwire

URL = "http://127.0.0.1:8000/mcp"   # the DNS-rebinding guard allows loopback names, with a port


async def _body(receive: Receive) -> bytes:
    body, more = b"", True
    while more:
        m = await receive()
        body += m.get("body", b"")
        more = m.get("more_body", False)
    return body


def _replay(body: bytes, receive: Receive):
    done = False

    async def replay() -> Message:
        nonlocal done
        if not done:
            done = True
            return {"type": "http.request", "body": body, "more_body": False}
        return await receive()
    return replay


async def _answer(send: Send, status: int, payload: Any) -> None:
    body = json.dumps(payload).encode() if payload is not None else b""
    headers = [(b"content-type", b"application/json")] if payload is not None else []
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body})


class OlderOnly:
    """A server that predates `2026-07-28`: a request at that revision gets
    what such a server answers a request with no session (400, -32600), and
    `initialize` is answered at `answer`."""

    def __init__(self, app: ASGIApp, answer: str):
        self.app, self.answer = app, answer

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = {k.decode().lower(): v.decode() for k, v in scope["headers"]}
        if headers.get("mcp-protocol-version") == mcpwire.MODERN:
            await _answer(send, 400, {"jsonrpc": "2.0", "id": "server-error",
                                      "error": {"code": -32600, "message": "Bad Request: Missing session ID"}})
            return
        body = await _body(receive)
        try:
            request = json.loads(body) if body else None
        except ValueError:
            request = None
        if isinstance(request, dict) and request.get("method") == "initialize":
            request["params"]["protocolVersion"] = self.answer
            body = json.dumps(request).encode()
        await self.app(scope, _replay(body, receive), send)


class Recorder:
    """Lists each POST's JSON-RPC method and the revision it named."""

    def __init__(self, app: ASGIApp):
        self.app = app
        self.seen: list[tuple[str | None, str | None]] = []

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] != "POST":
            await self.app(scope, receive, send)
            return
        headers = {k.decode().lower(): v.decode() for k, v in scope["headers"]}
        body = await _body(receive)
        try:
            method = json.loads(body).get("method")
        except (ValueError, AttributeError):
            method = None
        self.seen.append((method, headers.get("mcp-protocol-version")))
        await self.app(scope, _replay(body, receive), send)

    def methods(self) -> list[str | None]:
        return [m for m, _ in self.seen]


class Failing:
    """Answers `status` with no body to every request while `failing`."""

    def __init__(self, app: ASGIApp, status: int):
        self.app, self.status = app, status
        self.failing = True

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and self.failing:
            await _body(receive)
            await _answer(send, self.status, None)
            return
        await self.app(scope, receive, send)


@asynccontextmanager
async def in_process(server: mcpwire.ToolServer, app: ASGIApp | None = None) -> AsyncIterator[httpx2.ASGITransport]:
    """A transport to `app` (by default the server's own), with the server's
    session manager running, as its lifespan would run it."""
    app = app or server.asgi()
    server.http_app()
    async with server.session_manager.run():
        yield httpx2.ASGITransport(app=app)
