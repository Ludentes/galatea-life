"""The effective setting, what a mode admits, who may address: as tables.

Each row names the change that would redden it.
"""
import json
import os

import pytest

from voice_front import listening as L
from voice_front.listening import Narrowing, Record, WakeWord

WORD = WakeWord("Привет, Галатея", L.TRANSCRIPT)
MODEL_WORD = WakeWord("Галатея", "galatea-mww-v1")
SERVER = Record(L.WAKE_SERVER, (WORD,), follow_up=True, zone="kitchen", output="speech")


def test_the_configured_record_with_nothing_in_force():
    assert L.effective(SERVER) == L.Effective(SERVER, L.CONFIGURED)


def test_nothing_ever_read_listens_nowhere():
    """GA-VOICE-3. Fails if a front with no setting and no steward listens."""
    got = L.effective(None)
    assert got.record.listening == L.OFF and got.reason == L.NO_STEWARD


@pytest.mark.parametrize("narrowings,listening,follow_up", [
    ([Narrowing(listening=L.TAP)], L.TAP, True),
    ([Narrowing(follow_up=False)], L.WAKE_SERVER, False),
    # Narrowings stack field by field; one never lifts another.
    ([Narrowing(listening=L.TAP), Narrowing(listening=L.WAKE_DEVICE)], L.TAP, True),
    ([Narrowing(listening=L.OFF), Narrowing(follow_up=False)], L.OFF, False),
])
def test_narrowings_stack_to_the_narrowest(narrowings, listening, follow_up):
    got = L.effective(SERVER, narrowings)
    assert (got.record.listening, got.record.follow_up, got.reason) == (
        listening, follow_up, L.NARROWED)


def test_a_narrowing_never_widens():
    """Fails if a narrowing's mode replaces the configured one instead of
    lowering it. The steward refuses one this wide; the front never trusts that."""
    tap = Record(L.TAP, (WORD,))
    assert L.effective(tap, [Narrowing(listening=L.WAKE_SERVER)]) == L.Effective(tap, L.CONFIGURED)


@pytest.mark.parametrize("kwargs,reason", [
    ({"online": False}, L.OFFLINE),
    ({"muted": True}, L.MUTED),
    ({"online": False, "muted": True}, L.OFFLINE),
])
def test_offline_and_muted_are_off(kwargs, reason):
    got = L.effective(SERVER, **kwargs)
    assert got.record.listening == L.OFF and got.reason == reason


def test_a_named_model_the_box_cannot_run_falls_back_to_the_transcript_at_wake_server():
    rec = Record(L.WAKE_SERVER, (MODEL_WORD,))
    got = L.effective(rec)
    assert got.reason == L.NO_MODEL
    assert got.record.listening == L.WAKE_SERVER
    assert got.record.wake_words == (WakeWord("Галатея", L.TRANSCRIPT),)


def test_a_named_model_the_box_runs_is_configured():
    rec = Record(L.WAKE_SERVER, (MODEL_WORD,))
    assert L.effective(rec, runnable=frozenset({"galatea-mww-v1"})).reason == L.CONFIGURED


def test_wake_device_with_no_device_model_falls_back_to_tap():
    """GA-VOICE-4. Fails if a transcript word is thought checkable at
    wake_device, where only the device's windows are streamed."""
    rec = Record(L.WAKE_DEVICE, (WORD, MODEL_WORD))
    got = L.effective(rec)
    assert (got.record.listening, got.record.wake_words, got.reason) == (L.TAP, (), L.NO_MODEL)


def test_wake_device_keeps_the_words_its_device_checks():
    rec = Record(L.WAKE_DEVICE, (WORD, MODEL_WORD))
    got = L.effective(rec, device_models=frozenset({"galatea-mww-v1"}))
    assert (got.record.listening, got.record.wake_words, got.reason) == (
        L.WAKE_DEVICE, (MODEL_WORD,), L.NO_MODEL)


def test_no_model_outranks_narrowed():
    """A narrowing is listed in `describe`; a word nothing checks is seen only
    through the reason, so the reason says that."""
    rec = Record(L.WAKE_SERVER, (MODEL_WORD,), follow_up=True)
    assert L.effective(rec, [Narrowing(follow_up=False)]).reason == L.NO_MODEL


