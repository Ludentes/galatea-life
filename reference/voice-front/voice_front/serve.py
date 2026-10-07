"""TLS for both links, and serving the brain server.

The front serves its brains over TLS the brain checks, and reaches the
steward over TLS it checks itself (voice, *Links, security and retention*;
GA-SEC-2), unless both ends are on one host's loopback, which the
configuration decides (`config.py`).
"""
from __future__ import annotations

import ssl
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

import anyio
import uvicorn
from starlette.types import ASGIApp

STARTUP_S = 10


def client_context(ca_file: Path | None = None) -> ssl.SSLContext:
    """What the front trusts when it calls: the system's roots, or the
    home's own CA if one is named. The certificate is always checked."""
    ctx = ssl.create_default_context(cafile=str(ca_file) if ca_file else None)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    return ctx


@asynccontextmanager
async def serving(app: ASGIApp, host: str, port: int, *, cert_file: Path | None = None,
                  key_file: Path | None = None) -> AsyncIterator[int]:
    """Serve `app` while the block runs; yields the port (useful with 0).
    The app's lifespan runs, which starts the MCP session manager."""
    config = uvicorn.Config(app, host=host, port=port, lifespan="on", log_level="warning",
                            ssl_certfile=str(cert_file) if cert_file else None,
                            ssl_keyfile=str(key_file) if key_file else None)
    server = uvicorn.Server(config)
    async with anyio.create_task_group() as tg:
        tg.start_soon(server.serve)
        with anyio.fail_after(STARTUP_S):
            while not server.started:
                await anyio.sleep(0.01)
        try:
            yield server.servers[0].sockets[0].getsockname()[1]
        finally:
            server.should_exit = True
