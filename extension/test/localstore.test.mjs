// Unit tests for extension/src/localstore.js. Run: node --test extension/test/
process.env.TZ = "UTC"; // the shared scenario's local days are UTC days
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const YFF = require("../src/shared/core.js");
const L = require("../src/localstore.js");
const pass = (msg) => console.log(`PASS ${msg}`);

test("statsFrom over mergeJudged rows equals the proxy's Store.stats for the shared scenario", () => {
  const { scenario: sc, expected } = JSON.parse(readFileSync(path.join(here, "stats_fixture.json"), "utf8"));
  const rows = new Map();
  let firstVerdictDay = null;
  for (const e of sc.events) {
    const day = YFF.localDay(new Date(e.ts * 1000));
    const key = `${day}|${e.video.videoId}`;
    rows.set(key, L.mergeJudged(rows.get(key), day, e.ts, e.video, e.perGoal));
    if (!firstVerdictDay || day < firstVerdictDay) firstVerdictDay = day;
  }
  const feedback = sc.feedback.map((f) => ({ ts: f.ts, videoId: f.video.videoId, goalText: f.goal, action: f.action, p: f.p,
    previousVerdict: f.previousVerdict, reason: f.reason, title: f.video.title }));
  const [y, m, d] = sc.today.split("-").map(Number);
  const got = L.statsFrom({ rows: [...rows.values()], feedback, firstVerdictDay, days: sc.days, today: new Date(y, m - 1, d), localDay: YFF.localDay });
  assert.deepEqual(got, expected);
  pass(`YFFLocal.statsFrom + mergeJudged: identical to proxy.store.Store.stats on the ${sc.events.length}-event scenario`);
});
