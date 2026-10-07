"""The store: order, cursors, keeping across restarts, brains apart, audio.
Brain, *The front*; GA-VOICE-15, GA-VOICE-19; the storage design.

Against a real Postgres (`database`, see conftest). Each case names the
change that would redden it.
"""
import time
import uuid

import anyio
import psycopg
import pytest

from voice_front.store import KEEP_AT_LEAST_S, CursorExpired, Store, StoreUnavailable

pytestmark = pytest.mark.anyio

SCHEMA = "voice_kitchen"


@pytest.fixture
def anyio_backend():
    return "asyncio"


class Clock:
    def __init__(self, t: float = 1_000_000.0):
        self.t = t

    def __call__(self) -> float:
        return self.t


def utterance(endpoint="ep-kitchen", transcript="включи свет"):
    return {"utterance_id": str(uuid.uuid4()), "endpoint": endpoint, "transcript": transcript,
            "time": "2026-09-28T10:00:00+03:00", "available_at": "2026-09-28T10:00:01+03:00"}


def played(say_id="s-1", endpoint="ep-kitchen"):
    return {"say_id": say_id, "endpoint": endpoint, "status": "full", "clock_epoch": "1"}


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
async def opener(database, tmp_path, clock):
    """Opens stores and closes every one at teardown, so a failing assertion
    never leaks a pool (its tasks would block the runner's teardown)."""
    opened = []

    async def open_(schema=SCHEMA, **kw):
        s = await Store.open(database, schema=schema, audio_dir=tmp_path / "audio", now=clock, **kw)
        opened.append(s)
        return s
    yield open_
    for s in opened:
        await s.close()


@pytest.fixture
async def store(opener):
    s = await opener()
    yield s
    await s.close()


def rows(database, query):
    with psycopg.connect(database) as conn:
        return conn.execute(query).fetchall()


async def test_items_come_back_in_order_and_the_cursor_moves_past_them(store):
    a, b = utterance(), utterance()
    await store.add_utterance("brain-1", a)
    await store.add_played("brain-1", played())
    await store.add_utterance("brain-1", b)
    us, ps, cursor = await store.after("brain-1", None)
    assert [u["utterance_id"] for u in us] == [a["utterance_id"], b["utterance_id"]]
    assert ps == [played()]
    assert await store.after("brain-1", cursor) == ([], [], cursor)


async def test_a_brain_reads_only_what_was_delivered_to_it(store):
    """GA-VOICE-19: fails if `after` ignores the brain."""
    await store.add_utterance("brain-1", utterance())
    await store.add_played("brain-2", played())
    assert (await store.after("brain-2", None))[0] == []
    assert (await store.after("brain-1", None))[1] == []


async def test_the_cursor_passes_other_brains_items(store):
    await store.add_utterance("brain-2", utterance())
    _, _, cursor = await store.after("brain-1", None)
    await store.add_utterance("brain-1", u := utterance())
    assert (await store.after("brain-1", cursor))[0] == [u]


async def test_what_is_kept_survives_a_restart_and_so_does_the_cursor(opener):
    s = await opener()
    await s.add_utterance("brain-1", u := utterance())
    _, _, cursor = await s.after("brain-1", None)
    await s.add_utterance("brain-1", later := utterance())
    await s.close()
    again = await opener()
    assert (await again.after("brain-1", None))[0] == [u, later]
    assert (await again.after("brain-1", cursor))[0] == [later]
    await again.close()


async def test_the_schema_is_the_fronts_own_and_migrated_once(opener, database):
    """Storage design, *Inside a build*: fails if the tables leave the
    front's schema, or a restart applies a migration again."""
    await (await opener()).close()
    await (await opener()).close()
    assert rows(database, f"SELECT name FROM {SCHEMA}.migrations") == [("0001_store.sql",)]
    tables = {r[0] for r in rows(database, "SELECT table_name FROM information_schema.tables"
                                           f" WHERE table_schema = '{SCHEMA}'")}
    assert {"log", "says", "audio", "meta", "migrations"} <= tables
    assert rows(database, "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'") == [(0,)]


async def test_a_cursor_from_another_store_is_expired(opener, store):
    other = await opener(schema="voice_hall")
    await other.add_utterance("brain-1", utterance())
    _, _, foreign = await other.after("brain-1", None)
    await other.close()
    with pytest.raises(CursorExpired):
        await store.after("brain-1", foreign)
    with pytest.raises(CursorExpired):
        await store.after("brain-1", "not a cursor")


