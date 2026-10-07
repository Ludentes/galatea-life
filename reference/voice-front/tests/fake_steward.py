"""A fake steward for the front's tests: the five operations a front
credential may call, over the real MCP stack, with a house model the test
edits. Not a test, and not the harness's steward.

Every change to what `describe` shows counts up the revision and wakes a
waiting `describe`, as GA-HOUSE-1 says a narrowing does.
"""
from __future__ import annotations

import copy
from typing import Any

import anyio

from voice_front import mcpwire
from voice_front.schemas import schemas

FRONT, FRONT_SECRET = "front-1", "secret-front-1"
BRAIN, BRAIN_SECRET = "brain-local", "secret-brain"


def voice(listening="wake_server", words=(("Компьютер", "transcript"),), follow_up=False, zone="kitchen"):
    return {"listening": listening, "wake_words": [{"word": w, "model": m} for w, m in words],
            "zone": zone, "output": "speech", "follow_up": follow_up, "heard_by": FRONT}


class FakeSteward:
    def __init__(self):
        self.revision = 1
        self.endpoints: dict[str, dict[str, Any]] = {
            "ep-kitchen": {"id": "ep-kitchen", "name": "Кухня", "room": "kitchen", "type": "voice",
                           "person": None, "served_by": BRAIN, "voice": voice(), "narrowings": []},
        }
        self.home = {"timezone": "Europe/Moscow", "audio_retention_s": 0,
                     "other_wake_words": ["Алиса", "Окей, Гугл"]}
        self.persons = [{"id": "p-owner"}]
        self.sources: list[dict[str, Any]] = []
        self.calls: list[tuple[str, str, dict]] = []
        self._changed = anyio.Event()
        self._sources_changed = anyio.Event()
        self.server = mcpwire.ToolServer("fake-steward", [
            mcpwire.Tool("describe", self._describe, "steward/describe.request.json",
                         "steward/describe.response.json", read_only=True),
            mcpwire.Tool("zone_sources", self._zone_sources, "steward/zone_sources.request.json",
                         "steward/zone_sources.response.json", read_only=True),
            mcpwire.Tool("narrow", self._narrow, "steward/narrow.request.json",
                         "steward/narrow.response.json", destructive=True),
            mcpwire.Tool("front_status", self._front_status, "steward/front_status.request.json",
                         "steward/front_status.response.json"),
            mcpwire.Tool("speaking", self._speaking, "steward/speaking.request.json",
                         "steward/speaking.response.json"),
        ], mcpwire.Credentials({FRONT: FRONT_SECRET, BRAIN: BRAIN_SECRET}), schemas())

    # ---- what a test does ---------------------------------------------------

    def changed(self) -> None:
        self.revision += 1
        self._changed.set()
        self._changed = anyio.Event()

    def narrow_here(self, endpoint: str, **narrowing: Any) -> None:
        """A narrowing asked elsewhere (a person at the endpoint)."""
        n = {"narrowing_id": f"n-{self.revision}", "until": "2026-09-28T22:00:00+03:00",
             "cause": {"endpoint": endpoint}, **narrowing}
        self.endpoints[endpoint]["narrowings"].append(n)
        self.changed()

    def say_on(self, target: str, speech: str | None, speaking_for_ms: float = 0) -> None:
        self.sources = [s for s in self.sources if s["target"] != target]
        if speech is not None:
            self.sources.append({"target": target, "speech": speech, "speaking_for_ms": speaking_for_ms})
        self._sources_changed.set()
        self._sources_changed = anyio.Event()

    # ---- the operations -----------------------------------------------------

    def _front_only(self, caller: str) -> None:
        if caller != FRONT:
            raise mcpwire.ToolError("not_permitted", "a front's operation")

    async def _describe(self, caller: str, args: dict) -> dict:
        self.calls.append((caller, "describe", args))
        since = args.get("since_revision")
        if since is not None and since == self.revision:
            with anyio.move_on_after(args.get("wait_s", 0)):
                await self._changed.wait()
        endpoints = [copy.deepcopy(e) for e in self.endpoints.values()
                     if caller != FRONT or (e.get("voice") or {}).get("heard_by") == FRONT]
        return {"steward_id": "st-1", "standard_version": "0.8", "revision": self.revision,
                "home": copy.deepcopy(self.home), "rooms": [], "targets": [], "groups": [],
                "endpoints": endpoints, "scenarios": [], "rules": [], "schedules": [], "modes": [],
                "applier": {"applier_id": "ap-1", "levels": ["Act"], "ungoverned": []},
                "persons": copy.deepcopy(self.persons)}

    async def _zone_sources(self, caller: str, args: dict) -> dict:
        self._front_only(caller)
        self.calls.append((caller, "zone_sources", args))
        if args.get("cursor") is not None:
            with anyio.move_on_after(args.get("wait_s", 0)):
                await self._sources_changed.wait()
        return {"sources": copy.deepcopy(self.sources), "cursor": "c"}

    async def _narrow(self, caller: str, args: dict) -> dict:
        self.calls.append((caller, "narrow", args))
        endpoint = self.endpoints.get(args["endpoint"])
        if endpoint is None or (caller == FRONT and endpoint["voice"]["heard_by"] != FRONT):
            raise mcpwire.ToolError("not_permitted", "not this caller's endpoint")
        n = {k: v for k, v in args.items() if k in ("listening", "follow_up")}
        self.narrow_here(args["endpoint"], **n)
        return {"narrowing_id": endpoint["narrowings"][-1]["narrowing_id"],
                "until": endpoint["narrowings"][-1]["until"]}

    async def _front_status(self, caller: str, args: dict) -> dict:
        self._front_only(caller)
        self.calls.append((caller, "front_status", args))
        return {}

    async def _speaking(self, caller: str, args: dict) -> dict:
        self._front_only(caller)
        self.calls.append((caller, "speaking", args))
        return {}

    def called(self, name: str) -> list[dict]:
        return [args for _, n, args in self.calls if n == name]
