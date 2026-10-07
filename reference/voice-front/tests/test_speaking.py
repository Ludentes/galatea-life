"""Speaking: pieces played in order at their endpoints, each reported
`played` once. Voice, *Speaking*; GA-VOICE-10, GA-VOICE-20; brain, *The
front*.

A fake synthesiser and fake players take fake time, which each test moves
(`speaking_doubles`); the scripted lines are the tests' own. Each case names
the change that would redden it.
"""
import math
from dataclasses import replace

import anyio
import pytest

from speaking_doubles import BRAIN, EPOCH, OTHER_BRAIN, FakePlayer, Front, at, running
from voice_front.echo import Interval
from voice_front.schemas import schemas
from voice_front.speaking import heard_chars

LONG = "Сорок символов текста в этом куске речи."      # 40 characters; the tests make it 4 s

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ---- order and `played` -------------------------------------------------------

async def test_pieces_play_in_arrival_order_and_each_is_reported_full():
    """Fails if a queue plays out of order or a piece goes unreported."""
    async with running() as f:
        a = await f.say("Свет на кухне включён.")
        b = await f.say("Чайник тоже.", continues=a)
        c = await f.say("Прогноз на завтра: ясно.")
        await f.clock.advance(3.5)
        assert f.players["ep-kitchen"].played == ["Свет на кухне включён.", "Чайник тоже.",
                                                   "Прогноз на завтра: ясно."]
        assert f.statuses() == [(a, "full", None), (b, "full", None), (c, "full", None)]
        assert f.report(a) == {"say_id": a, "endpoint": "ep-kitchen", "status": "full",
                               "ended_at": at(1001.000), "clock_epoch": str(EPOCH)}
        assert f.report(c)["ended_at"] == at(1003.000)


async def test_say_returns_once_queued_not_once_played():
    async with running() as f:
        await f.say("Свет на кухне включён.")
        assert f.reports == []
        await f.clock.advance(1)
        assert len(f.reports) == 1


async def test_each_endpoint_has_its_own_queue():
    """Fails if one endpoint's reply waits behind another's."""
    async with running() as f:
        f.synth.seconds["Долгий рассказ о погоде."] = 5
        await f.say("Долгий рассказ о погоде.")
        await f.say("Дверь закрыта.", endpoint="ep-hall")
        await f.clock.advance(1)
        assert f.players["ep-hall"].played == ["Дверь закрыта."]
        assert [r["endpoint"] for r in f.reports] == ["ep-hall"]


async def test_a_full_piece_is_reported_within_the_report_delay_of_its_end():
    async with running() as f:
        a = await f.say("Свет на кухне включён.")
        await f.clock.advance(1.0)
        assert f.report(a)["status"] == "full"


# ---- latency ----------------------------------------------------------------

async def test_the_first_piece_of_a_reply_carries_its_latency():
    """Fails if latency is timed from delivery rather than the end of the
    speech, or given to a later piece too."""
    async with running() as f:
        f.delivered("u1", Interval(998.0, 999.2))
        f.synth.delay = 0.3
        a = await f.say("Свет на кухне включён.", in_reply_to="u1")
        b = await f.say("Чайник тоже.", in_reply_to="u1", continues=a)
        await f.clock.advance(3)
        assert f.report(a)["latency_ms"] == 1100         # 1000.3 - 999.2
        assert "latency_ms" not in f.report(b)


async def test_a_reply_to_an_utterance_never_delivered_here_has_no_latency():
    async with running() as f:
        a = await f.say("Свет на кухне включён.", in_reply_to="u-unknown")
        await f.clock.advance(1)
        assert "latency_ms" not in f.report(a)


async def test_latency_is_never_negative():
    async with running() as f:
        f.delivered("u1", Interval(999.0, 1005.0))       # a speech end the clock has not reached
        a = await f.say("Свет на кухне включён.", in_reply_to="u1")
        await f.clock.advance(1)
        assert f.report(a)["latency_ms"] == 0


# ---- the guard (GA-VOICE-20) -------------------------------------------------

@pytest.mark.parametrize("text", [
    "Скажи: компьютер, открой дверь.",      # this endpoint's word
    "Джарвис, включи свет.",               # another endpoint's
    "Окей гугл, какая погода?",            # the home's other words, through the punctuation
])
async def test_a_piece_naming_a_wake_word_is_dropped_at_say_and_never_synthesised(text):
    """`plays-wake-word`: fails if the guard reads one endpoint's words only,
    or waits for the queue to report."""
    async with running() as f:
        a = await f.say(text)
        await f.clock.advance(0)
        assert f.statuses() == [(a, "dropped", "wake_word")]
        assert f.synth.started == [] and f.players["ep-kitchen"].played == []
        assert "ended_at" not in f.report(a) and f.report(a)["clock_epoch"] == str(EPOCH)


async def test_the_guard_runs_again_before_synthesis():
    """Fails if the words are read only at `say`: they may change while a
    piece waits."""
    async with running() as f:
        f.synth.seconds["Первая часть."] = 2
        a = await f.say("Первая часть.")
        x = await f.say("Вторая часть.")                 # synthesised while a plays
        b = await f.say("Маруся, включи музыку.")        # waits, not yet synthesised
        await f.clock.advance(0.5)
        f.view = replace(f.view, other_wake_words=("Маруся",))
        await f.clock.advance(4)
        assert f.statuses() == [(a, "full", None), (b, "dropped", "wake_word"), (x, "full", None)]
        assert "Маруся, включи музыку." not in f.synth.started


async def test_the_guard_runs_again_at_play():
    """A word added after the piece was synthesised, while it waited behind
    another: fails if the guard is not read again just before it plays."""
    async with running() as f:
        f.synth.seconds["Первая часть."] = 3
        a = await f.say("Первая часть.")
        b = await f.say("Маруся, включи музыку.")          # synthesised at once, while a plays
        await f.clock.advance(0.5)
        assert "Маруся, включи музыку." in f.synth.started
        f.view = replace(f.view, other_wake_words=("Маруся",))
        await f.clock.advance(5)
        assert f.statuses() == [(a, "full", None), (b, "dropped", "wake_word")]
        assert f.players["ep-kitchen"].played == ["Первая часть."]


# ---- what stops a piece before it plays ---------------------------------------

async def test_with_no_view_yet_a_piece_is_not_served():
    """Fails if a front that has not yet heard from the steward names a
    reason that blames the endpoint's output."""
    async with running() as f:
        f.view = None
        a = await f.say("Первая часть.")
        await f.clock.advance(1)
        assert f.statuses() == [(a, "dropped", "not_served")]


async def test_speaking_that_is_not_running_says_so():
    f = Front()
    with pytest.raises(RuntimeError, match="start `run`"):
        await f.say("Первая часть.")

async def test_a_piece_for_an_endpoint_with_no_output_is_dropped():
    async with running() as f:
        f.change("ep-kitchen", output=None)
        a = await f.say("Свет на кухне включён.")
        await f.clock.advance(1)
        assert f.statuses() == [(a, "dropped", "no_output")]