async def test_an_hour_is_kept_and_what_is_older_expires_its_cursor(opener, clock):
    s = await opener(keep_s=KEEP_AT_LEAST_S)
    await s.add_utterance("brain-1", old := utterance())
    _, _, at_old = await s.after("brain-1", None)
    clock.t += KEEP_AT_LEAST_S - 1
    await s.purge()
    assert (await s.after("brain-1", None))[0] == [old]          # fails if kept less than an hour
    before_old = (await s.cursor()).split(".")[0] + ".0"
    clock.t += 2
    await s.add_utterance("brain-1", new := utterance())
    await s.purge()
    with pytest.raises(CursorExpired):
        await s.after("brain-1", before_old)
    assert (await s.after("brain-1", at_old))[0] == [new]        # nothing it pointed past was lost
    assert (await s.after("brain-1", None))[0] == [new]
    await s.close()


async def test_less_than_an_hour_is_refused(opener):
    with pytest.raises(ValueError):
        await opener(keep_s=KEEP_AT_LEAST_S - 1)


@pytest.mark.parametrize("schema", ["Voice", "voice-kitchen", "1voice", "voice; drop", ""])
async def test_a_schema_name_db_init_would_refuse_is_refused(opener, schema):
    """Fails if a name reaches `search_path` unchecked."""
    with pytest.raises(ValueError):
        await opener(schema=schema)


async def test_a_page_ends_where_it_stops(store, monkeypatch):
    monkeypatch.setattr("voice_front.store.PAGE", 2)
    items = [utterance() for _ in range(3)]
    for u in items:
        await store.add_utterance("brain-1", u)
    first, _, cursor = await store.after("brain-1", None)
    rest, _, _ = await store.after("brain-1", cursor)
    assert first + rest == items


async def test_says_and_utterances_are_owned(store):
    await store.note_say("s-1", "brain-1", "ep-kitchen")
    await store.add_utterance("brain-1", u := utterance())
    assert await store.say_of("s-1") == ("brain-1", "ep-kitchen")
    assert await store.say_of("s-2") is None
    assert await store.brain_of(u["utterance_id"]) == "brain-1"
    assert await store.brain_of(str(uuid.uuid4())) is None
    assert await store.utterance_owner(u["utterance_id"]) == ("brain-1", u["endpoint"])
    assert await store.utterance_owner(str(uuid.uuid4())) is None


async def test_no_audio_is_kept_by_default(store, tmp_path):
    """GA-VOICE-15: `audio_retention_s` is 0 unless the owner sets it."""
    u = str(uuid.uuid4())
    await store.put_audio(u, b"\x00\x01", retention_s=0)
    assert await store.audio(u) is None
    assert list((tmp_path / "audio").rglob("*.pcm")) == []


async def test_audio_is_a_file_the_owner_alone_reads_and_never_a_row(store, tmp_path, database):
    """Storage design, *Audio*: fails if the bytes go into the database, or
    the file is readable by others."""
    u = str(uuid.uuid4())
    await store.put_audio(u, b"\x00\x01", retention_s=60)
    [file] = (tmp_path / "audio" / SCHEMA).glob("*.pcm")
    assert file.read_bytes() == b"\x00\x01" and file.stat().st_mode & 0o077 == 0
    assert (tmp_path / "audio" / SCHEMA).stat().st_mode & 0o077 == 0
    [(path, digest)] = rows(database, f"SELECT path, sha256 FROM {SCHEMA}.audio")
    assert path == file.name and len(digest) == 64


async def test_audio_is_kept_no_longer_than_the_retention(store, clock, tmp_path):
    u = str(uuid.uuid4())
    await store.put_audio(u, b"\x00\x01", retention_s=60)
    assert await store.audio(u) == b"\x00\x01"
    clock.t += 60
    assert await store.audio(u) is None                    # fails if `until` is not honoured
    await store.purge()
    assert list((tmp_path / "audio").rglob("*.pcm")) == []  # fails if the sweep leaves the file


async def test_a_shorter_retention_applies_to_what_is_kept(store, tmp_path):
    u = str(uuid.uuid4())
    await store.put_audio(u, b"\x00", retention_s=3600)
    await store.limit_audio(0)
    assert await store.audio(u) is None
    assert list((tmp_path / "audio").rglob("*.pcm")) == []


