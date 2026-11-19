// Unit tests for extension/src/shared/core.js. Run: node --test extension/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const YFF = require("../src/shared/core.js");
// The logged-out test profile's home feed (e2e/capture_logged_out.mjs), and playlist, podcast
// and game cards whose free text is redacted (only keys, enum values and numbers kept).
const capture = JSON.parse(readFileSync(path.join(here, "../../e2e/fixtures/home_feed_loggedout.json"), "utf8"));
const nonVideo = JSON.parse(readFileSync(path.join(here, "nonvideo_cards.json"), "utf8"));
const pass = (msg) => console.log(`PASS ${msg}`);
// Neutral goals for tests that need ids, names and minimum durations.
const TEST_GOALS = [
  { id: "G1", name: "Cooking", minDurationMinutes: 8, text: "Cooking. Not: a, b, or c." },
  { id: "G2", name: "Finance", minDurationMinutes: 8, text: "Finance. Not: a, b, or c." },
  { id: "G3", name: "Coding", minDurationMinutes: 8, text: "Coding. Not: a, b, or c." },
  { id: "G4", name: "History", minDurationMinutes: 8, text: "History. Not: a, b, or c." },
  { id: "G5", name: "Music", minDurationMinutes: 0, text: "Music. Not: a, b, or c." },
];

test("parseDuration", () => {
  assert.equal(YFF.parseDuration("11:21"), 681);
  assert.equal(YFF.parseDuration("1:02:03"), 3723);
  assert.equal(YFF.parseDuration("0:31"), 31);
  for (const bad of ["LIVE", "Upcoming", "", null, "1:2", "SHORTS"]) assert.equal(YFF.parseDuration(bad), null);
  pass("YFF.parseDuration: m:ss and h:mm:ss parsed, badges like LIVE/Upcoming give null");
});

test("parseViews", () => {
  assert.equal(YFF.parseViews("390 thousand views"), 390000);
  assert.equal(YFF.parseViews("1 million views"), 1000000);
  assert.equal(YFF.parseViews("1.2 million views"), 1200000);
  assert.equal(YFF.parseViews("12,345 views"), 12345);
  assert.equal(YFF.parseViews("61K views"), 61000);
  assert.equal(YFF.parseViews("1.2M"), 1200000);
  assert.equal(YFF.parseViews("No views"), 0);
  assert.equal(YFF.parseViews("13h ago"), null);
  pass("YFF.parseViews: accessibility labels, K/M/B text and plain counts");
});

test("extractFromData on the logged-out home-feed capture", () => {
  assert.equal(capture.signedIn, false);
  const items = capture.cards.map((c) => ({ card: c, item: YFF.extractFromData(c.data) }));
  const kinds = {};
  for (const { item } of items) kinds[item.kind] = (kinds[item.kind] || 0) + 1;
  assert.deepEqual(kinds, { ad: 10, video: 275, short: 10, other: 2 });

  const videos = items.filter((x) => x.item.kind === "video");
  for (const { card, item } of videos) {
    assert.match(item.videoId, YFF.VIDEO_ID);
    assert.ok(card.linkPath.includes(item.videoId), `videoId ${item.videoId} not in link ${card.linkPath}`);
    assert.ok(item.title.length > 0 && item.channel.length > 0, `missing title/channel for ${item.videoId}`);
    assert.equal(item.description, "");
  }
  const noDuration = videos.filter((x) => x.item.durationSeconds === null);
  assert.ok(noDuration.length > 0 && noDuration.every((x) => x.item.isLive || x.item.isUpcoming), "only live or upcoming videos lack a duration");
  assert.equal(videos.filter((x) => x.item.viewCount === null).length, 17);

  const shorts = items.filter((x) => x.item.kind === "short");
  for (const { card, item } of shorts) {
    assert.equal(card.linkPath, `/shorts/${item.videoId}`);
    assert.ok(item.isShort && item.title.length > 0);
  }
  const first = videos[0].item;
  assert.deepEqual([first.videoId, first.channel, first.durationSeconds, first.viewCount],
    ["d3L2uPuxOxU", "CNBC", 1074, 5000000]);
  pass(`YFF.extractFromData: ${videos.length} videos, ${shorts.length} Shorts, 10 ads and 2 other cards from the logged-out capture`);
});

test("extractFromData classifies playlist, podcast and game cards", () => {
  for (const { kind, data } of nonVideo) assert.equal(YFF.extractFromData(data).kind, kind);
  pass(`YFF.extractFromData: ${nonVideo.length} redacted playlist, podcast and game cards keep their kind`);
});

test("extractFromData on unknown or empty data fails closed", () => {
  assert.equal(YFF.extractFromData(undefined).videoId, null);
  assert.equal(YFF.extractFromData({ content: { somethingNew: {} } }).kind, "unknown");
  pass("YFF.extractFromData: unknown card types return kind=unknown and no videoId");
});