async def test_output_turned_off_while_queued_drops_the_piece_at_play():
    async with running() as f:
        a = await f.say("Первая часть.")
        b = await f.say("Вторая часть.")
        await f.clock.advance(0.5)
        f.change("ep-kitchen", output=None)
        await f.clock.advance(2)
        assert f.statuses() == [(a, "full", None), (b, "dropped", "no_output")]


async def test_a_piece_whose_brain_no_longer_serves_the_endpoint_is_not_played():
    """Handover, before synthesis: fails if a former brain's queued piece
    plays."""
    async with running() as f:
        f.synth.seconds["Первая часть."] = 2
        a = await f.say("Первая часть.")
        x = await f.say("Вторая часть.")
        b = await f.say("Третья часть.")                 # waits, not yet synthesised
        await f.clock.advance(0.5)
        f.change("ep-kitchen", served_by=OTHER_BRAIN)
        await f.clock.advance(4)
        assert f.statuses() == [(a, "full", None), (x, "dropped", "not_served"), (b, "dropped", "not_served")]
        assert "Третья часть." not in f.synth.started


async def test_a_handover_after_synthesis_is_caught_before_play():
    """Fails if `served_by` is checked only before synthesis."""
    async with running() as f:
        a = await f.say("Первая часть.")
        b = await f.say("Вторая часть.")
        await f.clock.advance(0.5)                       # b is synthesised while a plays
        assert f.synth.started == ["Первая часть.", "Вторая часть."]
        f.change("ep-kitchen", served_by=OTHER_BRAIN)
        await f.clock.advance(2)
        assert f.statuses() == [(a, "full", None), (b, "dropped", "not_served")]
        assert f.players["ep-kitchen"].played == ["Первая часть."]


async def test_the_new_brains_pieces_play_after_a_handover():
    async with running() as f:
        f.change("ep-kitchen", served_by=OTHER_BRAIN)
        a = await f.say("Теперь отвечаю я.", brain=OTHER_BRAIN)
        await f.clock.advance(1)
        assert f.statuses() == [(a, "full", None)]


async def test_no_device_connected_drops_the_piece():
    async with running() as f:
        f.players["ep-kitchen"] = None
        a = await f.say("Свет на кухне включён.")
        await f.clock.advance(1)
        assert f.statuses() == [(a, "dropped", "no_device")]


async def test_a_device_gone_before_the_piece_began_drops_it_and_the_next_still_tries():
    async with running() as f:
        f.players["ep-kitchen"].gone = True
        a = await f.say("Первая часть.")
        await f.clock.advance(0)
        f.players["ep-kitchen"].gone = False
        b = await f.say("Вторая часть.")
        await f.clock.advance(1)
        assert f.statuses() == [(a, "dropped", "no_device"), (b, "full", None)]


async def test_a_device_that_leaves_mid_piece_cuts_it_with_what_was_heard():
    """Fails if a piece that was partly heard is reported dropped, or given a
    `cut_by`."""
    async with running() as f:
        text = "Сорок символов текста в этом куске речи."
        f.synth.seconds[text] = 4
        a = await f.say(text)
        await f.clock.advance(1)
        f.players["ep-kitchen"].leave()
        await f.clock.advance(0)
        r = f.report(a)
        assert (r["status"], r["heard_chars"], r["ended_at"]) == ("cut", round(len(text) / 4), at(1001.000))
        assert "cut_by" not in r


async def test_a_player_that_fails_loses_its_piece_not_the_front():
    """Fails if a bug in a link stops the endpoint's queue for good."""
    async with running() as f:
        f.players["ep-kitchen"].fail = RuntimeError("a bug in the link")
        a = await f.say("Первая часть.")
        await f.clock.advance(0)
        f.players["ep-kitchen"].fail = None
        b = await f.say("Вторая часть.")
        await f.clock.advance(1)
        assert f.statuses() == [(a, "dropped", "no_device"), (b, "full", None)]


async def test_a_lookup_of_the_device_that_raises_loses_the_piece_not_the_front():
    """Fails if a bug in `players` ends the lane, or all of speaking."""
    async with running() as f:
        players = f.speaking._players

        def flaky(endpoint):
            if endpoint == "ep-kitchen" and not f.reports:
                raise KeyError(endpoint)
            return players(endpoint)
        f.speaking._players = flaky
        a = await f.say("Первая часть.")
        await f.clock.advance(0)
        b = await f.say("Вторая часть.")
        c = await f.say("Дверь закрыта.", endpoint="ep-hall")
        await f.clock.advance(2)
        assert f.report(a)["reason"] == "no_device"
        assert (f.report(b)["status"], f.report(c)["status"]) == ("full", "full")


async def test_a_player_that_answers_nonsense_loses_its_piece_not_the_lane():
    class Nonsense:
        async def play(self, audio, stop, on_start):
            return "done"
    async with running() as f:
        f.players["ep-kitchen"] = Nonsense()
        a = await f.say("Первая часть.")
        await f.clock.advance(0)
        f.players["ep-kitchen"] = FakePlayer(f.clock)
        b = await f.say("Вторая часть.")
        await f.clock.advance(1)
        assert f.statuses() == [(a, "dropped", "no_device"), (b, "full", None)]


async def test_a_synthesis_failure_drops_the_piece_and_the_queue_goes_on():
    async with running() as f:
        f.synth.failing.add("Первая часть.")
        a = await f.say("Первая часть.")
        b = await f.say("Прогноз на завтра: ясно.")
        await f.clock.advance(1)
        assert f.statuses() == [(a, "dropped", "synth_failed"), (b, "full", None)]


async def test_a_view_that_fails_while_the_lane_looks_ahead_drops_a_piece_not_speaking():
    """Fails if a `view()` that raises between two pieces ends the lane, and
    with it Speaking."""
    async with running() as f:
        f.synth.delay = 0.5
        f.synth.failing.add("Первая часть.")
        a = await f.say("Первая часть.")
        b = await f.say("Вторая часть.")
        view = f.speaking._view

        def broken():
            raise RuntimeError("the view broke")
        f.speaking._view = broken
        await f.clock.advance(0.6)                        # a fails; the lane looks at b
        f.speaking._view = view
        c = await f.say("Третья часть.")
        await f.clock.advance(3)
        assert f.statuses() == [(a, "dropped", "synth_failed"), (b, "dropped", "no_device"),
                                (c, "full", None)]


# ---- synthesis runs one piece ahead ------------------------------------------

async def test_the_next_piece_is_synthesised_while_one_plays_and_no_further():
    """Fails with no lookahead (a gap between pieces) or with unbounded
    lookahead (a hushed reply's pieces synthesised for nothing)."""
    async with running() as f:
        f.synth.seconds["Первая часть."] = 2
        a = await f.say("Первая часть.")
        await f.say("Вторая часть.", continues=a)
        await f.say("Третья часть.")
        await f.clock.advance(0.5)
        assert f.synth.started == ["Первая часть.", "Вторая часть."]
        await f.clock.advance(2)
        assert f.synth.started == ["Первая часть.", "Вторая часть.", "Третья часть."]


