from pathlib import Path

from fastapi.testclient import TestClient

from proxy.app import create_app
from proxy.config import Settings
from proxy.judge import Judge

from .conftest import FakeJev, video

ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"  # any id; the test only checks it is enforced
SECRET = "test-secret"


def make_client(store, jev=None, cap=100):
    settings = Settings(jev_api_key="unused", shared_secret=SECRET, extension_origin=ORIGIN,
                        db_path=Path("unused.sqlite3"), daily_call_cap=cap)
    judge = Judge(jev or FakeJev(p_by_title={"title 1": 0.95}), store, daily_call_cap=cap, max_concurrency=30)
    return TestClient(create_app(settings, judge, store))


def test_judge_requires_secret(store):
    c = make_client(store)
    body = {"goal": "g", "videos": [video(1)]}
    assert c.post("/judge", json=body).status_code == 401
    assert c.post("/judge", json=body, headers={"X-Filter-Secret": "wrong"}).status_code == 401
    assert c.post("/judge", json=body, headers={"X-Filter-Secret": SECRET}).status_code == 200
    print("PASS proxy.app.create_app authorize: /judge rejects missing or wrong X-Filter-Secret")


def test_foreign_origin_rejected_even_with_secret(store):
    c = make_client(store)
    r = c.post("/judge", json={"goal": "g", "videos": [video(1)]},
               headers={"X-Filter-Secret": SECRET, "Origin": "https://www.youtube.com"})
    assert r.status_code == 403
    r = c.post("/judge", json={"goal": "g", "videos": [video(1)]},
               headers={"X-Filter-Secret": SECRET, "Origin": ORIGIN})
    assert r.status_code == 200 and r.headers["access-control-allow-origin"] == ORIGIN
    print("PASS proxy.app.create_app authorize: only the extension origin is accepted and CORS-allowed")


def test_judge_response_shape(store):
    c = make_client(store)
    r = c.post("/judge", json={"goal": "g", "videos": [video(1), video(2)]}, headers={"X-Filter-Secret": SECRET})
    data = r.json()
    assert data["model"] == "jev-1.14.0" and data["wording"] == "N1"
    first = data["results"][0]
    assert set(first) == {"videoId", "p", "verdict", "source", "error", "goalId", "perGoal"}
    assert first["verdict"] == "show" and data["results"][1]["verdict"] == "uncertain"
    print("PASS proxy.app.judge_endpoint: returns {videoId, p, verdict, source, error} per video")


def test_validation_rejects_bad_input(store):
    c = make_client(store)
    h = {"X-Filter-Secret": SECRET}
    assert c.post("/judge", json={"goal": "g", "videos": [dict(video(1), videoId="not-an-id")]}, headers=h).status_code == 422
    assert c.post("/judge", json={"goal": "", "videos": [video(1)]}, headers=h).status_code == 422
    assert c.post("/judge", json={"goal": "g", "videos": [video(1)], "show": 0.1, "hide": 0.5}, headers=h).status_code == 422
    too_many = [video(i) for i in range(61)]
    assert c.post("/judge", json={"goal": "g", "videos": too_many}, headers=h).status_code == 413
    print("PASS proxy.app.judge_endpoint: rejects bad video ids, empty goals, inverted thresholds, >60 videos")


def test_feedback_logged(store):
    c = make_client(store)
    r = c.post("/feedback", headers={"X-Filter-Secret": SECRET},
               json={"goal": "g", "video": video(1), "action": "hide", "p": 0.91, "previousVerdict": "show"})
    assert r.status_code == 200 and store.count("feedback") == 1
    assert c.post("/feedback", json={"goal": "g", "video": video(1), "action": "hide"}).status_code == 401
    print("PASS proxy.app.feedback_endpoint: overrides are logged, and require the secret")


def test_health_reveals_no_secret(store):
    c = make_client(store)
    body = c.get("/health").json()
    assert body["ok"] and SECRET not in str(body) and "unused" not in str(body)
    print("PASS proxy.app.health: liveness only, no secrets in the response")


def test_secret_checked_before_body_validation(store):
    c = make_client(store)
    empty = {"goal": "connection test", "videos": []}
    assert c.post("/judge", json=empty, headers={"X-Filter-Secret": "wrong"}).status_code == 401
    assert c.post("/judge", json=empty, headers={"X-Filter-Secret": SECRET}).status_code == 422
    print("PASS proxy.app.create_app authorize: a bad secret is rejected (401) before body validation (422)")


def test_judge_accepts_goal_list(store):
    jev = FakeJev(p_by_goal_title={("b", "title 1"): 0.95, ("a", "title 1"): 0.1})
    c = make_client(store, jev=jev)
    h = {"X-Filter-Secret": SECRET}
    r = c.post("/judge", headers=h, json={"goals": [{"id": "A", "text": "a"}, {"id": "B", "text": "b"}], "videos": [video(1)]})
    first = r.json()["results"][0]
    assert r.status_code == 200 and first["goalId"] == "B" and first["verdict"] == "show"
    assert c.post("/judge", headers=h, json={"goal": "a", "goals": [{"id": "A", "text": "a"}], "videos": [video(1)]}).status_code == 422
    assert c.post("/judge", headers=h, json={"goals": [{"id": "A", "text": "a"}, {"id": "A", "text": "b"}], "videos": [video(1)]}).status_code == 422
    assert c.post("/judge", headers=h, json={"goals": [], "videos": [video(1)]}).status_code == 422
    print("PASS proxy.app.JudgeRequest: goals list returns best goal; rejects both forms, duplicate ids, empty list")
