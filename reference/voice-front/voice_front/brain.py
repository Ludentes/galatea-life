"""The front's server for its brains: `listen`, `say` and `hush` (brain,
*The front*; GA-VOICE-19, GA-VOICE-21).

A brain is known by its bearer credential, which the front's configuration
binds to the brain's client id at the steward. An utterance is delivered
only to the brain its endpoint's `served_by` names when it is delivered, and
`say` and `hush` are taken only for endpoints the caller serves. A caller
with no credential the front knows gets HTTP 401 and nothing else.

Speaking is not here: `say` and `hush` are handed to a `Speech` (stage 2c),
which reports each piece through `report_played`.
"""
from __future__ import annotations

import functools
import uuid
from typing import Any, Callable, Mapping, Protocol

from mcp.shared.exceptions import MCPError
from mcp_types import INTERNAL_ERROR

from voice_front import mcpwire
from voice_front.schemas import Schemas, schemas as repository_schemas
from voice_front.store import CursorExpired, Store, StoreUnavailable

ServedBy = Callable[[], Mapping[str, str | None]]     # endpoint -> brain client id, or None


def _store_errors(handler):
    """A store that cannot be reached is the MCP internal error, -32603
    (storage design, *When the store is unreachable*): nothing was done, and
    the brain calls again."""
    @functools.wraps(handler)
    async def wrapper(self, brain, args):
        try:
            return await handler(self, brain, args)
        except StoreUnavailable:
            raise MCPError(INTERNAL_ERROR, "the front's store is unavailable; call again") from None
    return wrapper


class Speech(Protocol):
    """Stage 2c's queues. `say` returns once the piece is queued."""

    async def say(self, brain: str, say_id: str, request: dict[str, Any]) -> None: ...

    async def hush(self, brain: str, request: dict[str, Any]) -> None: ...


class BrainServer:
    def __init__(self, store: Store, speech: Speech, served_by: ServedBy,
                 credentials: Mapping[str, str], *, schemas: Schemas | None = None,
                 new_id: Callable[[], str] = lambda: str(uuid.uuid4()),
                 allowed_hosts: list[str] | None = None):
        """`credentials`: brain client id -> the secret it presents."""
        self._store = store
        self._speech = speech
        self._served_by = served_by
        self._new_id = new_id
        self._versions: dict[str, str | None] = {}
        self.mcp = mcpwire.ToolServer("galatea-voice-front", [
            mcpwire.Tool("listen", self._listen, "brain/listen.request.json", "brain/listen.response.json",
                         read_only=True),
            mcpwire.Tool("say", self._say, "brain/say.request.json", "brain/say.response.json"),
            mcpwire.Tool("hush", self._hush, "brain/hush.request.json", "brain/hush.response.json"),
        ], mcpwire.Credentials(credentials), schemas or repository_schemas(), allowed_hosts=allowed_hosts)

    # ---- what the rest of the front calls -----------------------------------

    async def deliver(self, utterance: dict[str, Any]) -> str | None:
        """Make an utterance available to the brain its endpoint's `served_by`
        names now; that brain's id, or None when the endpoint has none.
        Raises `StoreUnavailable`."""
        brain = self._served_by().get(utterance["endpoint"])
        if brain is None:
            return None
        await self._store.add_utterance(brain, utterance)
        return brain

    async def report_played(self, played: dict[str, Any]) -> bool:
        """File a `played` report with the brain that said the piece. False
        if the piece is no longer known. Raises `StoreUnavailable`."""
        owner = await self._store.say_of(played["say_id"])
        if owner is None:
            return False
        await self._store.add_played(owner[0], played)
        return True

    def front_version(self, brain: str) -> str | None:
        """The brain standard version `brain` last named in `listen` (voice,
        *Compatibility*); None if it named none or has not called."""
        return self._versions.get(brain)

    # ---- the tools ----------------------------------------------------------

    def _serves(self, brain: str, endpoint: str) -> bool:
        return self._served_by().get(endpoint) == brain

    @_store_errors
    async def _listen(self, brain: str, args: dict[str, Any]) -> dict[str, Any]:
        self._versions[brain] = args.get("front_version")
        try:
            utterances, played, cursor = await self._store.wait(brain, args.get("cursor"), args.get("wait_s", 0))
        except CursorExpired:
            raise mcpwire.ToolError("cursor_expired", "older than the front keeps; call again with no cursor")
        return {"utterances": utterances, "played": played, "cursor": cursor}

    @_store_errors
    async def _say(self, brain: str, args: dict[str, Any]) -> dict[str, Any]:
        endpoint = args["endpoint"]
        if not self._serves(brain, endpoint):
            raise mcpwire.ToolError("not_permitted", "an endpoint this brain does not serve")
        reply_to = args.get("in_reply_to")
        if reply_to is not None and await self._store.brain_of(reply_to) not in (None, brain):
            raise mcpwire.ToolError("not_permitted", "an utterance delivered to another brain")
        earlier = args.get("continues")
        if earlier is not None:
            owner = await self._store.say_of(earlier)
            if owner is not None and owner[0] != brain:
                raise mcpwire.ToolError("not_permitted", "a piece another brain said")
            if owner is not None and owner[1] != endpoint:
                raise mcpwire.ToolError("invalid_request", "a piece continues one at another endpoint")
        say_id = self._new_id()
        await self._store.note_say(say_id, brain, endpoint)
        # `served_by` may have moved while the store was awaited: check again,
        # with no await between the check and the call.
        if not self._serves(brain, endpoint):
            raise mcpwire.ToolError("not_permitted", "an endpoint this brain does not serve")
        await self._speech.say(brain, say_id, args)
        return {"say_id": say_id}

    @_store_errors
    async def _hush(self, brain: str, args: dict[str, Any]) -> dict[str, Any]:
        if "endpoint" in args:
            endpoint = args["endpoint"]
        elif "say_id" in args:
            owner = await self._store.say_of(args["say_id"])
            if owner is None:
                return {}                                   # nothing left to stop
            if owner[0] != brain:
                raise mcpwire.ToolError("not_permitted", "a piece another brain said")
            endpoint = owner[1]
        else:
            owner = await self._store.utterance_owner(args["utterance_id"])
            if owner is None:
                return {}
            if owner[0] != brain:
                raise mcpwire.ToolError("not_permitted", "an utterance delivered to another brain")
            endpoint = owner[1]
        # No await between this check and the call.
        if not self._serves(brain, endpoint):
            raise mcpwire.ToolError("not_permitted", "an endpoint this brain does not serve")
        await self._speech.hush(brain, args)
        return {}
