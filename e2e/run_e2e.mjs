// End-to-end verification of the unpacked extension on youtube.com, in the separate
// Chrome for Testing profile (logged out, seeded by seed_profile.mjs). The service worker
// calls Jev with jev_api_key from .env (about 1,000 calls a run), and verdicts go to the test
// profile's IndexedDB. The "scorer unreachable" step blocks the worker's requests to Jev.
// Writes results/e2e_report.json.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { EXT_ID, ROOT, blockJev, envValue, extensionWorker, launch, pct, setSettings, sleep } from "./lib.mjs";

const GOAL = "Deep technical AI/ML and systems engineering content, no hype or news recaps";
const NOTHING_GOAL = "Competitive underwater basket weaving taught entirely in Old Norse";
const HOSTS = "ytd-rich-item-renderer, ytd-watch-next-secondary-results-renderer yt-lockup-view-model";
const TIMING_LOADS = 10;
const report = { startedAt: new Date().toISOString(), checks: {} };
const check = (name, ok, detail) => {
  report.checks[name] = { ...detail, ok }; // ok last: a detail object may carry its own ok
  console.log(`${ok === "inconclusive" ? "INCONCLUSIVE" : ok ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(detail).slice(0, 360)}`);
};

// Runs in the page's MAIN world from document start. Records when each card is inserted and,
// on every animation frame and mutation, flags (a) any video link readable while its card has
// no readable verdict (show, uncertain, revealed), and (b) any readable card whose link is not
// the video that was judged.
function flashMonitor(hosts) {
  const state = { frames: 0, checks: 0, violations: [], stale: [], inserted: 0 };
  window.__yffE2E = state;
  const sel = "a[href^='/watch?v='], a[href^='/shorts/']";
  const scope = "ytd-browse[page-subtype='home'], #secondary, ytd-watch-next-secondary-results-renderer";
  const vidOf = (href) => { const m = /[?&]v=([A-Za-z0-9_-]{11})/.exec(href) || /\/shorts\/([A-Za-z0-9_-]{11})/.exec(href); return m && m[1]; };
  function blurredOrHidden(host, link) {
    if (getComputedStyle(host).display === "none") return true;
    let target = host.matches("ytd-rich-item-renderer") ? host.querySelector(":scope > #content") : null;
    if (!target) for (let n = link; n && n.parentElement; n = n.parentElement) if (n.parentElement === host) { target = n; break; }
    return !!target && getComputedStyle(target).filter.includes("blur");
  }
  function sweep(origin) {
    if (document.documentElement.hasAttribute("data-yff-off")) return;
    for (const a of document.querySelectorAll(sel)) {
      if (!a.closest(scope)) continue;
      const r = a.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      state.checks += 1;
      const host = a.closest(hosts);
      const href = a.getAttribute("href");
      if (!host) {
        if (state.violations.length < 50) {
          const chain = [];
          for (let n = a.parentElement; n && chain.length < 10; n = n.parentElement) chain.push(n.tagName.toLowerCase() + (n.id ? `#${n.id}` : ""));
          const onScreen = r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
          state.violations.push({ origin, why: "link outside any known card", href, t: performance.now(), onScreen,
            rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], chain });
        }
        continue;
      }
      const s = host.dataset.yffState;
      if (s === "show" || s === "revealed" || s === "uncertain") {
        const vid = vidOf(href);
        if (vid && /^[A-Za-z0-9_-]{11}$/.test(host.dataset.yffKey || "") && vid !== host.dataset.yffKey && state.stale.length < 50) {
          state.stale.push({ origin, judged: host.dataset.yffKey, visible: vid, state: s, t: performance.now() });
        }
        continue;
      }
      if (!blurredOrHidden(host, a) && state.violations.length < 50) {
        state.violations.push({ origin, why: "readable before a verdict", state: s || "none", href, t: performance.now() });
      }
    }
  }
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType === 1 && n.matches && n.matches(hosts) && !n.dataset.e2eInserted) {
        n.dataset.e2eInserted = String(performance.now());
        state.inserted += 1;
      }
    }
    sweep("mutation");
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["href", "data-yff-state"] });
  const loop = () => { state.frames += 1; sweep("frame"); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
}