test("videoIdFromHref", () => {
  assert.equal(YFF.videoIdFromHref("/watch?v=6K9fFLZ3e6Q&pp=x"), "6K9fFLZ3e6Q");
  assert.equal(YFF.videoIdFromHref("/shorts/WK-Pc0twBv0"), "WK-Pc0twBv0");
  assert.equal(YFF.videoIdFromHref("/playlist?list=RD123"), null);
  pass("YFF.videoIdFromHref: watch and shorts links, others null");
});

const settings = { ...YFF.DEFAULT_SETTINGS, allowlist: ["Good Channel"], blocklist: ["Bad Channel"], allowedLanguages: ["en"] };
const video = (extra = {}) => ({ kind: "video", videoId: "abcdefghijk", title: "How the Linux kernel schedules threads",
  channel: "Some Channel", durationSeconds: 1800, viewCount: 1000, isShort: false, description: "", ...extra });

test("applyRules order and outcomes", () => {
  assert.deepEqual(YFF.applyRules(video({ channel: "Bad Channel" }), settings, "keep"), { state: "show", reason: "override:keep" });
  assert.deepEqual(YFF.applyRules(video({ channel: "good channel " }), settings, null), { state: "show", reason: "rule:allowlist" });
  assert.deepEqual(YFF.applyRules(video({ channel: "Bad Channel" }), settings, null), { state: "hide", reason: "rule:blocklist" });
  assert.equal(YFF.applyRules(video({ kind: "short", isShort: true, durationSeconds: null }), settings, null).reason, "rule:shorts");
  assert.equal(YFF.applyRules(video({ kind: "short", isShort: true }), { ...settings, hideShorts: false }, null), null);
  assert.equal(YFF.applyRules(video({ kind: "playlist", videoId: null }), settings, null).reason, "rule:non-video:playlist");
  assert.equal(YFF.applyRules(video({ durationSeconds: 60 }), settings, null), null, "duration is judged after scoring");
  assert.equal(YFF.applyRules(video({ title: "Cómo hacer pan casero sin horno y con muy pocos ingredientes" }), settings, null).reason, "rule:language:es");
  assert.equal(YFF.applyRules(video(), settings, null), null);
  assert.deepEqual(YFF.applyRules(video(), settings, "hide"), { state: "hide", reason: "override:hide" });
  pass("YFF.applyRules: override > allowlist > blocklist > Shorts > non-video > language > model");
});

test("applyRules language rule is configurable, not English-only", () => {
  const es = video({ title: "Cómo hacer pan casero sin horno y con muy pocos ingredientes" });
  assert.equal(YFF.applyRules(es, { ...settings, allowedLanguages: ["en", "es"] }, null), null);
  assert.equal(YFF.applyRules(es, { ...settings, allowedLanguages: [] }, null), null);
  pass("YFF.applyRules: allowed-language list is user-set; empty list disables the rule");
});

test("decideScored applies the best goal's minimum duration", () => {
  const s = { ...YFF.DEFAULT_SETTINGS, goals: TEST_GOALS };
  assert.deepEqual(YFF.decideScored(video({ durationSeconds: 7 * 60 }), s, 0.9, "G1"),
    { state: "hide", reason: "rule:min-duration:G1:8m p=0.90" });
  assert.deepEqual(YFF.decideScored(video({ durationSeconds: 8 * 60 }), s, 0.9, "G1"), { state: "show", reason: "show p=0.90 G1" });
  assert.deepEqual(YFF.decideScored(video({ durationSeconds: 3 * 60 }), s, 0.9, "G5"), { state: "show", reason: "show p=0.90 G5" });
  assert.equal(YFF.decideScored(video({ durationSeconds: 3 * 60 }), s, 0.5, "G4").reason, "rule:min-duration:G4:8m p=0.50");
  assert.equal(YFF.decideScored(video({ durationSeconds: 3 * 60 }), s, 0.05, "G2").reason, "hide p=0.05 G2");
  assert.equal(YFF.decideScored(video({ durationSeconds: null }), s, 0.9, "G3").state, "show", "unknown duration passes");
  pass("YFF.decideScored: 8 min for G1-G4, none for G5, applied to the goal with the highest p");
});

