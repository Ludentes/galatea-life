"""Nothing private and no wake word reaches the package.

⛔ The repository goes public. The seed came from a private product, and its
comments named that product's apps, rigs, hosts and issues. This test is the
floor, not the review: it catches the patterns, and a reviewer reads the rest.
"""
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "voice_front"
SCANNED = {".py", ".toml", ".sh", ".json", ".md", ".txt", ".cfg"}
SKIP_DIRS = {".venv", "models", "vendor", "__pycache__", ".pytest_cache"}

# A bracketed letter keeps a name pattern from spelling the name it bans, so a
# scan of the repository does not find it here.
BANNED_EVERYWHERE = {
    "the private product's name": re.compile(r"u[m]ka", re.I),
    "its content service": re.compile(r"\bcms\b", re.I),
    "its app": re.compile(r"guide-?app", re.I),
    "its research tree": re.compile(r"experiments/|voice-h0|wwpipe", re.I),
    "its repositories": re.compile(r"prototype/|docs/superpowers", re.I),
    "a home directory": re.compile(r"/home/|~/"),
    "an IP address": re.compile(r"\b(?!127\.0\.0\.1\b)(?!0\.0\.0\.0\b)(?:\d{1,3}\.){3}\d{1,3}\b"),
    "a host of the private network": re.compile(r"\.171\b|m[a]ugry", re.I),
}
# The wake word is data: no source file names one.
BANNED_IN_SOURCE = {
    "a wake word": re.compile(r"у[м]к|галате", re.I),
}


def _files(base: Path):
    for p in base.rglob("*"):
        if p.is_file() and p.suffix in SCANNED and not SKIP_DIRS & set(p.parts):
            yield p


def _hits(files, patterns):
    out = []
    for p in files:
        text = p.read_text(encoding="utf-8")
        for what, rx in patterns.items():
            for m in rx.finditer(text):
                line = text.count("\n", 0, m.start()) + 1
                out.append(f"{p.relative_to(ROOT)}:{line}: {what} ({m.group(0)!r})")
    return out


def test_no_private_reference_anywhere_in_the_package():
    hits = _hits([p for p in _files(ROOT) if p.name != "test_hygiene.py"],
                 BANNED_EVERYWHERE)
    assert not hits, "\n".join(hits)


def test_no_source_file_names_a_wake_word():
    hits = _hits(_files(SOURCE), BANNED_IN_SOURCE)
    assert not hits, "\n".join(hits)


def test_models_and_local_configuration_are_not_committable():
    for path in ("models/x.onnx", "vendor/x.so", "voice-front.toml", "x.wav",
                 "tests/cases/local/x.json",
                 # stage 2b: secrets, keys, certificates, kept audio and the state
                 "secrets/front.credential", "x.credential", "x.key", "x.pem",
                 "state/last.json", "audio/voice_kitchen/x.pcm", "x.pcm"):
        rc = subprocess.run(["git", "check-ignore", "-q", path], cwd=ROOT).returncode
        assert rc == 0, f"{path} is committable"


def test_no_json_under_tests_is_tracked():
    """Measured cases hold real speech and stay local. Test data that is
    committed lives in the test modules, where a reviewer reads it."""
    tracked = subprocess.run(["git", "ls-files", "tests"], cwd=ROOT, check=True,
                             capture_output=True, text=True).stdout.split()
    json_files = [p for p in tracked if p.endswith(".json")]
    assert not json_files, json_files