async function waitSettled(page, timeoutMs = 45000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await page.evaluate(() => JSON.parse(document.documentElement.dataset.yffCounts || "null"));
    if (last && last.pending === 0 && last.shown + last.hidden + last.uncertain > 0) return last;
    await sleep(500);
  }
  return last;
}

// Cards on the currently shown page only (YouTube keeps hidden pages in the DOM).
async function cardSnapshot(page) {
  return page.evaluate((hosts) => [...document.querySelectorAll(hosts)].filter((h) => {
    const p = h.closest("ytd-page-manager > *");
    return !p || !p.hasAttribute("hidden");
  }).map((h) => {
    let meta = null;
    try { meta = JSON.parse(h.getAttribute("data-yff-meta") || "null"); } catch (e) { meta = null; }
    return { key: h.dataset.yffKey, metaId: meta && (meta.videoId || meta.contentId), kind: meta && meta.kind,
      state: h.dataset.yffState || null, reason: h.dataset.yffReason || null, source: h.dataset.yffSource || null,
      tInserted: Number(h.dataset.e2eInserted || NaN), tApplied: Number(h.dataset.yffTApplied || NaN),
      sidebar: !h.matches("ytd-rich-item-renderer"), title: meta && meta.title };
  }), HOSTS);
}

const tally = (cards) => cards.reduce((a, c) => ((a[c.state] = (a[c.state] || 0) + 1), a), {});
const delays = (cards, sources) => cards.filter((c) => sources.includes(c.source) && Number.isFinite(c.tApplied) &&
  Number.isFinite(c.tInserted)).map((c) => c.tApplied - c.tInserted);

async function badgeAndCounts(browser, page) {
  const worker = await extensionWorker(browser);
  const badge = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return { text: await chrome.action.getBadgeText({ tabId: tab.id }), title: await chrome.action.getTitle({ tabId: tab.id }) };
  });
  const dom = await page.evaluate(() => JSON.parse(document.documentElement.dataset.yffCounts));
  const cards = await cardSnapshot(page);
  const recount = { shown: 0, hidden: 0, uncertain: 0 };
  for (const c of cards) {
    if (c.state === "show" || c.state === "revealed") recount.shown += 1;
    else if (c.state === "hide") recount.hidden += 1;
    else if (c.state === "uncertain" || c.state === "error") recount.uncertain += 1;
  }
  // The badge flags only a drifting feed; counts live in the tooltip and the popup.
  const ok = badge.text === (dom.drift ? "!" : "") && recount.shown === dom.shown && recount.hidden === dom.hidden &&
    recount.uncertain === dom.uncertain && badge.title.includes(`${dom.shown} shown, ${dom.hidden} hidden, ${dom.uncertain} uncertain`);
  return { ok, badge, dom, recount };
}

const browser = await launch({ withExtension: true });
const page = await browser.newPage();
await page.evaluateOnNewDocument(flashMonitor, HOSTS);
await extensionWorker(browser);
const baseSettings = { goals: [{ id: "e2e", text: GOAL, minDurationMinutes: 0 }],
  jevKey: envValue("jev_api_key"), dailyCallLimit: 20000, autoLoadCap: 3,
  hideShorts: true, hideNonVideo: true, allowedLanguages: [], blocklist: [], allowlist: [], showThreshold: 0.8, hideThreshold: 0.1 };

// 0. Before setup (no key, no goal): YouTube is left alone; saving settings starts filtering
// in the open tab without a reload.
await setSettings(browser, { goals: [], jevKey: "" });
const fresh = await browser.newPage();
await fresh.goto("https://www.youtube.com/", { waitUntil: "domcontentloaded" });
await sleep(6000);
const unset = await fresh.evaluate(() => ({ setup: document.documentElement.dataset.yffSetup || null,
  cards: document.querySelectorAll("ytd-rich-item-renderer").length, decided: document.querySelectorAll("[data-yff-state]").length,
  blurred: [...document.querySelectorAll("ytd-rich-item-renderer > #content")].filter((c) => getComputedStyle(c).filter.includes("blur")).length }));