test("default settings preset no goals and need setup", () => {
  const s = YFF.DEFAULT_SETTINGS;
  assert.deepEqual(s.goals, []);
  assert.deepEqual(s.allowedLanguages, []);
  assert.equal(s.hideShorts, true);
  assert.deepEqual([s.showThreshold, s.hideThreshold], [0.8, 0.1]);
  assert.equal(YFF.activeGoals({ goals: [{ id: "A", text: " " }, { id: "B", text: "x" }] }).length, 1);
  assert.equal(YFF.setupComplete(s), false, "no key, no goal");
  assert.equal(YFF.setupComplete({ ...s, jevKey: "k" }), false, "key but no goal");
  assert.equal(YFF.setupComplete({ ...s, goals: [YFF.EXAMPLE_GOALS[0]] }), false, "goal but no key");
  assert.equal(YFF.setupComplete({ ...s, jevKey: "k", goals: [YFF.EXAMPLE_GOALS[0]] }), true);
  assert.equal(YFF.setupComplete({ ...s, proxySecret: "x", goals: [YFF.EXAMPLE_GOALS[0]] }), false, "a proxy secret is not a key");
  assert.equal(YFF.setupComplete({ ...s, jevKey: "k", goals: [{ ...YFF.EXAMPLE_GOALS[0], off: true }] }), false, "goal switched off");
  pass("YFF.DEFAULT_SETTINGS / YFF.setupComplete: no preset goals or languages; ready only with a key and an active goal");
});

test("migrateSettings moves only the old default hide threshold", () => {
  assert.equal(YFF.migrateSettings({ hideThreshold: 0.2, showThreshold: 0.65 }).hideThreshold, 0.1);
  assert.equal(YFF.migrateSettings({ hideThreshold: 0.2, showThreshold: 0.65 }).showThreshold, 0.65);
  assert.equal(YFF.migrateSettings({ hideThreshold: 0.3 }).hideThreshold, 0.3, "a user's own value is kept");
  assert.equal(YFF.migrateSettings({ hideThreshold: 0.2, settingsVersion: 2 }).hideThreshold, 0.2, "chosen after migration");
  assert.equal(YFF.migrateSettings(undefined).hideThreshold, 0.1);
  pass("YFF.migrateSettings: saved 0.2 from version 1 becomes 0.1; other values and version-2 choices are kept");
});

test("detectLanguage separates Urdu from Arabic and Persian", () => {
  assert.equal(YFF.detectLanguage("علامہ اقبال کا کلام اور اس کی تشریح").lang, "ur");
  assert.equal(YFF.detectLanguage("غالب کی غزلیں نصرت فتح علی خان").lang, "ur");
  assert.equal(YFF.detectLanguage("كيف تتعلم البرمجة في المنزل").lang, "ar");
  assert.equal(YFF.detectLanguage("کلام اقبال").lang, null, "no Urdu-only letter: left to the model");
  assert.equal(YFF.detectLanguage("ਪੰਜਾਬੀ ਕਵਿਤਾ ਅਤੇ ਸੰਗੀਤ").lang, "pa");
  assert.equal(YFF.detectLanguage("Ghalib ki ghazal aur uska matlab kya hai").lang, "hi-Latn");
  const allowed = { ...YFF.DEFAULT_SETTINGS, allowedLanguages: ["en", "ur", "pa", "hi"] };
  assert.equal(YFF.applyRules(video({ title: "علامہ اقبال کا کلام اور اس کی تشریح" }), allowed, null), null);
  assert.equal(YFF.applyRules(video({ title: "Ghalib ki ghazal aur uska matlab kya hai" }), allowed, null), null);
  assert.equal(YFF.applyRules(video({ title: "كيف تتعلم البرمجة في المنزل" }), allowed, null).reason, "rule:language:ar");
  pass("YFF.detectLanguage / YFF.applyRules: Urdu, Gurmukhi and romanised Urdu/Hindi pass; Arabic is hidden");
});

test("band edges", () => {
  assert.equal(YFF.band(0.81, 0.8, 0.2), "show");
  assert.equal(YFF.band(0.8, 0.8, 0.2), "uncertain");
  assert.equal(YFF.band(0.2, 0.8, 0.2), "uncertain");
  assert.equal(YFF.band(0.19, 0.8, 0.2), "hide");
  pass("YFF.band: > show is show, < hide is hide, edges uncertain");
});

test("detectLanguage basics", () => {
  assert.equal(YFF.detectLanguage("高校数学からはじめる深層学習入門").lang, "ja");
  assert.equal(YFF.detectLanguage("हिंदी समाचार आज की बड़ी खबरें").lang, "hi");
  assert.equal(YFF.detectLanguage("Die Spätantike im Überblick und die Geschichte der Stadt").lang, "de");
  assert.equal(YFF.detectLanguage("How to cook lentils: the easy way for the whole week").lang, "en");
  assert.equal(YFF.detectLanguage("Raft").lang, null, "too little evidence gives null");
  pass("YFF.detectLanguage: scripts and stopwords; short titles give null (no rule fires)");
});

test("core.main.js is an up-to-date copy of core.js", () => {
  const dir = path.join(here, "../src/shared");
  const main = readFileSync(path.join(dir, "core.main.js"), "utf8");
  const core = readFileSync(path.join(dir, "core.js"), "utf8");
  assert.ok(main.endsWith(core) && main.length - core.length < 200, "run: node extension/sync_core.mjs");
  pass("extension/sync_core.mjs output: core.main.js matches core.js (MAIN-world copy)");
});

