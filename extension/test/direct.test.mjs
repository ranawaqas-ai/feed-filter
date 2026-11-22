// Unit tests for extension/src/direct.js (the scorer). Run: node --test extension/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const YFF = require("../src/shared/core.js");
const D = require("../src/direct.js");
const pass = (msg) => console.log(`PASS ${msg}`);

// Cache, daily counter and log in memory, with the interface the IndexedDB store has.
class MemoryStore {
  constructor() {
    this.cache = new Map();
    this.about = new Map();
    this.usage = new Map();
    this.logged = [];
  }
  async cachedP(vid, gh, m, w) { return this.cache.get(`${vid}|${gh}|${m}|${w}`) ?? null; }
  async putCache(vid, gh, m, w, p) { this.cache.set(`${vid}|${gh}|${m}|${w}`, p); }
  async cachedAbout(vid, m, w) { return this.about.get(`${vid}|${m}|${w}`) ?? null; }
  async putAbout(vid, m, w, a) { this.about.set(`${vid}|${m}|${w}`, a); }
  async reserveCalls(day, wanted, cap) {
    const used = this.usage.get(day) || 0;
    const granted = Math.max(0, Math.min(wanted, cap - used));
    this.usage.set(day, used + granted);
    return granted;
  }
  async callsToday(day) { return this.usage.get(day) || 0; }
  async logJudged(day, ts, items) { this.logged.push({ day, ts, items }); }
}

const ok = (p) => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ answers: { v0: { type: "noul", noul: p } } }) });
const okAbout = (clickbait, probabilities) => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ answers: {
  clickbait: { type: "noul", noul: clickbait }, kind: { type: "choice", probabilities } } }) });
const status = (s, headers = {}) => ({ ok: false, status: s, headers: new Map(Object.entries(headers)), json: async () => ({}) });
const video = (id) => ({ videoId: id, title: `t ${id}`, channel: "c", durationSeconds: 600, viewCount: 1000, isShort: false, description: "" });

// Goal calls and per-video calls are counted apart; the per-video call is answered with `about`.
function setup({ score, dailyCap = 100, responses, about = () => okAbout(0.1, { Tutorial: 1 }) } = {}) {
  const calls = [];
  const aboutCalls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.questions.kind) {
      aboutCalls.push(body);
      return about(body.state);
    }
    calls.push({ url, init, body });
    if (responses) return responses.shift();
    return ok(score(body.state.goal, body.state.video));
  };
  const jev = new D.JevClient({ apiKey: "test-key", fetch, sleep: async () => {}, random: () => 0 });
  const store = new MemoryStore();
  const judge = new D.DirectJudge({ jev, store, formatVideo: YFF.formatVideo, formatLength: YFF.formatDurationText,
    kinds: YFF.KINDS, localDay: YFF.localDay, dailyCap });
  return { calls, aboutCalls, jev, store, judge };
}

test("goalHash is the first 32 hex characters of sha256", async () => {
  // python: hashlib.sha256("Learn Rust".encode()).hexdigest()[:32]
  assert.equal(await D.goalHash("Learn Rust"), "682ddafabd103587597f0a8e5e7d4135");
  pass("YFFDirect.goalHash: sha256 of the goal text, first 32 hex characters");
});

