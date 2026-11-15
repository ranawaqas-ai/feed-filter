import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))  # evaluation code, for the parity test


class FakeJev:
    """Stands in for AsyncTypeSafeClient. p comes from the title; tracks concurrency."""

    def __init__(self, p_by_title=None, default_p=0.5, delay=0.02, fail_titles=None, p_by_goal_title=None):
        self.p_by_title = p_by_title or {}
        self.p_by_goal_title = p_by_goal_title or {}  # (goal text, title) -> p
        self.default_p = default_p
        self.delay = delay
        self.fail_titles = fail_titles or {}
        self.calls = []
        self.in_flight = 0
        self.max_in_flight = 0

    async def system_one(self, state, questions):
        self.calls.append((state, questions))
        self.in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self.in_flight)
        try:
            await asyncio.sleep(self.delay)
            title = state["video"].splitlines()[0].removeprefix("Title: ")
            if title in self.fail_titles:
                raise self.fail_titles[title]
            p = self.p_by_goal_title.get((state["goal"], title), self.p_by_title.get(title, self.default_p))
            return SimpleNamespace(answers={"v0": SimpleNamespace(noul=p)})
        finally:
            self.in_flight -= 1


def video(i: int, title: str | None = None, **extra) -> dict:
    vid = f"vid{i:08d}"[:11]
    return {"videoId": vid, "title": title or f"title {i}", "channel": f"channel {i}",
            "durationSeconds": 600, "viewCount": 1234, "isShort": False, "description": "", **extra}


@pytest.fixture
def store(tmp_path):
    from proxy.store import Store
    s = Store(tmp_path / "test.sqlite3")
    yield s
    s.close()
