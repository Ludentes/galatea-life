"""What the front keeps for its brains: utterances and `played` reports, in
the order they became available, across restarts (brain, *The front*); and
audio of delivered utterances, only for the home's `audio_retention_s`
(GA-VOICE-15).

Postgres, in the front's own schema, `voice_<id>` (storage design). Every
item gets the next number of one sequence, never reused. A cursor is the
store's generation and that number: a cursor from another store, or one
older than what is kept or ahead of it, is `cursor_expired`, and the brain starts again from
the oldest kept.

An item belongs to the brain it was delivered to, fixed when it is added: a
brain that later serves the endpoint reads nothing said before.

The front is its schema's only writer, and writes one at a time, so the
sequence's order is the order of commits and a reader never passes a number
that commits later. A `listen` that waits is woken by this process, not by
the database.

Audio bytes are files under `audio_dir`, never rows: a row keeps the path,
the hash and when it expires. A row whose file is gone is expired.
"""
from __future__ import annotations

import functools
import hashlib
import os
import re
import secrets
import time
import uuid
from pathlib import Path
from typing import Any, Callable

import anyio
import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool, PoolTimeout

KEEP_AT_LEAST_S = 3600          # brain, *The front*
KEEP_S = 7 * 24 * 3600          # "preferably as long as the steward's history" (GA-STW-7)
PAGE = 500                      # items per `listen`
STATEMENT_TIMEOUT_MS = 5000     # a statement never holds a brain longer
CONNECT_TIMEOUT_S = 10

UTTERANCE, PLAYED = "utterance", "played"
SCHEMA = re.compile(r"[a-z][a-z0-9_]{0,62}")      # as db-init names an instance
MIGRATIONS = Path(__file__).with_name("migrations")


class CursorExpired(Exception):
    """The cursor names nothing this store still keeps."""


class StoreUnavailable(Exception):
    """The store cannot be reached. Nothing was kept or read; the caller
    answers with an internal error and tries again later (storage design,
    *When the store is unreachable*)."""


def _unavailable(fn):
    @functools.wraps(fn)
    async def wrapper(*args, **kwargs):
        try:
            return await fn(*args, **kwargs)
        except (psycopg.OperationalError, PoolTimeout) as e:
            raise StoreUnavailable(str(e)) from e
    return wrapper


async def migrate(conn: psycopg.AsyncConnection, schema: str) -> None:
    """Apply what `migrations/` has that the schema does not, in one
    transaction. The schema is created only when it is missing, which happens
    only in a test's database: in an installation db-init made it."""
    async with conn.transaction():
        found = await (await conn.execute("SELECT 1 FROM pg_namespace WHERE nspname = %s", (schema,))).fetchone()
        if found is None:
            await conn.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
        await conn.execute(sql.SQL("SET LOCAL search_path TO {}").format(sql.Identifier(schema)))
        await conn.execute("CREATE TABLE IF NOT EXISTS migrations"
                           " (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())")
        done = {r[0] for r in await (await conn.execute("SELECT name FROM migrations")).fetchall()}
        for file in sorted(MIGRATIONS.glob("*.sql")):
            if file.name not in done:
                await conn.execute(file.read_text(encoding="utf-8"))
                await conn.execute("INSERT INTO migrations (name) VALUES (%s)", (file.name,))


