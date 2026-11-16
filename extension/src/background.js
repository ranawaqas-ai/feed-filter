// Service worker: the only part of the extension that reads the Jev key or calls Jev.
// Content scripts and pages send it {type: "judge" | "feedback" | "health" | "usage" | "tally" | "stats" | "counts" |
// "watched" | "profile" | "topics" | "topicsHealth"}. It also holds the Anthropic key and groups titles into topics weekly.
// Scores, the daily counter and the verdict log live in IndexedDB (localstore.js). Per-tab
// counts live in chrome.storage.session because the worker can be stopped at any time.
importScripts("shared/core.js", "direct.js", "localstore.js", "topics.js");

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return self.YFF.migrateSettings(settings);
}

const MAX_VIDEOS_PER_REQUEST = 60;
const localStore = new self.YFFLocal.IdbStore({ localDay: self.YFF.localDay });
localStore.prune().catch(() => {});
let directJudge = null;
let directKey = "";

// One judge per key and cap, so its in-flight limit holds across requests.
function judgeFor(s) {
  const key = `${s.jevKey}|${s.dailyCallLimit}`;
  if (!directJudge || directKey !== key) {
    const jev = new self.YFFDirect.JevClient({ apiKey: s.jevKey, fetch: self.fetch.bind(self) });
    directJudge = new self.YFFDirect.DirectJudge({ jev, store: localStore, formatVideo: self.YFF.formatVideo,
      localDay: self.YFF.localDay, dailyCap: s.dailyCallLimit });
    directKey = key;
  }
  return directJudge;
}

async function judgeRequest(s, body) {
  if (!s.jevKey) return { error: "no Jev key set (open the extension settings)" };
  const goals = body.goals || (body.goal ? [{ id: "goal", text: body.goal }] : []);
  if (!goals.length || !Array.isArray(body.videos) || !body.videos.length) return { error: "nothing to judge" };
  if (body.videos.length > MAX_VIDEOS_PER_REQUEST) return { error: `at most ${MAX_VIDEOS_PER_REQUEST} videos per request` };
  const out = await judgeFor(s).judgeGoals(goals, body.videos);
  const error = self.YFFDirect.requestError(out.results);
  return error ? { error } : out;
}

// `unsaved` lets the setup and settings pages test a typed key before it is saved.
async function health(s) {
  if (!s.jevKey) return { error: "no Jev key set" };
  return new self.YFFDirect.JevClient({ apiKey: s.jevKey, fetch: self.fetch.bind(self) }).check();
}

async function setCounts(tabId, counts, off) {
  if (tabId === undefined) return;
  await chrome.storage.session.set({ [`counts:${tabId}`]: { ...counts, off, at: Date.now() } });
  // A count would cover the icon; the badge only flags a paused tab or a drifting feed.
  const text = off ? "off" : counts.drift ? "!" : "";
  await chrome.action.setBadgeText({ tabId, text });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: off ? "#777" : "#E07B39" });
  if (!off && counts.drift) await chrome.action.setBadgeTextColor({ tabId, color: "#FFFFFF" });
  await chrome.action.setTitle({ tabId, title:
    `Feed filter: ${counts.shown} shown, ${counts.hidden} hidden, ${counts.uncertain} uncertain` +
    (counts.pending ? `, ${counts.pending} pending` : "") + (counts.drift ? " (feed drifting)" : "") + (off ? " (disabled in this tab)" : "") });
}

// Rule-hide tally for the dashboard: tally:<local day> = {id: reason}, in this browser only.
// Writes are chained so two cards arriving together cannot overwrite each other.
const TALLY_MAX_PER_DAY = 3000;
const TALLY_KEEP_DAYS = 90;
let tallyChain = Promise.resolve();
function recordTally(id, reason) {
  tallyChain = tallyChain.then(async () => {
    const day = self.YFF.localDay(new Date());
    const key = `tally:${day}`;
    const got = await chrome.storage.local.get([key, "tallySince"]);
    const today = got[key] || {};
    if (id in today || Object.keys(today).length >= TALLY_MAX_PER_DAY) return;
    today[id] = String(reason).slice(0, 60);
    const write = { [key]: today };
    if (!got.tallySince) write.tallySince = day;
    await chrome.storage.local.set(write);
    if (got[key]) return; // old days are pruned once, when a day's first entry is written
    const cutoff = self.YFF.localDay(new Date(Date.now() - TALLY_KEEP_DAYS * 86400000));
    const old = Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith("tally:") && k.slice(6) < cutoff);
    if (old.length) await chrome.storage.local.remove(old);
  }).catch(() => {});
  return tallyChain;
}

