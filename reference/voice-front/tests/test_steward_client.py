"""The front as the steward's client: its view, the watch, the operations,
the sources. GA-VOICE-2, GA-VOICE-3, GA-VOICE-9, GA-VOICE-21; steward,
*Listening*, GA-AUTH-8.

A fake steward serves over the real MCP stack, in process. Each case names
the change that would redden it.
"""
import asyncio
import time
from contextlib import asynccontextmanager

import json

import anyio
import httpx2
import pytest
from mcp_types import CallToolResult, TextContent

from fake_steward import FRONT_SECRET, FakeSteward, voice
from mcp_doubles import URL, Failing, OlderOnly, in_process
from voice_front import listening, mcpwire
from voice_front.schemas import SchemaError, schemas
from voice_front.steward import SourceLog, Steward, view_of, watch_describe, watch_sources

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def steward():
    fake = FakeSteward()
    async with in_process(fake.server) as transport:
        fake.transport = transport
        yield fake


def opener(fake, transport=None):
    @asynccontextmanager
    async def open_():
        async with mcpwire.connect(URL, FRONT_SECRET, transport=transport or fake.transport,
                                   schemas=schemas()) as session:
            yield Steward(session)
    return open_


# ---- the view (no wire) -----------------------------------------------------

def described(**endpoint_changes):
    fake = FakeSteward()
    fake.endpoints["ep-kitchen"].update(endpoint_changes)
    return anyio.run(fake._describe, "front-1", {})


def test_the_view_reads_the_record_the_brain_and_the_home():
    v = view_of(described())
    e = v.endpoints["ep-kitchen"]
    assert e.record == listening.Record("wake_server", (listening.WakeWord("Компьютер", "transcript"),),
                                        follow_up=False, zone="kitchen", output="speech")
    assert (e.served_by, e.heard_by, e.type) == ("brain-local", "front-1", "voice")
    assert v.served_by() == {"ep-kitchen": "brain-local"}
    assert v.persons == {"p-owner"}
    assert v.other_wake_words == ("Алиса", "Окей, Гугл")
    assert v.audio_retention_s == 0


def test_narrowings_in_force_narrow_the_effective_setting():
    v = view_of(described(narrowings=[{"narrowing_id": "n1", "listening": "tap",
                                       "until": "2026-09-28T22:00:00+03:00", "cause": {"endpoint": "ep-kitchen"}}]))
    record, narrowings = v.settings()["ep-kitchen"]
    got = listening.effective(record, narrowings, runnable=frozenset({"transcript"}))
    assert (got.record.listening, got.reason) == ("tap", "narrowed")


def test_an_endpoint_whose_record_cannot_be_read_is_left_out_and_named():
    """Fails if a bad record is read as some default: the front must listen
    nowhere there."""
    v = view_of(described(voice={**voice(), "listening": "everything"}))
    assert v.endpoints == {} and v.skipped == ("ep-kitchen",)


def test_an_endpoint_with_no_voice_record_is_not_the_fronts():
    v = view_of(described(voice=None))
    assert v.endpoints == {} and v.skipped == ()


def test_a_negative_or_missing_retention_keeps_no_audio():
    fake = FakeSteward()
    fake.home["audio_retention_s"] = -5
    assert view_of(anyio.run(fake._describe, "front-1", {})).audio_retention_s == 0


# ---- the operations ---------------------------------------------------------

async def test_the_front_reaches_its_steward_at_2026_07_28(steward):
    async with opener(steward)() as st:
        assert st.revision == "2026-07-28"
        assert (await st.describe())["revision"] == 1


async def test_a_steward_that_predates_it_is_reached_through_the_handshake(steward):
    older = httpx2.ASGITransport(app=OlderOnly(steward.server.asgi(), "2025-11-25"))
    async with opener(steward, older)() as st:
        assert st.revision == "2025-11-25"


async def test_narrow_front_status_and_speaking_reach_the_steward(steward):
    async with opener(steward)() as st:
        got = await st.narrow("ep-kitchen", listening="tap")
        await st.front_status(models=[], clips=["Не могу ответить"],
                              effective={"ep-kitchen": {"listening": "tap", "reason": "narrowed"}},
                              frames={"ep-kitchen": {"read": 0, "discarded": 0}}, skills={})
        await st.speaking("ep-kitchen", True)
    assert got["narrowing_id"] == steward.endpoints["ep-kitchen"]["narrowings"][-1]["narrowing_id"]
    assert steward.called("narrow") == [{"endpoint": "ep-kitchen", "listening": "tap"}]
    assert steward.called("speaking") == [{"endpoint": "ep-kitchen", "on": True}]
    assert steward.called("front_status")[0]["clips"] == ["Не могу ответить"]


async def test_a_request_its_schema_refuses_is_never_sent(steward):
    async with opener(steward)() as st:
        with pytest.raises(SchemaError):
            await st.narrow("ep-kitchen", listening="everywhere")
    assert steward.called("narrow") == []


# ---- the watch --------------------------------------------------------------