test("aggregate", () => {
  const s = { ...YFF.DEFAULT_SETTINGS, goals: TEST_GOALS, showThreshold: 0.6, hideThreshold: 0.1 };
  const [g1, , , , g5] = s.goals.map((g) => g.text);
  const ts = new Date(2026, 10, 15, 9).getTime() / 1000;
  const row = (videoId, pByGoalText, extra = {}) => ({ day: "2026-11-15", videoId, firstSeen: ts, title: videoId,
    channel: "c", durationSeconds: 1200, isShort: false, pByGoalText, sightings: 1, errors: 0, ...extra });
  const stats = { since: "2026-11-02", today: "2026-11-15", firstVerdictDay: "2026-11-14", feedback: [], rows: [
    row("high", { [g1]: 0.7, [g5]: 0.2 }),               // highlighted, G1
    row("mid", { [g1]: 0.05, [g5]: 0.3 }),               // uncertain, best goal G5
    row("low", { [g1]: 0.02 }),                          // hidden by score
    row("short", { [g1]: 0.7 }, { durationSeconds: 120 }), // G1 needs 8 min: hidden by duration
    row("failed", {}, { errors: 5 }),                    // not judged
    row("old", { "an earlier goal wording": 0.9 }),      // unknown text
    row("part", { [g1]: 0.9 }, { goalTexts: [g1, g5] }), // G5 never scored: not judged
  ] };
  const tally = { since: "2026-11-15", days: { "2026-11-15": { a: "rule:shorts", b: "rule:language:ru", c: "rule:shorts" },
    "2026-10-01": { z: "rule:shorts" } } };
  const a = YFF.aggregate(stats, tally, s);
  assert.equal(a.latestDay, "2026-11-15");
  assert.deepEqual(a.latestCounts, { offered: 7, highlighted: 2, uncertain: 1, hiddenScore: 1, hiddenDuration: 1, notJudged: 2 });
  assert.equal(a.byGoal.find((g) => g.goalId === "G5").uncertain, 1);
  assert.equal(a.byGoal.find((g) => g.goalId === "earlier").highlighted, 1);
  assert.deepEqual(a.highlighted.map((h) => h.videoId), ["old", "high"]);
  assert.equal(a.nearMisses[0].videoId, "short");
  assert.ok(a.nearMisses[0].reason.startsWith("rule:min-duration:G1"));
  assert.deepEqual(a.rules.byReason, { shorts: 2, "language:ru": 1 }, "tally days outside the range are left out");
  assert.equal(a.hours.length, 24);
  assert.equal(a.hours[9].offered, 7);
  pass("YFF.aggregate: decides at current thresholds, min-duration hide, unknown goal text, not judged (incl. partly scored), rule tally");
});

test("aggregate dedupes lists across days", () => {
  const s = { ...YFF.DEFAULT_SETTINGS, goals: TEST_GOALS, showThreshold: 0.6 };
  const t = s.goals[0].text;
  const r = (day, p) => ({ day, videoId: "same", firstSeen: 0, title: "x", channel: "", durationSeconds: 900,
    isShort: false, pByGoalText: { [t]: p }, sightings: 1, errors: 0 });
  const a = YFF.aggregate({ since: "2026-11-01", today: "2026-11-15", rows: [r("2026-11-14", 0.3), r("2026-11-15", 0.4)] }, null, s);
  assert.equal(a.days.length, 2);
  assert.equal(a.nearMisses.length, 1);
  assert.equal(a.nearMisses[0].p, 0.4);
  pass("YFF.aggregate: counted once per day, listed once at its highest p");
});

test("splitGoal and joinGoal round-trip the example goals", () => {
  for (const g of YFF.EXAMPLE_GOALS) {
    const { want, nots } = YFF.splitGoal(g.text);
    assert.ok(nots.length >= 3, `${g.id} has its Not: list`);
    assert.equal(YFF.joinGoal(want, nots), g.text, `${g.id} round-trips byte for byte`);
  }
  assert.deepEqual(YFF.splitGoal("Only this."), { want: "Only this.", nots: [] });
  assert.equal(YFF.joinGoal("Only this.", []), "Only this.");
  assert.equal(YFF.joinGoal("A.", ["x"]), "A. Not: x.");
  assert.deepEqual(YFF.splitGoal(YFF.joinGoal("A.", ["x", "y"])).nots, ["x", "y"]);
  pass(`YFF.splitGoal/YFF.joinGoal: all ${YFF.EXAMPLE_GOALS.length} example goals round-trip exactly; 0, 1 and 2 tags too`);
});

test("activeGoals skips goals switched off", () => {
  const goals = [{ id: "G1", text: "a" }, { id: "G2", text: "b", off: true }, { id: "G3", text: " " }];
  assert.deepEqual(YFF.activeGoals({ goals }).map((g) => g.id), ["G1"]);
  pass("YFF.activeGoals: off and empty goals are not scored");
});

