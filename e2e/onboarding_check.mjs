// Live check of the first run in the test profile: the three-step setup page, then the panel
// on YouTube that reports how the home feed scores. The service worker calls Jev with
// jev_api_key from .env (about 100 calls a run, fewer when the score cache is warm).
// The empty-feed case runs in a throwaway profile and makes no calls.
// Usage: node e2e/onboarding_check.mjs   (E2E_SHOTS=<folder> also saves screenshots)
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import { createRequire } from "node:module";
import { EXT_ID, EXT_PATH, ROOT, blockJev, envValue, extensionWorker, here, launch, sleep } from "./lib.mjs";

const YFF = createRequire(import.meta.url)(path.join(ROOT, "extension/src/shared/core.js"));
const NEED = "Deep technical AI, machine learning and systems engineering lectures and talks";
const SKIP = "hype, news recaps, reaction videos";
const SHOTS = process.env.E2E_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(detail).slice(0, 400)}`);
};
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };

const panelState = (page) => page.evaluate(() => {
  const panel = document.getElementById("yff-firstrun");
  const text = (sel) => panel?.querySelector(sel)?.textContent || null;
  const live = { onGoal: 0, maybe: 0, hidden: 0 };
  for (const h of document.querySelectorAll("ytd-rich-item-renderer")) {
    const s = h.dataset.yffState;
    if (s === "show" || s === "revealed") live.onGoal += 1;
    else if (s === "uncertain") live.maybe += 1;
    else if (s === "hide") live.hidden += 1;
  }
  return { panel: !!panel, data: JSON.parse(document.documentElement.dataset.yffFirstRun || "null"), title: text(".yff-fr-title"), sub: text(".yff-fr-sub"),
    legend: panel ? [...panel.querySelectorAll(".yff-fr-legend span")].map((s) => s.textContent) : [],
    reveal: text(".yff-fr-reveal"), revealOn: document.documentElement.hasAttribute("data-yff-reveal"), live };
});

async function waitPanel(page, want, timeoutMs) {
  const seen = new Set();
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await panelState(page).catch(() => null); // the page may be mid-navigation
    if (last?.data) seen.add(last.data.state);
    if (last?.data?.state === want) break;
    await sleep(150);
  }
  return { ...last, seen: [...seen] };
}

const browser = await launch({ withExtension: true });
const worker = await extensionWorker(browser);
const before = await worker.evaluate(() => chrome.storage.local.get(["settings", "firstRun"]));

// 1. An install that is already set up and has no firstRun value never sees the panel.
await worker.evaluate(() => chrome.storage.local.remove("firstRun"));
const page = await browser.newPage();
await page.bringToFront(); // a background tab does not render YouTube's feed
if (YFF.setupComplete(before.settings)) {
  await page.goto("https://www.youtube.com/", { waitUntil: "domcontentloaded" });
  await sleep(6000);
  const quiet = await panelState(page);
  check("no first-run value: no panel on the home page", !quiet.panel && quiet.data === null, { panel: quiet.panel, live: quiet.live });
} else {
  check("no first-run value: no panel on the home page", false, { skipped: "the test profile is not set up; run node e2e/run_e2e.mjs first" });
}

// 2. The setup page, from a state with no key and no goal.
await worker.evaluate(async () => {
  const { settings } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...self.YFF.DEFAULT_SETTINGS, ...(settings || {}), goals: [], jevKey: "", dailyCallLimit: 20000 } });
});
await page.goto(`chrome-extension://${EXT_ID}/src/setup.html`, { waitUntil: "load" });
await page.waitForSelector("#welcome:not([hidden])");
const visible = () => page.evaluate(() => ["welcome", "stepGoal", "stepKey"].filter((id) => !document.getElementById(id).hidden));
const atWelcome = await visible();
await shot(page, "1_welcome");
await page.click("#start");
const atGoal = await visible();
await page.click("#toKey");
const blocked = { step: await visible(), msg: await page.$eval("#goalMsg", (e) => e.textContent) };
await page.click("#examples .chip:nth-child(3)");
const example = await page.evaluate(() => ({ need: document.getElementById("need").value, skip: document.getElementById("skip").value,
  name: document.getElementById("draftName").textContent, text: document.getElementById("draftText").textContent }));
