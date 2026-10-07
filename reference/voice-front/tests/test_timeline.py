"""The front's clock: placing a stream's audio, and the epochs of its wall-time
mapping. Clocks are fakes the test drives."""
import json

import pytest

from voice_front.timeline import (EpochStoreError, Stream, WallClock,
                                  reported)

RATE = 16_000
FRAME = 320          # 20 ms


def feed(stream, arrivals, start=0):
    for i, arrival in enumerate(arrivals):
        stream.frame(start + i * FRAME, arrival)


def test_a_steady_stream_is_placed_by_its_quickest_frame():
    s = Stream()
    # Each frame arrives 50 ms after it began, but one came through in 30 ms.
    arrivals = [100.05 + i * 0.02 for i in range(10)]
    arrivals[4] -= 0.02
    feed(s, arrivals)
    assert s.at(0) == pytest.approx(100.03)
    assert s.at(RATE) == pytest.approx(101.03)


def test_a_short_stall_delays_arrivals_but_does_not_move_the_audio():
    """Fails if the anchor follows the latest frame rather than the least."""
    s = Stream()
    feed(s, [100.05 + i * 0.02 for i in range(50)])
    before = s.at(0)
    # A 2 s stall: the next frames arrive late, in a burst.
    feed(s, [103.05 + i * 0.001 for i in range(20)], start=50 * FRAME)
    assert s.at(0) == pytest.approx(before)


def test_a_slow_device_clock_is_corrected_within_the_window():
    """The device captures 1 % slow: its positions fall behind the front's
    clock. Once the early frames leave the anchor window, the anchor follows."""
    s = Stream()
    arrivals = [100.0 + (i * FRAME / RATE) * 1.01 for i in range(1500)]   # 30 s
    feed(s, arrivals)
    last = 1499 * FRAME
    assert s.at(last) == pytest.approx(arrivals[-1], abs=0.11)


def test_the_head_sits_before_the_stream_began():
    s = Stream(head_samples=RATE)             # 1 s of pre-roll, then the stream
    feed(s, [100.02, 100.04])
    assert s.at(0) == pytest.approx(100.02)
    assert s.at(-RATE) == pytest.approx(99.02)


def test_no_anchor_before_a_frame():
    with pytest.raises(ValueError):
        Stream().at(0)


def test_arrivals_never_go_back():
    s = Stream()
    s.frame(0, 100.0)
    with pytest.raises(ValueError):
        s.frame(FRAME, 99.0)


def test_a_reported_stretch_is_placed_at_its_arrival():
    assert reported(50.0, duration_ms=1500, ended_ago_ms=200) == pytest.approx((48.3, 49.8))
    with pytest.raises(ValueError):
        reported(50.0, duration_ms=-1, ended_ago_ms=0)


class Clocks:
    def __init__(self, mono=10.0, wall=1_790_000_000.0):
        self.mono, self.wall = mono, wall

    def tick(self, s):
        self.mono += s
        self.wall += s


def test_the_first_start_is_epoch_zero_and_each_restart_counts_up(tmp_path):
    store = tmp_path / "epoch.json"
    c = Clocks()
    assert WallClock(store, mono=lambda: c.mono, wall=lambda: c.wall).epoch == 0
    assert WallClock(store, mono=lambda: c.mono, wall=lambda: c.wall).epoch == 1
    assert json.loads(store.read_text()) == {"epoch": 1}


def test_a_restart_after_a_step_never_reuses_an_epoch(tmp_path):
    """reuses-an-epoch: fails if the epoch restarts from 0 after a restart."""
    store = tmp_path / "epoch.json"
    c = Clocks()
    first = WallClock(store, mono=lambda: c.mono, wall=lambda: c.wall)
    c.wall -= 3600                          # the wall clock steps back
    assert first.check() is True
    assert first.epoch == 1
    again = WallClock(store, mono=lambda: c.mono, wall=lambda: c.wall)
    assert again.epoch == 2


@pytest.mark.parametrize("drift,reanchored", [(0.9, False), (1.0, False), (1.1, True)])
def test_drift_past_the_tolerance_reanchors(tmp_path, drift, reanchored):
    c = Clocks()
    clock = WallClock(tmp_path / "e.json", mono=lambda: c.mono, wall=lambda: c.wall)
    c.tick(60)
    c.wall += drift
    assert clock.check() is reanchored


def test_an_instant_is_written_by_the_mapping_in_force_when_it_happened(tmp_path):
    c = Clocks(mono=10.0, wall=1_790_000_000.0)
    clock = WallClock(tmp_path / "e.json", mono=lambda: c.mono, wall=lambda: c.wall)
    c.tick(5)
    c.wall += 30                            # a step
    clock.check()
    before, epoch_before = clock.rfc3339(12.0)
    after, epoch_after = clock.rfc3339(15.5)
    assert (epoch_before, epoch_after) == (0, 1)
    assert before == "2026-09-21T14:13:22.000+00:00"
    assert after == "2026-09-21T14:13:55.500+00:00"


@pytest.mark.parametrize("content", ["not json", json.dumps({"epoch": -1}),
                                     json.dumps({"epoch": True}), json.dumps([1])])
def test_a_damaged_epoch_store_stops_the_front(tmp_path, content):
    """⛔ Fails if a damaged store is read as epoch 0: that could reuse one."""
    store = tmp_path / "epoch.json"
    store.write_text(content)
    with pytest.raises(EpochStoreError):
        WallClock(store)


def test_a_store_that_cannot_be_written_stops_the_front(tmp_path):
    parent = tmp_path / "not-a-directory"
    parent.write_text("x", encoding="utf-8")
    with pytest.raises(EpochStoreError):
        WallClock(parent / "epoch.json")


def test_a_failed_write_leaves_no_temp_file(tmp_path, monkeypatch):
    import os
    store = tmp_path / "epoch.json"
    WallClock(store)

    def boom(*a, **k):
        raise OSError("disk gone")
    monkeypatch.setattr(os, "replace", boom)
    with pytest.raises(EpochStoreError):
        WallClock(store)
    assert [p.name for p in tmp_path.iterdir()] == ["epoch.json"]
    assert json.loads(store.read_text(encoding="utf-8")) == {"epoch": 0}