test("describe turns reason strings into plain words", () => {
  const goals = TEST_GOALS;
  assert.deepEqual(YFF.describe("show p=0.86 G1", goals), { label: "On goal", p: 0.86, match: "86% match", goal: "Cooking" });
  assert.equal(YFF.describe("uncertain p=0.40 G4", goals).label, "Maybe");
  assert.equal(YFF.describe("hide p=0.02 G2", goals).detail, "best match 2%");
  const d = YFF.describe("rule:min-duration:G1:8m p=0.40", goals);
  assert.deepEqual([d.label, d.detail, d.goal], ["Too short", "under 8 min", "Cooking"]);
  assert.equal(YFF.describe("rule:shorts").detail, "Short");
  assert.equal(YFF.describe("rule:language:es").detail, "Spanish");
  assert.equal(YFF.describe("rule:non-video:playlist").detail, "Playlist");
  assert.equal(YFF.describe("override:keep").label, "Kept");
  assert.equal(YFF.describe("show p=0.90 earlier", goals).goal, "An earlier goal");
  assert.equal(YFF.describe("filter offline: timeout").label, "Couldn't check");
  pass("YFF.describe: scored, too-short, rule, override and error reasons");
});

test("insights states facts from the aggregate", () => {
  const goals = TEST_GOALS;
  const agg = {
    byGoal: [
      { goalId: "G1", offered: 10, highlighted: 2, uncertain: 3, maxP: 0.9 },
      { goalId: "G4", offered: 8, highlighted: 0, uncertain: 1, maxP: 0.74 },
      { goalId: "G5", offered: 0, highlighted: 0, uncertain: 0, maxP: null },
    ],
    nearMisses: [{ p: 0.77 }, { p: 0.71 }],
  };
  const texts = YFF.insights(agg, goals).map((i) => i.text);
  assert.deepEqual(texts, [
    "History: 8 offered, none on goal. The best scored 74%.",
    "The top 2 near misses scored 71% to 77%.",
    "Cooking let through the most (50%), History the least (13%).",
  ]);
  assert.ok(!texts.join(" ").match(/threshold|should|try/i), "no advice");
  pass("YFF.insights: no-hit goals, near-miss range, highest and lowest share; no advice");
});

test("migrateSettings version 3 leaves goals as saved", () => {
  const v2 = { settingsVersion: 2, goals: [{ id: "G1", text: "mine" }, { id: "G4", name: "Mine", text: "x" }] };
  const s = YFF.migrateSettings(v2);
  assert.equal(s.settingsVersion, 5);
  assert.deepEqual(s.goals, v2.goals, "names and text untouched");
  pass("YFF.migrateSettings: v3 changes no saved goal");
});

test("driftShare counts only Jev-scored cards", () => {
  const reasons = ["show p=0.90 G1", "uncertain p=0.50 G2", "hide p=0.02 G3", "hide p=0.05 G1",
    "rule:shorts", "rule:min-duration:G1:8m p=0.85", "override:keep", "not judged: timeout", "", undefined];
  assert.deepEqual(YFF.driftShare(reasons), { scored: 4, rejected: 2, fit: 2, percent: 50 });
  assert.deepEqual(YFF.driftShare([]), { scored: 0, rejected: 0, fit: 0, percent: 0 });
  pass("YFF.driftShare: rule hides, min-duration, overrides and failures left out; fit + rejected = scored");
});

test("driftOn needs 20 scored, triggers at the threshold and holds until 5 points below", () => {
  const share = (scored, rejected) => ({ scored, rejected, fit: scored - rejected, percent: (100 * rejected) / scored });
  assert.equal(YFF.driftOn(false, share(19, 19), 80), false, "under 20 scored");
  assert.equal(YFF.driftOn(false, share(20, 16), 80), true, "exactly 80%");
  assert.equal(YFF.driftOn(false, share(100, 79), 80), false, "79% while off");
  assert.equal(YFF.driftOn(true, share(100, 79), 80), true, "79% while on stays on");
  assert.equal(YFF.driftOn(true, share(100, 76), 80), true, "76% while on stays on");
  assert.equal(YFF.driftOn(true, share(100, 75), 80), false, "75% turns off");
  assert.equal(YFF.driftOn(true, share(100, 100), 0), false, "0 turns the notice off");
  assert.equal(YFF.migrateSettings(undefined).driftPercent, 80);
  assert.equal(YFF.migrateSettings({ settingsVersion: 3 }).driftPercent, 80, "saved settings get the default");
  pass("YFF.driftOn: 20-card minimum, on at the threshold, off 5 points below, 0 disables; default 80");
});