async def test_with_synthesis_ahead_the_next_piece_starts_as_the_last_ends():
    async with running() as f:
        f.synth.delay = 0.4
        a = await f.say("Первая часть.")
        b = await f.say("Вторая часть.", continues=a)
        await f.clock.advance(2.4)
        assert f.report(a)["ended_at"] == at(1001.400)
        assert f.report(b)["ended_at"] == at(1002.400)      # no second synthesis delay


# ---- the reporter -------------------------------------------------------------

async def test_a_lost_store_delays_reports_never_speech_and_they_arrive_in_order():
    """Fails if a lost store stalls the queue, drops a report, reorders
    reports, or re-stamps `ended_at` when it is finally filed."""
    async with running() as f:
        f.down = True
        a = await f.say("Первая часть.")
        b = await f.say("Вторая часть.")
        await f.clock.advance(2)
        assert f.players["ep-kitchen"].played == ["Первая часть.", "Вторая часть."]
        assert f.reports == []
        f.down = False
        await f.clock.advance(10)
        assert f.statuses() == [(a, "full", None), (b, "full", None)]
        assert [r["ended_at"] for r in f.reports] == [at(1001.000), at(1002.000)]


async def test_the_reporter_backs_off_one_two_five_then_every_ten_seconds():
    async with running() as f:
        f.down = True
        await f.say("Первая часть.")
        await f.clock.advance(1)                 # reported at 1001: fails
        seen = []
        for _ in range(6):
            before = f.attempts
            t = f.clock.t
            while f.attempts == before:
                await f.clock.advance(0.5)
            seen.append(f.clock.t - t)
        assert seen == [1, 2, 5, 10, 10, 10]


# ---- the play log (GA-VOICE-8) ----------------------------------------------

async def test_the_play_log_holds_the_real_playback_open_while_it_plays():
    """Fails if a playback is logged at its queue time, or only once it
    ends: an utterance heard during a long piece must see it."""
    async with running() as f:
        f.synth.delay = 0.5
        await f.say("Свет на кухне включён.")
        await f.clock.advance(0.7)
        [s] = f.speaking.play_log.recent()
        assert (s.interval.start, s.interval.end, s.text) == (1000.5, math.inf, "Свет на кухне включён.")
        await f.clock.advance(1)
        [s] = f.speaking.play_log.recent()
        assert (s.interval.start, s.interval.end) == (1000.5, 1001.5)


async def test_the_play_log_forgets_after_its_keep_with_nothing_played_since():
    """Fails if old playbacks are pruned only when another one ends."""
    async with running() as f:
        await f.say("Первая часть.")
        await f.clock.advance(62)
        assert f.speaking.play_log.recent() == []


async def test_the_play_log_forgets_after_its_keep():
    async with running() as f:
        await f.say("Первая часть.")
        await f.clock.advance(62)
        await f.say("Вторая часть.")
        await f.clock.advance(1)
        assert [s.text for s in f.speaking.play_log.recent()] == ["Вторая часть."]


async def test_a_start_reported_after_the_playback_ended_opens_nothing():
    """A link that says a piece started after `play` returned: fails if the
    play log keeps an entry with no end, which would mark every later
    utterance an echo."""
    from voice_front.speaking import Playback

    class Late:
        def __init__(self):
            self.on_start = None

        async def play(self, audio, stop, on_start):
            self.on_start = on_start
            return Playback(1000.0, 1001.0, completed=True)

    async with running() as f:
        late = f.players["ep-kitchen"] = Late()
        a = await f.say("Свет на кухне включён.")
        await f.clock.advance(0)
        late.on_start(1000.5)
        assert f.report(a)["status"] == "full"
        assert [(s.interval.start, s.interval.end) for s in f.speaking.play_log.recent()] == [(1000.0, 1001.0)]


def test_heard_chars_is_in_proportion_to_the_time_played():
    assert heard_chars("четыре слова тут есть", 0.5, 2.0) == 5
    assert heard_chars("текст", 9, 2.0) == 5            # clamped to the text
    assert heard_chars("текст", 1, 0) == 0


async def test_every_report_has_the_played_shape_and_no_other_field():
    """brain/listen.response.json's `played`: fails if a field is of the
    wrong kind, or is one the schema does not name (it allows extras, so
    that is checked here)."""
    s = schemas()
    known = set(s.schema("brain/listen.response.json")["properties"]["played"]["items"]["properties"])
    async with running() as f:
        f.synth.seconds[LONG] = 4
        f.delivered("u1", Interval(999.0, 999.5))
        await f.say(LONG, in_reply_to="u1")
        await f.say("Алиса, включи свет.")
        await f.clock.advance(1)
        await f.speaking.cut("ep-kitchen", "u-wake")
        assert {r["status"] for r in f.reports} == {"cut", "dropped"}
        for r in f.reports:
            s.check("brain/listen.response.json", {"utterances": [], "played": [r], "cursor": "c"})
            assert set(r) <= known, set(r) - known


# ---- hush (GA-VOICE-10) -------------------------------------------------------

async def test_hush_endpoint_cuts_what_plays_and_drops_what_is_queued():
    """Fails if a hushed endpoint goes on speaking, if a queued piece is
    reported anything but `hush`, or if the cut piece names a `cut_by`."""
    async with running() as f:
        f.synth.seconds[LONG] = 4
        a = await f.say(LONG)
        b = await f.say("Вторая часть.", continues=a)
        c = await f.say("Другой ответ.")
        await f.clock.advance(1)
        await f.speaking.hush(BRAIN, {"endpoint": "ep-kitchen"})
        await f.clock.advance(0)
        assert f.statuses() == [(b, "dropped", "hush"), (c, "dropped", "hush"), (a, "cut", None)]
        r = f.report(a)
        assert (r["heard_chars"], r["ended_at"]) == (10, at(1001.0)) and "cut_by" not in r
        await f.clock.advance(5)
        assert f.players["ep-kitchen"].played == [LONG]


async def test_after_a_hush_the_endpoint_speaks_again():
    async with running() as f:
        await f.say("Первая часть.")
        await f.clock.advance(0.5)
        await f.speaking.hush(BRAIN, {"endpoint": "ep-kitchen"})
        d = await f.say("Новый ответ.")
        await f.clock.advance(1)
        assert f.report(d)["status"] == "full"


async def test_hush_endpoint_with_nothing_said_there_does_nothing():
    async with running() as f:
        await f.speaking.hush(BRAIN, {"endpoint": "ep-hall"})
        assert f.reports == []


async def test_hush_say_id_cuts_that_piece_and_its_reply_not_the_next_reply():
    """Fails if a hush by `say_id` stops more than the named reply, or leaves
    its later pieces to play."""
    async with running() as f:
        f.synth.seconds[LONG] = 4
        a = await f.say(LONG)
        b = await f.say("Вторая часть.", continues=a)
        c = await f.say("Другой ответ.")
        await f.clock.advance(2)
        await f.speaking.hush(BRAIN, {"say_id": a})
        await f.clock.advance(2)
        assert f.statuses() == [(a, "cut", None), (b, "dropped", "earlier_cut"), (c, "full", None)]
        assert f.report(a)["heard_chars"] == 20


