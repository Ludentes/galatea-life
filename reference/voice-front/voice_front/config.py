"""The front's configuration file.

    uv run python -m voice_front.app --config voice-front.toml

Stage 1 reads three tables -- `server`, `models` and `wake_words` -- and
refuses any key it does not know, so a misspelt key is an error rather than a
setting silently left at its default.

⛔ The link binds only to a host that RESOLVES only to loopback addresses.
Checked by address, never by string: `localhost` may resolve anywhere, and a
wildcard such as `0.0.0.0` reaches the whole network. Until stage 2 the link
has no TLS and no device keys, so anything but loopback is refused.

The wake words come from here in stage 1. Stage 2 takes them from the
steward's endpoint record.

Stage 2b adds the steward, the brains, the store and the state directory,
each optional until 2d composes them. A credential is read from a file named
here, never written in this file, and never appears in an error. TLS is
required on both links unless both ends are on one host's loopback
(voice, *Links, security and retention*; GA-SEC-2).

Stage 2c adds the synthesiser and the fixed clips, optional as 2b's tables
are. ⛔ The synthesiser speaks Wyoming, which has neither encryption nor
authentication, so it runs on this host: `unix://`, or `tcp://` to a
loopback address written as one, or `localhost`, which must resolve only to
loopback. A name that happens to resolve to loopback today is refused: it
may not tomorrow. A clip's audio is read when the front starts
(`clips.load_clips`), not here.
"""
from __future__ import annotations

import ipaddress
import re
import socket
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import parse_qs, urlsplit

from voice_front.clips import ClipEntry, ClipError, check as check_clips
from voice_front.synth import DEADLINE_S, READ_S
from voice_front.wake.transcript import WakeRule

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
DEFAULT_MODELS_DIR = "models"

_TABLES = {"server", "models", "wake_words", "steward", "brain_server", "brains", "store", "state",
           "synthesiser", "clips"}
_STEWARD_KEYS = {"url", "credential_file", "ca_file"}
_BRAIN_SERVER_KEYS = {"host", "port", "cert_file", "key_file", "names"}
_BRAIN_KEYS = {"client_id", "credential_file"}
_STORE_KEYS = {"url", "password_file", "audio_dir", "keep_s"}
_STATE_KEYS = {"dir"}
_SYNTHESISER_KEYS = {"uri", "voice", "timeout_s"}
_CLIP_KEYS = {"name", "path", "text"}
DEFAULT_BRAIN_PORT = 8766
DEFAULT_KEEP_S = 7 * 24 * 3600
KEEP_AT_LEAST_S = 3600
_SCHEMA = re.compile(r"[a-z][a-z0-9_]{0,62}")
_SERVER_KEYS = {"host", "port"}
_MODELS_KEYS = {"dir"}
_WAKE_KEYS = {"word", "carrier", "inflections", "max_carrier", "max_trigger", "max_join"}


class ConfigError(ValueError):
    """The configuration file is missing, unreadable or wrong. The message
    always begins with the file's name."""


@dataclass(frozen=True)
class StewardLink:
    url: str
    credential: str = field(repr=False)
    ca_file: Path | None = None


@dataclass(frozen=True)
class BrainServerConfig:
    host: str
    port: int
    cert_file: Path | None          # None only on loopback
    key_file: Path | None
    allowed_hosts: tuple[str, ...]  # the Host headers brains may send


@dataclass(frozen=True)
class StoreLink:
    """The front's Postgres role, whose schema is named as it (storage design)."""
    url: str                        # no password: that is in `password`
    schema: str
    password: str = field(repr=False)
    audio_dir: Path = Path("audio")
    keep_s: int = DEFAULT_KEEP_S


@dataclass(frozen=True)
class SynthesiserLink:
    uri: str                        # tcp:// to loopback, or unix://
    voice: str | None = None        # the server's name for it; its default if None
    timeout_s: float = READ_S       # the longest wait for the next event of a piece


@dataclass(frozen=True)
class Config:
    host: str
    port: int
    models_dir: Path
    wake_rules: tuple[WakeRule, ...]
    steward: StewardLink | None = None
    brain_server: BrainServerConfig | None = None
    brains: Mapping[str, str] = field(default_factory=dict, repr=False)   # client id -> credential
    store: StoreLink | None = None
    state_dir: Path | None = None
    synthesiser: SynthesiserLink | None = None
    clips: tuple[ClipEntry, ...] = ()


