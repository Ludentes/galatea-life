"""The configuration of stages 2b and 2c: the steward, the brains, the store,
the state directory, the synthesiser and the fixed clips. Voice, *Links,
security and retention*, *Speaking*; GA-SEC-2, GA-VOICE-11.

Each case names the change that would redden it. Credentials here are made
up in each test's tmp_path.
"""
import pytest

from voice_front.config import ConfigError, load

SEED = """
[server]
host = "127.0.0.1"

[[wake_words]]
word = "компьютер"
"""

LINKS = """
[steward]
url = "https://steward.example:8443/mcp"
credential_file = "secrets/front.credential"
ca_file = "secrets/home-ca.pem"

[brain_server]
host = "0.0.0.0"
port = 8766
cert_file = "secrets/front.pem"
key_file = "secrets/front.key"
names = ["front.example"]

[[brains]]
client_id = "brain-local"
credential_file = "secrets/brain-local.credential"

[[brains]]
client_id = "brain-cloud"
credential_file = "secrets/brain-cloud.credential"

[store]
url = "postgresql://voice_kitchen@postgres:5432/galatea"
password_file = "secrets/db.credential"
audio_dir = "audio"

[state]
dir = "state"
"""


def write(tmp_path, text, secrets=None):
    (tmp_path / "secrets").mkdir(exist_ok=True)
    for name, value in (secrets or {"front": "front-secret-1", "brain-local": "local-secret-2",
                                     "brain-cloud": "cloud-secret-3", "db": "db-secret-4"}).items():
        (tmp_path / "secrets" / f"{name}.credential").write_text(value + "\n", encoding="utf-8")
    p = tmp_path / "voice-front.toml"
    p.write_text(text, encoding="utf-8")
    return p


def refused(tmp_path, text, **kw) -> str:
    with pytest.raises(ConfigError) as e:
        load(write(tmp_path, text, **kw))
    return str(e.value)


def test_the_seed_alone_still_loads(tmp_path):
    cfg = load(write(tmp_path, SEED))
    assert cfg.steward is None and cfg.brain_server is None and dict(cfg.brains) == {}


def test_the_links_load(tmp_path):
    cfg = load(write(tmp_path, SEED + LINKS))
    assert cfg.steward.url == "https://steward.example:8443/mcp"
    assert cfg.steward.credential == "front-secret-1"            # stripped of its newline
    assert cfg.steward.ca_file == tmp_path / "secrets" / "home-ca.pem"
    assert cfg.brain_server.allowed_hosts == ("front.example:8766",)
    assert dict(cfg.brains) == {"brain-local": "local-secret-2", "brain-cloud": "cloud-secret-3"}
    assert cfg.store.url == "postgresql://voice_kitchen@postgres:5432/galatea"
    assert cfg.store.schema == "voice_kitchen"                   # the role's own schema
    assert cfg.store.password == "db-secret-4"
    assert cfg.store.audio_dir == tmp_path / "audio"
    assert cfg.store.keep_s == 7 * 24 * 3600
    assert cfg.state_dir == tmp_path / "state"


def test_no_credential_is_ever_shown(tmp_path):
    cfg = load(write(tmp_path, SEED + LINKS))
    shown = repr(cfg)
    assert not any(s in shown for s in ("front-secret-1", "local-secret-2", "cloud-secret-3", "db-secret-4"))


def test_a_steward_off_this_host_is_reached_only_over_tls(tmp_path):
    msg = refused(tmp_path, SEED + LINKS.replace("https://steward.example", "http://steward.example"))
    assert "https" in msg


def test_a_steward_on_loopback_may_be_plain(tmp_path):
    cfg = load(write(tmp_path, SEED + LINKS.replace("https://steward.example:8443", "http://127.0.0.1:8443")))
    assert cfg.steward.url.startswith("http://127.0.0.1")


def test_a_brain_server_off_loopback_needs_tls(tmp_path):
    text = SEED + LINKS.replace('cert_file = "secrets/front.pem"\nkey_file = "secrets/front.key"\n', "")
    assert "TLS" in refused(tmp_path, text)


def test_a_brain_server_off_loopback_needs_the_names_brains_use(tmp_path):
    """The SDK refuses a Host header it was not told of; fails if the front
    binds the network with none named."""
    assert "names" in refused(tmp_path, SEED + LINKS.replace('names = ["front.example"]\n', ""))


def test_a_brain_server_on_loopback_allows_loopback_names(tmp_path):
    text = SEED + LINKS.replace('host = "0.0.0.0"', 'host = "127.0.0.1"').replace('names = ["front.example"]\n', "")
    cfg = load(write(tmp_path, text))
    assert cfg.brain_server.allowed_hosts == ("127.0.0.1:8766", "localhost:8766", "[::1]:8766")


def test_two_brains_with_one_credential_are_refused(tmp_path):
    """GA-VOICE-19: fails if one secret may stand for two brains."""
    msg = refused(tmp_path, SEED + LINKS, secrets={"front": "a", "brain-local": "same", "brain-cloud": "same"})
    assert "share" in msg and "same" not in msg.replace("share", "")


