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

  const READABLE = new Set(["show", "uncertain", "revealed"]);

  let settings = null;
  let overrides = {};
  const pCache = new Map(); // `${goalsHash}|${videoId}` -> {p, goalId, about}, for this tab's lifetime
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
  let kindPick = ""; // the kind chosen in the bar above the home grid; "" shows all
  let firstRun = ""; // "pending" from the setup page's save until the first-run panel is closed

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
  // failed cards, and a three-dot menu with the match line, Keep and Hide. A maybe card has no
  // three-dot menu: a bar across the top of its thumbnail asks "On goal?" with Yes and No, always
  // visible, so a correction is one click.
  const OVERLAY_HTML =
    '<div class="yff-thumb">' +
      '<span class="yff-badge"></span>' +
      '<span class="yff-pill">Checking\u2026</span>' +
      '<button class="yff-more" type="button" aria-label="Feed Filter actions" aria-haspopup="menu" aria-expanded="false">' +
        '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg></button>' +
      '<div class="yff-menu" role="menu">' +
        '<button class="yff-keep" type="button" role="menuitem">Keep, it\u2019s on goal</button>' +
        '<button class="yff-hide" type="button" role="menuitem">Hide, not for me</button>' +
      '<button class="yff-notbait" type="button" role="menuitem">Not clickbait</button>' +
        '<div class="yff-sep"></div><div class="yff-match"></div>' +
      '</div>' +
      '<div class="yff-ask"><span class="yff-ask-text"></span>' +
        '<button class="yff-keep" type="button" aria-label="Keep, it\u2019s on goal">' +
          '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>Yes</button>' +
        '<button class="yff-hide" type="button" aria-label="Hide, not for me">' +
          '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>No</button>' +
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
    renderTags(host);
  }

  // The kind and the clickbait label, as badges in the bottom left corner of YouTube's own
  // thumbnail element, so they belong to the card like the duration badge in the other corner.
  const WARN_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M12 4L2.5 20h19z"/><path d="M12 10v4M12 17v.01"/></svg>';
  function renderTags(host) {
    let tags = host.querySelector(".yff-tags");
    const kind = host.dataset.yffKind || "";
    const bait = host.dataset.yffClickbait === "1";
    if (!kind && !bait) {
      if (tags) tags.remove();
      return;
    }
    if (!tags) {
      const thumb = host.querySelector("yt-thumbnail-view-model");
      if (!thumb) return;
      tags = document.createElement("div");
      tags.className = "yff-tags";
      thumb.appendChild(tags);
    }
    const key = `${kind}|${bait}`;
    if (tags.dataset.key === key) return;
    tags.dataset.key = key;
    tags.textContent = "";
    const add = (text, icon) => {
      const el = document.createElement("div");
      el.className = "yff-tag";
      el.innerHTML = icon;
      el.append(text);
      tags.appendChild(el);
    };
    if (kind) add(kind, "");
    if (bait) add("Clickbait", WARN_SVG);
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
    else if (d.byRule) match = `${d.match} for ${d.goal}, but filtered: ${d.detail}.`;
    else if (d.p != null) match = `${d.match} for ${d.goal}. ${marks}`;
    else if (d.detail) match = `${d.label}: ${d.detail}.`;
    const bait = host.dataset.yffClickbait === "1";
    if (bait && !d.byRule) match += `${match ? " " : ""}The title reads as clickbait.`;
    box.querySelector(".yff-menu .yff-notbait").hidden = !bait;
    box.querySelector(".yff-match").textContent = match;
    box.querySelector(".yff-match").hidden = !match;
    box.querySelector(".yff-ask-text").textContent = d.p != null ? `On goal? ${d.match}` : "On goal?";
    let title = "";
    if (state === "error") title = "Couldn\u2019t check this video";
    else if (d.label === "Too short") title = `Filtered \u00b7 ${d.detail}`;
    else title = d.detail ? `${d.label} \u00b7 ${d.detail}` : d.label;
    box.querySelector(".yff-reason").textContent = title;
    const meta = host.yffMeta;
    box.querySelector(".yff-title").textContent = meta && meta.title ? meta.title : "";
  }

  // ---- match chip on hover -----------------------------------------------------------
  // YouTube's preview player covers the thumbnail within 200 ms of the pointer arriving and
  // takes the pointer with it (measured 2026-11-17), so nothing inside the card stays visible.
  // The chip is one element in the page, above the preview, styled like YouTube's duration
  // badge and placed in the opposite corner. It holds while the pointer is inside the card's box.
  let hoverHost = null;

  function hoverChip() {
    let chip = document.getElementById("yff-hover");
    if (!chip) {
      chip = document.createElement("div");
      chip.id = "yff-hover";
      chip.hidden = true;
      document.body.appendChild(chip);
    }
    return chip;
  }

  function hideHover() {
    hoverHost = null;
    const chip = document.getElementById("yff-hover");
    if (chip) chip.hidden = true;
  }

  function showHover(host) {
    const thumb = host.querySelector(":scope > .yff-overlay > .yff-thumb");
    const d = Y.describe(host.dataset.yffReason, settings ? settings.goals : []);
    if (thumb && thumb.parentElement.classList.contains("yff-open")) return hideHover();
    if (!thumb || d.p == null || !READABLE.has(host.dataset.yffState)) return hideHover();
    const r = thumb.getBoundingClientRect();
    const chip = hoverChip();
    // The watch-page sidebar's thumbnail is too narrow for the goal's name beside the duration.
    chip.textContent = r.width >= 240 ? `${d.match} \u00b7 ${d.goal}` : d.match;
    chip.dataset.state = host.dataset.yffState;
    chip.style.left = `${r.left + window.scrollX + 8}px`;
    chip.style.top = `${r.bottom + window.scrollY - 8}px`;
    chip.style.maxWidth = `${Math.max(0, r.width - 80)}px`; // leaves the duration badge clear
    chip.hidden = false;
    hoverHost = host;
  }

  function onPointerOver(e) {
    const host = e.target.closest ? e.target.closest(HOSTS) : null;
    if (host) {
      if (host !== hoverHost) showHover(host);
      return;
    }
    if (hoverHost && hoverHost.isConnected) {
      const r = hoverHost.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return; // on the preview
    }
    hideHover();
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
    if (host === hoverHost) showHover(host);
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

  // Sets the card's tags from what Jev said about the video, then decides it.
  function applyScored(host, meta, { p, goalId, about: raw }, source) {
    const about = raw && overrides[Y.notClickbaitKey(meta.videoId)] ? { ...raw, clickbait: 0 } : raw;
    host.dataset.yffGoal = goalId;
    host.dataset.yffKind = Y.kindOf(about) || "";
    host.dataset.yffClickbait = Y.isClickbait(about, meta.title, settings) ? "1" : "";
    const d = Y.decideScored(meta, settings, p, goalId, about);
    apply(host, d.state, d.reason, source);
  }

  function decide(host, meta) {
    host.dataset.yffKind = "";
    host.dataset.yffClickbait = "";
    if (!goals().length) return apply(host, "error", "no goal set", "rule");
    const override = meta.videoId ? overrides[overrideKey(meta.videoId)] : null;
    const ruled = Y.applyRules(meta, settings, override);
    if (ruled) {
      apply(host, ruled.state, ruled.reason, ruled.reason.startsWith("override") ? "override" : "rule");
      if (ruled.state === "hide" && ruled.reason.startsWith("rule:")) tally(meta, ruled.reason, host);
      return;
    }
    if (!meta.videoId) return apply(host, "error", "could not read this card", "rule");
    if (meta.title) cardMeta.set(meta.videoId, { title: meta.title, channel: meta.channel || "" });
    const hit = pCache.get(`${Y.goalsKey(goals())}|${meta.videoId}`);
    if (hit) return applyScored(host, meta, hit, "session");
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
        host.removeAttribute("data-yff-offkind");
        if (reused) host.dataset.yffTSeen = String(now);
        host.yffMeta = meta;
        decide(host, meta);
      } else if (!host.dataset.yffState) {
        host.yffMeta = meta;
        decide(host, meta); // re-blurred by reblurIfReused and now consistent again
      } else if (!host.querySelector(":scope > .yff-overlay")) {
        ensureOverlay(host); // YouTube re-rendered the card and dropped our overlay
      } else if ((host.dataset.yffKind || host.dataset.yffClickbait) && !host.querySelector(".yff-tags")) {
        renderTags(host); // or only its thumbnail
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
      const scored = { p: r.p, goalId: r.goalId, about: r.about || null };
      pCache.set(`${key}|${meta.videoId}`, scored);
      applyScored(host, meta, scored, r.source);
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
    if (btn.classList.contains("yff-notbait")) return markNotClickbait(host, meta);
    const overlay = btn.closest(".yff-overlay");
    if (btn.classList.contains("yff-more") || btn.classList.contains("yff-why")) {
      const open = !overlay.classList.contains("yff-open");
      closeMenus(overlay);
      overlay.classList.toggle("yff-open", open);
      if (open) hideHover(); // the match chip sits above the page and would cover the menu
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

  async function markNotClickbait(host, meta) {
    closeMenus();
    const reason = host.dataset.yffReason || "";
    const pMatch = /p=([\d.]+)/.exec(reason);
    const best = goals().find((g) => g.id === host.dataset.yffGoal) || goals()[0];
    overrides[Y.notClickbaitKey(meta.videoId)] = "no";
    await chrome.storage.local.set({ overrides });
    const kept = host.dataset.yffState === "revealed" || reason.startsWith("override:");
    if (kept) {
      host.dataset.yffClickbait = ""; // the Keep stands; only the label goes
      ensureOverlay(host);
    } else {
      decide(host, meta);
    }
    scheduleCounts();
    if (!best) return;
    chrome.runtime.sendMessage({ type: "feedback", body: {
      goal: best.text, action: "notClickbait", p: pMatch ? Number(pMatch[1]) : null, previousVerdict: host.dataset.yffState,
      reason: reason.slice(0, 80), video: Y.videoPayload(meta) } }).catch(() => {});
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
    const c = { shown: 0, hidden: 0, uncertain: 0, pending: 0, clickbait: 0 };
    for (const host of document.querySelectorAll(HOSTS)) {
      if (!onVisiblePage(host)) continue;
      const s = host.dataset.yffState;
      if (s === "show" || s === "revealed") c.shown += 1;
      else if (s === "hide") c.hidden += 1;
      else if (s === "uncertain" || s === "error") c.uncertain += 1;
      else c.pending += 1;
      if (READABLE.has(s) && host.dataset.yffClickbait === "1") c.clickbait += 1;
    }
    c.drift = driftActive;
    return c;
  }

  function sendCounts() {
    countsTimer = null;
    updateDrift();
    updateFirstRun();
    updateKinds();
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

  // ---- kinds bar -----------------------------------------------------------------------
  // Chips above the home grid: one per kind among the readable cards. Picking one shows only
  // that kind from what is already loaded, and pauses infinite scroll, which would otherwise
  // keep loading pages to fill the grid. "All" brings everything back.
  function updateKinds() {
    const grid = homeGrid();
    const bar = document.getElementById("yff-kinds");
    const cards = grid ? [...grid.querySelectorAll(HOME)] : [];
    const kindName = (h) => h.dataset.yffKind || Y.NOT_SURE;
    const readable = cards.filter((h) => READABLE.has(h.dataset.yffState));
    const tally = new Map();
    for (const h of readable) tally.set(kindName(h), (tally.get(kindName(h)) || 0) + 1);
    if (kindPick && !tally.has(kindPick)) kindPick = "";
    for (const h of cards) h.toggleAttribute("data-yff-offkind", !!kindPick && kindName(h) !== kindPick);
    html().toggleAttribute("data-yff-kind-pick", !!kindPick);
    if (tabOff() || !Y.KIND_LIST.some((k) => tally.has(k))) {
      if (bar) bar.remove();
      return;
    }
    const chips = [["", "All", readable.length], ...[...Y.KIND_LIST, Y.NOT_SURE].filter((k) => tally.has(k)).map((k) => [k, k, tally.get(k)])];
    const key = JSON.stringify([kindPick, chips]);
    if (bar && bar.parentNode === grid && bar.dataset.key === key) return;
    const focused = bar && bar.contains(document.activeElement) ? document.activeElement.dataset.kind : null;
    const el = bar && bar.parentNode === grid ? bar : document.createElement("div");
    if (bar && el !== bar) bar.remove();
    el.id = "yff-kinds";
    el.dataset.key = key;
    el.setAttribute("role", "group");
    el.setAttribute("aria-label", "Kinds of video");
    el.textContent = "";
    for (const [value, label, n] of chips) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.kind = value;
      b.setAttribute("aria-pressed", String(value === kindPick));
      b.textContent = `${label} ${n}`;
      b.addEventListener("click", () => {
        kindPick = value;
        updateKinds();
      });
      el.appendChild(b);
    }
    if (!el.parentNode) grid.insertBefore(el, grid.querySelector(":scope > #contents") || grid.firstChild);
    if (focused !== null) [...el.children].find((b) => b.dataset.kind === focused)?.focus();
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

  // ---- first-run check -------------------------------------------------------------------
  // After the setup page saves, a panel at the bottom right of the home page counts the cards
  // as they are checked, then reports how many serve the goals. The numbers are taken once,
  // when the first load has been scored, and the panel stays until Done or the X is pressed.
  const FIRST_RUN_EMPTY_MS = 8000; // no card by then: the home feed is empty
  const FIRST_RUN_QUIET_MS = 1500; // nothing waiting for this long: the first load is scored
  const FIRST_RUN_MAX_MS = 30000; // report what is scored by then, however much is still loading
  let firstRunScore = null;
  let firstRunSince = 0;
  let firstRunQuiet = null;
  const onHome = () => location.pathname === "/";

  function homeScore() {
    return Y.feedScore([...document.querySelectorAll(HOME)].filter(onVisiblePage).map((h) => h.dataset.yffState));
  }

  function buildFirstRunPanel() {
    const panel = document.createElement("section");
    panel.id = "yff-firstrun";
    panel.setAttribute("aria-label", "Feed Filter first check");
    panel.innerHTML = '<div class="yff-fr-head">' + MARK_SVG + '<b>Feed Filter</b><button type="button" class="yff-fr-x" aria-label="Close">\u00d7</button></div>' +
      '<div class="yff-fr-title" role="status"></div><div class="yff-fr-sub"></div>' +
      '<div class="yff-fr-bar"><span class="yff-fr-on"></span><span class="yff-fr-maybe"></span><span class="yff-fr-hidden"></span></div>' +
      '<div class="yff-fr-legend"><span class="yff-fr-on"></span><span class="yff-fr-maybe"></span><span class="yff-fr-hidden"></span></div>' +
      '<div class="yff-fr-acts"><button type="button" class="yff-fr-reveal">See what was hidden</button><span></span>' +
      '<button type="button" class="yff-fr-adjust">Adjust goal</button><button type="button" class="yff-fr-done">Done</button></div>';
    const close = () => {
      firstRun = "done";
      chrome.storage.local.set({ firstRun }).catch(() => {});
      updateFirstRun();
    };
    panel.querySelector(".yff-fr-x").addEventListener("click", close);
    panel.querySelector(".yff-fr-done").addEventListener("click", close);
    panel.querySelector(".yff-fr-reveal").addEventListener("click", () => {
      html().toggleAttribute("data-yff-reveal");
      updateFirstRun();
    });
    panel.querySelector(".yff-fr-adjust").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "openOptions" }).catch(() => {});
    });
    return panel;
  }

  function firstRunState(score, elapsed) {
    if (firstRunScore) return "done";
    if (scorerDown) return "down";
    const nothing = !score.checked && !score.pending && !score.failed;
    return nothing && elapsed > FIRST_RUN_EMPTY_MS ? "empty" : "checking";
  }

  // Takes the numbers once the first load is scored: nothing waiting for FIRST_RUN_QUIET_MS,
  // or FIRST_RUN_MAX_MS gone by with something scored.
  function settleFirstRun(score, elapsed) {
    const quiet = score.checked > 0 && score.pending === 0;
    if (quiet && !firstRunQuiet) {
      firstRunQuiet = setTimeout(() => {
        firstRunQuiet = null;
        const now = homeScore();
        if (firstRun === "pending" && !firstRunScore && now.checked > 0 && now.pending === 0) firstRunScore = now;
        updateFirstRun();
      }, FIRST_RUN_QUIET_MS);
    } else if (!quiet && firstRunQuiet) {
      clearTimeout(firstRunQuiet);
      firstRunQuiet = null;
    }
    if (!firstRunScore && score.checked > 0 && elapsed > FIRST_RUN_MAX_MS) firstRunScore = score;
  }

  function updateFirstRun() {
    let panel = document.getElementById("yff-firstrun");
    if (firstRun !== "pending" || tabOff() || !onHome()) {
      if (panel) panel.remove();
      delete html().dataset.yffFirstRun;
      return;
    }
    if (!panel) {
      if (!document.body) return void setTimeout(updateFirstRun, 200); // document_start: no body yet
      panel = buildFirstRunPanel();
      document.body.appendChild(panel);
      firstRunSince = performance.now();
      setTimeout(updateFirstRun, FIRST_RUN_EMPTY_MS + 100);
      setTimeout(updateFirstRun, FIRST_RUN_MAX_MS + 100);
    }
    const elapsed = performance.now() - firstRunSince;
    const live = homeScore();
    if (!firstRunScore && !scorerDown) settleFirstRun(live, elapsed);
    const state = firstRunState(live, elapsed);
    const score = firstRunScore || live;
    const title = panel.querySelector(".yff-fr-title");
    const sub = panel.querySelector(".yff-fr-sub");
    const width = (n, of) => `${of ? (100 * n) / of : 0}%`;
    panel.dataset.state = state;
    title.textContent = "";
    if (state === "done") {
      const n = document.createElement("em");
      n.textContent = `${score.onGoal} of ${score.checked}`;
      title.append(n, ` videos serve your ${goals().length > 1 ? "goals" : "goal"}`);
      const rest = score.checked - score.onGoal;
      sub.textContent = rest ? `The other ${rest} ${rest === 1 ? "is" : "are"} what YouTube thinks will keep you watching.` : "Every video on this page serves you.";
      for (const [cls, count, label] of [["on", score.onGoal, "on goal"], ["maybe", score.maybe, "maybe"], ["hidden", score.hidden, "hidden"]]) {
        panel.querySelector(`.yff-fr-bar .yff-fr-${cls}`).style.width = width(count, score.checked);
        panel.querySelector(`.yff-fr-legend .yff-fr-${cls}`).textContent = `${count} ${label}`;
      }
      const reveal = panel.querySelector(".yff-fr-reveal");
      reveal.textContent = html().hasAttribute("data-yff-reveal") ? "Hide them again" : "See what was hidden";
      reveal.hidden = !score.hidden;
    } else if (state === "empty") {
      title.textContent = "Nothing to check yet";
      sub.textContent = "Your home feed is empty. That happens when you are signed out or your watch history is off.";
    } else if (state === "down") {
      title.textContent = "Could not check your feed";
      sub.textContent = "Feed Filter cannot reach Jev. The message at the bottom left says why.";
    } else {
      const total = score.checked + score.failed + score.pending;
      title.textContent = "Checking your home feed";
      sub.textContent = total ? `${score.checked} of ${total} checked against ${goals().map(goalQuery).join(", ")}` : "Waiting for YouTube to load your feed.";
      panel.querySelector(".yff-fr-bar .yff-fr-on").style.width = width(score.checked, total);
      panel.querySelector(".yff-fr-bar .yff-fr-maybe").style.width = "0%";
      panel.querySelector(".yff-fr-bar .yff-fr-hidden").style.width = "0%";
    }
    html().dataset.yffFirstRun = JSON.stringify({ state, ...score }); // read by the end-to-end check
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

  // ---- watched videos ----------------------------------------------------------------------
  // A watch page that stays open for WATCH_MS is logged (id, title, channel) in the browser.
  // The dashboard's feed profile counts them per topic.
  const WATCH_MS = 10000;
  const cardMeta = new Map(); // videoId -> {title, channel}, from the cards scored in this tab
  let watchTimer = null;
  const watchPageId = () => (location.pathname === "/watch" ? new URLSearchParams(location.search).get("v") : null);

  function noteWatchPage() {
    clearTimeout(watchTimer);
    const videoId = watchPageId();
    if (!videoId || !Y.VIDEO_ID.test(videoId)) return;
    watchTimer = setTimeout(() => {
      if (watchPageId() !== videoId || tabOff()) return;
      const known = cardMeta.get(videoId) || {};
      const owner = document.querySelector("ytd-watch-metadata ytd-channel-name a");
      const title = known.title || document.title.replace(/^\(\d+\) /, "").replace(/ - YouTube$/, "");
      if (!title || title === "YouTube") return;
      try {
        chrome.runtime.sendMessage({ type: "watched", video: { videoId, title, channel: known.channel || (owner ? owner.textContent.trim() : "") } }).catch(() => {});
      } catch (err) {
        // The extension was reloaded and this script is orphaned.
      }
    }, WATCH_MS);
  }

  // ---- wiring -----------------------------------------------------------------------------
  function resetForNavigation() {
    hideHover();
    noteWatchPage();
    pages.clear();
    consecutiveEmpty = 0;
    driftActive = false;
    kindPick = "";
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
    const got = await chrome.storage.local.get(["settings", "overrides", "driftDismissed", "firstRun"]);
    settings = Y.migrateSettings(got.settings);
    overrides = got.overrides || {};
    driftDismissed = got.driftDismissed || "";
    firstRun = got.firstRun || "";
  }

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local") return;
    if (changes.overrides) overrides = changes.overrides.newValue || {};
    if (changes.firstRun) {
      firstRun = changes.firstRun.newValue || "";
      if (firstRun === "pending") firstRunScore = null; // setup was saved again: check afresh
      scheduleCounts();
    }
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
    document.addEventListener("mouseover", onPointerOver, true);
    document.documentElement.addEventListener("mouseleave", hideHover);
    setInterval(scanSoon, 500); // catches DOM-fallback timeouts and quiet re-renders
    scanSoon();
    scheduleCounts(); // the first-run panel must appear even when the feed never loads a card
    noteWatchPage();
  }

  start();
})();