def resolves_to_loopback_only(host: str) -> bool:
    """True when every address `host` resolves to is a loopback address.

    An unresolvable host is not loopback: it cannot be shown to be.
    """
    try:
        infos = socket.getaddrinfo(host, None)
    except (socket.gaierror, UnicodeError, OSError):
        return False
    addresses = {info[4][0] for info in infos}
    if not addresses:
        return False
    try:
        # An IPv6 address may carry a zone ("fe80::1%eth0"); the zone is not
        # part of the address.
        return all(ipaddress.ip_address(a.split("%", 1)[0]).is_loopback
                   for a in addresses)
    except ValueError:
        return False


def _loopback_literal(host: str) -> bool:
    """A loopback address as written, or `localhost` resolving only to loopback."""
    if host == "localhost":
        return resolves_to_loopback_only(host)
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _bare_name(n: str) -> bool:
    """A host name or address, as a Host header holds it before the port."""
    if n.startswith("[") and n.endswith("]"):
        n = n[1:-1]
    try:
        ipaddress.ip_address(n)
        return True
    except ValueError:
        pass
    return not any(c in n for c in ":/?#@[] \t")


def _host_header(n: str) -> str:
    """An IPv6 address is bracketed in a Host header."""
    if n.startswith("["):
        return n
    try:
        return f"[{n}]" if ipaddress.ip_address(n).version == 6 else n
    except ValueError:
        return n


def _is_int(v: Any) -> bool:
    """bool is a subclass of int in Python, so `true` would arrive as 1."""
    return isinstance(v, int) and not isinstance(v, bool)