def test_a_brain_listed_twice_is_refused(tmp_path):
    text = SEED + LINKS.replace('client_id = "brain-cloud"', 'client_id = "brain-local"')
    assert "twice" in refused(tmp_path, text)


def test_a_missing_or_empty_credential_file_is_refused(tmp_path):
    assert "cannot read" in refused(tmp_path, SEED + LINKS, secrets={"brain-local": "x", "brain-cloud": "y",
                                                                       "db": "z"})
    assert "empty" in refused(tmp_path, SEED + LINKS, secrets={"front": " ", "brain-local": "x",
                                                                 "brain-cloud": "y", "db": "z"})


def test_a_missing_store_password_file_is_refused(tmp_path):
    assert "store.password_file" in refused(tmp_path, SEED + LINKS, secrets={"front": "w", "brain-local": "x",
                                                                               "brain-cloud": "y"})


def test_a_store_kept_less_than_an_hour_is_refused(tmp_path):
    text = SEED + LINKS.replace('audio_dir = "audio"', 'audio_dir = "audio"\nkeep_s = 600')
    assert "3600" in refused(tmp_path, text)


@pytest.mark.parametrize("url,says", [
    ("postgresql://voice_kitchen:hunter2@postgres/galatea", "password"),     # credentials live in files
    ("postgresql://postgres/galatea", "role"),
    ("postgresql://Voice-Kitchen@postgres/galatea", "role"),
    ("sqlite:///front.sqlite", "postgresql"),
    ("postgresql://voice_kitchen@postgres/galatea?password=x", "password"),
    ("postgresql://voice_kitchen@postgres/galatea?sslmode=require&password=", "password"),
    ("postgresql://voice_kitchen@postgres/galatea?user=postgres", "user"),
    ("postgresql://voice_kitchen@postgres/galatea?passfile=/x", "passfile"),
    ("postgresql://voice_kitchen@postgres/galatea?service=s", "service"),
])
def test_a_store_url_that_is_not_the_fronts_role_is_refused(tmp_path, url, says):
    text = SEED + LINKS.replace("postgresql://voice_kitchen@postgres:5432/galatea", url)
    message = refused(tmp_path, text)
    assert says in message and "hunter2" not in message


@pytest.mark.parametrize("table", ["steward", "brain_server", "store", "state"])
def test_an_unknown_key_in_a_new_table_is_refused(tmp_path, table):
    text = SEED + LINKS.replace(f"[{table}]\n", f"[{table}]\nsurprise = 1\n")
    assert "surprise" in refused(tmp_path, text)


def test_a_brain_server_with_no_brains_is_refused(tmp_path):
    start = LINKS.index("[[brains]]")
    text = SEED + LINKS[:start] + LINKS[LINKS.index("[store]"):]
    assert "brains" in refused(tmp_path, text)


def test_a_store_url_may_keep_its_other_query_keys(tmp_path):
    text = SEED + LINKS.replace("/galatea\"", "/galatea?sslmode=require\"")
    assert load(write(tmp_path, text)).store.url.endswith("?sslmode=require")


@pytest.mark.parametrize("value", ['""', "1"])
def test_an_empty_or_non_string_certificate_is_refused(tmp_path, value):
    """GA-SEC-2: fails if an empty path counts as a certificate and the network is served plain."""
    text = SEED + LINKS.replace('cert_file = "secrets/front.pem"', f"cert_file = {value}").replace(
        'key_file = "secrets/front.key"', f"key_file = {value}")
    assert "cert_file" in refused(tmp_path, text)


def test_a_steward_url_with_userinfo_is_refused_without_quoting_it(tmp_path):
    text = SEED + LINKS.replace("https://steward.example", "https://u:pw-9@steward.example")
    message = refused(tmp_path, text)
    assert "steward.url" in message and "pw-9" not in message


def test_a_credential_file_that_is_not_text_is_refused(tmp_path):
    p = write(tmp_path, SEED + LINKS)
    (tmp_path / "secrets" / "front.credential").write_bytes(b"\xff\xfe\x00")
    with pytest.raises(ConfigError) as e:
        load(p)
    assert "front.credential" in str(e.value) and "UTF-8" in str(e.value)


@pytest.mark.parametrize("name", ["front.example:443", "https://front.example", "front.example/x"])
def test_a_brain_server_name_is_a_bare_host_name(tmp_path, name):
    text = SEED + LINKS.replace('"front.example"', f'"{name}"')
    assert "names" in refused(tmp_path, text)


def test_a_brain_server_on_ipv6_loopback_allows_its_bracketed_names(tmp_path):
    text = SEED + LINKS.replace('host = "0.0.0.0"', 'host = "::1"').replace('names = ["front.example"]\n', "")
    cfg = load(write(tmp_path, text))
    assert "[::1]:8766" in cfg.brain_server.allowed_hosts


# ---- stage 2c: the synthesiser and the fixed clips ------------------------------------

SPEAKING = """
[synthesiser]
uri = "tcp://127.0.0.1:10200"
voice = "ru_RU-irina-medium"

[[clips]]
name = "cannot_answer"
path = "clips/cannot_answer.wav"
text = "Не могу ответить"

[[clips]]
name = "earcon"
path = "clips/earcon.wav"
text = ""
"""


