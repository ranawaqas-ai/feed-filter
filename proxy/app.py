"""HTTP API for the extension.

POST /judge     {goals: [{id, text}] | goal, videos[], show?, hide?}
                -> {model, results: [{videoId, p, verdict, source, error, goalId, perGoal}]}
                p is the highest p across goals and goalId the goal that produced it.
POST /feedback  {goal, video, action: keep|hide, p?, previousVerdict?, reason?}
POST /stats     {days: 1..90} -> per (local day, video) max p per goal text, plus feedback rows
GET  /health    liveness only; reveals nothing secret

/judge, /feedback and /stats require the X-Filter-Secret header. Requests that carry an Origin
must come from the extension origin; CORS is limited to that origin as well.
"""

import hmac
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, model_validator

from .config import Settings
from .judge import Judge
from .prompt import JEV_MODEL, WORDING_ID
from .store import Store


class VideoIn(BaseModel):
    videoId: str = Field(pattern=r"^[A-Za-z0-9_-]{11}$")
    title: str = Field(max_length=400)
    channel: str = Field(default="", max_length=200)
    durationSeconds: int | None = Field(default=None, ge=0)
    viewCount: int | None = Field(default=None, ge=0)
    isShort: bool = False
    description: str = Field(default="", max_length=500)


class GoalIn(BaseModel):
    id: str = Field(min_length=1, max_length=40)
    text: str = Field(min_length=1, max_length=2000)


class JudgeRequest(BaseModel):
    goal: str | None = Field(default=None, min_length=1, max_length=2000)  # single goal, as evaluated
    goals: list[GoalIn] | None = Field(default=None, min_length=1, max_length=10)
    videos: list[VideoIn] = Field(min_length=1)
    show: float = Field(default=0.8, ge=0, le=1)
    hide: float = Field(default=0.2, ge=0, le=1)

    @model_validator(mode="after")
    def one_goal_form(self):
        if (self.goal is None) == (self.goals is None):
            raise ValueError("send exactly one of goal or goals")
        if self.goals is not None and len({g.id for g in self.goals}) != len(self.goals):
            raise ValueError("goal ids must be unique")
        return self

    def goal_list(self) -> list[dict]:
        return [g.model_dump() for g in self.goals] if self.goals is not None else [{"id": "goal", "text": self.goal}]


class FeedbackRequest(BaseModel):
    goal: str = Field(min_length=1, max_length=2000)
    video: VideoIn
    action: Literal["keep", "hide"]
    p: float | None = None
    previousVerdict: str | None = Field(default=None, max_length=40)
    reason: str | None = Field(default=None, max_length=80)


class StatsRequest(BaseModel):
    days: int = Field(default=14, ge=1, le=90)


def create_app(settings: Settings, judge: Judge, store: Store) -> FastAPI:
    app = FastAPI(title="YouTube feed filter proxy", docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(CORSMiddleware, allow_origins=[settings.extension_origin],
                       allow_methods=["GET", "POST"], allow_headers=["Content-Type", "X-Filter-Secret"])

    def authorize(request: Request, x_filter_secret: str = Header(default="")) -> None:
        origin = request.headers.get("origin")
        if origin is not None and origin != settings.extension_origin:
            raise HTTPException(403, "origin not allowed")
        if not hmac.compare_digest(x_filter_secret.encode(), settings.shared_secret.encode()):
            raise HTTPException(401, "bad or missing X-Filter-Secret")

    @app.get("/health")
    def health() -> dict:
        return {"ok": True, "model": JEV_MODEL, "wording": WORDING_ID}

    @app.post("/judge", dependencies=[Depends(authorize)])
    async def judge_endpoint(body: JudgeRequest) -> dict:
        if len(body.videos) > settings.max_videos_per_request:
            raise HTTPException(413, f"at most {settings.max_videos_per_request} videos per request")
        if body.hide > body.show:
            raise HTTPException(422, "hide threshold must not exceed show threshold")
        results = await judge.judge_goals(body.goal_list(), [v.model_dump() for v in body.videos], body.show, body.hide)
        return {"model": JEV_MODEL, "wording": WORDING_ID, "results": [r.__dict__ for r in results],
                "callsToday": store.calls_today(), "dailyCap": settings.daily_call_cap}

    @app.post("/feedback", dependencies=[Depends(authorize)])
    def feedback_endpoint(body: FeedbackRequest) -> dict:
        store.log_feedback(video=body.video.model_dump(), goal=body.goal, action=body.action, p=body.p,
                           previous_verdict=body.previousVerdict, reason=body.reason)
        return {"ok": True}

    @app.post("/stats", dependencies=[Depends(authorize)])
    def stats_endpoint(body: StatsRequest) -> dict:
        return store.stats(body.days)

    return app