// ---- feed profile: titles from the local log, grouped into topics by Claude once a week ----
const TOPICS_ALARM = "topics";
const WEEK_MINUTES = 7 * 24 * 60;
const topicClient = (s) => new self.YFFTopics.TopicClient({ apiKey: s.anthropicKey, fetch: self.fetch.bind(self) });
const profileSince = () => self.YFF.localDay(new Date(Date.now() - (self.YFF.PROFILE.days - 1) * 86400000));

async function runTopics(s) {
  if (!s.anthropicKey) return { error: "no Anthropic key set" };
  const Y = self.YFF;
  const today = Y.localDay(new Date());
  const since = profileSince();
  const data = await localStore.profileData(since);
  const items = Y.profileItems(data.rows, data.watched);
  if (items.length < Y.PROFILE.minItems) return { error: `only ${items.length} videos logged so far` };
  try {
    const out = await topicClient(s).group(Y.profileLines(items), data.result ? data.result.topics.map((t) => t.name) : []);
    const topics = Y.topicsFromReply(out.text, items);
    // When the list was not cut at the cap, everything since `since` was sent.
    const oldestDay = items.length < Y.PROFILE.maxItems ? since : items[items.length - 1].day;
    await localStore.putTopics({ day: today, ranAt: Date.now(), oldestDay, sent: items.length, usage: out.usage, topics }, null);
    return { ok: true, sent: items.length, usage: out.usage };
  } catch (err) {
    const text = err.code ? self.YFFTopics.errorText(err.code) : String(err.message || err);
    await localStore.putTopics(null, { day: today, text });
    return { error: text };
  }
}

// One run at a time: the alarm and the Refresh button can ask together.
let topicsRunning = null;
function refreshTopics(s) {
  if (!topicsRunning) topicsRunning = runTopics(s).finally(() => { topicsRunning = null; });
  return topicsRunning;
}

chrome.alarms.get(TOPICS_ALARM, (alarm) => {
  if (!alarm) chrome.alarms.create(TOPICS_ALARM, { delayInMinutes: 5, periodInMinutes: WEEK_MINUTES });
});
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== TOPICS_ALARM) return;
  const s = await getSettings();
  if (!s.anthropicKey) return;
  const { result } = await localStore.profileData(profileSince());
  // The alarm can fire early after a restart; a run in the last six days is recent enough.
  if (result && Date.now() - result.ranAt < 6 * 86400000) return;
  await refreshTopics(s);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const s = { ...(await getSettings()), ...(msg.type === "health" || msg.type === "topicsHealth" ? msg.unsaved || {} : {}) };
    switch (msg.type) {
      case "judge":
        return judgeRequest(s, msg.body);
      case "feedback":
        return localStore.logFeedback(msg.body);
      case "health":
        return health(s);
      case "usage":
        return { callsToday: await localStore.callsToday(self.YFF.localDay(new Date())), dailyCap: s.dailyCallLimit };
      case "tally":
        await recordTally(msg.id, msg.reason);
        return { ok: true };
      case "stats":
        return localStore.stats(Math.min(Math.max(msg.days || 14, 1), 90));
      case "watched":
        return msg.video && self.YFF.VIDEO_ID.test(msg.video.videoId) ? localStore.logWatched(self.YFF.localDay(new Date()), msg.video) : { error: "no video" };
      case "profile":
        return { ...(await localStore.profileData(profileSince())), today: self.YFF.localDay(new Date()), hasKey: !!s.anthropicKey, running: !!topicsRunning };
      case "topics":
        return refreshTopics(s);
      case "topicsHealth":
        return s.anthropicKey ? topicClient(s).check() : { error: "no Anthropic key set" };
      case "openOptions":
        await chrome.runtime.openOptionsPage();
        return { ok: true };
      case "counts":
        await setCounts(sender.tab && sender.tab.id, msg.counts, msg.off);
        return { ok: true };
      default:
        return { error: `unknown message ${msg.type}` };
    }
  })().then(sendResponse);
  return true; // async response
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("src/setup.html") });
});

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(`counts:${tabId}`));
