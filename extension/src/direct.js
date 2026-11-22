// The scorer: the service worker calls Jev with the user's own key (one call per video and
// goal, best p wins, cache, daily cap, retries).
// Loaded with importScripts in the service worker and with require() in the unit tests.
(function (root) {
  "use strict";

  const JEV_URL = "https://api.typesafe.ai/v1/systemone";
  const MODELS_URL = "https://api.typesafe.ai/v1/models";
  // The exact request the evaluation measured.
  const JEV_MODEL = "jev-1.14.0";
  const WORDING_ID = "N1";
  const WORDING = "Does the video in `video` serve the goal in `goal`?";
  // The second request: two questions about the video alone, asked once per video whatever the
  // goals are. Wording and state are the ones measured on 2026-11-23 (experiments/).
  const ABOUT_ID = "A1";
  const CLICKBAIT_WORDING = "Is the title in `title` written to lure clicks by withholding the key fact, exaggerating, shocking or promising too much, instead of plainly saying what the video is?";
  const KIND_WORDING = "What kind of video is this, judging from `title`, `channel` and `length`?";

  // Retry policy: 4 retries on 408, 429 and 5xx or a network
  // error, backoff from 0.5 s doubling to 8 s with up to 25% jitter, Retry-After respected.
  const RETRY = { maxRetries: 4, initialMs: 500, maxMs: 8000, jitter: 0.25 };
  const RETRY_STATUS = (s) => s === 408 || s === 429 || (s >= 500 && s < 600);

  class JevError extends Error {
    constructor(code) {
      super(code);
      this.code = code;
    }
  }

  // sha256 of the exact goal text, first 32 hex characters.
  async function goalHash(text) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
  }

  function requestBody(goal, video, formatVideo) {
    return { state: { goal, video: formatVideo(video) }, model: JEV_MODEL,
      questions: { v0: { type: "noul", instructions: WORDING } } };
  }

  function aboutBody(video, kinds, formatLength) {
    return { state: { title: video.title, channel: video.channel, length: formatLength(video.durationSeconds) }, model: JEV_MODEL,
      questions: { clickbait: { type: "noul", instructions: CLICKBAIT_WORDING },
        kind: { type: "choice", instructions: KIND_WORDING, criteria: kinds } } };
  }

  // The raw answers kept for a video: P(clickbait) and the likeliest kind with its probability.
  // Cut-offs are applied when a card is decided, so changing one needs no new call.
  function readAbout(answers) {
    const clickbait = answers && answers.clickbait && answers.clickbait.noul;
    const probs = answers && answers.kind && answers.kind.probabilities;
    const top = probs ? Object.entries(probs).sort((a, b) => b[1] - a[1])[0] : null;
    if (typeof clickbait !== "number" || !top || typeof top[1] !== "number") throw new JevError("jev_error:bad_response");
    return { clickbait, kind: top[0], kindP: top[1] };
  }

  class Semaphore {
    constructor(n) {
      this.free = n;
      this.waiting = [];
    }
    async run(fn) {
      if (this.free > 0) this.free -= 1;
      else await new Promise((resolve) => this.waiting.push(resolve));
      try {
        return await fn();
      } finally {
        const next = this.waiting.shift();
        if (next) next();
        else this.free += 1;
      }
    }
  }

  // One Jev System One call with retries. Resolves to the answers, or throws JevError with a code the
  // extension shows (timeout, rate_limited, bad_key, jev_error:HTTP n, jev_error:connection).
  class JevClient {
    constructor({ apiKey, fetch, sleep, random, timeoutMs = 15000 }) {
      this.apiKey = apiKey;
      this.fetch = fetch;
      this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
      this.random = random || Math.random;
      this.timeoutMs = timeoutMs;
    }

    async noul(body) {
      const answers = await this.ask(body);
      const p = answers && answers.v0 && answers.v0.noul;
      if (typeof p !== "number") throw new JevError("jev_error:bad_response");
      return p;
    }

    async ask(body) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        return await this.withRetries(body, ctrl.signal);
      } catch (err) {
        if (err instanceof JevError) throw err;
        if (ctrl.signal.aborted) throw new JevError("timeout");
        throw new JevError("jev_error:connection");
      } finally {
        clearTimeout(timer);
      }
    }

    async withRetries(body, signal) {
      for (let attempt = 0; ; attempt++) {
        let res = null;
        try {
          res = await this.fetch(JEV_URL, {
            method: "POST",
            credentials: "omit",
            headers: { "Authorization": `Bearer ${this.apiKey}`, "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify(body),
            signal,
          });
        } catch (err) {
          if (signal.aborted || attempt >= RETRY.maxRetries) throw err;
          await this.sleep(this.backoff(attempt, null));
          continue;
        }
        if (res.ok) {
          const json = await res.json();
          return (json && json.answers) || null;
        }
        if (res.status === 401 || res.status === 403) throw new JevError("bad_key");
        if (!RETRY_STATUS(res.status) || attempt >= RETRY.maxRetries) {
          throw new JevError(res.status === 429 ? "rate_limited" : `jev_error:HTTP ${res.status}`);
        }
        await this.sleep(this.backoff(attempt, res.headers && res.headers.get && res.headers.get("retry-after")));
      }
    }

    backoff(attempt, retryAfter) {
      const after = Number(retryAfter);
      if (retryAfter && Number.isFinite(after) && after >= 0) return Math.min(after * 1000, RETRY.maxMs);
      const base = Math.min(RETRY.initialMs * 2 ** attempt, RETRY.maxMs);
      return base * (1 - RETRY.jitter * this.random());
    }

    // Lists models: tells a working key from a rejected one without scoring anything.
    async check() {
      try {
        const res = await this.fetch(MODELS_URL, { method: "GET", credentials: "omit",
          headers: { "Authorization": `Bearer ${this.apiKey}`, "Accept": "application/json" } });
        if (res.status === 401 || res.status === 403) return { error: "Jev rejected the key" };
        if (!res.ok) return { error: `Jev HTTP ${res.status}` };
        return { ok: true, model: JEV_MODEL, wording: WORDING_ID };
      } catch (err) {
        return { error: "Jev unreachable" };
      }
    }
  }

  // The judge. `store` keeps the cache, the daily counter and the log.
  class DirectJudge {
    constructor({ jev, store, formatVideo, formatLength, kinds, localDay, dailyCap, maxConcurrency = 30 }) {
      this.jev = jev;
      this.store = store;
      this.formatVideo = formatVideo;
      this.formatLength = formatLength;
      this.kinds = kinds;
      this.localDay = localDay;
      this.dailyCap = dailyCap;
      this.sem = new Semaphore(maxConcurrency);
    }

    // `reserved` is called once this goal's calls are booked against the daily limit.
    async judgeOne(goal, ghash, videos, reserved) {
      const unique = [...new Map(videos.map((v) => [v.videoId, v])).values()];
      const results = new Map();
      const misses = [];
      for (const v of unique) {
        const p = await this.store.cachedP(v.videoId, ghash, JEV_MODEL, WORDING_ID);
        if (p === null || p === undefined) misses.push(v);
        else results.set(v.videoId, { videoId: v.videoId, p, source: "cache", error: null });
      }
      const granted = await this.store.reserveCalls(this.localDay(new Date()), misses.length, this.dailyCap);
      reserved();
      for (const v of misses.slice(granted)) {
        results.set(v.videoId, { videoId: v.videoId, p: null, source: "none", error: "daily_cap" });
      }
      await Promise.all(misses.slice(0, granted).map(async (v) => {
        let p = null;
        let error = null;
        try {
          p = await this.sem.run(() => this.jev.noul(requestBody(goal, v, this.formatVideo)));
          await this.store.putCache(v.videoId, ghash, JEV_MODEL, WORDING_ID, p);
        } catch (err) {
          error = err instanceof JevError ? err.code : `internal:${err && err.name}`;
        }
        results.set(v.videoId, { videoId: v.videoId, p, source: p === null ? "none" : "jev", error });
      }));
      return unique.map((v) => results.get(v.videoId));
    }

    // videoId -> {clickbait, kind, kindP}. A video whose call fails, or that the daily cap leaves
    // out, is missing: it gets no tags, and its goal scores still decide the card.
    async aboutVideos(videos) {
      const found = new Map();
      const misses = [];
      for (const v of new Map(videos.map((x) => [x.videoId, x])).values()) {
        const hit = await this.store.cachedAbout(v.videoId, JEV_MODEL, ABOUT_ID);
        if (hit) found.set(v.videoId, hit);
        else misses.push(v);
      }
      const granted = await this.store.reserveCalls(this.localDay(new Date()), misses.length, this.dailyCap);
      await Promise.all(misses.slice(0, granted).map(async (v) => {
        try {
          const about = readAbout(await this.sem.run(() => this.jev.ask(aboutBody(v, this.kinds, this.formatLength))));
          found.set(v.videoId, about);
          await this.store.putAbout(v.videoId, JEV_MODEL, ABOUT_ID, about);
        } catch (err) {
          console.warn(`Feed Filter: no kind or clickbait answer for ${v.videoId} (${err && err.code ? err.code : err})`);
        }
      }));
      return found;
    }

    // goals: [{id, text}].
    async judgeGoals(goals, videos) {
      const hashes = await Promise.all(goals.map((g) => goalHash(g.text)));
      // Goal scores are booked against the daily limit first; the per-video calls get what is left.
      const booked = goals.map(() => Promise.withResolvers());
      const scoring = Promise.all(goals.map((g, i) => this.judgeOne(g.text, hashes[i], videos, booked[i].resolve)));
      const asking = Promise.all(booked.map((b) => b.promise)).then(() => this.aboutVideos(videos));
      const [perGoal, about] = await Promise.all([scoring, asking]);
      const byGoal = perGoal.map((rs) => new Map(rs.map((r) => [r.videoId, r])));
      const ids = [...new Set(videos.map((v) => v.videoId))];
      const results = ids.map((vid) => ({
        ...bestOf(vid, goals.map((g, i) => [g.id, byGoal[i].get(vid)])), about: about.get(vid) || null }));
      if (this.store.logJudged) {
        const byId = new Map(videos.map((v) => [v.videoId, v]));
        await this.store.logJudged(this.localDay(new Date()), Date.now() / 1000,
          ids.map((vid) => ({ video: byId.get(vid), about: about.get(vid) || null, perGoal: goals.map((g, i) => [g.text, byGoal[i].get(vid)]) })));
      }
      return { model: JEV_MODEL, wording: WORDING_ID, results,
        callsToday: await this.store.callsToday(this.localDay(new Date())), dailyCap: this.dailyCap };
    }
  }

  // Highest p across goals; any failed goal makes the whole item an error, because the missing
  // goal could have been the best one.
  function bestOf(videoId, perGoal) {
    const ps = Object.fromEntries(perGoal.map(([gid, r]) => [gid, r.p]));
    const failed = perGoal.filter(([, r]) => r.p === null);
    const source = perGoal.some(([, r]) => r.source === "jev") ? "jev" : "cache";
    if (failed.length) return { videoId, p: null, source: "none", error: failed[0][1].error, goalId: null, perGoal: ps };
    const [gid, top] = perGoal.reduce((a, b) => (b[1].p > a[1].p ? b : a));
    return { videoId, p: top.p, source, error: null, goalId: gid, perGoal: ps };
  }

  // When every item failed for a reason that is about the scorer and not the video (a rejected
  // key, no connection), the request reports it once, so the page shows the scorer banner.
  const REQUEST_ERRORS = { bad_key: "Jev rejected the key", "jev_error:connection": "Jev unreachable", timeout: "Jev unreachable" };
  function requestError(results) {
    if (!results.length) return null;
    const first = results[0].error;
    return REQUEST_ERRORS[first] && results.every((r) => r.error === first) ? REQUEST_ERRORS[first] : null;
  }

  const api = { JEV_URL, JEV_MODEL, WORDING_ID, WORDING, ABOUT_ID, aboutBody, readAbout, JevClient, JevError, DirectJudge, Semaphore, goalHash, requestBody, bestOf, requestError };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.YFFDirect = api;
})(typeof self !== "undefined" ? self : globalThis);