test("formatVideo produces the evaluated request text byte for byte", () => {
  const cases = JSON.parse(readFileSync(path.join(here, "format_video_fixture.json"), "utf8"));
  for (const c of cases) assert.equal(YFF.formatVideo(c.video), c.text, c.video.videoId);
  assert.equal(YFF.formatVideo({ title: "t", channel: "c", durationSeconds: null, viewCount: 1250000, isShort: false }),
    "Title: t\nChannel: c\nDuration: unknown (video)\nViews: 1.2M", "exact tie rounds to even, as Python does");
  pass(`YFF.formatVideo: identical to the pinned text on ${cases.length} fixture cases, including x.x5 ties`);
});

test("videoPayload holds exactly the fields that leave the browser", () => {
  const meta = { videoId: "abcdefghijk", title: "T", channel: "C", durationSeconds: 90, viewCount: 5, isShort: 1, description: "d",
    kind: "video", contentId: "x", source: "data", badges: ["LIVE"], lang: "en" };
  assert.deepEqual(YFF.videoPayload(meta),
    { videoId: "abcdefghijk", title: "T", channel: "C", durationSeconds: 90, viewCount: 5, isShort: true, description: "d" });
  assert.deepEqual(YFF.videoPayload({ videoId: "abcdefghijk" }),
    { videoId: "abcdefghijk", title: "", channel: "", durationSeconds: null, viewCount: null, isShort: false, description: "" });
  pass("YFF.videoPayload: seven named fields and nothing else from the card; missing ones become empty or null");
});

test("goalsKey changes with a goal's id or text, and cardKey and tallyId name a card", () => {
  const a = [{ id: "g1", text: "Cooking" }, { id: "g2", text: "Finance" }];
  assert.equal(YFF.goalsKey(a), YFF.goalsKey([{ id: "g1", text: "Cooking", name: "renamed" }, { id: "g2", text: "Finance" }]), "only id and text count");
  assert.notEqual(YFF.goalsKey(a), YFF.goalsKey([{ id: "g1", text: "Cooking." }, a[1]]), "edited text");
  assert.notEqual(YFF.goalsKey(a), YFF.goalsKey([a[0]]), "goal turned off");
  assert.equal(YFF.goalsKey([{ id: "g", text: "Learn Rust" }]), "1mtcfcq");
  assert.equal(YFF.cardKey({ videoId: "abcdefghijk", contentId: "c", kind: "video", title: "t" }), "abcdefghijk");
  assert.equal(YFF.cardKey({ videoId: null, contentId: "PL1", kind: "playlist" }), "PL1");
  assert.equal(YFF.cardKey({ videoId: null, kind: "ad" }), "ad:");
  assert.equal(YFF.tallyId({ videoId: null, kind: "ad", title: "x".repeat(200) }, "e1").length, 120);
  assert.equal(YFF.tallyId({ videoId: null, kind: "ad" }, "e1"), "ad:e1");
  assert.notEqual(YFF.tallyId({ videoId: null, kind: "ad" }, "e1"), YFF.tallyId({ videoId: null, kind: "ad" }, "e2"), "two untitled ads count as two");
  pass("YFF.goalsKey, cardKey, tallyId: goal edits change the key; ads without a title are tallied per card element");
});

test("profileItems and topicsFromReply turn the log into a numbered list and the reply into topics", () => {
  const rows = [
    { day: "2026-11-10", videoId: "a", title: "A  title", channel: "Ch A" },
    { day: "2026-11-12", videoId: "a", title: "A  title", channel: "Ch A" },
    { day: "2026-11-11", videoId: "b", title: "B title", channel: "" },
    { day: "2026-11-11", videoId: "x", title: "", channel: "no title" },
  ];
  const items = YFF.profileItems(rows, [{ day: "2026-11-13", videoId: "w", title: "Watched", channel: "Ch W" }]);
  assert.deepEqual(items.map((v) => [v.videoId, v.day]), [["w", "2026-11-13"], ["a", "2026-11-12"], ["b", "2026-11-11"]]);
  assert.deepEqual(YFF.profileLines(items), ["1. Watched | Ch W", "2. A title | Ch A", "3. B title | "]);
  const many = Array.from({ length: YFF.PROFILE.maxItems + 50 }, (_, i) => ({ day: "2026-11-01", videoId: `v${i}`, title: "t", channel: "c" }));
  assert.equal(YFF.profileItems(many, []).length, YFF.PROFILE.maxItems);
  const reply = JSON.stringify({ topics: [{ name: " Cooking ", sentence: "Recipes.", items: [2, 3, 99, 2] }, { name: "Games", sentence: "", items: [3, 1] }, { name: "", items: [1] }] });
  assert.deepEqual(YFF.topicsFromReply(reply, items), [
    { name: "Cooking", sentence: "Recipes.", videoIds: ["a", "b"] }, { name: "Games", sentence: "", videoIds: ["w"] }]);
  assert.throws(() => YFF.topicsFromReply("not json", items), /not JSON/);
  assert.throws(() => YFF.topicsFromReply('{"topics":[{"name":"x","items":[99]}]}', items), /no usable topics/);
  pass("YFF.profileItems / topicsFromReply: one line per video, newest first, capped; numbers out of range or reused are dropped, a bad reply throws");
});