async def test_hush_say_id_of_a_queued_piece_drops_it_and_what_continues_it():
    async with running() as f:
        a = await f.say("Первый ответ.")
        b = await f.say("Второй ответ.")
        c = await f.say("Его продолжение.", continues=b)
        await f.clock.advance(0.5)
        await f.speaking.hush(BRAIN, {"say_id": b})
        await f.clock.advance(2)
        assert f.statuses() == [(b, "dropped", "hush"), (c, "dropped", "earlier_cut"), (a, "full", None)]


async def test_a_piece_that_continues_a_hushed_one_later_is_dropped():
    """Fails if the chain is forgotten once the hushed piece is reported: the
    brain may still be sending the reply's next piece."""
    async with running() as f:
        a = await f.say("Первая часть.")
        await f.clock.advance(1)                                 # a played in full
        await f.speaking.hush(BRAIN, {"say_id": a})
        b = await f.say("Вторая часть.", continues=a)
        await f.clock.advance(1)
        assert f.statuses() == [(a, "full", None), (b, "dropped", "earlier_cut")]


async def test_hush_utterance_id_stops_no_speech():
    async with running() as f:
        a = await f.say("Первая часть.", in_reply_to="u1")
        await f.clock.advance(0.5)
        await f.speaking.hush(BRAIN, {"utterance_id": "u1"})
        await f.clock.advance(1)
        assert f.statuses() == [(a, "full", None)]


# ---- cut (the wake word, barge-in) ----------------------------------------------

async def test_a_cut_names_its_utterance_and_drops_the_rest_of_the_reply():
    """GA-VOICE-10: fails if a cut piece lacks `cut_by`, or its reply's next
    piece still plays."""
    async with running() as f:
        f.synth.seconds[LONG] = 4
        a = await f.say(LONG)
        b = await f.say("Вторая часть.", continues=a)
        c = await f.say("Другой ответ.")
        await f.clock.advance(3)
        await f.speaking.cut("ep-kitchen", "u-wake")
        assert f.statuses() == [(a, "cut", None), (b, "dropped", "earlier_cut")]
        assert (f.report(a)["cut_by"], f.report(a)["heard_chars"]) == ("u-wake", 30)
        await f.clock.advance(2)
        assert f.report(c)["status"] == "full"


async def test_a_cut_returns_only_once_its_reports_are_in_the_store():
    """The cutting utterance is delivered after the cut piece's report: fails
    if `cut` returns while the store has not taken it."""
    async with running() as f:
        f.synth.seconds[LONG] = 4
        a = await f.say(LONG)
        await f.clock.advance(1)
        f.down = True
        returned = []

        async def cutting():
            await f.speaking.cut("ep-kitchen", "u-wake")
            returned.append(f.clock.t)
        f.speaking._task_group().start_soon(cutting)
        await f.clock.advance(3)
        assert returned == [] and f.reports == []
        f.down = False
        await f.clock.advance(10)
        assert f.statuses() == [(a, "cut", None)] and returned


async def test_a_cut_with_nothing_playing_returns_at_once():
    async with running() as f:
        await f.speaking.cut("ep-kitchen", "u-wake")
        await f.speaking.cut("ep-nowhere", None)
        assert f.reports == []


async def test_a_device_that_does_not_stop_is_cut_off_after_the_stop_wait():
    """Fails if a stuck device holds a cut, and so the cutting utterance,
    past the stop wait."""
    async with running() as f:
        f.synth.seconds[LONG] = 4
        f.players["ep-kitchen"].deaf = True
        a = await f.say(LONG)
        await f.clock.advance(1)
        f.speaking._task_group().start_soon(f.speaking.cut, "ep-kitchen", "u-wake")
        await f.clock.advance(0.5)
        r = f.report(a)
        assert (r["status"], r["ended_at"], r["heard_chars"], r["cut_by"]) == ("cut", at(1001.5), 15, "u-wake")


async def test_a_hush_and_a_cut_together_report_the_piece_once():
    async with running() as f:
        f.synth.seconds[LONG] = 4
        a = await f.say(LONG)
        await f.clock.advance(1)
        async with anyio.create_task_group() as tg:
            tg.start_soon(f.speaking.cut, "ep-kitchen", "u-wake")
            tg.start_soon(f.speaking.hush, BRAIN, {"say_id": a})
            tg.start_soon(f.speaking.hush, BRAIN, {"endpoint": "ep-kitchen"})
        assert f.report(a)["cut_by"] == "u-wake"


async def test_a_stop_before_the_first_sound_is_a_cut_of_nothing_heard():
    """A device told to stop before it made a sound: fails if that is
    reported as a device gone, or logged as a playback."""
    async with running() as f:
        f.players["ep-kitchen"].lead = 1.0
        a = await f.say(LONG)
        await f.clock.advance(0.5)
        await f.speaking.cut("ep-kitchen", "u-wake")
        r = f.report(a)
        assert (r["status"], r["heard_chars"], r["cut_by"]) == ("cut", 0, "u-wake")
        assert f.speaking.play_log.recent() == []


async def test_a_stuck_device_cut_off_before_its_first_sound_is_a_cut_not_a_device_gone():
    async with running() as f:
        f.players["ep-kitchen"].lead = 2.0
        f.players["ep-kitchen"].deaf = True
        a = await f.say(LONG)
        await f.clock.advance(0.5)
        f.speaking._task_group().start_soon(f.speaking.cut, "ep-kitchen", "u-wake")
        await f.clock.advance(0.5)
        r = f.report(a)
        assert (r["status"], r["heard_chars"], r["ended_at"]) == ("cut", 0, at(1001.0))


async def test_a_cut_between_two_pieces_ends_the_reply_being_made():
    """Nothing plays while the reply's next piece is synthesised: fails if a
    wake word then leaves that piece to play (the last piece's chain ends)."""
    async with running() as f:
        a = await f.say("Первая часть.")
        await f.clock.advance(1.0)                          # a ended at 1001
        f.synth.delay = 1.0
        b = await f.say("Вторая часть.", continues=a)
        await f.clock.advance(0.2)
        await f.speaking.cut("ep-kitchen", "u-wake")
        c = await f.say("Третья часть.", continues=b)      # the brain had not heard yet
        d = await f.say("Новый ответ.")
        await f.clock.advance(3)
        assert f.statuses() == [(a, "full", None), (b, "dropped", "earlier_cut"),
                                (c, "dropped", "earlier_cut"), (d, "full", None)]


