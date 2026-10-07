"""The standards' messages as JSON Schema: the copy the front ships in
`standard_schemas/` (from the standard's `conformance/schemas/`, by
`tools/copy_schemas.py`), or the folder VOICE_FRONT_SCHEMAS names.

The front validates what it sends and what it takes against the same
schemas the harness uses, without the TypeScript types. A schema is named by
its `$id` («brain/listen.request.json»); `$ref`s between files resolve by
`$id`, as the schemas are written.
"""
from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

SHIPPED = Path(__file__).resolve().parent / "standard_schemas"


def default_root() -> Path:
    """VOICE_FRONT_SCHEMAS when set, else the copy the front ships."""
    return Path(os.environ.get("VOICE_FRONT_SCHEMAS") or SHIPPED)


ROOT = default_root()
DIRS = ("brain", "steward")


class SchemaError(ValueError):
    """A message that its schema refuses. `path` is where, as JSON keys."""

    def __init__(self, schema_id: str, message: str, path: tuple[Any, ...]):
        super().__init__(f"{schema_id}: {'/'.join(map(str, path)) or '(root)'}: {message}")
        self.schema_id = schema_id
        self.path = path


class Schemas:
    def __init__(self, root: Path = ROOT):
        docs: dict[str, dict] = {}
        for path in [root / "common.json", *(p for d in DIRS for p in sorted((root / d).glob("*.json")))]:
            doc = json.loads(path.read_text(encoding="utf-8"))
            docs[doc["$id"]] = doc
        self._docs = docs
        self._registry = Registry().with_resources(
            (sid, Resource.from_contents(doc)) for sid, doc in docs.items())
        self._validators: dict[str, Draft202012Validator] = {}

    def __contains__(self, schema_id: str) -> bool:
        return schema_id in self._docs

    def schema(self, schema_id: str) -> dict:
        return self._docs[schema_id]

    def check(self, schema_id: str, instance: Any) -> None:
        """Raise `SchemaError` at the first place the schema refuses."""
        v = self._validators.get(schema_id)
        if v is None:
            v = Draft202012Validator(self._docs[schema_id], registry=self._registry,
                                     format_checker=Draft202012Validator.FORMAT_CHECKER)
            self._validators[schema_id] = v
        err = next(iter(sorted(v.iter_errors(instance), key=lambda e: list(e.absolute_path))), None)
        if err is not None:
            raise SchemaError(schema_id, err.message, tuple(err.absolute_path))


@lru_cache(maxsize=1)
def schemas() -> Schemas:
    """The schemas at ROOT, loaded once."""
    return Schemas()
