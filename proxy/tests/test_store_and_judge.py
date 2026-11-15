import asyncio

from typesafe_sdk import TypeSafeRateLimitError

from proxy.judge import Judge, band
from proxy.prompt import JEV_MODEL, WORDING_ID
from proxy.store import Store, goal_hash

from .conftest import FakeJev, video


def run(coro):
    return asyncio.run(coro)


def test_goal_hash_is_exact_text_and_stable():
    assert goal_hash("Learn cooking") == goal_hash("Learn cooking")
    assert goal_hash("Learn cooking") != goal_hash("Learn cooking ")
    assert len(goal_hash("x")) == 32
    print("PASS proxy.store.goal_hash: stable, sensitive to any edit, 32 hex chars")


def test_cache_key_includes_video_goal_model_and_wording(store):
    g = goal_hash("goal A")
    store.put_cache("abcdefghijk", g, JEV_MODEL, WORDING_ID, 0.9)
    assert store.cached_p("abcdefghijk", g, JEV_MODEL, WORDING_ID) == 0.9
    assert store.cached_p("abcdefghijk", goal_hash("goal B"), JEV_MODEL, WORDING_ID) is None
    assert store.cached_p("abcdefghijk", g, "jev-other", WORDING_ID) is None
    assert store.cached_p("abcdefghijk", g, JEV_MODEL, "N2") is None
    print("PASS proxy.store.Store.cached_p: keyed by (videoId, goal hash, model, wording)")


def test_daily_cap_counts_persist_across_restart(tmp_path):
    path = tmp_path / "cap.sqlite3"
    s = Store(path)
    assert s.reserve_calls(7, cap=10, day="2026-11-14") == 7
    s.close()
    s = Store(path)  # a restart must not reset the count
    assert s.reserve_calls(7, cap=10, day="2026-11-14") == 3
    assert s.reserve_calls(1, cap=10, day="2026-11-14") == 0
    assert s.reserve_calls(5, cap=10, day="2026-11-15") == 5
    s.close()
    print("PASS proxy.store.Store.reserve_calls: cap enforced per day and persisted across restarts")


def test_band_edges():
    assert band(0.81, 0.8, 0.2) == "show" and band(0.8, 0.8, 0.2) == "uncertain"
    assert band(0.19, 0.8, 0.2) == "hide" and band(0.2, 0.8, 0.2) == "uncertain"
    assert band(0.5, 0.8, 0.2) == "uncertain"
    print("PASS proxy.judge.band: show above 0.8, hide below 0.2, edges uncertain")


def test_fan_out_is_concurrent_one_call_per_video(store):
    jev = FakeJev(delay=0.05)
    judge = Judge(jev, store, daily_call_cap=1000, max_concurrency=30)
    vids = [video(i) for i in range(30)]
    results = run(judge.judge("goal", vids))
    assert len(jev.calls) == 30 and jev.max_in_flight == 30
    assert all(len(q) == 1 for _, q in jev.calls)
    assert [r.videoId for r in results] == [v["videoId"] for v in vids]
    print("PASS proxy.judge.Judge.judge: 30 videos -> 30 single-video Jev calls, all 30 in flight at once")


def test_concurrency_limit_respected(store):
    jev = FakeJev(delay=0.02)
    run(Judge(jev, store, daily_call_cap=1000, max_concurrency=5).judge("goal", [video(i) for i in range(20)]))
    assert jev.max_in_flight == 5
    print("PASS proxy.judge.Judge.judge: semaphore caps in-flight Jev calls")


def test_cache_hits_skip_jev_and_duplicates_collapse(store):
    jev = FakeJev(p_by_title={"title 1": 0.95, "title 2": 0.05})
    judge = Judge(jev, store, daily_call_cap=1000, max_concurrency=30)
    first = run(judge.judge("goal", [video(1), video(2), video(1)]))
    assert len(jev.calls) == 2 and len(first) == 2
    second = run(judge.judge("goal", [video(1), video(2), video(3)]))
    assert len(jev.calls) == 3
    by_id = {r.videoId: r for r in second}
    assert by_id[video(1)["videoId"]].source == "cache" and by_id[video(1)["videoId"]].verdict == "show"
    assert by_id[video(2)["videoId"]].verdict == "hide" and by_id[video(3)["videoId"]].source == "jev"
    run(judge.judge("another goal", [video(1)]))
    assert len(jev.calls) == 4  # a different goal is a cache miss
    print("PASS proxy.judge.Judge.judge: cached items skip Jev; duplicates in one request make one call")


