import json
from datetime import date, datetime

from .conftest import video
from .test_app import SECRET, make_client

TODAY = date(2026, 11, 15)


def at(day: date, hour: int) -> float:
    return datetime(day.year, day.month, day.day, hour).timestamp()


def put(store, ts, vid_n, goal, p, source="jev", title=None):
    v = video(vid_n, title)
    store._db.execute(
        "INSERT INTO verdicts (ts, video_id, goal_hash, goal_text, model, wording, p, verdict, source, error,"
        " latency_ms, video_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (ts, v["videoId"], "h", goal, "m", "w", p, "hide", source, None if p is not None else "daily_cap", 1.0,
         json.dumps(v)))
    store._db.commit()


def test_stats_dedupes_per_day_and_keeps_max_p_per_goal(store):
    d = TODAY
    for hour in (9, 10, 11):  # three requests for the same video, two goals each
        put(store, at(d, hour), 1, "goal A", 0.1 * hour / 10)
        put(store, at(d, hour), 1, "goal B", 0.5)
    put(store, at(d, 12), 1, "goal A", 0.9, source="cache")
    out = store.stats(1, today=d)
    assert len(out["rows"]) == 1
    r = out["rows"][0]
    assert r["pByGoalText"] == {"goal A": 0.9, "goal B": 0.5}
    assert r["sightings"] == 4 and r["errors"] == 0 and r["firstSeen"] == at(d, 9)
    print("PASS proxy.store.Store.stats: one row per (day, video), max p per goal text, sightings counted")


def test_stats_separates_days_and_respects_range(store):
    put(store, at(date(2026, 11, 13), 10), 1, "goal A", 0.2)
    put(store, at(date(2026, 11, 14), 10), 1, "goal A", 0.3)
    put(store, at(TODAY, 10), 1, "goal A", 0.4)
    assert [r["day"] for r in store.stats(2, today=TODAY)["rows"]] == ["2026-11-14", "2026-11-15"]
    out = store.stats(3, today=TODAY)
    assert [r["pByGoalText"]["goal A"] for r in out["rows"]] == [0.2, 0.3, 0.4]
    assert out["firstVerdictDay"] == "2026-11-13" and out["since"] == "2026-11-13"
    print("PASS proxy.store.Store.stats: rows split by local day and limited to the requested range")


def test_stats_error_rows_are_not_scores(store):
    put(store, at(TODAY, 10), 2, "goal A", None, source="none")
    put(store, at(TODAY, 10), 2, "goal B", None, source="none")
    r = store.stats(1, today=TODAY)["rows"][0]
    assert r["pByGoalText"] == {} and r["errors"] == 2 and sorted(r["goalTexts"]) == ["goal A", "goal B"]
    print("PASS proxy.store.Store.stats: failed rows give no p (not judged), never a hide")


def test_stats_endpoint_requires_secret_and_returns_feedback(store):
    c = make_client(store)
    assert c.post("/stats", json={"days": 1}).status_code == 401
    h = {"X-Filter-Secret": SECRET}
    assert c.post("/stats", json={"days": 0}, headers=h).status_code == 422
    assert c.post("/stats", json={"days": 91}, headers=h).status_code == 422
    c.post("/feedback", json={"goal": "goal A", "video": video(3, "kept one"), "action": "keep", "p": 0.4}, headers=h)
    data = c.post("/stats", json={"days": 1}, headers=h).json()
    assert data["feedback"][0]["action"] == "keep" and data["feedback"][0]["title"] == "kept one"
    print("PASS proxy.app.stats_endpoint: needs X-Filter-Secret, validates days, includes feedback rows")