await setSettings(browser, baseSettings);
await waitSettled(fresh);
const started = await fresh.evaluate(() => ({ setup: document.documentElement.dataset.yffSetup || null,
  decided: document.querySelectorAll("ytd-rich-item-renderer[data-yff-state]").length }));
check("first run: nothing blurred or sent before setup; filtering starts when settings save",
  unset.setup === "needed" && unset.cards > 0 && unset.decided === 0 && unset.blurred === 0 && started.setup === null && started.decided > 0,
  { before: unset, after: started });
await fresh.close();

// 1. Home feed: every card judged, nothing readable early.
await page.bringToFront(); // a background tab does not render YouTube's feed
await page.goto("https://www.youtube.com/", { waitUntil: "domcontentloaded" });
await waitSettled(page);
for (let i = 0; i < 2; i++) { await page.evaluate(() => window.scrollBy(0, 2500)); await sleep(2500); }
await waitSettled(page);
let cards = await cardSnapshot(page);
let mon = await page.evaluate(() => window.__yffE2E);
check("home: every card judged", cards.length > 0 && cards.every((c) => c.state && c.state !== "pending"), { cards: cards.length, states: tally(cards) });
check("home: no unblurred flash", mon.violations.length === 0 && mon.stale.length === 0,
  { frames: mon.frames, linkChecks: mon.checks, violations: mon.violations.slice(0, 3), stale: mon.stale.slice(0, 3) });
report.homeCards = cards.map(({ title, metaId, kind, state, reason, source }) => ({ title, videoId: metaId, kind, state, reason, source }));
const looks = await page.evaluate(() => [...document.querySelectorAll("ytd-rich-item-renderer")]
  .filter((h) => ["show", "uncertain"].includes(h.dataset.yffState)).map((h) => {
    const c = getComputedStyle(h.querySelector(":scope > #content"));
    return { state: h.dataset.yffState, blurred: c.filter.includes("blur"), outlined: c.outlineStyle === "solid" && parseFloat(c.outlineWidth) > 0 };
  }));
const lookTally = (st) => looks.filter((l) => l.state === st);
check("home: uncertain cards readable, shown cards highlighted",
  lookTally("uncertain").length > 0 && looks.every((l) => !l.blurred) &&
  lookTally("uncertain").every((l) => !l.outlined) && lookTally("show").every((l) => l.outlined),
  { uncertain: lookTally("uncertain").length, shown: lookTally("show").length,
    blurred: looks.filter((l) => l.blurred).length, uncertainOutlined: lookTally("uncertain").filter((l) => l.outlined).length,
    shownNotOutlined: lookTally("show").filter((l) => !l.outlined).length });
const home = await badgeAndCounts(browser, page);
check("badge matches the home page", home.ok, home);

// 2. Real mouse clicks on the card controls: the page must not navigate.
const url0 = page.url();
const mark = (id, tag) => page.evaluate((vid, t, hosts) => {
  const h = [...document.querySelectorAll(hosts)].find((x) => x.dataset.yffKey === vid);
  if (h) h.dataset.e2eTarget = t;
  return !!h;
}, id, tag, HOSTS);
const stateOf = (id) => page.evaluate((vid, hosts) => {
  const h = [...document.querySelectorAll(hosts)].find((x) => x.dataset.yffKey === vid);
  return h ? { state: h.dataset.yffState, reason: h.dataset.yffReason } : null;
}, id, HOSTS);
const uncertain = cards.filter((c) => c.state === "uncertain" && c.metaId && !c.sidebar);
const clicks = {};
if (uncertain.length >= 2) {
  await mark(uncertain[0].metaId, "keep");
  // A maybe card has Yes and No on its thumbnail; the pointer starts on the title because
  // YouTube's preview covers the card once it is over the thumbnail.
  await page.hover("[data-e2e-target='keep'] h3");
  await page.click("[data-e2e-target='keep'] > .yff-overlay .yff-ask .yff-keep");
  await sleep(600);
  clicks.keep = { id: uncertain[0].metaId, after: await stateOf(uncertain[0].metaId), url: page.url() };
  await mark(uncertain[1].metaId, "hideclick");
  await page.hover("[data-e2e-target='hideclick'] h3");
  await page.click("[data-e2e-target='hideclick'] > .yff-overlay .yff-ask .yff-hide");
  await sleep(600);
  clicks.hide = { id: uncertain[1].metaId, after: await stateOf(uncertain[1].metaId), url: page.url() };
}
check("mouse clicks: Keep and Hide on uncertain cards change state without navigating",
  clicks.keep?.after?.state === "show" && clicks.hide?.after?.state === "hide" &&
  clicks.keep.url === url0 && clicks.hide.url === url0, clicks);