def test_cached_p_rebands_with_new_thresholds(store):
    jev = FakeJev(p_by_title={"title 1": 0.7})
    judge = Judge(jev, store, daily_call_cap=1000, max_concurrency=30)
    assert run(judge.judge("goal", [video(1)]))[0].verdict == "uncertain"
    assert run(judge.judge("goal", [video(1)], show=0.6, hide=0.2))[0].verdict == "show"
    assert len(jev.calls) == 1
    print("PASS proxy.judge.Judge.judge: cache stores p, so changed thresholds need no new call")


def test_daily_cap_returns_errors_not_verdicts(store):
    jev = FakeJev()
    judge = Judge(jev, store, daily_call_cap=3, max_concurrency=30)
    results = run(judge.judge("goal", [video(i) for i in range(5)]))
    assert len(jev.calls) == 3
    capped = [r for r in results if r.error == "daily_cap"]
    assert len(capped) == 2 and all(r.p is None and r.verdict is None for r in capped)
    print("PASS proxy.judge.Judge.judge: over the daily cap items get error=daily_cap and no verdict")


def test_failures_never_become_verdicts(store):
    err = TypeSafeRateLimitError.__new__(TypeSafeRateLimitError)
    jev = FakeJev(fail_titles={"title 1": err, "title 2": RuntimeError("boom")}, delay=0.01)
    judge = Judge(jev, store, daily_call_cap=100, max_concurrency=30)
    results = {r.videoId: r for r in run(judge.judge("goal", [video(1), video(2), video(3)]))}
    r1, r2, r3 = (results[video(i)["videoId"]] for i in (1, 2, 3))
    assert r1.error == "rate_limited" and r1.verdict is None and r1.p is None
    assert r2.error == "internal:RuntimeError" and r2.verdict is None
    assert r3.error is None and r3.verdict == "uncertain"
    assert store.cached_p(video(1)["videoId"], goal_hash("goal"), JEV_MODEL, WORDING_ID) is None
    print("PASS proxy.judge.Judge._call: rate limits and unexpected errors stay per-item errors, nothing cached")


def test_timeout_becomes_error(store):
    jev = FakeJev(delay=0.5)
    judge = Judge(jev, store, daily_call_cap=100, max_concurrency=30, timeout_s=0.05)
    r = run(judge.judge("goal", [video(1)]))[0]
    assert r.error == "timeout" and r.verdict is None
    print("PASS proxy.judge.Judge._call: a slow Jev call becomes error=timeout, not a verdict")


def test_every_verdict_logged_with_full_input(store):
    import json
    jev = FakeJev(p_by_title={"title 1": 0.9})
    judge = Judge(jev, store, daily_call_cap=100, max_concurrency=30)
    run(judge.judge("goal text", [video(1)]))
    run(judge.judge("goal text", [video(1)]))
    assert store.count("verdicts") == 2
    row = store._db.execute("SELECT goal_text, source, video_json, state_json FROM verdicts ORDER BY id").fetchall()
    assert [r[1] for r in row] == ["jev", "cache"]
    assert json.loads(row[0][2])["title"] == "title 1" and json.loads(row[0][3])["goal"] == "goal text"
    print("PASS proxy.store.Store.log_verdict: every verdict, cached or fresh, logged with full input")


GOALS = [{"id": "G1", "text": "goal one"}, {"id": "G2", "text": "goal two"}]


def test_judge_goals_keeps_highest_p_and_its_goal(store):
    jev = FakeJev(p_by_goal_title={("goal one", "title 1"): 0.3, ("goal two", "title 1"): 0.9,
                                   ("goal one", "title 2"): 0.6, ("goal two", "title 2"): 0.1})
    judge = Judge(jev, store, daily_call_cap=1000, max_concurrency=30)
    r = {x.videoId: x for x in run(judge.judge_goals(GOALS, [video(1), video(2)]))}
    one, two = r[video(1)["videoId"]], r[video(2)["videoId"]]
    assert (one.p, one.goalId, one.verdict) == (0.9, "G2", "show") and one.perGoal == {"G1": 0.3, "G2": 0.9}
    assert (two.p, two.goalId, two.verdict) == (0.6, "G1", "uncertain")
    assert len(jev.calls) == 4, "one call per (video, goal)"
    again = run(judge.judge_goals(GOALS, [video(1)]))[0]
    assert again.source == "cache" and len(jev.calls) == 4
    print("PASS proxy.judge.Judge.judge_goals: best p across goals, its goal id, per-goal p, cached per goal")


def test_judge_goals_any_failed_goal_is_an_error(store):
    from proxy.judge import Result, best_of
    ok, bad = Result("v", 0.95, "show", "jev"), Result("v", None, None, "none", "timeout")
    r = best_of("v", [("G1", ok), ("G2", bad)], 0.8, 0.2)
    assert r.p is None and r.verdict is None and r.error == "timeout" and r.perGoal == {"G1": 0.95, "G2": None}
    print("PASS proxy.judge.best_of: a failed goal never yields a verdict, even when another goal scored high")
