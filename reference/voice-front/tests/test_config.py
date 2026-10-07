import re
from pathlib import Path

import pytest

from voice_front.config import ConfigError, load
from voice_front.wake.transcript import WakeRule

EXAMPLE = Path(__file__).resolve().parents[1] / "voice-front.example.toml"


def _write(tmp_path, text):
    p = tmp_path / "voice-front.toml"
    p.write_text(text, encoding="utf-8")
    return p


GOOD = """
[server]
host = "127.0.0.1"
port = 8765

[models]
dir = "models"

[[wake_words]]
word = "Галатея"
inflections = ["галатеи", "галатее", "галатею", "галатеей"]

[[wake_words]]
word = "дом"
carrier = "привет"
"""


def test_the_example_loads():
    cfg = load(EXAMPLE)
    assert cfg.wake_rules


@pytest.mark.parametrize("host", ["localhost", "127.0.0.1", "::1"])
def test_loopback_hosts_are_accepted(tmp_path, host):
    assert load(_write(tmp_path, f'[server]\nhost = "{host}"\n[[wake_words]]\nword = "дом"\n')).host == host


@pytest.mark.parametrize("host", ["0.0.0.0", "::", "no-such-host.invalid"])
def test_a_host_that_is_not_only_loopback_is_refused(tmp_path, host):
    """⛔ Resolved, not string-matched. A wildcard reaches the whole network, and
    until stage 2 this link has no TLS and no device keys."""
    with pytest.raises(ConfigError, match="loopback"):
        load(_write(tmp_path, f'[server]\nhost = "{host}"\n[[wake_words]]\nword = "дом"\n'))


def test_a_good_file(tmp_path):
    cfg = load(_write(tmp_path, GOOD))
    assert (cfg.host, cfg.port) == ("127.0.0.1", 8765)
    assert cfg.models_dir == tmp_path / "models"   # relative to the file
    assert cfg.wake_rules[0] == WakeRule(
        word="галатея", inflections=frozenset({"галатеи", "галатее", "галатею", "галатеей"}))
    assert cfg.wake_rules[1].carrier == "привет"


def test_defaults(tmp_path):
    cfg = load(_write(tmp_path, '[[wake_words]]\nword = "дом"\n'))
    assert (cfg.host, cfg.port) == ("127.0.0.1", 8765)
    assert cfg.models_dir == tmp_path / "models"


@pytest.mark.parametrize("text, says", [
    ("", "wake_words"),
    ('[[wake_words]]\nword = "два слова"\n', "wake_words[0]"),
    ('[server]\nport = "x"\n[[wake_words]]\nword = "дом"\n', "port"),
    ('[server]\nport = 70000\n[[wake_words]]\nword = "дом"\n', "port"),
    ('[sever]\nport = 1\n[[wake_words]]\nword = "дом"\n', "sever"),
    ('[[wake_words]]\nword = "дом"\ncarier = "привет"\n', "carier"),
    ('[[wake_words]]\nword = "дом"\ncarrier = ""\n', "wake_words[0]"),
    ('[server]\nmachine = "kitchen"\n[[wake_words]]\nword = "дом"\n', "machine"),
    ("not toml = = =", "voice-front.toml"),
])
def test_a_bad_file_says_what_is_wrong(tmp_path, text, says):
    with pytest.raises(ConfigError, match=re.escape(says)):
        load(_write(tmp_path, text))
