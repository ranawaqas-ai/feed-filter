// The scorer's storage, in IndexedDB: the p cache, the daily call counter, the verdict log
// (one row per local day and video) and Keep/Hide feedback. stats() returns the rows the
// dashboard aggregates. Nothing here leaves the browser.
(function (root) {
  "use strict";

  const DB_NAME = "feed-filter";
  const DB_VERSION = 1;
  const KEEP_DAYS = 30;

  // ---- pure parts, unit-tested against test/stats_fixture.json --------------------------

  // Folds one judge request into the (day, video) row: every goal asked about is listed, p is the max per goal text, each request
  // counts one sighting and each failed goal call one error.
  function mergeJudged(row, day, ts, video, perGoal) {
    const r = row || { day, videoId: video.videoId, firstSeen: ts, title: "", channel: "", durationSeconds: null,
      isShort: false, pByGoalText: {}, goalTexts: [], sightings: 0, errors: 0 };
    r.firstSeen = Math.min(r.firstSeen, ts);
    r.title = video.title || "";
    r.channel = video.channel || "";
    r.durationSeconds = video.durationSeconds ?? null;
    r.isShort = !!video.isShort;
    for (const [goalText, p] of perGoal) {
      if (!r.goalTexts.includes(goalText)) r.goalTexts.push(goalText);
      if (p === null || p === undefined) r.errors += 1;
      else r.pByGoalText[goalText] = Math.max(r.pByGoalText[goalText] ?? -Infinity, p);
    }
    r.sightings += 1;
    return r;
  }

  function statsFrom({ rows, feedback, firstVerdictDay, days, today, localDay }) {
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1));
    const since = localDay(start);
    const sinceTs = start.getTime() / 1000;
    return {
      since, today: localDay(today), firstVerdictDay: firstVerdictDay || null,
      rows: rows.filter((r) => r.day >= since).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.firstSeen - b.firstSeen)),
      feedback: feedback.filter((f) => f.ts >= sinceTs).sort((a, b) => a.ts - b.ts)
        .map(({ ts, videoId, goalText, action, p, previousVerdict, reason, title }) => ({ ts, videoId, goalText, action, p, previousVerdict, reason, title })),
    };
  }

  // ---- IndexedDB --------------------------------------------------------------------------
  const req = (r) => new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const done = (tx) => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });

  class IdbStore {
    constructor({ localDay, indexedDB = root.indexedDB }) {
      this.localDay = localDay;
      this.idb = indexedDB;
      this.dbPromise = null;
    }

    db() {
      if (!this.dbPromise) {
        const open = this.idb.open(DB_NAME, DB_VERSION);
        open.onupgradeneeded = () => {
          const db = open.result;
          db.createObjectStore("cache").createIndex("createdAt", "createdAt");
          db.createObjectStore("usage");
          db.createObjectStore("days").createIndex("day", "day");
          db.createObjectStore("feedback", { autoIncrement: true }).createIndex("ts", "ts");
          db.createObjectStore("meta");
        };
        this.dbPromise = req(open);
      }
      return this.dbPromise;
    }

    async cachedP(videoId, ghash, model, wording) {
      const db = await this.db();
      const hit = await req(db.transaction("cache").objectStore("cache").get(`${videoId}|${ghash}|${model}|${wording}`));
      return hit ? hit.p : null;
    }

    async putCache(videoId, ghash, model, wording, p) {
      const db = await this.db();
      const tx = db.transaction("cache", "readwrite");
      tx.objectStore("cache").put({ p, createdAt: Date.now() / 1000 }, `${videoId}|${ghash}|${model}|${wording}`);
      await done(tx);
    }

    // Read and write in one readwrite transaction, so two requests cannot both take the last calls.
    async reserveCalls(day, wanted, cap) {
      const db = await this.db();
      const tx = db.transaction("usage", "readwrite");
      const store = tx.objectStore("usage");
      const used = (await req(store.get(day))) || 0;
      const granted = Math.max(0, Math.min(wanted, cap - used));
      store.put(used + granted, day);
      await done(tx);
      return granted;
    }

    async callsToday(day) {
      const db = await this.db();
      return (await req(db.transaction("usage").objectStore("usage").get(day))) || 0;
    }

    // items: [{video, perGoal: [[goalText, {p}]]}] from one judge request.
    async logJudged(day, ts, items) {
      const db = await this.db();
      const tx = db.transaction(["days", "meta"], "readwrite");
      const daysStore = tx.objectStore("days");
      for (const { video, perGoal } of items) {
        const key = `${day}|${video.videoId}`;
        const row = await req(daysStore.get(key));
        daysStore.put(mergeJudged(row, day, ts, video, perGoal.map(([g, r]) => [g, r.p])), key);
      }
      const meta = tx.objectStore("meta");
      if (!(await req(meta.get("firstVerdictDay")))) meta.put(day, "firstVerdictDay");
      await done(tx);
    }

    async logFeedback({ goal, video, action, p, previousVerdict, reason }) {
      const db = await this.db();
      const tx = db.transaction("feedback", "readwrite");
      tx.objectStore("feedback").add({ ts: Date.now() / 1000, videoId: video.videoId, goalText: goal, action,
        p: p ?? null, previousVerdict: previousVerdict ?? null, reason: reason ?? null, title: video.title || "" });
      await done(tx);
      return { ok: true };
    }

    async stats(days, today = new Date()) {
      const db = await this.db();
      const tx = db.transaction(["days", "feedback", "meta"]);
      const [rows, feedback, firstVerdictDay] = await Promise.all([
        req(tx.objectStore("days").getAll()), req(tx.objectStore("feedback").getAll()), req(tx.objectStore("meta").get("firstVerdictDay"))]);
      return statsFrom({ rows, feedback, firstVerdictDay, days, today, localDay: this.localDay });
    }

    // Drops log rows, feedback and cache entries older than KEEP_DAYS; runs at startup.
    async prune(now = new Date()) {
      const db = await this.db();
      const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - KEEP_DAYS);
      const cutoffDay = this.localDay(cutoff);
      const cutoffTs = cutoff.getTime() / 1000;
      const tx = db.transaction(["days", "feedback", "cache", "usage"], "readwrite");
      tx.objectStore("days").index("day").openCursor(IDBKeyRange.upperBound(cutoffDay, true)).onsuccess = deleteAll;
      tx.objectStore("feedback").index("ts").openCursor(IDBKeyRange.upperBound(cutoffTs, true)).onsuccess = deleteAll;
      tx.objectStore("cache").index("createdAt").openCursor(IDBKeyRange.upperBound(cutoffTs, true)).onsuccess = deleteAll;
      tx.objectStore("usage").openCursor(IDBKeyRange.upperBound(cutoffDay, true)).onsuccess = deleteAll;
      await done(tx);
    }
  }

  function deleteAll(ev) {
    const cursor = ev.target.result;
    if (!cursor) return;
    cursor.delete();
    cursor.continue();
  }

  const api = { mergeJudged, statsFrom, IdbStore, KEEP_DAYS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.YFFLocal = api;
})(typeof self !== "undefined" ? self : globalThis);