await page.$eval("#need", (e) => { e.value = ""; });
await page.type("#need", NEED);
await page.$eval("#skip", (e) => { e.value = ""; });
await page.type("#skip", SKIP);
const draft = await page.evaluate(() => ({ name: document.getElementById("draftName").textContent, text: document.getElementById("draftText").textContent }));
await shot(page, "2_goal");
const expected = YFF.draftGoal(NEED, SKIP);
check("setup: welcome first, then a goal from two answers, with an empty first answer refused",
  atWelcome.join() === "welcome" && atGoal.join() === "stepGoal" && blocked.step.join() === "stepGoal" && !!blocked.msg &&
  example.name === YFF.EXAMPLE_GOALS[2].name && example.text === YFF.EXAMPLE_GOALS[2].text && draft.name === expected.name && draft.text === expected.text,
  { atWelcome, atGoal, blocked, exampleName: example.name, draft });

await page.click("#toKey");
const atKey = await visible();
await page.type("#jevKey", envValue("jev_api_key"));
await page.click("#testKey");
await page.waitForFunction(() => /Key works|Can't use/.test(document.getElementById("keyText").textContent), { timeout: 20000 });
const keyText = await page.$eval("#keyText", (e) => e.textContent);
await shot(page, "3_key");
await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null), page.click("#save")]);
const stored = await worker.evaluate(() => chrome.storage.local.get(["settings", "firstRun"]));
check("setup: key tested, then saving stores the goal, marks the first run pending and opens YouTube",
  atKey.join() === "stepKey" && keyText.startsWith("Key works") && stored.firstRun === "pending" && stored.settings.goals.length === 1 &&
  stored.settings.goals[0].text === expected.text && stored.settings.goals[0].name === expected.name && !!stored.settings.jevKey &&
  new URL(page.url()).hostname === "www.youtube.com",
  { atKey, keyText: keyText.slice(0, 9), firstRun: stored.firstRun, goal: stored.settings.goals[0], url: page.url() });

// 3. The panel on YouTube: counts while checking, then one frozen score.
const done = await waitPanel(page, "done", 60000);
await sleep(300);
await shot(page, "4_result");
const d = done.data || {};
check("panel: checking, then N of M with on goal + maybe + hidden = M",
  done.seen.includes("checking") && d.state === "done" && d.checked > 0 && d.onGoal + d.maybe + d.hidden === d.checked &&
  done.title === `${d.onGoal} of ${d.checked} videos serve your goal` &&
  done.legend.join("|") === `${d.onGoal} on goal|${d.maybe} maybe|${d.hidden} hidden` &&
  d.onGoal <= done.live.onGoal && d.maybe <= done.live.maybe + done.live.onGoal && d.hidden <= done.live.hidden,
  { seen: done.seen, data: d, title: done.title, sub: done.sub, legend: done.legend, live: done.live });