// 3. Badge on a watch page reached by in-app navigation (home cards stay in the DOM, hidden).
const shownCard = (await cardSnapshot(page)).find((c) => (c.state === "show" || c.state === "revealed") && !c.sidebar && c.kind === "video");
if (shownCard) {
  await mark(shownCard.key, "open");
  await page.click("[data-e2e-target='open'] a[href^='/watch?v=']");
  await page.waitForFunction(() => location.pathname === "/watch", { timeout: 15000 });
  await sleep(6000);
  await waitSettled(page, 30000);
  const watch = await badgeAndCounts(browser, page);
  const side = (await cardSnapshot(page)).filter((c) => c.sidebar);
  const homeStillInDom = await page.evaluate(() => document.querySelectorAll("ytd-browse[page-subtype='home'] ytd-rich-item-renderer").length);
  check("badge matches the watch page after in-app navigation", watch.ok && side.length > 0 &&
    watch.dom.shown + watch.dom.hidden + watch.dom.uncertain + watch.dom.pending === side.length,
    { ...watch, sidebarCards: side.length, homeCardsStillInDom: homeStillInDom, url: page.url(),
      visiblePages: await page.evaluate(() => [...document.querySelectorAll("ytd-page-manager > *")]
        .filter((e) => !e.hasAttribute("hidden")).map((e) => e.tagName.toLowerCase())) });
  mon = await page.evaluate(() => window.__yffE2E);
  check("watch sidebar: every card judged, nothing readable early", side.length > 0 && side.every((c) => c.state && c.state !== "pending") &&
    mon.violations.length === 0 && mon.stale.length === 0,
    { sidebarCards: side.length, states: tally(side), violations: mon.violations.slice(0, 3), stale: mon.stale.slice(0, 3) });

  // 4. Mouse Hide on a sidebar card, then reload: the override persists.
  // YouTube reshuffles the sidebar on every load, so a card seen once may never come back
  // (that made earlier runs inconclusive). Reload first and target the highest-ranked video
  // present in both loads; those are the ones YouTube keeps recommending.
  await page.reload({ waitUntil: "domcontentloaded" });
  await sleep(6000);
  await waitSettled(page, 30000);
  const sideNow = (await cardSnapshot(page)).filter((c) => c.sidebar);
  const stable = sideNow.filter((c) => c.metaId && side.some((s0) => s0.metaId === c.metaId));
  report.overrideTargetPool = { firstLoad: side.length, secondLoad: sideNow.length, inBoth: stable.length };
  // Several targets: YouTube does not reliably bring back even a twice-seen card, so a single
  // target left the check inconclusive. Every target that reappears must carry its override.
  const targets = stable.filter((c) => c.metaId && c.kind === "video" && c.state !== "hide").slice(0, 5);
  if (targets.length) {
    const immediate = {};
    for (const t of targets) {
      await mark(t.key, "hide");
      await page.hover("[data-e2e-target='hide'] h3"); // the title: over the thumbnail, YouTube's preview covers the card
      if (t.state === "uncertain") await page.click("[data-e2e-target='hide'] > .yff-overlay .yff-ask .yff-hide");
      else {
        await page.click("[data-e2e-target='hide'] > .yff-overlay .yff-more");
        await page.click("[data-e2e-target='hide'] > .yff-overlay .yff-menu .yff-hide");
      }
      await sleep(600);
      immediate[t.key] = await stateOf(t.key);
      await page.evaluate(() => document.querySelector("[data-e2e-target='hide']")?.removeAttribute("data-e2e-target"));
    }
    const urlBefore = page.url();
    let after = {};
    let reloads = 0;
    while (!Object.keys(after).length && reloads < 3) {
      await page.reload({ waitUntil: "domcontentloaded" });
      reloads += 1;
      await sleep(6000);
      await waitSettled(page, 30000);
      for (const t of targets) {
        const st = await stateOf(t.key);
        if (st) after[t.key] = st;
      }
    }
    const stored = await (await extensionWorker(browser)).evaluate(async () => (await chrome.storage.local.get("overrides")).overrides || {});
    const persistedOk = targets.every((t) => immediate[t.key]?.state === "hide" && stored[`v:${t.key}`] === "hide");
    const reappeared = Object.values(after);
    check("override: mouse Hide applies at once and persists after reload",
      !persistedOk ? false : reappeared.length ? reappeared.every((st) => st.reason === "override:hide") : "inconclusive",
      { targets: targets.map((t) => t.key), immediate, afterReload: after, reappeared: reappeared.length, reloads,
        sameUrl: urlBefore === page.url() });
  }
}

