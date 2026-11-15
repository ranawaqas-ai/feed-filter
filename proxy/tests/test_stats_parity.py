"""Pins Store.stats to a committed scenario that the extension's IndexedDB log also replays
(extension/test/localstore.test.mjs), so the dashboard reads the same shape in both modes.
Synthetic videos only. Runs in UTC so local days are fixed."""

import json
import time
from datetime import date
from pathlib import Path

from proxy.store import Store, goal_hash

FIXTURE = Path(__file__).resolve().parents[2] / "extension" / "test" / "stats_fixture.json"
NOON = 1794657600  # 2026-11-14 12:00 UTC


def scenario() -> dict:
    v = lambda i, short=False: {"videoId": f"vid{i}", "title": f"Synthetic title {i}", "channel": f"Channel {i % 3}",
                                "durationSeconds": 300 + i, "viewCount": 1000 * i, "isShort": short, "description": ""}
    day = 86400
    events = [
        {"ts": NOON - 3 * day, "video": v(1), "perGoal": [["Goal A", 0.2], ["Goal B", 0.7]]},
        {"ts": NOON - 3 * day + 60, "video": v(1), "perGoal": [["Goal A", 0.4], ["Goal B", None]]},
        {"ts": NOON - day, "video": v(2, True), "perGoal": [["Goal A", 0.05]]},
        {"ts": NOON, "video": v(3), "perGoal": [["Goal A", 0.9], ["Goal B", 0.1]]},
        {"ts": NOON - 30, "video": v(4), "perGoal": [["Goal A", None], ["Goal B", None]]},
        {"ts": NOON - 20 * day, "video": v(5), "perGoal": [["Goal A", 0.5]]},
    ]
    feedback = [
        {"ts": NOON - day + 5, "video": v(2, True), "goal": "Goal A", "action": "keep", "p": 0.05,
         "previousVerdict": "hide", "reason": "hide p=0.05 g1"},
        {"ts": NOON - 20 * day, "video": v(5), "goal": "Goal A", "action": "hide", "p": None,
         "previousVerdict": None, "reason": None},
    ]
    return {"events": events, "feedback": feedback, "days": 7, "today": "2026-11-14"}


def proxy_stats(tmp_path: Path, sc: dict) -> dict:
    time.tzset()  # TZ is UTC here: set by the test, or by the caller regenerating the fixture
    store = Store(tmp_path / "s.sqlite3")
    db = store._db
    for e in sc["events"]:
        for goal, p in e["perGoal"]:
            db.execute("INSERT INTO verdicts (ts, video_id, goal_hash, goal_text, model, wording, p, verdict, source,"
                       " error, latency_ms, video_json, state_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                       (e["ts"], e["video"]["videoId"], goal_hash(goal), goal, "jev-1.14.0", "N1", p, None,
                        "jev" if p is not None else "none", None if p is not None else "timeout", None,
                        json.dumps(e["video"]), None))
    for f in sc["feedback"]:
        db.execute("INSERT INTO feedback (ts, video_id, goal_hash, goal_text, action, p, previous_verdict, reason,"
                   " video_json) VALUES (?,?,?,?,?,?,?,?,?)",
                   (f["ts"], f["video"]["videoId"], goal_hash(f["goal"]), f["goal"], f["action"], f["p"],
                    f["previousVerdict"], f["reason"], json.dumps(f["video"])))
    db.commit()
    return store.stats(sc["days"], today=date.fromisoformat(sc["today"]))


def test_stats_fixture_is_current(tmp_path, monkeypatch):
    monkeypatch.setenv("TZ", "UTC")  # restored after the test, so other tests keep the real zone
    sc = scenario()
    try:
        expected = {"scenario": sc, "expected": proxy_stats(tmp_path, sc)}
    finally:
        monkeypatch.undo()
        time.tzset()
    assert json.loads(FIXTURE.read_text(encoding="utf-8")) == expected, "regenerate the fixture"
    print(f"PASS proxy.store.Store.stats: matches the {len(sc['events'])}-event scenario the extension replays")
