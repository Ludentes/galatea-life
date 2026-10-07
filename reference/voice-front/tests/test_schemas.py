"""The standards' schemas, as the front reads them: its own copy of `conformance/schemas/`.

Each case names the change that would redden it.
"""
import json
import sys
from pathlib import Path

import pytest

from voice_front.schemas import ROOT, SHIPPED, SchemaError, Schemas, default_root, schemas

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import copy_schemas  # noqa: E402

UTTERANCE = {"utterance_id": "0b0c5e6e-6f4e-4c3e-9a51-3a0a8d1f2c11", "endpoint": "ep-kitchen",
             "time": "2026-09-28T10:00:00+03:00", "available_at": "2026-09-28T10:00:01+03:00",
             "transcript": "включи свет"}


def listen_response(**changes):
    return {"utterances": [{**UTTERANCE, **changes}], "played": [], "cursor": "g.1"}


def test_every_operation_the_front_serves_or_calls_has_its_schemas():
    s = schemas()
    for op in ("brain/listen", "brain/say", "brain/hush", "steward/describe", "steward/zone_sources",
               "steward/narrow", "steward/front_status", "steward/speaking"):
        assert f"{op}.request.json" in s and f"{op}.response.json" in s


def test_a_good_message_passes():
    schemas().check("brain/listen.response.json", listen_response())


@pytest.mark.parametrize("changes,where", [
    ({"utterance_id": "u-1"}, ("utterances", 0, "utterance_id")),       # fails without the uuid format
    ({"time": "2026-09-28T10:00:00"}, ("utterances", 0, "time")),        # fails without rfc3339 checking
    ({"addressed_by": "shout"}, ("utterances", 0, "addressed_by")),      # fails if refs to common.json break
])
def test_a_bad_field_is_refused_where_it_is(changes, where):
    with pytest.raises(SchemaError) as e:
        schemas().check("brain/listen.response.json", listen_response(**changes))
    assert e.value.path == where


def test_the_first_refusal_is_reported_by_place():
    with pytest.raises(SchemaError) as e:
        schemas().check("brain/listen.request.json", {"wait_s": 31})
    assert e.value.schema_id == "brain/listen.request.json" and e.value.path == ("wait_s",)


def test_the_schemas_are_read_once():
    assert schemas() is schemas()


def test_a_missing_directory_fails_at_once(tmp_path):
    with pytest.raises(FileNotFoundError):
        Schemas(tmp_path)


# ---- where the schemas come from ---------------------------------------------

PACKAGE = Path(__file__).resolve().parents[1] / "voice_front"
STANDARD = Path(__file__).resolve().parents[3] / "conformance" / "schemas"


def test_the_front_reads_the_copy_it_ships():
    """Fails if the front reads the standard's folder by path again: the
    public code repository has no conformance/ beside it."""
    assert ROOT == PACKAGE / "standard_schemas"
    assert (ROOT / "common.json").is_file()


def test_the_root_can_be_named(tmp_path, monkeypatch):
    for d in ("brain", "steward"):
        (tmp_path / d).mkdir()
    (tmp_path / "common.json").write_text(json.dumps({"$schema": "https://json-schema.org/draft/2020-12/schema", "$id": "common.json"}), encoding="utf-8")
    monkeypatch.setenv("VOICE_FRONT_SCHEMAS", str(tmp_path))
    assert default_root() == tmp_path and "common.json" in Schemas(default_root())
    monkeypatch.delenv("VOICE_FRONT_SCHEMAS")
    assert default_root() == SHIPPED == ROOT


def test_the_shipped_copy_is_the_standards_own():
    """In the workshop, where the standard's schemas sit beside the front,
    the copy must match them file for file (resync: tools/copy_schemas.py).
    Where the front stands alone there is nothing to compare, and the copy
    must still hold every file the front loads."""
    shipped = copy_schemas.listing(PACKAGE / "standard_schemas")
    assert shipped and "common.json" in shipped
    if STANDARD.is_dir():
        assert copy_schemas.drift(STANDARD, PACKAGE / "standard_schemas") == []