// 5. Card reuse stress: most cards shown (show threshold near 0), then chip filters and history navigation.
await setSettings(browser, { showThreshold: 0.02, hideThreshold: 0.01, hideShorts: false, hideNonVideo: false });
const stress = page; // the main tab: a second tab behind a playing watch page did not render the feed
await stress.bringToFront();
await stress.goto("https://www.youtube.com/", { waitUntil: "domcontentloaded" });
await waitSettled(stress);
const chipLabels = await stress.$$eval("yt-chip-cloud-chip-renderer", (cs) => cs.map((c) => c.textContent.trim()).filter(Boolean));
const actions = [];
for (let i = 1; i <= Math.min(3, chipLabels.length - 1); i++) {
  await stress.evaluate((idx) => document.querySelectorAll("yt-chip-cloud-chip-renderer")[idx]?.click(), i);
  actions.push(`chip:${chipLabels[i]}`);
  await sleep(3500);
}
await stress.evaluate(() => document.querySelectorAll("yt-chip-cloud-chip-renderer")[0]?.click());
actions.push("chip:All");
await sleep(3500);
const firstLink = await stress.$eval("ytd-rich-item-renderer a[href^='/watch?v=']", (a) => a.getAttribute("href")).catch(() => null);
if (firstLink) {
  await stress.click(`ytd-rich-item-renderer a[href='${firstLink}']`);
  actions.push("open video");
  await sleep(4000);
  await stress.goBack(); actions.push("back"); await sleep(3500);
  await stress.goForward(); actions.push("forward"); await sleep(3500);
  await stress.goBack(); actions.push("back"); await sleep(3500);
}
await waitSettled(stress, 20000);
const stressCards = await cardSnapshot(stress);
mon = await stress.evaluate(() => window.__yffE2E);
check("card reuse: no stale or early-readable card through chips and back/forward",
  mon.violations.length === 0 && mon.stale.length === 0 && stressCards.filter((c) => c.state === "show").length > 10,
  { actions, chipsAvailable: chipLabels.length, shownCards: stressCards.filter((c) => c.state === "show").length,
    frames: mon.frames, linkChecks: mon.checks, violations: mon.violations.slice(0, 3), stale: mon.stale.slice(0, 3) });
await setSettings(browser, baseSettings);

