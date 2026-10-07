"""Both links over real TLS on this host's loopback, with a throwaway CA.
Voice, *Links, security and retention*; GA-SEC-2, GA-BRAIN-16.

Each case names the change that would redden it.
"""
import pytest

from fake_steward import FRONT_SECRET, FakeSteward
from tls_certs import make
from voice_front import mcpwire
from voice_front.brain import BrainServer
from voice_front.serve import client_context, serving
from voice_front.steward import opener
from voice_front.store import Store

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


class Silent:
    async def say(self, brain, say_id, request):
        pass

    async def hush(self, brain, request):
        pass


@pytest.fixture
def certs(tmp_path):
    return make(tmp_path)


@pytest.fixture
async def front(database, tmp_path):
    store = await Store.open(database, schema="voice_kitchen", audio_dir=tmp_path / "audio")
    # Closed whatever fails after it opens: a pool left open holds the run.
    try:
        yield BrainServer(store, Silent(), lambda: {"ep-kitchen": "brain-local"}, {"brain-local": "secret-local"})
    finally:
        await store.close()


async def test_a_brain_reaches_the_front_over_tls_it_checks(front, certs):
    ca, cert, key = certs
    async with serving(front.mcp.asgi(), "127.0.0.1", 0, cert_file=cert, key_file=key) as port:
        async with mcpwire.connect(f"https://127.0.0.1:{port}/mcp", "secret-local",
                                   verify=client_context(ca)) as session:
            assert session.revision == "2026-07-28"
            assert (await session.call("listen", {}))["utterances"] == []


async def test_a_certificate_the_caller_cannot_check_is_refused(front, certs):
    """Fails if the client stops checking certificates."""
    _, cert, key = certs
    async with serving(front.mcp.asgi(), "127.0.0.1", 0, cert_file=cert, key_file=key) as port:
        with pytest.raises(mcpwire.Unavailable):
            async with mcpwire.connect(f"https://127.0.0.1:{port}/mcp", "secret-local",
                                       verify=client_context(None)):
                pass


async def test_a_certificate_for_another_name_is_refused(front, tmp_path):
    """Fails if the client stops checking the name, not only the chain."""
    ca, cert, key = make(tmp_path, ("other.example",))
    async with serving(front.mcp.asgi(), "127.0.0.1", 0, cert_file=cert, key_file=key) as port:
        with pytest.raises(mcpwire.Unavailable):
            async with mcpwire.connect(f"https://127.0.0.1:{port}/mcp", "secret-local",
                                       verify=client_context(ca)):
                pass


async def test_plain_http_to_a_tls_port_reaches_nothing(front, certs):
    _, cert, key = certs
    async with serving(front.mcp.asgi(), "127.0.0.1", 0, cert_file=cert, key_file=key) as port:
        with pytest.raises(mcpwire.Unavailable):
            async with mcpwire.connect(f"http://127.0.0.1:{port}/mcp", "secret-local"):
                pass


async def test_the_front_reaches_its_steward_over_tls(certs):
    ca, cert, key = certs
    fake = FakeSteward()
    async with serving(fake.server.asgi(), "127.0.0.1", 0, cert_file=cert, key_file=key) as port:
        open_ = opener(f"https://127.0.0.1:{port}/mcp", FRONT_SECRET, verify=client_context(ca))
        async with open_() as steward:
            assert (await steward.describe())["revision"] == fake.revision


async def test_on_loopback_the_front_may_serve_without_tls(front):
    async with serving(front.mcp.asgi(), "127.0.0.1", 0) as port:
        async with mcpwire.connect(f"http://127.0.0.1:{port}/mcp", "secret-local") as session:
            assert session.revision == "2026-07-28"