test("feedProfile counts share, change, coverage and watched videos per topic", () => {
  const settings = YFF.migrateSettings({ goals: [{ id: "g", name: "Cooking", text: "Cooking", minDurationMinutes: 0 }], showThreshold: 0.8, hideThreshold: 0.1 });
  const today = "2026-11-28";
  const day = (n) => { const d = new Date(2026, 10, 28 - n); return YFF.localDay(d); };
  const rows = [];
  const add = (prefix, count, daysBack, p) => { for (let i = 0; i < count; i++) rows.push({ day: day(daysBack[i % daysBack.length]), videoId: `${prefix}${daysBack[0]}_${i}`,
    title: "t", channel: "c", durationSeconds: 600, pByGoalText: { Cooking: p }, goalTexts: ["Cooking"], firstSeen: 0 }); };
  add("cook", 10, [0, 1, 2], 0.9); add("game", 30, [0, 1, 2], 0.02); add("misc", 10, [0], 0.05); // this week: 50 videos
  add("cook", 30, [22, 23, 24], 0.9); add("game", 5, [22, 23, 24], 0.02); add("misc", 15, [22], 0.05); // four weeks ago: 50 videos
  const ids = (prefix) => rows.filter((r) => r.videoId.startsWith(prefix)).map((r) => r.videoId);
  const result = { day: today, oldestDay: day(27), topics: [
    { name: "Home cooking", sentence: "Recipes.", videoIds: ids("cook") }, { name: "Gaming", sentence: "Playthroughs.", videoIds: [...ids("game"), "w1", "w2"] },
    { name: "One day only", sentence: "", videoIds: ids("misc0") }] };
  const watched = [{ day: day(1), videoId: "w1" }, { day: day(2), videoId: "w2" }, { day: day(2), videoId: "w2" }, { day: day(3), videoId: "elsewhere" }];
  const p = YFF.feedProfile({ rows, watched, result, settings, today });
  assert.deepEqual(p.topics.map((t) => [t.name, t.share, t.change, t.covered, t.goalId, t.watched, t.fading]), [
    ["Gaming", 60, 50, false, null, 2, false], ["Home cooking", 20, -40, true, "g", 0, true]]);
  assert.equal(p.other, 20, "a topic seen on one day is not listed and counts as Other");
  assert.equal(p.headline, "60% of your feed this week is Gaming, and no goal covers it.");
  // A decided topic leaves the list and the headline; its share is reported apart from Other.
  const ruled = YFF.feedProfile({ rows, watched, result, settings, today, decided: ["Gaming", "Home cooking"] });
  assert.deepEqual(ruled.topics.map((t) => t.name), ["Home cooking"], "a covered topic stays listed even if decided");
  assert.deepEqual([ruled.decidedShare, ruled.other], [60, 20]);
  assert.equal(ruled.headline, "Every main topic in your feed this week is covered by a goal.");
  const gamesOnly = { ...result, topics: [result.topics[1]] };
  assert.equal(YFF.feedProfile({ rows, watched, result: gamesOnly, settings, today, decided: ["Gaming"] }).headline, "You have decided on every main topic in this week's feed.");
  assert.equal(YFF.feedProfile({ rows, watched, result: { ...result, oldestDay: day(10) }, settings, today }).topics[0].change, null, "older week not sent in full");
  assert.equal(YFF.feedProfile({ rows, watched, result: null, settings, today }), null);
  // "Not for me" rewrites every goal's text; rows scored with the old text still count for the goal.
  const tagged = { ...settings, goals: YFF.goalsExcluding(settings.goals, "Gaming") };
  assert.equal(tagged.goals[0].text, "Cooking Not: gaming.");
  assert.deepEqual(YFF.feedProfile({ rows, watched, result, settings: tagged, today }).topics.map((t) => [t.name, t.covered, t.goalId]),
    [["Gaming", false, null], ["Home cooking", true, "g"]], "a new But not tag does not uncover a topic");
  // A reworded goal no longer matches its old rows, but what was let through still counts as covered.
  const reworded = { ...settings, goals: [{ ...settings.goals[0], text: "Recipes and technique" }] };
  assert.deepEqual(YFF.feedProfile({ rows, watched, result, settings: reworded, today }).topics.map((t) => [t.name, t.covered, t.goalId]),
    [["Gaming", false, null], ["Home cooking", true, null]]);
  // A log that is two days old cannot show a topic on three days, so two days are enough.
  const young = rows.filter((r) => r.day >= day(1));
  assert.deepEqual(YFF.feedProfile({ rows: young, watched: [], result, settings, today }).topics.map((t) => [t.name, t.days]), [["Gaming", 2], ["Home cooking", 2]]);
  assert.equal(YFF.feedProfile({ rows: young, watched: [], result: { ...result, topics: [result.topics[2]] }, settings, today }).headline, "No topic stands out in this week's feed yet.");
  const covered = YFF.feedProfile({ rows: rows.filter((r) => r.videoId.startsWith("cook")), watched: [], result, settings, today });
  assert.equal(covered.headline, "Every main topic in your feed this week is covered by a goal.");
  pass("YFF.feedProfile: share of this week's videos, change against the same week four weeks ago, covered when half were let through, watched counted once per video");
});