def test_a_narrowing_to_tap_needs_no_model():
    rec = Record(L.WAKE_SERVER, (MODEL_WORD,))
    assert L.effective(rec, [Narrowing(listening=L.TAP)]).reason == L.NARROWED


def test_a_lost_steward_keeps_the_last_setting_and_says_so():
    got = L.effective(SERVER, [Narrowing(listening=L.TAP)], steward_lost=True)
    assert (got.record.listening, got.reason) == (L.TAP, L.NO_STEWARD)


@pytest.mark.parametrize("mode,window,admitted", [
    (L.OFF, L.TAP_WINDOW, False),         # fails if a tap opens anything at off
    (L.TAP, None, False),                  # hears-before-the-tap
    (L.TAP, L.TAP_WINDOW, True),
    (L.TAP, L.DEVICE_WINDOW, False),       # a device's own wake opens nothing at tap
    (L.WAKE_DEVICE, None, False),
    (L.WAKE_DEVICE, L.DEVICE_WINDOW, True),
    (L.WAKE_DEVICE, L.TAP_WINDOW, True),
    (L.WAKE_SERVER, None, True),
])
def test_admits(mode, window, admitted):
    assert L.admits(mode, window) is admitted


@pytest.mark.parametrize("mode,by,allowed", [
    (L.OFF, L.BY_TAP, False),
    (L.TAP, L.BY_TAP, True),
    (L.TAP, L.BY_WAKE, False),             # fails if a wake addresses at tap
    (L.WAKE_DEVICE, L.BY_WAKE, True),
    (L.WAKE_SERVER, L.BY_WAKE, True),       # the transcript rule addresses here
    (L.WAKE_SERVER, L.BY_TAP, True),
])
def test_may_address(mode, by, allowed):
    assert L.may_address(mode, by) is allowed


def test_the_last_setting_survives_a_restart(tmp_path):
    path = tmp_path / "last.json"
    last = {"ep-kitchen": (SERVER, (Narrowing(listening=L.TAP),))}
    L.save_last(path, last)
    assert L.load_last(path) == last
    assert not (tmp_path / "last.json.tmp").exists()


@pytest.mark.parametrize("content", [None, "", "not json", json.dumps({"version": 99}),
                                     json.dumps({"version": 1, "endpoints": {"e": {}}})])
def test_an_unreadable_last_setting_is_none(tmp_path, content):
    """⛔ Fails if a damaged file is read as a guess rather than as nothing."""
    path = tmp_path / "last.json"
    if content is not None:
        path.write_text(content, encoding="utf-8")
    assert L.load_last(path) == {}


def test_an_unknown_mode_is_refused():
    with pytest.raises(ValueError):
        Record("loud")
    with pytest.raises(ValueError):
        Narrowing(listening="demo")


def test_an_unknown_mode_admits_nothing():
    """⛔ Fails closed, like `may_address`."""
    with pytest.raises(ValueError):
        L.admits("wake_everywhere", None)


def test_follow_up_is_on_only_when_stored_as_true(tmp_path):
    path = tmp_path / "last.json"
    for stored, expected in [(True, True), (False, False), ("false", False),
                             (1, False), ("yes", False), (None, False)]:
        doc = {"version": 1, "endpoints": {"e": {
            "configured": {"listening": "tap", "wake_words": [], "follow_up": stored},
            "narrowings": []}}}
        path.write_text(json.dumps(doc), encoding="utf-8")
        (record, _), = L.load_last(path).values()
        assert record.follow_up is expected, stored


def test_a_last_setting_that_is_not_an_object_is_none(tmp_path):
    path = tmp_path / "last.json"
    path.write_text("[]", encoding="utf-8")
    assert L.load_last(path) == {}


def test_a_failed_save_keeps_the_previous_file_and_no_temp(tmp_path, monkeypatch):
    path = tmp_path / "last.json"
    last = {"ep": (Record(L.TAP), ())}
    L.save_last(path, last)

    def boom(*a, **k):
        raise OSError("disk gone")
    monkeypatch.setattr(os, "replace", boom)
    with pytest.raises(OSError):
        L.save_last(path, {})
    assert L.load_last(path) == last
    assert [p.name for p in tmp_path.iterdir()] == ["last.json"]