// 6. Timing: 10 loads with a fresh goal each (every card goes to Jev) and 10 with a fixed goal (served from the cache).
const timing = { jev: [], cache: [], rule: [], loads: { jev: 0, cache: 0 }, batches: { jev: 0, cache: 0 } };
const tpage = await browser.newPage();
await tpage.bringToFront();
await tpage.evaluateOnNewDocument(flashMonitor, HOSTS);
// A goal change re-scores the cards on every open YouTube page. That would put the next
// load's videos in the cache before it starts, so no YouTube page is open when the goal changes.
for (const p of await browser.pages()) if (p !== tpage && p.url().includes("youtube.com")) await p.goto("about:blank");
for (const mode of ["jev", "cache"]) {
  for (let i = 0; i < TIMING_LOADS; i++) {
    const text = mode === "jev" ? `${GOAL} (timing run ${Date.now()}-${i})` : GOAL;
    await tpage.goto("about:blank");
    await setSettings(browser, { goals: [{ id: "e2e", text, minDurationMinutes: 0 }] });
    await tpage.goto("https://www.youtube.com/", { waitUntil: "domcontentloaded" });
    await waitSettled(tpage);
    const cs = await cardSnapshot(tpage);
    timing[mode].push(...delays(cs, mode === "jev" ? ["jev"] : ["cache"]));
    timing.rule.push(...delays(cs, ["rule"]));
    timing.loads[mode] += 1;
    timing.batches[mode] += Number(await tpage.evaluate(() => document.documentElement.dataset.yffFlushes || 0));
  }
}
await tpage.close();
await setSettings(browser, baseSettings);
const summary = (xs) => ({ n: xs.length, p50_ms: Math.round(pct(xs, 0.5)), p95_ms: Math.round(pct(xs, 0.95)) });
report.timing = { jev: summary(timing.jev), cache: summary(timing.cache), rule: summary(timing.rule), loads: timing.loads, batches: timing.batches };
check("timing: card inserted -> verdict applied", timing.jev.length > 50 && timing.cache.length > 50, report.timing);

// 7. Scorer unreachable: model cards stay blurred, banner shows, one click disables the tab and stops scoring calls.
// A new goal text, so nothing comes from the cache, and the worker's requests to Jev are blocked.
await setSettings(browser, { ...baseSettings, goals: [{ id: "down", text: `${GOAL} (unreachable ${Date.now()})`, minDurationMinutes: 0 }] });
await blockJev(browser, true);
const down = await browser.newPage();
await down.bringToFront();
await down.evaluateOnNewDocument(flashMonitor, HOSTS);
await down.goto("https://www.youtube.com/", { waitUntil: "domcontentloaded" });
// A blocked call is retried four times (about 7 s of backoff) before the batch fails.
await down.waitForSelector("#yff-banner", { timeout: 40000 }).catch(() => {});
await sleep(1500);
const downCards = await cardSnapshot(down);
const banner = await down.evaluate(() => document.getElementById("yff-banner")?.innerText || null);
mon = await down.evaluate(() => window.__yffE2E);
check("scorer unreachable: model cards stay blurred and banner shows",
  downCards.every((c) => c.state !== "show" || ["rule", "override"].includes(c.source)) && !!banner && mon.violations.length === 0,
  { cards: downCards.length, states: tally(downCards), banner, violations: mon.violations.length });
const errCard = downCards.find((c) => c.state === "error" && c.metaId);
let anyway = null;
if (errCard) {
  await down.evaluate((vid, hosts) => { const h = [...document.querySelectorAll(hosts)].find((x) => x.dataset.yffKey === vid); if (h) { h.dataset.e2eTarget = "anyway"; h.scrollIntoView({ block: "center" }); } }, errCard.key, HOSTS);
  await sleep(300); // centred, so the banner at the top cannot cover the button
  await down.click("[data-e2e-target='anyway'] > .yff-overlay .yff-anyway");
  await sleep(400);
  anyway = await down.evaluate((vid, hosts) => {
    const h = [...document.querySelectorAll(hosts)].find((x) => x.dataset.yffKey === vid);
    return h ? { state: h.dataset.yffState, blurred: getComputedStyle(h.querySelector(":scope > #content") || h).filter.includes("blur"), url: location.href } : null;
  }, errCard.key, HOSTS);
}
check("scorer unreachable: Show anyway on a failed card reveals it without navigating",
  anyway?.state === "revealed" && !anyway.blurred && anyway.url === "https://www.youtube.com/", { video: errCard?.key, anyway });
await down.evaluate(() => [...document.querySelectorAll("#yff-banner button")].find((b) => /pause/i.test(b.textContent))?.click());
await sleep(500);
const flushesAtOff = await down.evaluate(() => Number(document.documentElement.dataset.yffFlushes || 0));
for (let i = 0; i < 2; i++) { await down.evaluate(() => window.scrollBy(0, 3000)); await sleep(2500); }
const offState = await down.evaluate(() => ({ off: document.documentElement.hasAttribute("data-yff-off"),
  firstFilter: getComputedStyle(document.querySelector("ytd-rich-item-renderer > #content")).filter,
  flushes: Number(document.documentElement.dataset.yffFlushes || 0), cards: document.querySelectorAll("ytd-rich-item-renderer").length }));