test("goalsExcluding adds a topic to the But not tags of every goal that is on", () => {
  const goals = [{ id: "a", text: "Cooking. Not: mukbang, or drama." }, { id: "b", text: "Coding" }, { id: "c", text: "Music", off: true }];
  const out = YFF.goalsExcluding(goals, "Gaming, Walkthroughs.");
  assert.deepEqual(out.map((g) => g.text), ["Cooking. Not: mukbang, drama, or gaming walkthroughs.", "Coding Not: gaming walkthroughs.", "Music"]);
  assert.deepEqual(YFF.splitGoal(out[0].text).nots, ["mukbang", "drama", "gaming walkthroughs"], "reads back as one tag");
  assert.deepEqual(YFF.goalsExcluding(out, "gaming walkthroughs"), out, "adding it twice changes nothing");
  pass("YFF.goalsExcluding: one tag per topic on each active goal, commas removed, goals that are off untouched");
});

test("draftGoal builds the first-run goal from two answers", () => {
  const d = YFF.draftGoal("Learning to program. Tutorials with real code", "tech drama, salary reveals,\nreaction videos.");
  assert.equal(d.name, "Learning to program");
  assert.equal(d.text, "Learning to program. Tutorials with real code. Not: tech drama, salary reveals, or reaction videos.");
  assert.deepEqual(YFF.splitGoal(d.text), { want: "Learning to program. Tutorials with real code.", nots: ["tech drama", "salary reveals", "reaction videos"] });
  assert.deepEqual(YFF.draftGoal("  Home   cooking  ", ""), { name: "Home cooking", text: "Home cooking" }, "the second answer may be empty");
  assert.equal(YFF.draftGoal("Woodworking with hand tools: joinery and sharpening", "shop tours").text,
    "Woodworking with hand tools: joinery and sharpening. Not: shop tours.");
  assert.equal(YFF.draftGoal("A very long first answer that runs on and on past forty characters without any stop", "x").name.length <= 40, true);
  const example = YFF.EXAMPLE_GOALS[0];
  const parts = YFF.splitGoal(example.text);
  assert.equal(YFF.draftGoal(parts.want, parts.nots.join(", ")).text, example.text, "an example goal filled in and saved unchanged keeps its exact text");
  pass("YFF.draftGoal: name from the first clause, the second answer split into Not tags, and example goals round-trip");
});

test("feedScore counts the home cards for the first-run panel", () => {
  assert.deepEqual(YFF.feedScore(["show", "revealed", "uncertain", "hide", "hide", "error", "pending", undefined]),
    { onGoal: 2, maybe: 1, hidden: 2, failed: 1, pending: 2, checked: 5 });
  assert.deepEqual(YFF.feedScore([]), { onGoal: 0, maybe: 0, hidden: 0, failed: 0, pending: 0, checked: 0 });
  pass("YFF.feedScore: on goal, maybe and hidden make up the checked total; failed and pending cards stay out of it");
});

test("migrateSettings version 5 drops the proxy settings", () => {
  const proxyUser = YFF.migrateSettings({ settingsVersion: 4, scorer: "proxy", proxyUrl: "http://127.0.0.1:8787", proxySecret: "s",
    dailyCallLimit: 15000, goals: [YFF.EXAMPLE_GOALS[0]], blocklist: ["x"] });
  assert.deepEqual(["scorer", "proxyUrl", "proxySecret"].filter((k) => k in proxyUser), []);
  assert.deepEqual([proxyUser.settingsVersion, proxyUser.jevKey, proxyUser.goals.length, proxyUser.blocklist], [5, "", 1, ["x"]]);
  assert.equal(YFF.setupComplete(proxyUser), false, "no key yet: not set up");
  const direct = YFF.migrateSettings({ settingsVersion: 4, scorer: "direct", jevKey: "k", dailyCallLimit: 500, goals: [YFF.EXAMPLE_GOALS[0]] });
  assert.deepEqual([direct.jevKey, direct.dailyCallLimit, YFF.setupComplete(direct)], ["k", 500, true]);
  const fresh = YFF.migrateSettings(undefined);
  assert.deepEqual([fresh.jevKey, fresh.dailyCallLimit, fresh.settingsVersion], ["", 3000, 5]);
  pass("YFF.migrateSettings: v5 drops scorer, proxyUrl and proxySecret; a former proxy profile keeps its goals and rules and is not set up until it has a key");
});
