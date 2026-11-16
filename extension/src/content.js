// Isolated-world content script: decides every feed card and applies the result.
// Pipeline per card: override -> code rules -> session cache -> Jev (every goal,
// best p wins) -> bands -> minimum duration of the best goal.
// Cards stay blurred (blur.css) until a verdict: show (highlighted) and uncertain are readable,
// hide collapses, and any failure keeps the card blurred.
(function () {
  "use strict";
  const Y = globalThis.YFF;
  const HOME = Y.HOME_CARD;
  const HOSTS = `${HOME}, ${Y.SIDEBAR_CARD}`;
  const META_WAIT_MS = 700; // after this, fall back to reading the DOM
  const BATCH_SIZE = 30;
  const FLUSH_MS = 60;
  const FINAL = new Set(["show", "hide", "uncertain", "revealed"]);

  let settings = null;
  let overrides = {};
  const pCache = new Map(); // `${goalsHash}|${videoId}` -> {p, goalId}, for this tab's lifetime
  const queue = new Map(); // videoId -> {host, meta}
  let flushTimer = null;
  let flushCount = 0;
  let scorerDown = false;
  let pageSeq = 0;
  const pages = new Map(); // feed page id -> {hosts: Set, closed}
  const seenContinuations = new WeakSet();
  let pagesClosed = 0;
  let consecutiveEmpty = 0;
  let waitingForSetup = false; // no key or no active goal yet: YouTube is left as it is
  let driftActive = false; // the drift condition, see YFF.driftOn
  let driftDismissed = ""; // local day "Not today" was pressed

  const html = () => document.documentElement;
  const tabOff = () => sessionStorage.getItem("yff-off") === "1";

  function goals() {
    return settings ? Y.activeGoals(settings) : [];
  }

  // Overrides apply to the video whatever goal scored it.
  function overrideKey(videoId) {
    return `v:${videoId}`;
  }

  // ---- applying a state --------------------------------------------------------------
  // One overlay per card, laid over the thumbnail. What shows depends on data-yff-state
  // (blur.css): ON GOAL badge, Checking pill, a grey box for filtered (in reveal mode) and
  // failed cards, and a three-dot menu with the match line, Keep and Hide.
  const OVERLAY_HTML =
    '<div class="yff-thumb">' +
      '<span class="yff-badge"></span>' +
      '<span class="yff-pill">Checking\u2026</span>' +
      '<button class="yff-more" type="button" aria-label="Feed Filter actions" aria-haspopup="menu" aria-expanded="false">' +
        '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg></button>' +
      '<div class="yff-menu" role="menu">' +
        '<button class="yff-keep" type="button" role="menuitem">Keep, it\u2019s on goal</button>' +
        '<button class="yff-hide" type="button" role="menuitem">Hide, not for me</button>' +
        '<div class="yff-sep"></div><div class="yff-match"></div>' +
      '</div>' +
      '<div class="yff-box">' +
        '<div class="yff-reason"></div><div class="yff-title"></div>' +
        '<div class="yff-acts">' +
          '<button class="yff-keep yff-filtered-only" type="button">Keep</button>' +
          '<button class="yff-why yff-filtered-only" type="button">Why?</button>' +
          '<button class="yff-anyway" type="button">Show anyway</button>' +
          '<button class="yff-retry" type="button">Retry</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  function ensureOverlay(host) {
    let box = host.querySelector(":scope > .yff-overlay");
    if (!box) {
      box = document.createElement("div");
      box.className = "yff-overlay";
      box.innerHTML = OVERLAY_HTML;
      box.addEventListener("click", onOverlayClick, true);
      host.appendChild(box);
    }
    renderOverlay(host, box);
  }

  const pctText = (p) => `${Math.round(p * 100)}%`;
  // The plain-word texts for this card, from its reason string.
  function renderOverlay(host, box) {
    const state = host.dataset.yffState || "";
    const reason = host.dataset.yffReason || "";
    const d = Y.describe(reason, settings ? settings.goals : []);
    const marks = settings ? `Above ${pctText(settings.showThreshold)} is highlighted, below ${pctText(settings.hideThreshold)} is filtered.` : "";
    box.querySelector(".yff-badge").textContent = d.label === "Kept" ? "KEPT" : "ON GOAL";
    let match = "";
    if (d.p != null && d.label === "Too short") match = `${d.match} for ${d.goal}, but ${d.detail}, shorter than this goal shows.`;
    else if (d.p != null) match = `${d.match} for ${d.goal}. ${marks}`;
    else if (d.detail) match = `${d.label}: ${d.detail}.`;
    box.querySelector(".yff-match").textContent = match;
    box.querySelector(".yff-match").hidden = !match;
    let title = "";
    if (state === "error") title = "Couldn\u2019t check this video";
    else if (d.label === "Too short") title = `Filtered \u00b7 ${d.detail}`;
    else title = d.detail ? `${d.label} \u00b7 ${d.detail}` : d.label;
    box.querySelector(".yff-reason").textContent = title;
    const meta = host.yffMeta;
    box.querySelector(".yff-title").textContent = meta && meta.title ? meta.title : "";
  }

  function closeMenus(except) {
    for (const o of document.querySelectorAll(".yff-overlay.yff-open")) {
      if (o === except) continue;
      o.classList.remove("yff-open");
      o.querySelector(".yff-more").setAttribute("aria-expanded", "false");
    }
  }

  function apply(host, state, reason, source) {
    host.dataset.yffState = state;
    host.dataset.yffReason = reason || "";
    if (source) host.dataset.yffSource = source;
    if (FINAL.has(state) && !host.dataset.yffTApplied) host.dataset.yffTApplied = String(performance.now());
    ensureOverlay(host);
    scheduleCounts();
    noteBatchProgress(host);
  }

  // ---- deciding ----------------------------------------------------------------------
  function readMeta(host) {
    const raw = host.getAttribute("data-yff-meta");
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch (err) {
        return null;
      }
    }
    const seenAt = Number(host.dataset.yffTSeen || 0);
    if (seenAt && performance.now() - seenAt > META_WAIT_MS) {
      const m = Y.extractFromDom(host);
      return m.videoId ? m : { kind: "unknown", videoId: null, source: "dom" };
    }
    return null; // wait for the page bridge
  }

  // Rule hides never reach the scorer, so the dashboard counts them from a local tally.
  // Each card is sent once per page; the background dedupes per day. Nothing leaves the browser.
  const tallied = new Set();
  function tally(meta, reason, host) {
    if (!meta.videoId && !meta.contentId && !meta.title && !host.dataset.yffTallyId) {
      host.dataset.yffTallyId = Math.random().toString(36).slice(2, 10);
    }
    const id = Y.tallyId(meta, host.dataset.yffTallyId);
    if (tallied.has(id)) return;
    tallied.add(id);
    try {
      chrome.runtime.sendMessage({ type: "tally", id, reason }).catch(() => {});
    } catch (err) {
      // The extension was reloaded and this script is orphaned; the hide already happened.
    }
  }

  function decide(host, meta) {
    if (!goals().length) return apply(host, "error", "no goal set", "rule");
    const override = meta.videoId ? overrides[overrideKey(meta.videoId)] : null;
    const ruled = Y.applyRules(meta, settings, override);
    if (ruled) {
      apply(host, ruled.state, ruled.reason, ruled.reason.startsWith("override") ? "override" : "rule");
      if (ruled.state === "hide" && ruled.reason.startsWith("rule:")) tally(meta, ruled.reason, host);
      return;
    }
    if (!meta.videoId) return apply(host, "error", "could not read this card", "rule");
    const hit = pCache.get(`${Y.goalsKey(goals())}|${meta.videoId}`);
    if (hit) {
      const d = Y.decideScored(meta, settings, hit.p, hit.goalId);
      return apply(host, d.state, d.reason, "session");
    }
    host.dataset.yffState = "pending";
    ensureOverlay(host);
    queue.set(meta.videoId, { host, meta });
    scheduleCounts();
    scheduleFlush();
  }

  function linkVideoId(host) {
    const a = host.querySelector("a[href*='/watch?v='], a[href^='/shorts/']");
    return Y.videoIdFromHref(a && a.getAttribute("href"));
  }

  // Runs inside the MutationObserver callback, which fires before the next paint. If YouTube
  // reused a card element for a different video, re-blur it now; scan() re-decides it once the
  // bridge has stamped the new data.
  function reblurIfReused(host) {
    const key = host.dataset.yffKey;
    // Only cards decided as a video are compared: ads and mixes link to a video that is not
    // their key, and comparing them would re-blur them forever.
    if (!key || !host.dataset.yffState || !Y.VIDEO_ID.test(key)) return;
    const vid = linkVideoId(host);
    if (vid && vid !== key) {
      delete host.dataset.yffState;
      delete host.dataset.yffTApplied;
      host.dataset.yffReason = "";
    }
  }

  function onMutations(mutations) {
    if (!settings || tabOff()) return;
    for (const m of mutations) {
      const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      const host = el && el.closest(HOSTS);
      if (host) reblurIfReused(host);
    }
    scanSoon();
  }

  function scan() {
    if (!settings || tabOff()) return;
    const now = performance.now();
    const fresh = [];
    for (const host of document.querySelectorAll(HOSTS)) {
      if (!host.dataset.yffTSeen) {
        host.dataset.yffTSeen = String(now);
        if (host.matches(HOME)) fresh.push(host);
      }
      const meta = readMeta(host);
      if (!meta) continue;
      const vid = linkVideoId(host);
      if (vid && meta.videoId && vid !== meta.videoId) {
        // Usually stale data that the bridge is about to replace; wait, but not forever.
        const since = Number(host.dataset.yffMismatchSince || 0) || now;
        host.dataset.yffMismatchSince = String(since);
        if (now - since < 1500) continue;
      } else {
        delete host.dataset.yffMismatchSince;
      }
      const key = Y.cardKey(meta);
      if (host.dataset.yffKey !== key) {
        // New card, or YouTube reused this element for a different video: start over, blurred.
        const reused = host.dataset.yffKey !== undefined;
        host.dataset.yffKey = key;
        delete host.dataset.yffState;
        delete host.dataset.yffTApplied;
        if (reused) host.dataset.yffTSeen = String(now);
        host.yffMeta = meta;
        decide(host, meta);
      } else if (!host.dataset.yffState) {
        host.yffMeta = meta;
        decide(host, meta); // re-blurred by reblurIfReused and now consistent again
      } else if (!host.querySelector(":scope > .yff-overlay")) {
        ensureOverlay(host); // YouTube re-rendered the card and dropped our overlay
      }
    }
    trackFeedPages(fresh);
  }

  let scanQueued = false;
  function scanSoon() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(() => {
      scanQueued = false;
      scan();
    });
  }

  // ---- talking to the scorer (via the service worker) ---------------------------------
  function scheduleFlush() {
    if (queue.size >= BATCH_SIZE) return flush();
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
  }

  async function flush() {
    clearTimeout(flushTimer);
    flushTimer = null;
    const active = goals();
    const key = Y.goalsKey(active);
    const items = [...queue.values()].slice(0, BATCH_SIZE);
    for (const { meta } of items) queue.delete(meta.videoId);
    if (queue.size) scheduleFlush();
    if (!items.length || !active.length) return;
    flushCount += 1;
    html().dataset.yffFlushes = String(flushCount); // batches sent, read by the end-to-end timing check
    const videos = items.map(({ meta }) => Y.videoPayload(meta));
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: "judge", body: {
        goals: active.map((g) => ({ id: g.id, text: g.text })), videos } });
    } catch (err) {
      resp = { error: "extension_error" };
    }
    if (!resp || resp.error) {
      for (const { host } of items) if (host.dataset.yffKey === host.yffMeta?.videoId) apply(host, "error", `filter offline: ${resp ? resp.error : "no response"}`, "error");
      setScorerDown(true, resp ? resp.error : "no response");
      return;
    }
    setScorerDown(false);
    const byId = new Map(resp.results.map((r) => [r.videoId, r]));
    for (const { host, meta } of items) {
      const r = byId.get(meta.videoId);
      if (host.dataset.yffKey !== meta.videoId) continue; // card was reused meanwhile
      if (!r || r.p === null || r.p === undefined) {
        apply(host, "error", `not judged: ${r ? r.error : "missing"}`, "error");
        continue;
      }
      pCache.set(`${key}|${meta.videoId}`, { p: r.p, goalId: r.goalId });
      host.dataset.yffGoal = r.goalId;
      const d = Y.decideScored(meta, settings, r.p, r.goalId);
      apply(host, d.state, d.reason, r.source);
    }
  }

  // ---- overlay buttons ----------------------------------------------------------------
  async function onOverlayClick(ev) {
    const btn = ev.target.closest("button");
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    const host = btn.closest(HOSTS);
    const meta = host && host.yffMeta;
    if (!meta) return;
    const overlay = btn.closest(".yff-overlay");
    if (btn.classList.contains("yff-more") || btn.classList.contains("yff-why")) {
      const open = !overlay.classList.contains("yff-open");
      closeMenus(overlay);
      overlay.classList.toggle("yff-open", open);
      overlay.querySelector(".yff-more").setAttribute("aria-expanded", String(open));
      return;
    }
    closeMenus();
    if (btn.classList.contains("yff-retry")) return decide(host, meta);
    if (btn.classList.contains("yff-anyway")) return apply(host, "revealed", host.dataset.yffReason, host.dataset.yffSource);
    const action = btn.classList.contains("yff-keep") ? "keep" : "hide";
    if (!meta.videoId) return apply(host, action === "keep" ? "revealed" : "hide", `manual ${action}`, "override");
    const previous = host.dataset.yffState;
    const reason = host.dataset.yffReason;
    overrides[overrideKey(meta.videoId)] = action;
    await chrome.storage.local.set({ overrides });
    apply(host, action === "keep" ? "show" : "hide", `override:${action}`, "override");
    const pMatch = /p=([\d.]+)/.exec(reason || "");
    const best = goals().find((g) => g.id === host.dataset.yffGoal) || goals()[0];
    if (!best) return;
    chrome.runtime.sendMessage({ type: "feedback", body: {
      goal: best.text, action, p: pMatch ? Number(pMatch[1]) : null, previousVerdict: previous, reason: (reason || "").slice(0, 80),
      video: Y.videoPayload(meta) } }).catch(() => {});
  }

  // ---- counts, banner, auto-load cap ----------------------------------------------------
  let countsTimer = null;
  function scheduleCounts() {
    if (!countsTimer) countsTimer = setTimeout(sendCounts, 200);
  }

  // YouTube keeps earlier pages (for example the home feed) in the DOM, hidden, while you are
  // on a watch page. Counts cover only cards on the page currently shown.
  function onVisiblePage(host) {
    const page = host.closest("ytd-page-manager > *");
    return !page || !page.hasAttribute("hidden");
  }

  function counts() {
    const c = { shown: 0, hidden: 0, uncertain: 0, pending: 0 };
    for (const host of document.querySelectorAll(HOSTS)) {
      if (!onVisiblePage(host)) continue;
      const s = host.dataset.yffState;
      if (s === "show" || s === "revealed") c.shown += 1;
      else if (s === "hide") c.hidden += 1;
      else if (s === "uncertain" || s === "error") c.uncertain += 1;
      else c.pending += 1;
    }
    c.drift = driftActive;
    return c;
  }

  function sendCounts() {
    countsTimer = null;
    updateDrift();
    const c = counts();
    html().dataset.yffCounts = JSON.stringify(c); // read by the end-to-end check
    chrome.runtime.sendMessage({ type: "counts", counts: c, off: tabOff() }).catch(() => {});
  }

  function banner(id, text, actions) {
    let el = document.getElementById("yff-banner");
    if (!el) {
      el = document.createElement("div");
      el.id = "yff-banner";
      document.body.appendChild(el);
    }
    el.dataset.kind = id;
    el.textContent = "";
    const span = document.createElement("span");
    span.textContent = text;
    el.appendChild(span);
    actions.forEach(([label, fn, secondary]) => {
      const b = document.createElement("button");
      b.textContent = label;
      if (secondary) b.className = "yff-secondary";
      b.addEventListener("click", fn);
      el.appendChild(b);
    });
  }

  function clearBanner(kind) {
    const el = document.getElementById("yff-banner");
    if (el && (!kind || el.dataset.kind === kind)) el.remove();
  }

  // ---- feed drift notice ---------------------------------------------------------------
  // When most of the home cards Jev scored are rejected, a panel above the home grid says so
  // and offers a YouTube search per goal. Watch-page sidebars never count.
  const MARK_SVG = '<svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="20" fill="#FF0000"/><path d="M11 13h18l-7 8v6l-4 2v-8z" fill="#fff"/></svg>';
  const SEARCH_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="M15 15l6 6"/></svg>';

  function homeGrid() {
    return document.querySelector('ytd-browse[page-subtype="home"]:not([hidden]) ytd-rich-grid-renderer');
  }

  function goalQuery(g) {
    return g.name || Y.splitGoal(g.text || "").want.slice(0, 80) || g.id;
  }

  function buildDriftPanel() {
    const panel = document.createElement("section");
    panel.id = "yff-drift";
    panel.setAttribute("aria-label", "Feed drift notice");
    panel.innerHTML = MARK_SVG +
      '<div class="yff-drift-main"><div class="yff-drift-head">Your feed has drifted from your goals</div>' +
      '<div class="yff-drift-body"></div>' +
      '<div class="yff-drift-sub">What you watch shapes what YouTube suggests next. A few picks from your goals pull the feed back.</div>' +
      '<div class="yff-drift-goals"></div>' +
      '<div class="yff-drift-acts"><button type="button" class="yff-drift-reveal">Show what was filtered</button>' +
      '<button type="button" class="yff-drift-dismiss">Not today</button></div></div>';
    panel.querySelector(".yff-drift-reveal").addEventListener("click", () => {
      html().setAttribute("data-yff-reveal", "");
    });
    panel.querySelector(".yff-drift-dismiss").addEventListener("click", () => {
      driftDismissed = Y.localDay(new Date());
      chrome.storage.local.set({ driftDismissed }).catch(() => {});
      updateDrift();
    });
    return panel;
  }

  function fillDriftGoals(panel) {
    const list = goals();
    const key = list.map(goalQuery).join("\u0001");
    if (panel.dataset.goals === key) return;
    panel.dataset.goals = key;
    const box = panel.querySelector(".yff-drift-goals");
    box.textContent = "";
    for (const g of list) {
      const a = document.createElement("a");
      a.className = "yff-drift-goal";
      a.href = `https://www.youtube.com/results?search_query=${encodeURIComponent(goalQuery(g))}`;
      a.innerHTML = SEARCH_SVG;
      a.append(goalQuery(g));
      box.appendChild(a);
    }
  }

  function updateDrift() {
    const grid = homeGrid();
    const share = Y.driftShare(grid ? [...grid.querySelectorAll(HOME)].map((h) => h.dataset.yffReason) : []);
    driftActive = !!grid && Y.driftOn(driftActive, share, Number(settings && settings.driftPercent) || 0);
    html().dataset.yffDrift = JSON.stringify({ on: driftActive, ...share }); // read by the end-to-end check
    let panel = document.getElementById("yff-drift");
    if (!driftActive || driftDismissed === Y.localDay(new Date())) {
      if (panel) panel.remove();
      return;
    }
    if (!panel || panel.parentNode !== grid) {
      if (panel) panel.remove();
      panel = buildDriftPanel();
      const contents = grid.querySelector(":scope > #contents");
      grid.insertBefore(panel, contents || grid.firstChild);
    }
    fillDriftGoals(panel);
    panel.querySelector(".yff-drift-body").textContent =
      `Of ${share.scored} videos scored, ${share.fit} fit your goals (${Math.round(share.percent)}% rejected).`;
  }

  function setScorerDown(down, why) {
    if (down === scorerDown && !down) return;
    scorerDown = down;
    if (down && !tabOff()) {
      banner("scorer", `Can\u2019t reach the scorer (${why}). Videos stay blurred.`, [
        ["Pause on this tab", () => setTabOff(true)],
        ["Retry", () => { clearBanner("scorer"); retryErrors(); }, true],
      ]);
    } else if (!down) {
      clearBanner("scorer");
    }
  }

  function retryErrors() {
    for (const host of document.querySelectorAll(HOSTS)) {
      if (host.dataset.yffState === "error" && host.yffMeta) decide(host, host.yffMeta);
    }
  }

  function setTabOff(off) {
    if (off) {
      sessionStorage.setItem("yff-off", "1");
      html().setAttribute("data-yff-off", "");
      clearBanner();
    } else {
      sessionStorage.removeItem("yff-off");
      html().removeAttribute("data-yff-off");
      scanSoon(); // cards that arrived while off are undecided (and blurred again now)
    }
    sendCounts();
  }

  // A feed "page" is the set of cards YouTube appends together with a fresh continuation
  // element (the spinner at the end of the grid that triggers the next load). Count
  // consecutive pages where every card ended up hidden: YouTube keeps loading while the
  // grid is short, so an all-hidden feed could otherwise loop forever.
  function trackFeedPages(fresh) {
    let page = pages.get(pageSeq);
    if (fresh.length) {
      if (!page) pages.set(pageSeq, (page = { hosts: new Set(), closed: false }));
      for (const h of fresh) {
        page.hosts.add(h);
        h.dataset.yffPage = String(pageSeq);
      }
    }
    const conts = document.querySelectorAll("ytd-rich-grid-renderer ytd-continuation-item-renderer");
    let newContinuation = false;
    for (const c of conts) if (!seenContinuations.has(c)) { seenContinuations.add(c); newContinuation = true; }
    if (newContinuation && page) {
      page.closed = true;
      pagesClosed += 1;
      html().dataset.yffPagesClosed = String(pagesClosed);
      const id = pageSeq;
      pageSeq += 1;
      evaluatePage(id);
    }
    updateHold();
  }

  // While a loaded page is still being judged, hide the continuation spinner so YouTube does
  // not fetch the next page yet. Otherwise a page already in flight slips past the cap.
  // A safety timer releases the hold if judging stalls.
  let holdTimer = null;
  function updateHold() {
    const waiting = [...pages.values()].some((p) => p.closed);
    if (waiting && !html().hasAttribute("data-yff-hold-loading")) {
      html().setAttribute("data-yff-hold-loading", "");
      clearTimeout(holdTimer);
      holdTimer = setTimeout(() => html().removeAttribute("data-yff-hold-loading"), 5000);
    } else if (!waiting) {
      clearTimeout(holdTimer);
      html().removeAttribute("data-yff-hold-loading");
    }
  }

  function noteBatchProgress(host) {
    const id = host.dataset.yffPage;
    if (id !== undefined) evaluatePage(Number(id));
  }

  function evaluatePage(id) {
    const page = pages.get(id);
    if (!page || !page.closed) return;
    const states = [...page.hosts].map((h) => h.dataset.yffState);
    if (states.some((s) => !s || s === "pending")) return;
    pages.delete(id);
    consecutiveEmpty = states.every((s) => s === "hide") ? consecutiveEmpty + 1 : 0;
    html().dataset.yffConsecutiveEmpty = String(consecutiveEmpty);
    updateHold();
    const cap = Number(settings.autoLoadCap) || 0;
    if (cap > 0 && consecutiveEmpty >= cap && !html().hasAttribute("data-yff-stop-loading")) {
      html().setAttribute("data-yff-stop-loading", "");
      banner("autoload", `The last ${consecutiveEmpty} loads had nothing to show, so loading paused`, [
        ["Load more", () => {
          consecutiveEmpty = 0;
          html().removeAttribute("data-yff-stop-loading");
          clearBanner("autoload");
          window.scrollBy(0, 1);
        }],
      ]);
    }
  }

  // ---- wiring -----------------------------------------------------------------------------
  function resetForNavigation() {
    pages.clear();
    consecutiveEmpty = 0;
    driftActive = false;
    html().removeAttribute("data-yff-stop-loading");
    clearBanner("autoload");
    scanSoon();
    scheduleCounts();
  }

  function redecideAll() {
    for (const host of document.querySelectorAll(HOSTS)) {
      if (!host.yffMeta) continue;
      delete host.dataset.yffState;
      decide(host, host.yffMeta);
    }
  }

  async function loadSettings() {
    const got = await chrome.storage.local.get(["settings", "overrides", "driftDismissed"]);
    settings = Y.migrateSettings(got.settings);
    overrides = got.overrides || {};
    driftDismissed = got.driftDismissed || "";
  }

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local") return;
    if (changes.overrides) overrides = changes.overrides.newValue || {};
    if (changes.driftDismissed) {
      driftDismissed = changes.driftDismissed.newValue || "";
      scheduleCounts();
    }
    if (changes.settings) {
      await loadSettings();
      if (waitingForSetup) {
        if (Y.setupComplete(settings)) begin();
        return;
      }
      redecideAll();
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "reveal") {
      if (msg.on) html().setAttribute("data-yff-reveal", "");
      else html().removeAttribute("data-yff-reveal");
    } else if (msg.type === "setTabOff") {
      setTabOff(msg.off);
    } else if (msg.type === "retry") {
      clearBanner("scorer");
      retryErrors();
    } else if (msg.type === "getState") {
      sendResponse({ counts: counts(), off: tabOff(), reveal: html().hasAttribute("data-yff-reveal"), scorerDown, needsSetup: waitingForSetup });
      return;
    }
    sendResponse({ ok: true });
  });

  // Until a key and a goal exist, nothing is blurred or sent: the page is marked off, as a
  // paused tab is, and filtering begins when the setup page saves. The off mark is set only
  // after settings load, so a set-up install keeps blur-first from document_start.
  async function start() {
    if (tabOff()) html().setAttribute("data-yff-off", "");
    await loadSettings();
    if (!Y.setupComplete(settings)) {
      waitingForSetup = true;
      html().dataset.yffSetup = "needed";
      html().setAttribute("data-yff-off", "");
      return;
    }
    begin();
  }

  function begin() {
    waitingForSetup = false;
    delete html().dataset.yffSetup;
    if (!tabOff()) html().removeAttribute("data-yff-off");
    new MutationObserver(onMutations).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ["data-yff-meta", "href"] });
    document.addEventListener("yt-navigate-finish", resetForNavigation);
    document.addEventListener("click", (e) => { if (!e.target.closest || !e.target.closest(".yff-overlay")) closeMenus(); }, true);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenus(); });
    setInterval(scanSoon, 500); // catches DOM-fallback timeouts and quiet re-renders
    scanSoon();
  }

  start();
})();