class Store:
    """Open with `await Store.open(...)`; close with `await store.close()`."""

    def __init__(self, pool: AsyncConnectionPool, audio_dir: Path, generation: str, *,
                 keep_s: float, now: Callable[[], float]):
        self._pool = pool
        self._audio_dir = audio_dir
        self._generation = generation
        self._keep_s = keep_s
        self._now = now
        self._write = anyio.Lock()
        self._added = anyio.Event()

    @classmethod
    async def open(cls, conninfo: str, *, schema: str, audio_dir: Path, password: str | None = None,
                   keep_s: float = KEEP_S, now: Callable[[], float] = time.time) -> Store:
        """Connect as the front's role, bring its schema up to date, and
        make the audio directory. Raises `StoreUnavailable`."""
        if keep_s < KEEP_AT_LEAST_S:
            raise ValueError(f"utterances are kept at least {KEEP_AT_LEAST_S} s, not {keep_s}")
        if not SCHEMA.fullmatch(schema):
            raise ValueError(f"a schema is lower case letters, digits and _, starting with a letter: {schema!r}")
        kwargs: dict[str, Any] = {
            "autocommit": True,
            "connect_timeout": CONNECT_TIMEOUT_S,
            "options": f"-c search_path={schema} -c statement_timeout={STATEMENT_TIMEOUT_MS}",
        }
        if password is not None:
            kwargs["password"] = password
        try:
            async with await psycopg.AsyncConnection.connect(conninfo, **kwargs) as conn:
                await migrate(conn, schema)
                await conn.execute("INSERT INTO meta VALUES ('generation', %s), ('purged_through', '0')"
                                   " ON CONFLICT (key) DO NOTHING", (secrets.token_hex(8),))
                generation = (await (await conn.execute(
                    "SELECT value FROM meta WHERE key = 'generation'")).fetchone())[0]
        except psycopg.OperationalError as e:
            raise StoreUnavailable(str(e)) from e
        pool = AsyncConnectionPool(conninfo, kwargs=kwargs, min_size=1, max_size=4,
                                   timeout=CONNECT_TIMEOUT_S, open=False)
        try:
            await pool.open()
            directory = Path(audio_dir) / schema
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            for part in directory.glob("*.part"):           # a write a crash cut short
                part.unlink(missing_ok=True)
            store = cls(pool, directory, generation, keep_s=keep_s, now=now)
            await store._drop_orphans()
        except BaseException as e:
            await pool.close()
            if isinstance(e, (psycopg.OperationalError, PoolTimeout)):
                raise StoreUnavailable(str(e)) from e
            raise
        return store

    async def _drop_orphans(self) -> None:
        """A clip no row names (a database restored from before its files)
        would never be swept: delete it (GA-VOICE-15)."""
        named = {r[0] for r in await self._all("SELECT path FROM audio")}
        for file in self._audio_dir.glob("*.pcm"):
            if file.name not in named:
                file.unlink(missing_ok=True)

    async def close(self) -> None:
        await self._pool.close()

    async def _one(self, query, params=()) -> tuple | None:
        async with self._pool.connection() as conn:
            return await (await conn.execute(query, params)).fetchone()

    async def _all(self, query, params=()) -> list[tuple]:
        async with self._pool.connection() as conn:
            return await (await conn.execute(query, params)).fetchall()

    async def _run(self, query, params=()) -> None:
        async with self._pool.connection() as conn:
            await conn.execute(query, params)

    # ---- adding -----------------------------------------------------------

    async def _add(self, kind: str, brain: str, item_id: str, body: dict[str, Any]) -> None:
        async with self._write:
            await self._run("INSERT INTO log (kind, brain, item_id, body, kept_at) VALUES (%s, %s, %s, %s, %s)"
                            " ON CONFLICT (kind, item_id) DO NOTHING",
                            (kind, brain, item_id, Jsonb(body), self._now()))
        self._added.set()
        self._added = anyio.Event()

    @_unavailable
    async def add_utterance(self, brain: str, utterance: dict[str, Any]) -> None:
        """An utterance delivered to `brain`, as `listen` returns it."""
        await self._add(UTTERANCE, brain, utterance["utterance_id"], utterance)

    @_unavailable
    async def add_played(self, brain: str, played: dict[str, Any]) -> None:
        """A `played` report for a piece `brain` said."""
        await self._add(PLAYED, brain, played["say_id"], played)

    @_unavailable
    async def note_say(self, say_id: str, brain: str, endpoint: str) -> None:
        async with self._write:
            await self._run("INSERT INTO says VALUES (%s, %s, %s, %s)", (say_id, brain, endpoint, self._now()))

    @_unavailable
    async def say_of(self, say_id: str) -> tuple[str, str] | None:
        """(brain, endpoint) of a piece said, if kept."""
        row = await self._one("SELECT brain, endpoint FROM says WHERE say_id = %s", (say_id,))
        return None if row is None else (row[0], row[1])

    @_unavailable
    async def brain_of(self, utterance_id: str) -> str | None:
        """The brain an utterance was delivered to, if kept."""
        row = await self._one("SELECT brain FROM log WHERE kind = 'utterance' AND item_id = %s", (utterance_id,))
        return None if row is None else row[0]

    @_unavailable
    async def utterance_owner(self, utterance_id: str) -> tuple[str, str] | None:
        """(brain, endpoint) an utterance was delivered to, if kept."""
        row = await self._one("SELECT brain, body->>'endpoint' FROM log WHERE kind = 'utterance' AND item_id = %s",
                              (utterance_id,))
        return None if row is None else (row[0], row[1])

    # ---- reading ----------------------------------------------------------

    _BOUNDS = ("(SELECT value::bigint FROM meta WHERE key = 'purged_through') AS purged,"
               " (SELECT COALESCE(MAX(seq), 0) FROM log) AS top")

    def _lower(self, cursor: str | None) -> int | None:
        if cursor is None:
            return None
        generation, _, number = cursor.partition(".")
        if generation != self._generation or not number.isdigit():
            raise CursorExpired(cursor)
        return int(number)

    @_unavailable
    async def cursor(self) -> str:
        """A cursor after everything kept now."""
        purged, top = await self._one(f"SELECT {self._BOUNDS}")
        return f"{self._generation}.{max(purged, top)}"

    @_unavailable
    async def after(self, brain: str, cursor: str | None) -> tuple[list[dict], list[dict], str]:
        """`brain`'s utterances and `played` reports after `cursor`, oldest
        first, at most a page; and the cursor after them. No cursor reads from
        the oldest kept. Raises `CursorExpired`.

        One statement, so one snapshot: the bounds and the page agree, and no
        item committed meanwhile is passed by the cursor returned."""
        lower = self._lower(cursor)
        rows = await self._all(
            f"WITH b AS (SELECT {self._BOUNDS}) SELECT b.purged, b.top, l.seq, l.kind, l.body FROM b"
            " LEFT JOIN LATERAL (SELECT seq, kind, body FROM log"
            "  WHERE seq > COALESCE(%s, b.purged) AND seq <= b.top AND brain = %s ORDER BY seq LIMIT %s) l ON true"
            " ORDER BY l.seq", (lower, brain, PAGE))
        purged, top = rows[0][0], rows[0][1]
        if lower is not None and not purged <= lower <= max(purged, top):
            raise CursorExpired(cursor)         # older than kept, or ahead of the store (a restore, or crafted)
        start = purged if lower is None else lower
        items = [r for r in rows if r[2] is not None]
        last = items[-1][2] if len(items) == PAGE else max(start, top)
        utterances = [r[4] for r in items if r[3] == UTTERANCE]
        played = [r[4] for r in items if r[3] == PLAYED]
        return utterances, played, f"{self._generation}.{last}"

    async def wait(self, brain: str, cursor: str | None, wait_s: float) -> tuple[list[dict], list[dict], str]:
        """`after`, waiting up to `wait_s` for something new if there is nothing."""
        with anyio.move_on_after(wait_s):
            while True:
                added = self._added
                found = await self.after(brain, cursor)
                if found[0] or found[1]:
                    return found
                await added.wait()
        return await self.after(brain, cursor)

    # ---- audio ------------------------------------------------------------

    def _path(self, utterance_id: str) -> Path:
        return self._audio_dir / f"{uuid.UUID(utterance_id)}.pcm"     # an id that is not a UUID raises

    @_unavailable
    async def put_audio(self, utterance_id: str, pcm: bytes, retention_s: float) -> None:
        """Keep a delivered utterance's audio for `retention_s`; none when 0."""
        if retention_s <= 0:
            return
        path = self._path(utterance_id)
        # The row first: a crash before the file leaves a row that reads as
        # expired and is swept, never a file that no row will ever sweep.
        async with self._write:
            await self._run("INSERT INTO audio VALUES (%s, %s, %s, %s) ON CONFLICT (utterance_id) DO UPDATE"
                            " SET path = EXCLUDED.path, sha256 = EXCLUDED.sha256, until = EXCLUDED.until",
                            (utterance_id, path.name, hashlib.sha256(pcm).hexdigest(), self._now() + retention_s))
            # Still under the lock: a `limit_audio` or sweep waits until the
            # file exists, so it cannot delete the row and leave a clip no row names.
            await anyio.to_thread.run_sync(self._write_file, path, pcm)

    @staticmethod
    def _write_file(path: Path, pcm: bytes) -> None:
        part = path.with_suffix(".part")
        fd = os.open(part, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(pcm)
            f.flush()
            os.fsync(f.fileno())
        os.replace(part, path)

    @_unavailable
    async def audio(self, utterance_id: str) -> bytes | None:
        """The kept audio, or None when there is none, it has expired, or its
        file is gone or is not what was kept."""
        row = await self._one("SELECT path, sha256 FROM audio WHERE utterance_id = %s AND until > %s",
                              (utterance_id, self._now()))
        if row is None:
            return None
        try:
            pcm = await anyio.to_thread.run_sync((self._audio_dir / row[0]).read_bytes)
        except FileNotFoundError:
            return None
        return pcm if hashlib.sha256(pcm).hexdigest() == row[1] else None

    @_unavailable
    async def limit_audio(self, retention_s: float) -> None:
        """The home's `audio_retention_s` changed: nothing is kept longer than
        the new value from now."""
        async with self._write:
            await self._run("UPDATE audio SET until = LEAST(until, %s)", (self._now() + max(retention_s, 0),))
        await self._sweep_audio()

    async def _sweep_audio(self) -> None:
        """The file first, then the row: a crash between leaves a row whose
        file is gone, which reads as expired."""
        for utterance_id, path in await self._all("SELECT utterance_id, path FROM audio WHERE until <= %s",
                                                  (self._now(),)):
            async with self._write:
                now = self._now()
                # Read again under the lock: the clip may have been kept again since.
                if await self._one("SELECT 1 FROM audio WHERE utterance_id = %s AND until <= %s",
                                   (utterance_id, now)) is None:
                    continue
                await anyio.to_thread.run_sync(functools.partial((self._audio_dir / path).unlink, missing_ok=True))
                await self._run("DELETE FROM audio WHERE utterance_id = %s AND until <= %s", (utterance_id, now))

    # ---- forgetting -------------------------------------------------------

    @_unavailable
    async def purge(self) -> None:
        """Forget what is past keeping: items older than the keep, their
        `says`, and audio past its time."""
        cut = self._now() - self._keep_s
        async with self._write:
            async with self._pool.connection() as conn:
                async with conn.transaction():
                    row = await (await conn.execute("SELECT MAX(seq) FROM log WHERE kept_at < %s", (cut,))).fetchone()
                    if row[0] is not None:
                        await conn.execute("DELETE FROM log WHERE seq <= %s", (row[0],))
                        await conn.execute("UPDATE meta SET value = GREATEST(value::bigint, %s)::text"
                                           " WHERE key = 'purged_through'", (row[0],))
                    await conn.execute("DELETE FROM says WHERE kept_at < %s", (cut,))
        await self._sweep_audio()