async def test_a_hush_of_the_endpoint_between_two_pieces_ends_the_reply_being_made():
    """Nothing plays between a reply's pieces: fails if a `hush` of the
    endpoint then leaves the piece that continues the last one to play."""
    async with running() as f:
        a = await f.say("Первая часть.")
        await f.clock.advance(1.5)                          # a played in full
        await f.speaking.hush(BRAIN, {"endpoint": "ep-kitchen"})
        b = await f.say("Вторая часть.", continues=a)      # the brain had not heard yet
        await f.clock.advance(3)
        assert f.statuses() == [(a, "full", None), (b, "dropped", "earlier_cut")]
        assert f.players["ep-kitchen"].played == ["Первая часть."]


@pytest.mark.parametrize("stopping", ["hush", "cut"])
async def test_a_buffered_piece_that_ends_within_the_stop_wait_still_ends_its_reply(stopping):
    """A device that buffered the whole piece plays it out and reports it
    full within the stop wait: fails if the lane then goes on to the piece
    that continues it."""
    async with running() as f:
        f.players["ep-kitchen"].deaf = True
        f.synth.seconds["Первая часть."] = 1.2
        a = await f.say("Первая часть.")
        b = await f.say("Вторая часть.", continues=a)
        await f.clock.advance(1.0)
        stop = (f.speaking.hush(BRAIN, {"say_id": a}) if stopping == "hush"
                else f.speaking.cut("ep-kitchen", "u-wake"))
        async with anyio.create_task_group() as tg:
            tg.start_soon(lambda: stop)
            await f.clock.advance(0.5)
        await f.clock.advance(2)
        assert f.statuses() == [(a, "full", None), (b, "dropped", "earlier_cut")]
        assert f.players["ep-kitchen"].played == ["Первая часть."]


async def test_hush_say_id_of_a_finished_piece_drops_its_queued_continuation():
    """Fails if a hush of a piece already played leaves the rest of its
    reply, queued and being made, to play."""
    async with running() as f:
        a = await f.say("Первая часть.")
        await f.clock.advance(1.0)                          # a played in full
        f.synth.delay = 1.0
        b = await f.say("Вторая часть.", continues=a)      # queued, being made
        c = await f.say("Третья часть.", continues=b)
        await f.clock.advance(0.2)
        await f.speaking.hush(BRAIN, {"say_id": a})
        await f.clock.advance(3)
        assert f.statuses() == [(a, "full", None), (b, "dropped", "earlier_cut"), (c, "dropped", "earlier_cut")]


# ---- chains ---------------------------------------------------------------------

async def test_a_failed_piece_drops_what_continues_it():
    async with running() as f:
        f.synth.failing.add("Первая часть.")
        a = await f.say("Первая часть.")
        b = await f.say("Вторая часть.", continues=a)
        c = await f.say("Третья часть.", continues=b)
        await f.clock.advance(1)
        assert f.statuses() == [(a, "dropped", "synth_failed"), (b, "dropped", "earlier_cut"),
                                (c, "dropped", "earlier_cut")]


async def test_a_piece_that_continues_a_guarded_one_is_dropped():
    async with running() as f:
        a = await f.say("Алиса, включи свет.")
        b = await f.say("И закрой дверь.", continues=a)
        await f.clock.advance(1)
        assert f.statuses() == [(a, "dropped", "wake_word"), (b, "dropped", "earlier_cut")]


async def test_a_fork_plays_both_and_an_unknown_earlier_piece_starts_a_chain():
    """Fails if `continues` naming a piece this front never saw (a restart)
    is dropped, or if two pieces continuing one exclude each other."""
    async with running() as f:
        a = await f.say("Первая часть.")
        b = await f.say("Ветка один.", continues=a)
        c = await f.say("Ветка два.", continues=a)
        d = await f.say("После перезапуска.", continues="s-before-restart")
        await f.clock.advance(4)
        assert f.statuses() == [(a, "full", None), (b, "full", None), (c, "full", None), (d, "full", None)]


async def test_a_chain_is_remembered_for_the_mark_keep_and_no_longer():
    async with running() as f:
        a = await f.say("Алиса, включи свет.")
        await f.clock.advance(61)
        b = await f.say("Продолжение.", continues=a)
        await f.clock.advance(1)
        assert f.report(b)["status"] == "full"


async def test_a_piece_dropped_with_the_one_it_continues_is_never_synthesised():
    """Fails if the lookahead, walking a queue a drop has just changed,
    starts synthesis of a piece already reported dropped."""
    async with running() as f:
        f.synth.seconds["Первая часть."] = 2
        await f.say("Первая часть.")
        await f.say("Другой ответ.")                         # synthesised while the first plays
        b = await f.say("Маруся, включи музыку.")
        c = await f.say("И погромче.", continues=b)
        await f.clock.advance(0.5)
        f.view = replace(f.view, other_wake_words=("Маруся",))
        await f.clock.advance(4)
        assert (f.report(b)["reason"], f.report(c)["reason"]) == ("wake_word", "earlier_cut")
        assert "И погромче." not in f.synth.started


# ---- telling the steward (GA-VOICE-12) ----------------------------------------------

async def test_speaking_is_on_at_the_first_audio_and_off_a_moment_after_the_last():
    """Fails if `on` is sent at the queue rather than the sound, or `off`
    later than the report delay."""
    async with running() as f:
        f.synth.delay = 0.5
        a = await f.say("Первая часть.")
        await f.say("Вторая часть.", continues=a)
        await f.clock.advance(4)
        assert f.ons() == [(1000.5, True), (1003.0, False)]      # audio 1000.5 to 1002.5


async def test_a_reply_whose_next_piece_comes_within_the_grace_does_not_flap():
    async with running() as f:
        await f.say("Первая часть.")
        await f.clock.advance(1.3)                                # ended at 1001, silent since
        await f.say("Вторая часть.")
        await f.clock.advance(3)
        assert f.ons() == [(1000.0, True), (1002.8, False)]


async def test_speaking_stays_on_while_the_next_piece_is_still_being_made():
    async with running() as f:
        await f.say("Первая часть.")
        await f.clock.advance(1.2)
        f.synth.delay = 1.0
        await f.say("Вторая часть.")                     # its audio starts at 1002.2
        await f.clock.advance(3)
        assert f.ons() == [(1000.0, True), (1003.7, False)]


async def test_speaking_goes_off_between_replies_further_apart_than_the_grace():
    async with running() as f:
        await f.say("Первая часть.")
        await f.clock.advance(2)
        await f.say("Вторая часть.")
        await f.clock.advance(2)
        assert f.ons() == [(1000.0, True), (1001.5, False), (1002.0, True), (1003.5, False)]


async def test_speaking_is_said_again_every_heartbeat_while_it_lasts():
    """Fails if a long reply is not re-announced within half the duck limit:
    the steward would un-duck in the middle of it."""
    async with running() as f:
        f.synth.seconds["Очень длинный рассказ."] = 50
        await f.say("Очень длинный рассказ.")
        await f.clock.advance(60)
        assert f.ons() == [(1000.0, True), (1020.0, True), (1040.0, True), (1050.5, False)]


async def test_each_endpoint_is_announced_on_its_own():
    async with running() as f:
        await f.say("Первая часть.")
        await f.say("Дверь закрыта.", endpoint="ep-hall")
        await f.clock.advance(2)
        assert f.ons("ep-hall") == [(1000.0, True), (1001.5, False)]
        assert f.ons("ep-kitchen") == [(1000.0, True), (1001.5, False)]