if (done.panel && d.state === "done") {
  for (let i = 0; i < 2; i++) { await page.evaluate(() => window.scrollBy(0, 2500)); await sleep(2500); }
  await page.evaluate(() => window.scrollTo(0, 0));
  const later = await panelState(page);
  let revealed = null, hiddenAgain = null;
  if (d.hidden) {
    await page.click("#yff-firstrun .yff-fr-reveal");
    revealed = await panelState(page);
    await shot(page, "5_revealed");
    await page.click("#yff-firstrun .yff-fr-reveal");
    hiddenAgain = await panelState(page);
  }
  const optionsOpened = browser.waitForTarget((t) => t.url().endsWith("/src/options.html"), { timeout: 10000 }).then((t) => t.page()).catch(() => null);
  await page.click("#yff-firstrun .yff-fr-adjust");
  const options = await optionsOpened;
  if (options) await options.close();
  await page.bringToFront();
  await page.evaluate(() => document.documentElement.setAttribute("dark", ""));
  await sleep(300);
  await shot(page, "6_result_dark");
  await page.evaluate(() => document.documentElement.removeAttribute("dark"));
  await page.click("#yff-firstrun .yff-fr-done");
  await sleep(500);
  const closed = await panelState(page);
  const flag = await worker.evaluate(() => chrome.storage.local.get("firstRun"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await sleep(6000);
  const reloaded = await panelState(page);
  check("panel: the score stays as taken while more cards load; See what was hidden toggles reveal; Adjust goal opens Settings",
    later.title === done.title && later.live.onGoal + later.live.maybe + later.live.hidden >= d.checked &&
    (!d.hidden || (revealed.revealOn && revealed.reveal === "Hide them again" && !hiddenAgain.revealOn && hiddenAgain.reveal === "See what was hidden")) && !!options,
    { laterTitle: later.title, laterLive: later.live, revealed: revealed && [revealed.revealOn, revealed.reveal], hiddenAgain: hiddenAgain && [hiddenAgain.revealOn, hiddenAgain.reveal], options: !!options });
  check("panel: Done closes it and it stays closed after a reload",
    !closed.panel && flag.firstRun === "done" && !reloaded.panel, { closed: closed.panel, flag, reloaded: reloaded.panel });
} else {
  check("panel: the score stays as taken while more cards load; See what was hidden toggles reveal; Adjust goal opens Settings", false, { skipped: "no result panel" });
  check("panel: Done closes it and it stays closed after a reload", false, { skipped: "no result panel" });
}

// 4. Jev unreachable: the panel says so and leaves the reason to the banner.
await worker.evaluate(async () => {
  const { settings } = await chrome.storage.local.get("settings");
  const goal = { id: "down", name: "Unreachable", text: `A goal no cache holds ${Date.now()}`, minDurationMinutes: 0 };
  await chrome.storage.local.set({ settings: { ...settings, goals: [goal] }, firstRun: "pending" });
});
await blockJev(browser, true);
await page.goto("https://www.youtube.com/", { waitUntil: "domcontentloaded" });
const down = await waitPanel(page, "down", 30000);
const banner = await page.evaluate(() => document.getElementById("yff-banner")?.innerText || null);
await shot(page, "7_down");
await blockJev(browser, false);
check("panel: with Jev unreachable it says the feed could not be checked",
  down.data?.state === "down" && down.title === "Could not check your feed" && !!banner, { data: down.data, title: down.title, banner });

await worker.evaluate(async (was) => {
  if (was.settings) await chrome.storage.local.set({ settings: was.settings });
  if (was.firstRun) await chrome.storage.local.set({ firstRun: was.firstRun });
  else await chrome.storage.local.remove("firstRun");
}, before);
await browser.close();

// 5. Empty home feed: a new logged-out profile has no feed, so there is nothing to score.
const freshDir = path.join(here, "profile", "onboarding-fresh");
rmSync(freshDir, { recursive: true, force: true });
const fresh = await puppeteer.launch({ headless: false, userDataDir: freshDir, defaultViewport: { width: 1440, height: 1000 },
  enableExtensions: [EXT_PATH], args: ["--window-size=1460,1100"] });
const freshWorker = await (await fresh.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/src/background.js"), { timeout: 20000 })).worker();
const opened = await fresh.waitForTarget((t) => t.url().endsWith("/src/setup.html"), { timeout: 10000 }).then(() => true).catch(() => false);
await freshWorker.evaluate(async () => {
  const goal = { id: "g", name: "Anything", text: "Anything at all", minDurationMinutes: 0 };
  await chrome.storage.local.set({ settings: { ...self.YFF.DEFAULT_SETTINGS, jevKey: "not-a-real-key", goals: [goal] }, firstRun: "pending" });
});
const emptyPage = await fresh.newPage();
await emptyPage.bringToFront();
await emptyPage.goto("https://www.youtube.com/", { waitUntil: "domcontentloaded" });
const empty = await waitPanel(emptyPage, "empty", 20000);
if (SHOTS) await emptyPage.screenshot({ path: path.join(SHOTS, "8_empty.png") });
const cards = await emptyPage.evaluate(() => document.querySelectorAll("ytd-rich-item-renderer").length);
check("fresh profile: install opens the setup page, and an empty home feed gets Nothing to check yet",
  opened && cards === 0 && empty.data?.state === "empty" && empty.title === "Nothing to check yet", { opened, cards, data: empty.data, title: empty.title });
await fresh.close();
rmSync(freshDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).map((r) => r.name);
console.log(`onboarding_check: ${results.length - failed.length} passed, ${failed.length} failed${failed.length ? ` (${failed.join("; ")})` : ""}`);
process.exit(failed.length ? 1 : 0);
