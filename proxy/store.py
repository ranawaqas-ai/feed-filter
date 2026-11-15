"""SQLite storage: verdict cache, verdict log, feedback log and the daily call counter.

The cache stores p (not the verdict) so threshold changes apply without new calls.
Logs keep the full input fields and the exact state sent, as future training data.
"""

import hashlib
import json
import sqlite3
import threading
import time
from datetime import date, datetime, timedelta
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS cache (
    video_id TEXT NOT NULL, goal_hash TEXT NOT NULL, model TEXT NOT NULL, wording TEXT NOT NULL,
    p REAL NOT NULL, created_at REAL NOT NULL,
    PRIMARY KEY (video_id, goal_hash, model, wording));
CREATE TABLE IF NOT EXISTS verdicts (
    id INTEGER PRIMARY KEY, ts REAL NOT NULL, video_id TEXT NOT NULL, goal_hash TEXT NOT NULL,
    goal_text TEXT NOT NULL, model TEXT NOT NULL, wording TEXT NOT NULL, p REAL, verdict TEXT,
    source TEXT NOT NULL, error TEXT, latency_ms REAL, video_json TEXT NOT NULL, state_json TEXT);
CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY, ts REAL NOT NULL, video_id TEXT NOT NULL, goal_hash TEXT NOT NULL,
    goal_text TEXT NOT NULL, action TEXT NOT NULL, p REAL, previous_verdict TEXT, reason TEXT,
    video_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS daily_usage (day TEXT PRIMARY KEY, calls INTEGER NOT NULL);
"""


def goal_hash(goal: str) -> str:
    """Cache key part for a goal: sha256 of the exact goal text, so any edit is a new goal."""
    return hashlib.sha256(goal.encode("utf-8")).hexdigest()[:32]


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(str(path), check_same_thread=False)
        self._db.executescript(SCHEMA)
        self._lock = threading.Lock()

    def close(self) -> None:
        self._db.close()

    def cached_p(self, video_id: str, ghash: str, model: str, wording: str) -> float | None:
        with self._lock:
            row = self._db.execute(
                "SELECT p FROM cache WHERE video_id=? AND goal_hash=? AND model=? AND wording=?",
                (video_id, ghash, model, wording)).fetchone()
        return row[0] if row else None

    def put_cache(self, video_id: str, ghash: str, model: str, wording: str, p: float) -> None:
        with self._lock, self._db:
            self._db.execute("INSERT OR REPLACE INTO cache VALUES (?,?,?,?,?,?)",
                             (video_id, ghash, model, wording, p, time.time()))

    def reserve_calls(self, wanted: int, cap: int, day: str | None = None) -> int:
        """Atomically reserve up to `wanted` Jev calls under today's cap; returns how many."""
        day = day or date.today().isoformat()
        with self._lock, self._db:
            row = self._db.execute("SELECT calls FROM daily_usage WHERE day=?", (day,)).fetchone()
            used = row[0] if row else 0
            granted = max(0, min(wanted, cap - used))
            self._db.execute("INSERT OR REPLACE INTO daily_usage VALUES (?,?)", (day, used + granted))
        return granted

    def calls_today(self, day: str | None = None) -> int:
        day = day or date.today().isoformat()
        with self._lock:
            row = self._db.execute("SELECT calls FROM daily_usage WHERE day=?", (day,)).fetchone()
        return row[0] if row else 0

    def log_verdict(self, *, video: dict, goal: str, model: str, wording: str, p: float | None,
                    verdict: str | None, source: str, error: str | None, latency_ms: float | None,
                    state: dict | None) -> None:
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO verdicts (ts, video_id, goal_hash, goal_text, model, wording, p, verdict, source,"
                " error, latency_ms, video_json, state_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (time.time(), video["videoId"], goal_hash(goal), goal, model, wording, p, verdict, source,
                 error, latency_ms, json.dumps(video, ensure_ascii=False),
                 json.dumps(state, ensure_ascii=False) if state else None))

    def log_feedback(self, *, video: dict, goal: str, action: str, p: float | None,
                     previous_verdict: str | None, reason: str | None) -> None:
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO feedback (ts, video_id, goal_hash, goal_text, action, p, previous_verdict, reason,"
                " video_json) VALUES (?,?,?,?,?,?,?,?,?)",
                (time.time(), video["videoId"], goal_hash(goal), goal, action, p, previous_verdict, reason,
                 json.dumps(video, ensure_ascii=False)))

    def stats(self, days: int, today: date | None = None) -> dict:
        """Per (local day, video): max p per goal text, sightings and errors, for the dashboard.

        The verdicts log has one row per (video, goal) per request, so it is grouped here. The
        stored verdict column is ignored: the dashboard bands p again with the current settings.
        """
        today = today or date.today()
        since = datetime.combine(today - timedelta(days=days - 1), datetime.min.time()).timestamp()
        with self._lock:
            per_goal = self._db.execute(
                "SELECT date(ts,'unixepoch','localtime') d, video_id, goal_text, MAX(p), COUNT(*), SUM(p IS NULL),"
                " MIN(ts) FROM verdicts WHERE ts >= ? GROUP BY d, video_id, goal_text", (since,)).fetchall()
            latest = self._db.execute(
                "SELECT date(ts,'unixepoch','localtime') d, video_id, video_json, MAX(ts) FROM verdicts"
                " WHERE ts >= ? GROUP BY d, video_id", (since,)).fetchall()
            feedback = self._db.execute(
                "SELECT ts, video_id, goal_text, action, p, previous_verdict, reason, video_json FROM feedback"
                " WHERE ts >= ? ORDER BY ts", (since,)).fetchall()
            first = self._db.execute("SELECT MIN(ts) FROM verdicts").fetchone()[0]
        meta = {(d, vid): json.loads(vj) for d, vid, vj, _ in latest}
        rows: dict[tuple, dict] = {}
        for d, vid, goal_text, max_p, n, errors, first_seen in per_goal:
            v = meta[(d, vid)]
            r = rows.setdefault((d, vid), {
                "day": d, "videoId": vid, "firstSeen": first_seen, "title": v.get("title", ""),
                "channel": v.get("channel", ""), "durationSeconds": v.get("durationSeconds"),
                "isShort": bool(v.get("isShort")), "pByGoalText": {}, "goalTexts": [], "sightings": 0, "errors": 0})
            r["firstSeen"] = min(r["firstSeen"], first_seen)
            r["goalTexts"].append(goal_text)  # every goal asked about, scored or not
            if max_p is not None:
                r["pByGoalText"][goal_text] = max_p
            r["sightings"] = max(r["sightings"], n)  # each request logs one row per goal
            r["errors"] += errors
        return {
            "since": (today - timedelta(days=days - 1)).isoformat(), "today": today.isoformat(),
            "firstVerdictDay": datetime.fromtimestamp(first).date().isoformat() if first else None,
            "rows": sorted(rows.values(), key=lambda r: (r["day"], r["firstSeen"])),
            "feedback": [{"ts": ts, "videoId": vid, "goalText": g, "action": a, "p": p, "previousVerdict": pv,
                          "reason": reason, "title": json.loads(vj).get("title", "")}
                         for ts, vid, g, a, p, pv, reason, vj in feedback],
        }

    def count(self, table: str) -> int:
        if table not in ("cache", "verdicts", "feedback"):
            raise ValueError(table)
        with self._lock:
            return self._db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