async def test_a_lost_steward_never_holds_speech_and_is_told_once_it_is_back():
    """Fails if a `speaking` the steward did not take waits for the next
    heartbeat, or holds the speech."""
    async with running() as f:
        f.synth.seconds["Очень длинный рассказ."] = 30
        f.steward_down = True
        a = await f.say("Очень длинный рассказ.")
        await f.clock.advance(1.5)                        # tried at 1000 and 1001
        f.steward_down = False
        await f.clock.advance(35)
        assert f.ons() == [(1003.0, True), (1020.0, True), (1030.5, False)]
        assert f.report(a)["status"] == "full"


async def test_an_off_the_steward_did_not_take_is_sent_again():
    """Fails if a lost `off` is left to the duck limit."""
    async with running() as f:
        await f.say("Первая часть.")
        await f.clock.advance(1.2)
        f.steward_down = True
        await f.clock.advance(0.5)                        # off at 1001.5: not taken
        f.steward_down = False
        await f.clock.advance(5)
        assert f.ons() == [(1000.0, True), (1002.5, False)]


async def test_while_the_steward_is_away_only_the_latest_state_is_sent():
    async with running() as f:
        f.steward_down = True
        await f.say("Первая часть.")
        await f.clock.advance(1.8)                        # on, then off at 1001.5, none taken
        f.steward_down = False
        await f.clock.advance(5)
        assert f.ons() == [(1003.0, False)]


async def test_a_steward_call_that_hangs_holds_no_other_endpoint_and_is_given_up():
    """Fails if one endpoint's `speaking` waits on another's, or a call that
    never returns is never tried again."""
    gate = anyio.Event()
    async with running() as f:
        calls = []
        answer = f.speaking._speaking

        async def hanging_once(endpoint, on):
            calls.append((f.clock.t, endpoint, on))
            if len(calls) == 1:
                await gate.wait()                         # a steward that does not answer
            await answer(endpoint, on)
        f.speaking._speaking = hanging_once
        await f.say("Первая часть.")
        await f.say("Дверь закрыта.", endpoint="ep-hall")
        await f.clock.advance(0.5)
        assert f.ons("ep-hall") == [(1000.0, True)]
        await f.clock.advance(3)
        assert f.ons("ep-kitchen") == [(1003.0, False)]   # `on` given up at 1002; the retry sends the latest
        gate.set()


async def test_closing_says_off_and_files_what_the_store_had_not_taken():
    """Fails if a front that stops leaves the home ducked until the duck
    limit, drops the reports still waiting on the store, or leaves the piece
    it stopped in the middle of unreported."""
    front = None
    async with running() as f:
        front = f
        f.synth.seconds[LONG] = 4
        a = await f.say("Первая часть.")
        f.down = True
        await f.clock.advance(1.2)                                # a ended; its report waits
        b = await f.say(LONG)
        await f.clock.advance(1)
        f.down = False
    assert front.ons() == [(1000.0, True), (1002.2, False)]
    assert front.statuses() == [(a, "full", None), (b, "cut", None)]
    assert front.report(b)["heard_chars"] == 10


async def test_closing_says_off_before_it_files_the_last_reports():
    """The home un-ducks first: fails if a slow store holds the `off`."""
    front = None
    async with running() as f:
        front = f
        answer = f.speaking._speaking

        async def noting(endpoint, on):
            f.filed_before_off = len(f.reports)
            await answer(endpoint, on)
        f.speaking._speaking = noting
        f.down = True
        await f.say(LONG)
        f.synth.seconds[LONG] = 4
        await f.clock.advance(1)
        f.down = False
    assert front.ons()[-1][1] is False and front.filed_before_off == 0
    assert len(front.reports) == 1


async def test_a_report_the_store_was_taking_when_the_front_stopped_is_filed_at_close():
    """Fails if a report in flight at close is lost: filing it twice is
    harmless, losing it is not."""
    hang = anyio.Event()
    front = None
    async with running() as f:
        front = f
        answer = f.speaking._report
        calls = []

        async def slow(played):
            calls.append(played)
            if len(calls) == 1:
                await hang.wait()                         # in flight when the front stops
            return await answer(played)
        f.speaking._report = slow
        a = await f.say("Первая часть.")
        await f.clock.advance(1.2)
    assert front.statuses() == [(a, "full", None)]


async def test_closing_is_bounded_whatever_the_steward_and_store_do():
    stuck = anyio.Event()

    async def never(*args):
        await stuck.wait()
    started = anyio.current_time()
    async with running(close_s=0.2) as f:
        f.speaking._speaking = never
        f.speaking._report = never
        await f.say("Первая часть.")
        await f.clock.advance(1.2)
    assert anyio.current_time() - started < 1


async def test_a_cut_after_speaking_stopped_returns():
    """Fails if a cut waits for a reporter that has gone."""
    f = Front()
    async with anyio.create_task_group() as tg:
        await tg.start(f.speaking.run)
        f.synth.seconds[LONG] = 4
        await f.say(LONG)
        await f.clock.advance(0.5)
        f.down = True
        tg.cancel_scope.cancel()
    with anyio.fail_after(1):
        await f.speaking.cut("ep-kitchen", "u-wake")
    with pytest.raises(RuntimeError, match="not running"):
        await f.say("Вторая часть.")


# ---- the fixed clips ---------------------------------------------------------------

def clips(**more):
    from speaking_doubles import audio_of
    from voice_front.clips import Clip
    texts = {"cannot_answer": "Не могу ответить", **more}
    return {n: Clip(n, t, audio_of(t or "earcon", 0.5)) for n, t in texts.items()}


def addressed(f, utterance_id="u1", *, start=998.0, end=999.0, endpoint="ep-kitchen", by="wake",
              transcript="включи свет"):
    f.delivered(utterance_id, Interval(start, end), endpoint=endpoint, addressed_by=by, transcript=transcript)


async def test_a_silent_brain_gets_cannot_answer_once_after_the_bound_and_slack():
    """GA-VOICE-11: fails if the clip plays early, twice, or not at all."""
    async with running(clips=clips()) as f:
        addressed(f)
        await f.clock.advance(11.9)
        assert f.players["ep-kitchen"].played == []
        await f.clock.advance(0.2)
        assert f.players["ep-kitchen"].played == ["Не могу ответить"]
        await f.clock.advance(30)
        assert f.players["ep-kitchen"].played == ["Не могу ответить"]
        assert f.reports == []                                    # a clip has no say_id
        assert [s.text for s in f.speaking.play_log.recent()] == ["Не могу ответить"]
        assert f.ons() == [(1012.0, True), (1013.0, False)]        # a clip is speaking too


@pytest.mark.parametrize("by", ["tap", "typed"])
async def test_a_tap_or_typed_utterance_is_answered_too(by):
    async with running(clips=clips()) as f:
        addressed(f, by=by)
        await f.clock.advance(13)
        assert f.players["ep-kitchen"].played == ["Не могу ответить"]