def load(path: Path) -> Config:
    path = Path(path)
    name = path.name

    def fail(what: str) -> ConfigError:
        return ConfigError(f"{name}: {what}")

    try:
        with path.open("rb") as f:
            data = tomllib.load(f)
    except OSError as exc:
        raise fail(f"cannot read {path}: {exc.strerror or exc}") from exc
    except tomllib.TOMLDecodeError as exc:
        raise fail(f"not valid TOML: {exc}") from exc

    def unknown(keys, known: set[str], where: str) -> None:
        extra = sorted(set(keys) - known)
        if extra:
            raise fail(f"unknown key {where}{extra[0]!r}")

    unknown(data, _TABLES, "")

    server = data.get("server", {})
    if not isinstance(server, dict):
        raise fail("server must be a table")
    unknown(server, _SERVER_KEYS, "server.")

    host = server.get("host", DEFAULT_HOST)
    if not isinstance(host, str) or not host:
        raise fail("server.host must be a non-empty string")
    port = server.get("port", DEFAULT_PORT)
    if not _is_int(port) or not 0 < port < 65536:
        raise fail(f"server.port must be an integer 1..65535, got {port!r}")
    if not resolves_to_loopback_only(host):
        raise fail(f"server.host {host!r} does not resolve only to loopback "
                   "addresses; the link is loopback-only until stage 2 gives "
                   "it TLS and device keys")

    models = data.get("models", {})
    if not isinstance(models, dict):
        raise fail("models must be a table")
    unknown(models, _MODELS_KEYS, "models.")
    models_dir = models.get("dir", DEFAULT_MODELS_DIR)
    if not isinstance(models_dir, str) or not models_dir:
        raise fail("models.dir must be a non-empty string")

    words = data.get("wake_words", [])
    if not isinstance(words, list) or not words:
        raise fail("wake_words: at least one [[wake_words]] entry is required")
    rules = tuple(_wake_rule(w, i, fail) for i, w in enumerate(words))

    base = path.parent

    def table(key: str, known: set[str]) -> dict | None:
        t = data.get(key)
        if t is None:
            return None
        if not isinstance(t, dict):
            raise fail(f"{key} must be a table")
        unknown(t, known, f"{key}.")
        return t

    def text(t: dict, key: str, where: str) -> str:
        v = t.get(key)
        if not isinstance(v, str) or not v:
            raise fail(f"{where}.{key} must be a non-empty string")
        return v

    def secret(t: dict, where: str, key: str = "credential_file") -> str:
        file = base / text(t, key, where)
        try:
            value = file.read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise fail(f"{where}.{key}: cannot read {file}: {exc.strerror or exc}") from exc
        except UnicodeDecodeError:
            raise fail(f"{where}.{key}: cannot read {file}: not UTF-8 text") from None
        if not value:
            raise fail(f"{where}.{key}: {file} is empty")
        return value

    steward = None
    if (t := table("steward", _STEWARD_KEYS)) is not None:
        url = text(t, "url", "steward")
        parts = urlsplit(url)
        if parts.scheme not in ("https", "http") or not parts.hostname:
            raise fail("steward.url must be an http(s) URL")
        if parts.username is not None or parts.password is not None:
            raise fail("steward.url must not hold a user name or password: name a credential_file")
        if parts.scheme == "http" and not resolves_to_loopback_only(parts.hostname):
            raise fail("steward.url must be https unless the steward is on this host's loopback")
        ca = t.get("ca_file")
        if ca is not None and (not isinstance(ca, str) or not ca):
            raise fail("steward.ca_file must be a non-empty string")
        steward = StewardLink(url=url, credential=secret(t, "steward"), ca_file=base / ca if ca else None)

    brain_server = None
    if (t := table("brain_server", _BRAIN_SERVER_KEYS)) is not None:
        b_host = text(t, "host", "brain_server")
        b_port = t.get("port", DEFAULT_BRAIN_PORT)
        if not _is_int(b_port) or not 0 < b_port < 65536:
            raise fail(f"brain_server.port must be an integer 1..65535, got {b_port!r}")
        loopback = resolves_to_loopback_only(b_host)
        cert, key = t.get("cert_file"), t.get("key_file")
        if (cert is None) != (key is None):
            raise fail("brain_server: cert_file and key_file go together")
        if cert is not None:
            text(t, "cert_file", "brain_server")
            text(t, "key_file", "brain_server")
        if cert is None and not loopback:
            raise fail("brain_server: TLS (cert_file, key_file) is required unless the host is loopback")
        names = t.get("names", [])
        if not isinstance(names, list) or not all(isinstance(n, str) and n for n in names):
            raise fail("brain_server.names must be a list of host names")
        if any(not _bare_name(n) for n in names):
            raise fail("brain_server.names: each is a bare host name, with no scheme, port or path")
        if not names and not loopback:
            raise fail("brain_server.names: the names brains reach this front by are required "
                       "unless the host is loopback")
        allowed = [f"{_host_header(n)}:{b_port}" for n in (names or ["127.0.0.1", "localhost", "::1"])]
        brain_server = BrainServerConfig(host=b_host, port=b_port,
                                         cert_file=base / cert if cert else None,
                                         key_file=base / key if key else None,
                                         allowed_hosts=tuple(allowed))

    brains: dict[str, str] = {}
    entries = data.get("brains", [])
    if not isinstance(entries, list):
        raise fail("brains must be an array of tables ([[brains]])")
    for i, entry in enumerate(entries):
        where = f"brains[{i}]"
        if not isinstance(entry, dict):
            raise fail(f"{where} must be a table")
        unknown(entry, _BRAIN_KEYS, f"{where}.")
        client_id = text(entry, "client_id", where)
        if client_id in brains:
            raise fail(f"{where}: brain {client_id!r} is listed twice")
        value = secret(entry, where)
        if value in brains.values():
            raise fail(f"{where}: two brains share one credential, so neither could be told apart")
        brains[client_id] = value
    if brain_server is not None and not brains:
        raise fail("brain_server: at least one [[brains]] entry is required")

    store = None
    if (t := table("store", _STORE_KEYS)) is not None:
        url = text(t, "url", "store")
        parts = urlsplit(url)
        if parts.scheme not in ("postgresql", "postgres") or not parts.hostname:
            raise fail("store.url must be a postgresql:// URL with a host")
        if parts.password is not None:
            raise fail("store.url must not hold a password: name a password_file")
        try:
            query = parse_qs(parts.query, keep_blank_values=True)
        except ValueError:
            raise fail("store.url: the query is malformed") from None
        for banned in ("password", "user", "passfile", "service"):
            if banned in query:
                raise fail(f"store.url must not set {banned!r} in its query: the role is the URL's "
                           "user name and the password is a password_file")
        if not parts.username or not _SCHEMA.fullmatch(parts.username):
            raise fail("store.url must name the front's role, as db-init names an instance "
                       "(lower case letters, digits and _, starting with a letter)")
        keep_s = t.get("keep_s", DEFAULT_KEEP_S)
        if not _is_int(keep_s) or keep_s < KEEP_AT_LEAST_S:
            raise fail(f"store.keep_s must be an integer of at least {KEEP_AT_LEAST_S}, got {keep_s!r}")
        store = StoreLink(url=url, schema=parts.username, password=secret(t, "store", "password_file"),
                          audio_dir=base / text(t, "audio_dir", "store"), keep_s=keep_s)

    state_dir = None
    if (t := table("state", _STATE_KEYS)) is not None:
        state_dir = base / text(t, "dir", "state")

    synthesiser = None
    if (t := table("synthesiser", _SYNTHESISER_KEYS)) is not None:
        uri = text(t, "uri", "synthesiser")
        parts = urlsplit(uri)
        if parts.scheme == "tcp":
            try:
                synth_port = parts.port
            except ValueError:
                synth_port = None
            if not parts.hostname or synth_port is None or parts.path not in ("", "/"):
                raise fail("synthesiser.uri: tcp:// takes a host and a port, and nothing else")
            if not _loopback_literal(parts.hostname):
                raise fail("synthesiser.uri must name a loopback address, or localhost: Wyoming has no "
                           "encryption or authentication, so the synthesiser runs on this host")
        elif parts.scheme == "unix":
            if parts.netloc or not parts.path.startswith("/"):
                raise fail("synthesiser.uri: unix:// takes an absolute path (unix:///run/tts.sock)")
        else:
            raise fail("synthesiser.uri must be tcp:// to this host's loopback, or unix://")
        voice = t.get("voice")
        if voice is not None:
            voice = text(t, "voice", "synthesiser")
        timeout_s = t.get("timeout_s", READ_S)
        if (not isinstance(timeout_s, (int, float)) or isinstance(timeout_s, bool)
                or not 0 < timeout_s <= DEADLINE_S):
            raise fail(f"synthesiser.timeout_s must be a number of seconds, over 0 and at most "
                       f"{DEADLINE_S:.0f} (a whole piece's deadline), got {timeout_s!r}")
        synthesiser = SynthesiserLink(uri=uri, voice=voice, timeout_s=float(timeout_s))

    clip_entries: list[ClipEntry] = []
    entries = data.get("clips", [])
    if not isinstance(entries, list):
        raise fail("clips must be an array of tables ([[clips]])")
    for i, entry in enumerate(entries):
        where = f"clips[{i}]"
        if not isinstance(entry, dict):
            raise fail(f"{where} must be a table")
        unknown(entry, _CLIP_KEYS, f"{where}.")
        said = entry.get("text")
        if not isinstance(said, str):
            raise fail(f"{where}.text must be a string: what the clip says, empty for a sound")
        clip_entries.append(ClipEntry(name=text(entry, "name", where), path=base / text(entry, "path", where),
                                      text=said))
    if clip_entries:
        try:
            check_clips(clip_entries)
        except ClipError as e:
            raise fail(f"clips: {e}") from None

    return Config(host=host, port=port,
                  models_dir=base / models_dir,
                  wake_rules=rules, steward=steward, brain_server=brain_server, brains=brains,
                  store=store, state_dir=state_dir, synthesiser=synthesiser, clips=tuple(clip_entries))


def _wake_rule(entry: Any, i: int, fail) -> WakeRule:
    where = f"wake_words[{i}]"
    if not isinstance(entry, dict):
        raise fail(f"{where} must be a table")
    extra = sorted(set(entry) - _WAKE_KEYS)
    if extra:
        raise fail(f"{where}: unknown key {extra[0]!r}")
    word = entry.get("word")
    if not isinstance(word, str):
        raise fail(f"{where}.word must be a string")
    carrier = entry.get("carrier")
    if carrier is not None and not isinstance(carrier, str):
        raise fail(f"{where}.carrier must be a string")
    inflections = entry.get("inflections", [])
    if not isinstance(inflections, list) or not all(isinstance(x, str) for x in inflections):
        raise fail(f"{where}.inflections must be a list of strings")
    tolerances = {}
    for key in ("max_carrier", "max_trigger", "max_join"):
        if key in entry:
            if not _is_int(entry[key]):
                raise fail(f"{where}.{key} must be an integer")
            tolerances[key] = entry[key]
    try:
        return WakeRule(word=word, carrier=carrier,
                        inflections=frozenset(inflections), **tolerances)
    except ValueError as exc:
        raise fail(f"{where}: {exc}") from exc
