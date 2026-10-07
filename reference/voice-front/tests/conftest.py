"""A fresh Postgres database for each test that asks for one.

`tools/with-postgres.sh` names the server in VOICE_FRONT_TEST_DATABASE_URL.
Without it, a test that needs a database fails with a message: the store is
never tested against something that is not Postgres, and never skipped.
"""
import os
import secrets

import psycopg
import pytest
from psycopg import sql

ENV = "VOICE_FRONT_TEST_DATABASE_URL"


def pytest_collection_modifyitems(items):
    for item in items:
        if "database" in getattr(item, "fixturenames", ()):
            item.add_marker(pytest.mark.pg)


@pytest.fixture
def database():
    """A conninfo for a database made for this test, dropped after it. It
    logs in as the server's admin, as the harness's databases do, so the
    store creates its own schema there."""
    admin = os.environ.get(ENV)
    if not admin:
        pytest.fail(f"{ENV} is not set: run the tests through tools/with-postgres.sh", pytrace=False)
    name = f"test_{secrets.token_hex(6)}"
    with psycopg.connect(admin, autocommit=True) as conn:
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    try:
        yield psycopg.conninfo.make_conninfo(admin, dbname=name)
    finally:
        with psycopg.connect(admin, autocommit=True) as conn:
            conn.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))