async def test_a_narrowing_reaches_the_front_within_the_narrowing_delay(steward):
    """GA-VOICE-3 (2 s): fails if the front polls instead of waiting on the
    next revision."""
    views = []
    with anyio.fail_after(5):
        async with anyio.create_task_group() as tg:
            tg.start_soon(watch_describe, opener(steward), views.append, lambda e: None)
            while not views:
                await anyio.sleep(0.01)
            start = time.monotonic()
            steward.narrow_here("ep-kitchen", listening="off")
            while len(views) < 2:
                await anyio.sleep(0.01)
            took = time.monotonic() - start
            tg.cancel_scope.cancel()
    assert took < 2.0
    assert views[-1].settings()["ep-kitchen"][1] == (listening.Narrowing(listening="off"),)


async def test_a_lost_steward_is_reported_and_read_again_when_it_returns(steward):
    """GA-VOICE-2 `no_steward`: fails if a lost steward goes unnoticed."""
    failing = Failing(steward.server.asgi(), 503)
    views, lost = [], []
    with anyio.fail_after(5):
        async with anyio.create_task_group() as tg:
            tg.start_soon(lambda: watch_describe(opener(steward, httpx2.ASGITransport(app=failing)),
                                                 views.append, lost.append, retry_s=(0.05,)))
            while not lost:
                await anyio.sleep(0.01)
            assert views == []
            failing.failing = False
            while not views:
                await anyio.sleep(0.01)
            tg.cancel_scope.cancel()
    assert isinstance(lost[0], mcpwire.Unavailable)
    assert views[0].revision == steward.revision


async def test_a_result_breaking_its_own_schema_is_a_lost_steward(steward):
    """Fails if the SDK's RuntimeError from `call_tool` kills the watch silently."""
    class BadOut(mcpwire.ToolServer):
        async def call_tool(self, name, arguments, context=None):
            body = {"revision": "not-an-int"}
            return CallToolResult(content=[TextContent(type="text", text=json.dumps(body))],
                                  structured_content=body)

    bad = BadOut("x", list(steward.server._tools.values()), mcpwire.Credentials({"front-1": FRONT_SECRET}),
                 steward.server._schemas)
    lost = []
    async with in_process(bad) as transport:
        with anyio.fail_after(5):
            async with anyio.create_task_group() as tg:
                async def run():
                    await watch_describe(opener(steward, transport), lambda v: None,
                                         lambda e: (lost.append(e), tg.cancel_scope.cancel()), retry_s=(0.01,))
                tg.start_soon(run)
    assert isinstance(lost[0], mcpwire.Unavailable)


async def test_a_callback_that_fails_is_not_a_lost_steward(steward):
    """Fails if an OSError from `on_view` (a disk error saving the view) reads as `no_steward`."""
    lost = []

    def on_view(view):
        raise OSError("disk full")

    with anyio.fail_after(5):
        with pytest.raises(OSError, match="disk full"):
            await watch_describe(opener(steward), on_view, lost.append, retry_s=(0.01,))
    assert lost == []


# ---- the sources ------------------------------------------------------------

def test_a_source_starts_when_it_began_and_ends_when_it_is_no_longer_listed():
    log = SourceLog()
    log.update([{"target": "tv", "speech": "В эфире новости", "speaking_for_ms": 1500}], now=100.0)
    (s,) = log.spoken()
    assert (s.interval.start, s.interval.end, s.text) == (98.5, float("inf"), "В эфире новости")
    log.update([{"target": "tv", "speech": "В эфире новости", "speaking_for_ms": 4000}], now=102.5)
    assert log.spoken()[0].interval.start == 98.5          # fails if each listing restarts it
    log.update([], now=104.0)
    assert (log.spoken()[0].interval.start, log.spoken()[0].interval.end) == (98.5, 104.0)


def test_a_target_that_reports_no_speech_is_not_a_source():
    log = SourceLog()
    log.update([{"target": "tv", "speech": None, "speaking_for_ms": 0}], now=1.0)
    assert log.spoken() == []


def test_an_ended_source_is_forgotten_once_no_utterance_can_overlap_it():
    log = SourceLog(keep_s=60)
    log.update([{"target": "tv", "speech": "раз", "speaking_for_ms": 0}], now=0.0)
    log.update([], now=1.0)
    log.update([], now=61.0)
    assert len(log.spoken()) == 1
    log.update([], now=61.1)
    assert log.spoken() == []


async def test_the_sources_follow_the_steward(steward):
    log, clock = SourceLog(), [10.0]
    with anyio.fail_after(5):
        async with anyio.create_task_group() as tg:
            tg.start_soon(lambda: watch_sources(opener(steward), log, now=lambda: clock[0]))
            await anyio.sleep(0.2)
            steward.say_on("tv-hall", "Добрый вечер", speaking_for_ms=500)
            while not log.spoken():
                await anyio.sleep(0.01)
            tg.cancel_scope.cancel()
    assert log.spoken()[0].text == "Добрый вечер"
    assert log.spoken()[0].interval.start == 9.5


# ---- malformed content and a dropped transport --------------------------------