check("scorer unreachable: one click disables the tab and stops scoring calls",
  offState.off && !offState.firstFilter.includes("blur") && offState.flushes === flushesAtOff, { ...offState, flushesAtOff });
await down.evaluate(() => sessionStorage.removeItem("yff-off"));
await down.close();
await blockJev(browser, false);

// 7b. A rejected key: new goal text, so nothing comes from the cache.
await setSettings(browser, { ...baseSettings, jevKey: "not-a-real-key", goals: [{ id: "k", text: `${GOAL} (${Date.now()})`, minDurationMinutes: 0 }] });
const badKey = await browser.newPage();
await badKey.bringToFront();
await badKey.goto("https://www.youtube.com/", { waitUntil: "domcontentloaded" });
await sleep(9000);
const badCards = await cardSnapshot(badKey);
const badBanner = await badKey.evaluate(() => document.getElementById("yff-banner")?.innerText || null);
const scored = badCards.filter((c) => !["rule", "override"].includes(c.source) && c.state);
check("rejected key: model cards stay blurred with the reason and the banner",
  scored.length > 0 && scored.every((c) => c.state === "error" && /rejected the key/.test(c.reason)) && /rejected the key/.test(badBanner || ""),
  { cards: badCards.length, states: tally(badCards), reasons: [...new Set(scored.map((c) => c.reason))].slice(0, 3), banner: badBanner });
await badKey.close();
await setSettings(browser, baseSettings);

// 8. Auto-load cap: with a goal nothing matches, loading stops after 3 all-hidden feed pages.
// A high hide threshold makes every judged card hidden: this checks the cap mechanism, and
// with the default 0.1 a few cards of even this goal land in the visible uncertain band.
await setSettings(browser, { goals: [{ id: "none", text: NOTHING_GOAL, minDurationMinutes: 0 }], autoLoadCap: 3,
  showThreshold: 0.95, hideThreshold: 0.9 });
const cap = await browser.newPage();
await cap.bringToFront();
await cap.goto("https://www.youtube.com/", { waitUntil: "domcontentloaded" });
const timeline = [];
let stopped = false;
for (let i = 0; i < 20 && !stopped; i++) {
  await sleep(2500);
  await cap.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const s = await cap.evaluate(() => ({ cards: document.querySelectorAll("ytd-rich-item-renderer").length,
    pages: Number(document.documentElement.dataset.yffPagesClosed || 0),
    empty: Number(document.documentElement.dataset.yffConsecutiveEmpty || 0),
    stopped: document.documentElement.hasAttribute("data-yff-stop-loading") }));
  timeline.push(s);
  stopped = s.stopped;
}
for (let i = 0; i < 3; i++) { await cap.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await sleep(2500); }
const capEnd = await cap.evaluate(() => ({ cards: document.querySelectorAll("ytd-rich-item-renderer").length,
  pages: Number(document.documentElement.dataset.yffPagesClosed || 0), empty: Number(document.documentElement.dataset.yffConsecutiveEmpty || 0),
  banner: document.getElementById("yff-banner")?.innerText || null }));
const atStop = timeline[timeline.length - 1];
check("auto-load cap: stops after 3 all-hidden feed pages, then nothing more loads",
  stopped && atStop.empty === 3 && atStop.pages >= 3 && capEnd.cards === atStop.cards,
  { timeline, atStop, afterMoreScrolling: capEnd });
await cap.close();
await setSettings(browser, baseSettings);

