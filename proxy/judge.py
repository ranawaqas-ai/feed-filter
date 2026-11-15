"""Fan-out of one Jev request per (video, goal), with cache, daily cap and failure handling.

judge() scores one goal exactly as evaluated. judge_goals() runs judge() for every goal
and keeps the highest p per video, recording which goal produced it.

A failure never becomes a show or hide verdict: the item comes back with p=None and
an error code, and the extension keeps that card blurred.
"""

import asyncio
import time
from dataclasses import dataclass

from typesafe_sdk import TypeSafeAPIConnectionError, TypeSafeAPIError, TypeSafeRateLimitError

from .prompt import JEV_MODEL, WORDING_ID, build_request
from .store import Store, goal_hash


def band(p: float, show: float, hide: float) -> str:
    """Three bands: show above `show`, hide below `hide`, uncertain in between (inclusive)."""
    if p > show:
        return "show"
    if p < hide:
        return "hide"
    return "uncertain"


@dataclass
class Result:
    videoId: str
    p: float | None
    verdict: str | None
    source: str  # cache | jev | none
    error: str | None = None
    goalId: str | None = None  # the goal with the highest p (judge_goals only)
    perGoal: dict | None = None  # goal id -> p, None where that goal's call failed


def best_of(video_id: str, per_goal: list[tuple[str, Result]], show: float, hide: float) -> Result:
    """Highest p across goals. Any failed goal makes the whole item an error: the missing goal
    could have been the best one, and its per-goal minimum duration could differ."""
    ps = {gid: r.p for gid, r in per_goal}
    failed = [r for _, r in per_goal if r.p is None]
    source = "jev" if any(r.source == "jev" for _, r in per_goal) else "cache"
    if failed:
        return Result(video_id, None, None, "none", failed[0].error, None, ps)
    gid, top = max(per_goal, key=lambda gr: gr[1].p)
    return Result(video_id, top.p, band(top.p, show, hide), source, None, gid, ps)


class Judge:
    def __init__(self, jev_client, store: Store, *, daily_call_cap: int, max_concurrency: int,
                 timeout_s: float = 15.0):
        self._jev = jev_client
        self._store = store
        self._cap = daily_call_cap
        self._sem = asyncio.Semaphore(max_concurrency)
        self._timeout = timeout_s

    async def judge(self, goal: str, videos: list[dict], show: float = 0.8, hide: float = 0.2) -> list[Result]:
        ghash = goal_hash(goal)
        unique = list({v["videoId"]: v for v in videos}.values())
        results: dict[str, Result] = {}
        misses = []
        for v in unique:
            p = self._store.cached_p(v["videoId"], ghash, JEV_MODEL, WORDING_ID)
            if p is None:
                misses.append(v)
                continue
            results[v["videoId"]] = Result(v["videoId"], p, band(p, show, hide), "cache")
            self._store.log_verdict(video=v, goal=goal, model=JEV_MODEL, wording=WORDING_ID, p=p,
                                    verdict=results[v["videoId"]].verdict, source="cache", error=None,
                                    latency_ms=None, state=None)

        granted = self._store.reserve_calls(len(misses), self._cap)
        for v in misses[granted:]:
            results[v["videoId"]] = Result(v["videoId"], None, None, "none", "daily_cap")
            self._store.log_verdict(video=v, goal=goal, model=JEV_MODEL, wording=WORDING_ID, p=None,
                                    verdict=None, source="none", error="daily_cap", latency_ms=None, state=None)

        fresh = await asyncio.gather(*(self._call(goal, ghash, v, show, hide) for v in misses[:granted]))
        for r in fresh:
            results[r.videoId] = r
        return [results[v["videoId"]] for v in unique]

    async def judge_goals(self, goals: list[dict], videos: list[dict], show: float = 0.8,
                          hide: float = 0.2) -> list[Result]:
        """goals: [{id, text}]. One judge() per goal, run concurrently, combined by best_of."""
        per_goal = await asyncio.gather(*(self.judge(g["text"], videos, show, hide) for g in goals))
        unique = list({v["videoId"]: v for v in videos})
        by_goal = [{r.videoId: r for r in rs} for rs in per_goal]
        return [best_of(vid, [(g["id"], by_goal[i][vid]) for i, g in enumerate(goals)], show, hide)
                for vid in unique]

    async def _call(self, goal: str, ghash: str, video: dict, show: float, hide: float) -> Result:
        state, questions = build_request(goal, video)
        start = time.perf_counter()
        error = None
        p = None
        try:
            async with self._sem:
                resp = await asyncio.wait_for(self._jev.system_one(state, questions), self._timeout)
            p = float(resp.answers["v0"].noul)
        except asyncio.TimeoutError:
            error = "timeout"
        except TypeSafeRateLimitError:
            error = "rate_limited"  # the SDK already retried with backoff
        except (TypeSafeAPIError, TypeSafeAPIConnectionError) as exc:
            error = f"jev_error:{type(exc).__name__}"
        except Exception as exc:  # one bad item must not fail the page; it is logged below with its error
            error = f"internal:{type(exc).__name__}"
        latency_ms = (time.perf_counter() - start) * 1000
        verdict = band(p, show, hide) if p is not None else None
        if p is not None:
            self._store.put_cache(video["videoId"], ghash, JEV_MODEL, WORDING_ID, p)
        self._store.log_verdict(video=video, goal=goal, model=JEV_MODEL, wording=WORDING_ID, p=p,
                                verdict=verdict, source="jev" if p is not None else "none", error=error,
                                latency_ms=latency_ms, state=state)
        return Result(video["videoId"], p, verdict, "jev" if p is not None else "none", error)