def test_content_the_schema_does_not_constrain_never_escapes_the_view():
    """Fails if junk in `describe` raises: the watch would die and the front
    freeze on its last view."""
    fake = FakeSteward()
    fake.endpoints["ep-junk"] = {"id": "ep-junk", "voice": voice(), "narrowings": ["junk"]}
    fake.endpoints["ep-list"] = {"id": "ep-list", "voice": voice(), "narrowings": "junk"}
    d = anyio.run(fake._describe, "front-1", {})
    d["endpoints"] += ["junk", 7]
    d["persons"] += [{"name": "no id"}, 3]
    v = view_of(d)
    assert set(v.endpoints) == {"ep-kitchen"}
    assert set(v.skipped) == {"ep-junk", "ep-list"}
    assert v.persons == {"p-owner"}


def test_other_wake_words_must_be_a_list_and_retention_a_number_not_a_bool():
    fake = FakeSteward()
    fake.home["other_wake_words"] = "Алиса"
    fake.home["audio_retention_s"] = True
    v = view_of(anyio.run(fake._describe, "front-1", {}))
    assert v.other_wake_words == () and v.audio_retention_s == 0


async def test_a_junk_narrowing_does_not_stop_the_watch(steward):
    views = []
    with anyio.fail_after(5):
        async with anyio.create_task_group() as tg:
            tg.start_soon(watch_describe, opener(steward), views.append, lambda e: None)
            while not views:
                await anyio.sleep(0.01)
            steward.endpoints["ep-kitchen"]["narrowings"].append("junk")
            steward.changed()
            while len(views) < 2:
                await anyio.sleep(0.01)
            steward.endpoints["ep-kitchen"]["narrowings"] = []
            steward.narrow_here("ep-kitchen", listening="tap")
            while len(views) < 3:
                await anyio.sleep(0.01)
            tg.cancel_scope.cancel()
    assert views[1].skipped == ("ep-kitchen",)
    assert views[2].settings()["ep-kitchen"][1] == (listening.Narrowing(listening="tap"),)


class Dropping(httpx2.AsyncBaseTransport):
    def __init__(self, inner):
        self.inner, self.dropping = inner, False

    async def handle_async_request(self, request):
        if self.dropping:
            raise httpx2.ReadError("connection dropped")
        return await self.inner.handle_async_request(request)


async def test_a_transport_dropped_mid_poll_is_a_lost_steward(steward):
    """Fails if a dropped connection kills the watch instead of being reported
    and read again."""
    drop = Dropping(steward.transport)
    views, lost = [], []
    with anyio.fail_after(5):
        async with anyio.create_task_group() as tg:
            tg.start_soon(lambda: watch_describe(opener(steward, drop), views.append, lost.append,
                                                 wait_s=0.05, retry_s=(0.05,)))
            while not views:
                await anyio.sleep(0.01)
            drop.dropping = True
            while not lost:
                await anyio.sleep(0.01)
            drop.dropping = False
            while len(views) < 2:
                await anyio.sleep(0.01)
            tg.cancel_scope.cancel()
    assert isinstance(lost[0], mcpwire.Unavailable)     # observed: a lone Unavailable, not a group


def test_a_group_of_lost_leaves_is_lost_and_a_cancellation_never_is():
    from voice_front.steward import _is_lost
    assert _is_lost(BaseExceptionGroup("g", [mcpwire.Unavailable("a"), OSError("b")]))
    assert not _is_lost(BaseExceptionGroup("g", [mcpwire.Unavailable("a"), asyncio.CancelledError()]))
    assert not _is_lost(ValueError("bug"))


async def test_a_lost_steward_ends_the_sources_it_had_listed(steward):
    """GA-VOICE-9: fails if a source stays open through an outage, so a
    person's words overlapping it read as machine."""
    failing = Failing(steward.server.asgi(), 503)
    failing.failing = False
    log, clock, lost = SourceLog(), [10.0], []
    steward.say_on("tv-hall", "Добрый вечер", speaking_for_ms=500)
    with anyio.fail_after(5):
        async with anyio.create_task_group() as tg:
            tg.start_soon(lambda: watch_sources(opener(steward, httpx2.ASGITransport(app=failing)), log,
                                                now=lambda: clock[0], on_lost=lost.append,
                                                wait_s=0.05, retry_s=(0.05,)))
            while not log.spoken():
                await anyio.sleep(0.01)
            clock[0] = 20.0
            failing.failing = True
            while not lost:
                await anyio.sleep(0.01)
            (s,) = log.spoken()
            assert s.interval.end != float("inf")
            tg.cancel_scope.cancel()


def test_close_ends_every_open_entry_at_the_last_good_response():
    log = SourceLog()
    log.update([{"target": "tv", "speech": "раз", "speaking_for_ms": 0}], now=5.0)
    log.close(5.0)
    (s,) = log.spoken()
    assert (s.interval.start, s.interval.end) == (5.0, 5.0)
    log.update([{"target": "tv", "speech": "раз", "speaking_for_ms": 0}], now=50.0)   # placed afresh
    assert [x.interval.start for x in log.spoken() if x.interval.end == float("inf")] == [50.0]