async def test_a_clip_whose_file_is_gone_or_changed_is_expired(store, tmp_path):
    """Storage design, *Audio*: backups leave audio out, so a restored row
    may name no file."""
    gone, changed = str(uuid.uuid4()), str(uuid.uuid4())
    await store.put_audio(gone, b"\x00", retention_s=3600)
    await store.put_audio(changed, b"\x00", retention_s=3600)
    (tmp_path / "audio" / SCHEMA / f"{gone}.pcm").unlink()
    (tmp_path / "audio" / SCHEMA / f"{changed}.pcm").write_bytes(b"\x01")
    assert await store.audio(gone) is None
    assert await store.audio(changed) is None


async def test_no_clip_outlives_a_crash_unswept(opener, tmp_path, clock):
    """GA-VOICE-15: fails if a crash while keeping a clip can leave audio no
    sweep will ever delete."""
    s = await opener()
    kept = str(uuid.uuid4())
    await s.put_audio(kept, b"\x00", retention_s=60)
    await s.close()
    directory = tmp_path / "audio" / SCHEMA
    (directory / f"{uuid.uuid4()}.part").write_bytes(b"\x01")     # cut short mid-write
    s = await opener()
    assert list(directory.glob("*.part")) == []
    clock.t += 60
    await s.purge()
    assert list(directory.iterdir()) == []
    await s.close()


async def test_limiting_retention_cannot_slip_between_a_clip_row_and_its_file(store, tmp_path, database, monkeypatch):
    """GA-VOICE-15: fails if `limit_audio` can run after the row commits and
    before the file exists, leaving a clip no row names."""
    real = store._write_file

    def slow(path, pcm):
        time.sleep(0.3)                     # the file lands late, in its thread
        real(path, pcm)

    monkeypatch.setattr(store, "_write_file", slow)
    with anyio.fail_after(10):
        async with anyio.create_task_group() as tg:
            tg.start_soon(store.put_audio, str(uuid.uuid4()), b"\x00", 3600)
            await anyio.sleep(0.1)
            tg.start_soon(store.limit_audio, 0)
    named = {r[0] for r in rows(database, f"SELECT path FROM {SCHEMA}.audio")}
    assert {f.name for f in (tmp_path / "audio").rglob("*.pcm")} <= named


async def test_audio_for_an_id_that_is_not_a_uuid_is_refused(store):
    """Fails if an id could name a path outside the audio directory."""
    with pytest.raises(ValueError):
        await store.put_audio("../x", b"\x00", retention_s=60)


async def test_a_wait_returns_when_something_arrives(store):
    found = []

    async def reader():
        found.append(await store.wait("brain-1", None, 5))

    start = time.monotonic()
    with anyio.fail_after(10):
        async with anyio.create_task_group() as tg:
            tg.start_soon(reader)
            await anyio.sleep(0.05)
            await store.add_utterance("brain-1", utterance())
    us, _, _ = found[0]
    assert len(us) == 1 and time.monotonic() - start < 2       # fails if the wait ignores additions


async def test_a_wait_with_nothing_ends_after_wait_s(store):
    start = time.monotonic()
    with anyio.fail_after(10):
        us, ps, _ = await store.wait("brain-1", None, 0.2)
    assert (us, ps) == ([], []) and 0.15 < time.monotonic() - start < 2


async def test_writes_at_once_keep_the_order_readers_see(store):
    """Fails if two adds can commit out of the sequence's order: a reader
    polling meanwhile could pass a number that commits later, and miss it."""
    sent = {w: [utterance() for _ in range(5)] for w in range(4)}
    done = anyio.Event()
    seen = []

    async def writer(w):
        for u in sent[w]:
            await store.add_utterance("brain-1", u)

    async def reader():
        cursor = None
        while True:
            finished = done.is_set()
            us, _, cursor = await store.after("brain-1", cursor)
            seen.extend(us)
            if finished and not us:
                return

    with anyio.fail_after(10):
        async with anyio.create_task_group() as outer:
            outer.start_soon(reader)
            async with anyio.create_task_group() as tg:
                for w in sent:
                    tg.start_soon(writer, w)
            done.set()
    ids = [u["utterance_id"] for u in seen]
    assert len(ids) == 20 and len(set(ids)) == 20
    for items in sent.values():
        mine = [i for i in ids if i in {u["utterance_id"] for u in items}]
        assert mine == [u["utterance_id"] for u in items]