async def test_a_follow_up_or_an_endpoint_that_does_not_speak_gets_no_clip():
    async with running(clips=clips()) as f:
        addressed(f, "u1", by="follow_up")
        f.change("ep-hall", output=None)
        addressed(f, "u2", endpoint="ep-hall")
        await f.clock.advance(13)
        assert f.players["ep-kitchen"].played == [] and f.players["ep-hall"].played == []


async def test_a_reply_that_failed_to_synthesise_leaves_the_clip_to_play():
    """The spec's error table: the piece is dropped, "the silent-brain clip
    still applies" (the maintainer, 2026-09-30). Fails if a reply whose every piece was
    dropped `synth_failed`, the later ones with it, silences the clip."""
    async with running(clips=clips()) as f:
        addressed(f)
        f.synth.failing.add("Сейчас включу.")
        a = await f.say("Сейчас включу.", in_reply_to="u1")
        b = await f.say("Ещё немного.", in_reply_to="u1", continues=a)
        await f.clock.advance(13)
        assert f.statuses() == [(a, "dropped", "synth_failed"), (b, "dropped", "earlier_cut")]
        assert f.players["ep-kitchen"].played == ["Не могу ответить"]


async def test_a_reply_that_played_answers_even_when_cut_after():
    """Fails if a reply that was heard, then cut, leaves the clip to play as
    well: only a reply nobody heard because of the synthesiser is no answer."""
    async with running(clips=clips()) as f:
        addressed(f)
        f.synth.seconds[LONG] = 8
        await f.say(LONG, in_reply_to="u1")
        await f.clock.advance(1)
        await f.speaking.cut("ep-kitchen", "u-wake")
        await f.clock.advance(13)
        assert f.players["ep-kitchen"].played == [LONG]


async def test_a_reply_that_arrives_before_the_front_notes_the_delivery_still_counts():
    """A fast brain may reply before `delivered` is called: fails if that
    reply is forgotten and the clip plays over it."""
    async with running(clips=clips()) as f:
        await f.say("Сейчас включу.", in_reply_to="u1")
        addressed(f)
        await f.clock.advance(13)
        assert f.players["ep-kitchen"].played == ["Сейчас включу."]


async def test_an_utterance_noted_twice_gets_one_clip():
    """2d may call `delivered` again after a store retry: fails if each call
    starts a timer."""
    async with running(clips=clips()) as f:
        addressed(f)
        await f.clock.advance(1)
        addressed(f)
        await f.clock.advance(14)
        assert f.players["ep-kitchen"].played == ["Не могу ответить"]


async def test_a_reply_dropped_for_a_wake_word_does_not_count():
    async with running(clips=clips()) as f:
        addressed(f)
        await f.say("Алиса, включи свет.", in_reply_to="u1")
        await f.clock.advance(13)
        assert f.players["ep-kitchen"].played == ["Не могу ответить"]


async def test_a_reply_dropped_for_a_wake_word_before_synthesis_does_not_count_either():
    async with running(clips=clips()) as f:
        f.synth.seconds["Первая часть."] = 3
        addressed(f)
        await f.say("Первая часть.")
        await f.say("Другой ответ.")
        await f.say("Маруся, включи музыку.", in_reply_to="u1")
        await f.clock.advance(0.5)
        f.view = replace(f.view, other_wake_words=("Маруся",))
        await f.clock.advance(15)
        assert f.players["ep-kitchen"].played[-1] == "Не могу ответить"


async def test_a_hush_naming_the_utterance_means_no_clip():
    async with running(clips=clips()) as f:
        addressed(f)
        await f.speaking.hush("brain-local", {"utterance_id": "u1"})
        await f.clock.advance(13)
        assert f.players["ep-kitchen"].played == []


@pytest.mark.parametrize("other,answered", [
    (dict(start=998.5, end=999.5, endpoint="ep-kitchen-2"), True),                         # overlaps
    (dict(start=999.5, end=1000.5, endpoint="ep-kitchen-2"), True),                        # same words within 2 s
    (dict(start=1001.5, end=1002.5, endpoint="ep-kitchen-2"), False),                      # same words, 3.5 s later
    (dict(start=999.5, end=1000.5, endpoint="ep-kitchen-2", transcript="выключи свет"), False),
    (dict(start=998.5, end=999.5, endpoint="ep-hall"), False),                             # another zone
    (dict(start=999.5, end=1000.5, endpoint="ep-kitchen-2", transcript="...", same=""), False),  # no words
])
async def test_a_reply_to_a_duplicate_in_the_zone_answers_it(other, answered):
    """GA-VOICE-11: fails if a zone neighbour's reply leaves the clip to play
    over it, or if an unrelated reply silences it."""
    async with running(clips=clips()) as f:
        f.view = replace(f.view, endpoints={**f.view.endpoints,
                                            "ep-kitchen-2": replace(f.view.endpoints["ep-kitchen"], id="ep-kitchen-2")})
        other = dict(other)
        addressed(f, "u1", transcript=other.pop("same", "Включи свет!"))
        addressed(f, "u2", **{"transcript": "включи свет", **other})
        await f.say("Сейчас включу.", endpoint="ep-hall", in_reply_to="u2")      # where it plays is no matter
        await f.clock.advance(13)
        assert ("Не могу ответить" in f.players["ep-kitchen"].played) is not answered


async def test_a_reply_that_comes_after_the_clip_still_plays():
    async with running(clips=clips()) as f:
        addressed(f)
        await f.clock.advance(13)
        a = await f.say("Простите, отвечаю поздно.", in_reply_to="u1")
        await f.clock.advance(2)
        assert f.players["ep-kitchen"].played == ["Не могу ответить", "Простите, отвечаю поздно."]
        assert f.report(a)["status"] == "full"


async def test_a_clip_naming_a_wake_word_is_never_played_until_the_words_change():
    """GA-VOICE-20 for clips: fails if a clip is checked only at start."""
    async with running(clips=clips()) as f:
        f.view = replace(f.view, other_wake_words=("Могу",))
        addressed(f, "u1")
        await f.clock.advance(13)
        assert f.players["ep-kitchen"].played == []
        f.view = replace(f.view, other_wake_words=())
        addressed(f, "u2")
        await f.clock.advance(13)
        assert f.players["ep-kitchen"].played == ["Не могу ответить"]


async def test_with_no_clips_a_silent_brain_plays_nothing():
    async with running() as f:
        addressed(f)
        await f.clock.advance(13)
        assert f.players["ep-kitchen"].played == []


async def test_play_clip_queues_behind_speech_and_a_missing_one_plays_nothing():
    async with running(clips=clips(earcon="")) as f:
        await f.say("Первая часть.")
        f.speaking.play_clip("ep-kitchen", "earcon")
        f.speaking.play_clip("ep-kitchen", "not_recognised")
        await f.clock.advance(2)
        assert f.players["ep-kitchen"].played == ["Первая часть.", "earcon"]