def test_the_synthesiser_and_the_clips_load(tmp_path):
    """Fails too if reading them disturbs a table read before them."""
    cfg = load(write(tmp_path, SEED + LINKS + SPEAKING))
    assert (cfg.synthesiser.uri, cfg.synthesiser.voice, cfg.synthesiser.timeout_s) == (
        "tcp://127.0.0.1:10200", "ru_RU-irina-medium", 10.0)
    assert [(c.name, c.path, c.text) for c in cfg.clips] == [
        ("cannot_answer", tmp_path / "clips" / "cannot_answer.wav", "Не могу ответить"),
        ("earcon", tmp_path / "clips" / "earcon.wav", "")]
    assert (cfg.port, cfg.brain_server.port) == (8765, 8766)


def test_without_them_nothing_speaks_yet(tmp_path):
    cfg = load(write(tmp_path, SEED))
    assert cfg.synthesiser is None and cfg.clips == ()


@pytest.mark.parametrize("uri", ["unix:///run/wyoming/tts.sock", "tcp://localhost:10200", "tcp://[::1]:10200"])
def test_a_synthesiser_on_this_host_is_taken(tmp_path, uri):
    assert load(write(tmp_path, SEED + SPEAKING.replace("tcp://127.0.0.1:10200", uri))).synthesiser.uri == uri


@pytest.mark.parametrize("uri,says", [
    ("tcp://tts.example:10200", "loopback"),         # Wyoming has no encryption: never off this host
    ("tcp://0.0.0.0:10200", "loopback"),
    ("tcp://localhost.:10200", "loopback"),          # a name, not the literal: resolving is no proof
    ("tcp://127.0.0.1.nip.example:10200", "loopback"),
    ("tcp://127.0.0.1", "port"),
    ("tcp://127.0.0.1:10200/piper", "nothing else"),
    ("tcp://127.0.0.1:99999", "port"),
    ("unix://tts.sock", "absolute"),
    ("http://127.0.0.1:10200", "tcp://"),
    ("stdio://", "tcp://"),
])
def test_a_synthesiser_that_is_not_on_this_host_is_refused(tmp_path, uri, says):
    assert says in refused(tmp_path, SEED + SPEAKING.replace("tcp://127.0.0.1:10200", uri))


@pytest.mark.parametrize("value", ["0", "-1", "31", "true", '"10"'])
def test_a_synthesiser_timeout_out_of_range_is_refused(tmp_path, value):
    text = SEED + SPEAKING.replace('voice = "ru_RU-irina-medium"', f"timeout_s = {value}")
    assert "timeout_s" in refused(tmp_path, text)


def test_a_name_that_resolves_to_loopback_is_not_enough(tmp_path, monkeypatch):
    """Only an address as written, or localhost: fails if a host name is
    trusted because it resolves to loopback today."""
    import voice_front.config as config
    monkeypatch.setattr(config, "resolves_to_loopback_only", lambda host: True)
    assert "loopback" in refused(tmp_path, SEED + SPEAKING.replace("127.0.0.1", "tts.example"))


def test_a_synthesiser_timeout_up_to_the_piece_deadline_is_taken(tmp_path):
    text = SEED + SPEAKING.replace('voice = "ru_RU-irina-medium"', "timeout_s = 30")
    assert load(write(tmp_path, text)).synthesiser.timeout_s == 30


def test_an_empty_voice_is_refused_rather_than_sent(tmp_path):
    assert "synthesiser.voice" in refused(tmp_path, SEED + SPEAKING.replace('"ru_RU-irina-medium"', '""'))


@pytest.mark.parametrize("change,says", [
    (('name = "earcon"', 'name = "goodbye"'), "not one of"),
    (('name = "earcon"', 'name = "cannot_answer"'), "twice"),
    (('text = ""', 'text = "Слушаю"'), "a sound"),
    (('text = "Не могу ответить"', 'text = ""'), "cannot be empty"),
    (('name = "cannot_answer"', 'name = "not_recognised"'), "'cannot_answer' is required"),
    (('text = ""\n', ''), "clips[1].text"),
    (('path = "clips/earcon.wav"', 'path = ""'), "clips[1].path"),
    (('text = ""\n', 'text = ""\nloop = true\n'), "loop"),
])
def test_a_clip_list_the_front_could_not_declare_is_refused(tmp_path, change, says):
    """GA-VOICE-11: every clip is one the standard names, with the text it
    says; fails if a clip could play words front_status does not declare."""
    assert says in refused(tmp_path, SEED + SPEAKING.replace(*change))


def test_clips_as_a_table_is_refused(tmp_path):
    text = SEED + '[clips]\nname = "cannot_answer"\npath = "c.wav"\ntext = "Не могу ответить"\n'
    assert "[[clips]]" in refused(tmp_path, text)


def test_an_unknown_key_in_the_synthesiser_is_refused(tmp_path):
    assert "surprise" in refused(tmp_path, SEED + SPEAKING.replace("[synthesiser]\n", "[synthesiser]\nsurprise = 1\n"))