async def test_an_item_committed_while_a_page_is_read_is_not_passed(store):
    """Fails if the page and the bound the cursor takes come from different
    snapshots: a write landing between them would be passed and lost."""
    real_all, late = store._all, utterance()

    async def all_then_write(query, params=()):
        rows = await real_all(query, params)
        store._all = real_all
        await store.add_utterance("brain-1", late)      # commits right after the read
        return rows

    store._all = all_then_write
    us, _, cursor = await store.after("brain-1", None)
    assert us == []
    assert (await store.after("brain-1", cursor))[0] == [late]


async def test_a_clip_no_row_names_is_deleted_at_open(opener, tmp_path):
    """GA-VOICE-15: fails if a restore from before the files leaves clips no
    sweep will reach."""
    s = await opener()
    kept = str(uuid.uuid4())
    await s.put_audio(kept, b"\x00", retention_s=3600)
    await s.close()
    directory = tmp_path / "audio" / SCHEMA
    stray = directory / f"{uuid.uuid4()}.pcm"
    stray.write_bytes(b"\x01")
    s = await opener()
    assert not stray.exists()
    assert await s.audio(kept) == b"\x00"
    await s.close()


async def test_an_unreachable_store_is_unavailable(tmp_path):
    """Storage design, *When the store is unreachable*: fails if the front
    starts without its store or reports it as something else."""
    with pytest.raises(StoreUnavailable):
        await Store.open("postgresql://nobody@127.0.0.1:1/galatea", schema=SCHEMA, audio_dir=tmp_path)


async def test_a_store_that_goes_away_is_unavailable_and_comes_back(opener, database, monkeypatch):
    """Fails if a store that refuses connections is anything but
    `StoreUnavailable`, or the store stays broken once it takes them again."""
    monkeypatch.setattr("voice_front.store.CONNECT_TIMEOUT_S", 1)
    store = await opener()
    dbname = psycopg.conninfo.conninfo_to_dict(database)["dbname"]
    admin = psycopg.conninfo.make_conninfo(database, dbname="postgres")

    def allow(yes: bool):
        with psycopg.connect(admin, autocommit=True) as conn:
            conn.execute(f"ALTER DATABASE {dbname} ALLOW_CONNECTIONS {str(yes).lower()}")
            if not yes:
                conn.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s", (dbname,))

    allow(False)
    try:
        with pytest.raises(StoreUnavailable):
            await store.add_utterance("brain-1", utterance())
    finally:
        allow(True)
    u = utterance()
    with anyio.fail_after(30):
        while True:                 # as a caller would: the pool reconnects with a backoff
            try:
                await store.add_utterance("brain-1", u)
                break
            except StoreUnavailable:
                await anyio.sleep(0.1)
    assert (await store.after("brain-1", None))[0][-1] == u
    await store.close()


async def test_the_same_item_added_twice_is_kept_once(store):
    """A commit whose reply was lost is retried by the caller: fails if the
    retry stores it a second time. A conflicting insert wakes a waiter for
    nothing, harmlessly: `wait` reads again and sleeps on."""
    u = utterance()
    await store.add_utterance("brain-1", u)
    await store.add_utterance("brain-1", u)
    await store.add_played("brain-1", played())
    await store.add_played("brain-1", played())
    us, ps, cursor = await store.after("brain-1", None)
    assert (us, ps) == ([u], [played()])
    assert await store.after("brain-1", cursor) == ([], [], cursor)


async def test_a_cursor_ahead_of_the_store_is_expired(store):
    """After a restore from an older dump, or a crafted cursor: fails if it is
    accepted and skips what is added until the sequence passes it."""
    generation = (await store.cursor()).partition(".")[0]
    with pytest.raises(CursorExpired):
        await store.after("brain-1", f"{generation}.999")
    await store.add_utterance("brain-1", utterance())
    now = await store.cursor()
    assert await store.after("brain-1", now) == ([], [], now)
    assert await store.after("brain-1", f"{generation}.0") is not None


async def test_a_sweep_leaves_a_clip_renewed_after_it_looked(store, clock, monkeypatch):
    """Fails if the sweep deletes a row, and unlinks its file, on what it read
    before the clip was kept again."""
    kept = str(uuid.uuid4())
    await store.put_audio(kept, b"\x00", 10)
    clock.t += 20
    real = store._all

    async def renewing(query, params=()):
        found = await real(query, params)
        if "FROM audio WHERE until" in query:
            monkeypatch.setattr(store, "_all", real)
            await store.put_audio(kept, b"\x00", 3600)
        return found

    monkeypatch.setattr(store, "_all", renewing)
    await store._sweep_audio()
    assert await store.audio(kept) == b"\x00"
