// Service worker: the only part of the extension that talks to a scorer or reads the Jev key
// or shared secret. Content scripts send it {type: "judge" | "feedback" | "counts" | "tally" | "stats"}.
// Two scorers answer the same messages: direct (Jev with the user's key, IndexedDB) and the
// local Python proxy. Per-tab counts live in chrome.storage.session because the worker can be
// stopped at any time.
importScripts("shared/core.js", "direct.js", "localstore.js");

const TIMEOUT_MS = 20000;

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return self.YFF.migrateSettings(settings);
}

// `unsaved` lets the options page test the values typed in its form before they are saved.
async function callProxy(path, body, method = "POST", unsaved = null) {
  const s = { ...(await getSettings()), ...(unsaved || {}) };
  if (!s.proxySecret) return { error: "no proxy secret set (open the extension options)" };
  const base = s.proxyUrl.replace(/\/+$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(base + path, {
      method,
      credentials: "omit", // never send cookies anywhere
      headers: { "Content-Type": "application/json", "X-Filter-Secret": s.proxySecret },
      body: method === "POST" ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (res.status === 401) return { error: "proxy rejected the secret" };
    if (res.status === 403) return { error: "proxy rejected this extension's origin" };
    if (!res.ok) return { error: `proxy HTTP ${res.status}` };
    return await res.json();
  } catch (err) {
    return { error: err.name === "AbortError" ? "proxy timeout" : "proxy unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

// ---- direct mode -----------------------------------------------------------------------------
const MAX_VIDEOS_PER_REQUEST = 60; // the proxy's limit
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

async function directJudgeRequest(s, body) {
  if (!s.jevKey) return { error: "no Jev key set (open the extension settings)" };
  const goals = body.goals || (body.goal ? [{ id: "goal", text: body.goal }] : []);
  if (!goals.length || !Array.isArray(body.videos) || !body.videos.length) return { error: "nothing to judge" };
  if (body.videos.length > MAX_VIDEOS_PER_REQUEST) return { error: `at most ${MAX_VIDEOS_PER_REQUEST} videos per request` };
  const show = body.show ?? 0.8;
  const hide = body.hide ?? 0.2;
  if (hide > show) return { error: "hide threshold must not exceed show threshold" };
  const out = await judgeFor(s).judgeGoals(goals, body.videos, show, hide);
  // A rejected key fails every item; report it once, so the page shows the scorer banner.
  if (out.results.length && out.results.every((r) => r.error === "bad_key")) return { error: "Jev rejected the key" };
  return out;
}

async function directHealth(s) {
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
    const cutoff = self.YFF.localDay(new Date(Date.now() - TALLY_KEEP_DAYS * 86400000));
    const old = Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith("tally:") && k.slice(6) < cutoff);
    if (old.length) await chrome.storage.local.remove(old);
  }).catch(() => {});
  return tallyChain;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const s = { ...(await getSettings()), ...(msg.type === "health" || msg.type === "testJudge" ? msg.unsaved || {} : {}) };
    const direct = s.scorer === "direct";
    switch (msg.type) {
      case "judge":
        return direct ? directJudgeRequest(s, msg.body) : callProxy("/judge", msg.body);
      case "feedback":
        return direct ? localStore.logFeedback(msg.body) : callProxy("/feedback", msg.body);
      case "health":
        return direct ? directHealth(s) : callProxy("/health", null, "GET", msg.unsaved);
      case "testJudge":
        return callProxy("/judge", msg.body, "POST", msg.unsaved);
      case "usage":
        return { callsToday: direct ? await localStore.callsToday(self.YFF.localDay(new Date())) : null, dailyCap: s.dailyCallLimit, scorer: s.scorer };
      case "tally":
        await recordTally(msg.id, msg.reason);
        return { ok: true };
      case "stats":
        return direct ? localStore.stats(Math.min(Math.max(msg.days || 14, 1), 90)) : callProxy("/stats", { days: msg.days || 14 });
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