async def test_a_queued_clip_is_checked_again_when_its_turn_comes():
    async with running(clips=clips()) as f:
        await f.say("Первая часть.")
        f.speaking.play_clip("ep-kitchen", "cannot_answer")
        await f.clock.advance(0.5)
        f.view = replace(f.view, other_wake_words=("Могу",))
        await f.clock.advance(2)
        assert f.players["ep-kitchen"].played == ["Первая часть."]


async def test_a_clip_for_an_endpoint_that_does_not_speak_is_not_played():
    async with running(clips=clips()) as f:
        f.change("ep-kitchen", output=None)
        f.speaking.play_clip("ep-kitchen", "cannot_answer")
        await f.clock.advance(1)
        assert f.players["ep-kitchen"].played == []


async def test_a_cut_during_a_clip_ends_only_the_last_reply():
    """A clip has no say_id: fails if a cut while one plays drops every
    reply that continues nothing, or leaves the last reply's next piece."""
    async with running(clips=clips(earcon="")) as f:
        a = await f.say("Первая часть.")
        await f.clock.advance(1)
        f.speaking.play_clip("ep-kitchen", "earcon")
        b = await f.say("Вторая часть.", continues=a)
        c = await f.say("Другой ответ.")
        await f.clock.advance(0.2)
        await f.speaking.cut("ep-kitchen", "u-wake")
        await f.clock.advance(2)
        assert f.statuses() == [(a, "full", None), (b, "dropped", "earlier_cut"), (c, "full", None)]


async def test_hush_endpoint_drops_a_queued_clip_too():
    async with running(clips=clips(earcon="")) as f:
        await f.say("Первая часть.")
        f.speaking.play_clip("ep-kitchen", "earcon")
        await f.clock.advance(0.5)
        await f.speaking.hush("brain-local", {"endpoint": "ep-kitchen"})
        await f.clock.advance(2)
        assert f.players["ep-kitchen"].played == ["Первая часть."]


# ---- what the task reviews found ------------------------------------------------------

async def test_a_stamp_that_fails_loses_that_report_not_speaking():
    """Fails if a failure while building a report escapes the handler that
    settles a piece, and stops the lane and all of speaking with it."""
    async with running() as f:
        real, calls = f.speaking._stamp, []

        def flaky(mono):
            calls.append(mono)
            if len(calls) == 1:
                raise ValueError("the clock is not checked")
            return real(mono)
        f.speaking._stamp = flaky
        f.synth.failing.add("Первая часть.")
        await f.say("Первая часть.")            # dropped as `synth_failed`; its report cannot be built
        await f.clock.advance(0)
        b = await f.say("Вторая часть.")
        await f.clock.advance(1)
        assert f.statuses() == [(b, "full", None)]
        assert f.players["ep-kitchen"].played == ["Вторая часть."]


async def test_a_player_that_starts_and_then_answers_nonsense_leaves_the_play_log_closed():
    """Fails if a playback whose report cannot be read stays open in the play
    log: its text would be `playing` for good, and echo matching suppressed."""
    class StartsThenNonsense:
        async def play(self, audio, stop, on_start):
            on_start(f.clock.now())
            return "done"
    async with running() as f:
        f.players["ep-kitchen"] = StartsThenNonsense()
        a = await f.say("Первая часть.")
        await f.clock.advance(0)
        assert [s for s in f.speaking.play_log.recent() if math.isinf(s.interval.end)] == []
        assert len(f.speaking.play_log.recent()) == 1
        assert [r["say_id"] for r in f.reports] == [a]
        assert f.report(a)["status"] == "cut"           # it began and did not say it ended: heard, not full


async def test_say_and_delivered_change_nothing_when_speaking_is_not_running():
    """Fails if `say`, `delivered` or `play_clip` records the piece, the
    utterance or the clip before it finds out that nobody will read it: a
    retried `delivered` would be taken as a duplicate and start no timer."""
    stopped = Front(clips=clips())
    async with anyio.create_task_group() as tg:
        await tg.start(stopped.speaking.run)
        tg.cancel_scope.cancel()
    for f in (stopped, Front(clips=clips())):           # after it stopped; before it started
        with pytest.raises(RuntimeError, match="not running"):
            await f.say("Первая часть.")
        assert all(not lane.queue for lane in f.speaking._lanes.values())
        with pytest.raises(RuntimeError, match="not running"):
            f.delivered("u1", Interval(998.0, 999.0), addressed_by="wake")
        assert f.speaking._delivered == {}
        with pytest.raises(RuntimeError, match="not running"):
            f.speaking.play_clip("ep-kitchen", "cannot_answer")
        assert all(not lane.queue and not lane.running for lane in f.speaking._lanes.values())


async def test_a_clip_refused_before_run_does_not_lock_the_lane():
    """Fails if `play_clip` marks the lane running before its task starts: a
    later piece at that endpoint would queue behind a task that never was, and
    never be played or reported."""
    f = Front(clips=clips())
    with pytest.raises(RuntimeError, match="not running"):
        f.speaking.play_clip("ep-kitchen", "cannot_answer")
    with anyio.fail_after(5):
        async with anyio.create_task_group() as tg:
            await tg.start(f.speaking.run)
            a = await f.say("Первая часть.")
            await f.clock.advance(2)
            assert f.statuses() == [(a, "full", None)]
            assert f.players["ep-kitchen"].played == ["Первая часть."]
            tg.cancel_scope.cancel()


async def test_a_cut_keeps_its_utterance_when_a_hush_is_already_stopping_the_piece():
    """Fails if `cut_by` is taken only from the call that first sets `stop`."""
    async with running() as f:
        f.players["ep-kitchen"].deaf = True             # stopping takes the whole stop wait
        f.synth.seconds[LONG] = 4
        a = await f.say(LONG)
        await f.clock.advance(1)
        async with anyio.create_task_group() as tg:
            tg.start_soon(f.speaking.hush, BRAIN, {"endpoint": "ep-kitchen"})
            await f.clock.advance(0.1)
            tg.start_soon(f.speaking.cut, "ep-kitchen", "u-wake")
            await f.clock.advance(1)
        assert f.report(a)["status"] == "cut"
        assert f.report(a)["cut_by"] == "u-wake"


async def test_closing_says_off_when_an_on_is_still_out_after_the_grace():
    """Fails if closing sends `off` only where `on` or an acknowledged `on`
    stands: the steward may apply the late `on` and stay ducked until the duck
    limit."""
    gate = anyio.Event()
    async with running() as f:
        calls = []
        answer = f.speaking._speaking

        async def hanging_once(endpoint, on):
            calls.append((endpoint, on))
            if len(calls) == 1:
                await gate.wait()                       # an `on` the steward does not answer
            await answer(endpoint, on)
        f.speaking._speaking = hanging_once
        await f.say("Первая часть.")
        await f.clock.advance(1.6)                      # played; the grace has cleared `on`
        assert calls == [("ep-kitchen", True)]
    assert calls == [("ep-kitchen", True), ("ep-kitchen", False)]
    gate.set()