test("JevClient sends the evaluated request and reads answers.v0.noul", async () => {
  const { calls, judge } = setup({ score: () => 0.42 });
  const out = await judge.judgeGoals([{ id: "g", text: "Learn Rust" }], [video("a")]);
  assert.equal(calls.length, 1);
  const { url, init, body } = calls[0];
  assert.equal(url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(init.headers.Authorization, "Bearer test-key");
  assert.equal(init.credentials, "omit");
  assert.deepEqual(body, { state: { goal: "Learn Rust", video: YFF.formatVideo(video("a")) }, model: "jev-1.14.0",
    questions: { v0: { type: "noul", instructions: "Does the video in `video` serve the goal in `goal`?" } } });
  assert.equal(out.results[0].p, 0.42);
  assert.equal(out.model, "jev-1.14.0");
  pass("YFFDirect.JevClient: POST /v1/systemone with the jev-1.14.0 Noul N1 body, bearer key, no cookies");
});

test("DirectJudge keeps the best goal, caches p and skips the cache on a new goal text", async () => {
  const { calls, judge } = setup({ score: (goal, v) => (goal === "A" ? 0.3 : v.includes("t b") ? 0.9 : 0.1) });
  const goals = [{ id: "ga", text: "A" }, { id: "gb", text: "B" }];
  const first = await judge.judgeGoals(goals, [video("a"), video("b"), video("a")]);
  assert.deepEqual(first.results.map((r) => [r.videoId, r.p, r.goalId, r.source]),
    [["a", 0.3, "ga", "jev"], ["b", 0.9, "gb", "jev"]]);
  assert.deepEqual(first.results[0].perGoal, { ga: 0.3, gb: 0.1 });
  assert.equal(calls.length, 4, "2 unique videos x 2 goals; the duplicate is not called again");
  const again = await judge.judgeGoals(goals, [video("a"), video("b")]);
  assert.equal(calls.length, 4, "second request served from cache");
  assert.deepEqual(again.results.map((r) => r.source), ["cache", "cache"]);
  await judge.judgeGoals([{ id: "ga", text: "A edited" }], [video("a")]);
  assert.equal(calls.length, 5, "edited goal text is a new cache key");
  pass("YFFDirect.DirectJudge: best p wins with its goal id, duplicates deduped, cache hit on repeat, miss on edited goal");
});

test("DirectJudge: a failed goal makes the item an error, never a score", async () => {
  const { judge } = setup({ responses: [ok(0.9), status(400)] });
  const out = await judge.judgeGoals([{ id: "g1", text: "A" }, { id: "g2", text: "B" }], [video("a")]);
  assert.deepEqual([out.results[0].p, out.results[0].error], [null, "jev_error:HTTP 400"]);
  assert.deepEqual(out.results[0].perGoal, { g1: 0.9, g2: null });
  pass("YFFDirect.bestOf: any failed goal makes the whole item an error with p null");
});

test("requestError reports a scorer-wide failure once", () => {
  const failed = (error) => ({ p: null, error });
  assert.equal(D.requestError([failed("bad_key"), failed("bad_key")]), "Jev rejected the key");
  assert.equal(D.requestError([failed("jev_error:connection")]), "Jev unreachable");
  assert.equal(D.requestError([failed("timeout"), failed("timeout")]), "Jev unreachable");
  assert.equal(D.requestError([failed("jev_error:connection"), { p: 0.4, error: null }]), null, "one scored item: per-item errors stand");
  assert.equal(D.requestError([failed("daily_cap"), failed("daily_cap")]), null, "the cap is not a scorer failure");
  assert.equal(D.requestError([]), null);
  pass("YFFDirect.requestError: a rejected key or no connection on every item becomes one request error; mixed results and the cap do not");
});

test("DirectJudge stops at the daily cap and reports calls used", async () => {
  const { calls, aboutCalls, judge } = setup({ score: () => 0.5, dailyCap: 3 });
  const out = await judge.judgeGoals([{ id: "g", text: "A" }], ["a", "b", "c", "d", "e"].map(video));
  assert.equal(calls.length, 3);
  assert.equal(aboutCalls.length, 0, "goal scores come first; the per-video calls get what is left");
  assert.deepEqual(out.results.map((r) => r.error), [null, null, null, "daily_cap", "daily_cap"]);
  assert.equal(out.callsToday, 3);
  assert.equal(out.dailyCap, 3);
  pass("YFFDirect.DirectJudge: calls past the daily cap are not made and come back as daily_cap errors");
});

test("JevClient retries 429 and 5xx, honours Retry-After, and names the final error", async () => {
  const slept = [];
  const mk = (responses) => new D.JevClient({ apiKey: "k", fetch: async () => responses.shift(), sleep: async (ms) => slept.push(ms), random: () => 0 });
  assert.equal(await mk([status(429), status(503), ok(0.7)]).noul({}), 0.7);
  assert.deepEqual(slept, [500, 1000], "backoff doubles from 0.5 s");
  slept.length = 0;
  assert.equal(await mk([status(429, { "retry-after": "2" }), ok(0.1)]).noul({}), 0.1);
  assert.deepEqual(slept, [2000], "Retry-After respected");
  await assert.rejects(mk([status(429), status(429), status(429), status(429), status(429)]).noul({}), { code: "rate_limited" });
  await assert.rejects(mk([status(401)]).noul({}), { code: "bad_key" });
  await assert.rejects(mk([status(400)]).noul({}), { code: "jev_error:HTTP 400" });
  pass("YFFDirect.JevClient: 4 retries on 408/429/5xx with 0.5 s doubling backoff and Retry-After; 401/403 is bad_key");
});

test("JevClient times out the whole item", async () => {
  const jev = new D.JevClient({ apiKey: "k", timeoutMs: 20,
    fetch: (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))) });
  await assert.rejects(jev.noul({}), { code: "timeout" });
  pass("YFFDirect.JevClient: a call still pending at the timeout becomes a timeout error");
});

test("Semaphore caps calls in flight", async () => {
  const sem = new D.Semaphore(2);
  let inFlight = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 7 }, () => sem.run(async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight -= 1;
  })));
  assert.equal(peak, 2);
  pass("YFFDirect.Semaphore: never more than the limit in flight");
});

test("the per-video call asks kind and clickbait once, whatever the goals, and is cached", async () => {
  const { calls, aboutCalls, judge, store } = setup({ score: () => 0.5, about: () => okAbout(0.93, { News: 0.54, Opinion: 0.46 }) });
  const goals = [{ id: "ga", text: "A" }, { id: "gb", text: "B" }];
  const out = await judge.judgeGoals(goals, [video("a")]);
  assert.equal(calls.length, 2);
  assert.equal(aboutCalls.length, 1, "one call per video, not per goal");
  assert.deepEqual(aboutCalls[0].state, { title: "t a", channel: "c", length: "10:00" });
  assert.deepEqual(aboutCalls[0].questions.kind.criteria, YFF.KINDS);
  assert.deepEqual(out.results[0].about, { clickbait: 0.93, kind: "News", kindP: 0.54 });
  assert.deepEqual(store.logged[0].items[0].about, out.results[0].about);
  assert.equal(out.callsToday, 3, "it counts towards the daily limit");
  await judge.judgeGoals([{ id: "gc", text: "C" }], [video("a")]);
  assert.equal(aboutCalls.length, 1, "a new goal does not ask again");
  pass("YFFDirect.aboutVideos: one call per video for kind and clickbait, cached, logged and counted");
});

test("a failed per-video call leaves the goal score standing", async () => {
  for (const about of [() => status(400), () => okAbout(undefined, { News: 1 }), () => okAbout(0.5, {})]) {
    const { judge, store } = setup({ score: () => 0.9, about });
    const out = await judge.judgeGoals([{ id: "g", text: "A" }], [video("a")]);
    assert.deepEqual([out.results[0].p, out.results[0].error, out.results[0].about], [0.9, null, null]);
    assert.equal(store.about.size, 0, "a failed answer is not cached");
  }
  pass("YFFDirect.aboutVideos: an HTTP error or a malformed answer gives about null and never an error card");
});