// 8. Drift notice: a goal nothing on the feed serves gets every scored card rejected, so the
// panel appears at the default 80%.
const worker = await extensionWorker(browser);
await worker.evaluate(() => chrome.storage.local.remove("driftDismissed"));
await setSettings(browser, { ...baseSettings, goals: [{ id: "none", name: "Underwater basket weaving", text: NOTHING_GOAL, minDurationMinutes: 0 }], driftPercent: 80 });
const dp = await browser.newPage();
await dp.bringToFront();
await dp.goto("https://www.youtube.com/", { waitUntil: "domcontentloaded" });
await waitSettled(dp);
await dp.evaluate(() => window.scrollBy(0, 2500));
await sleep(2500);
await waitSettled(dp);
await dp.evaluate(() => window.scrollTo(0, 0));
await sleep(500);
const driftState = () => dp.evaluate(() => {
  const panel = document.getElementById("yff-drift");
  return { drift: JSON.parse(document.documentElement.dataset.yffDrift || "null"),
    counts: JSON.parse(document.documentElement.dataset.yffCounts || "null"),
    panel: !!panel, inHomeGrid: !!panel && panel.parentElement?.matches('ytd-browse[page-subtype="home"] ytd-rich-grid-renderer'),
    body: panel?.querySelector(".yff-drift-body")?.textContent || null,
    goalHrefs: panel ? [...panel.querySelectorAll(".yff-drift-goal")].map((a) => a.href) : [] };
});
const d1 = await driftState();
const badge1 = await worker.evaluate(async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return chrome.action.getBadgeText({ tabId: tab.id });
});
const expectedBody = d1.drift && `Of ${d1.drift.scored} videos scored, ${d1.drift.fit} fit your goals (${Math.round(d1.drift.percent)}% rejected).`;
check("drift: panel above the home grid once 80% of 20+ scored cards are rejected",
  !!d1.drift?.on && d1.drift.scored >= 20 && d1.drift.percent >= 80 && d1.panel && d1.inHomeGrid && d1.body === expectedBody &&
  d1.counts?.drift === true && badge1 === "!" &&
  d1.goalHrefs.length === 1 && d1.goalHrefs[0] === "https://www.youtube.com/results?search_query=Underwater%20basket%20weaving",
  { ...d1, badge: badge1 });
if (process.env.E2E_SHOTS) {
  await dp.screenshot({ path: path.join(process.env.E2E_SHOTS, "drift_light.png") });
  await dp.evaluate(() => document.documentElement.setAttribute("dark", ""));
  await sleep(300);
  await dp.screenshot({ path: path.join(process.env.E2E_SHOTS, "drift_dark.png") });
  await dp.evaluate(() => document.documentElement.removeAttribute("dark"));
}
if (d1.panel) {
  await dp.click("#yff-drift .yff-drift-reveal");
  const revealOn = await dp.evaluate(() => document.documentElement.hasAttribute("data-yff-reveal"));
  await dp.evaluate(() => document.documentElement.removeAttribute("data-yff-reveal"));
  await dp.click("#yff-drift .yff-drift-dismiss");
  await sleep(500);
  const afterDismiss = await driftState();
  const stored = await worker.evaluate(() => chrome.storage.local.get("driftDismissed"));
  await dp.reload({ waitUntil: "domcontentloaded" });
  await waitSettled(dp);
  await sleep(1000);
  const afterReload = await driftState();
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  check("drift: Show what was filtered reveals; Not today hides it and survives a reload",
    revealOn && !afterDismiss.panel && stored.driftDismissed === todayKey && !afterReload.panel,
    { revealOn, afterDismiss: { panel: afterDismiss.panel, on: afterDismiss.drift?.on }, stored, afterReload: { panel: afterReload.panel, drift: afterReload.drift } });
} else {
  check("drift: Show what was filtered reveals; Not today hides it and survives a reload", false, { skipped: "no panel to click" });
}
await dp.close();
await worker.evaluate(() => chrome.storage.local.remove("driftDismissed"));
await setSettings(browser, baseSettings);

report.finishedAt = new Date().toISOString();
writeFileSync(path.join(ROOT, "results", "e2e_report.json"), JSON.stringify(report, null, 2));
const failed = Object.entries(report.checks).filter(([, v]) => v.ok === false).map(([k]) => k);
const unclear = Object.entries(report.checks).filter(([, v]) => v.ok === "inconclusive").map(([k]) => k);
console.log(`run_e2e: ${Object.keys(report.checks).length - failed.length - unclear.length} passed, ${failed.length} failed${failed.length ? ` (${failed.join("; ")})` : ""}, ${unclear.length} inconclusive${unclear.length ? ` (${unclear.join("; ")})` : ""}`);
await browser.close();
