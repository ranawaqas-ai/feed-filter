// GENERATED from core.js by extension/sync_core.mjs; do not edit. Loaded in the page's MAIN world.
// Pure logic shared by the page bridge (MAIN world), the content script and Node tests:
// extraction from YouTube's data objects, parsing, language detection, rules and bands.
// No chrome.* APIs and no DOM access except in extractFromDom.
(function (root) {
  "use strict";

  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

  // "11:21" -> 681, "1:02:03" -> 3723; anything else -> null
  function parseDuration(text) {
    if (typeof text !== "string" || !/^\d+(:\d{2}){1,2}$/.test(text.trim())) return null;
    return text.trim().split(":").map(Number).reduce((acc, n) => acc * 60 + n, 0);
  }

  const WORD_SCALE = { thousand: 1e3, million: 1e6, billion: 1e9 };
  const LETTER_SCALE = { K: 1e3, M: 1e6, B: 1e9 };

  // "390 thousand views", "1.2 million views", "12,345 views", "390K views", "1.2M", "No views"
  function parseViews(text) {
    if (typeof text !== "string") return null;
    const t = text.trim();
    if (/^no views$/i.test(t)) return 0;
    let m = t.match(/^([\d.,]+)\s*(thousand|million|billion)\b/i);
    if (m) return Math.round(parseFloat(m[1].replace(/,/g, "")) * WORD_SCALE[m[2].toLowerCase()]);
    m = t.match(/^([\d.,]+)\s*([KMB])\b/);
    if (m) return Math.round(parseFloat(m[1].replace(/,/g, "")) * LETTER_SCALE[m[2]]);
    m = t.match(/^([\d,]+)\s*views?$/i);
    if (m) return parseInt(m[1].replace(/,/g, ""), 10);
    return null;
  }

  function badgeTexts(contentImage) {
    const out = [];
    const walk = (o) => {
      if (!o || typeof o !== "object") return;
      if (o.thumbnailBadgeViewModel && typeof o.thumbnailBadgeViewModel.text === "string") {
        out.push(o.thumbnailBadgeViewModel.text);
      }
      for (const v of Object.values(o)) walk(v);
    };
    walk(contentImage);
    return out;
  }

  const KIND_BY_CONTENT_TYPE = {
    LOCKUP_CONTENT_TYPE_VIDEO: "video",
    LOCKUP_CONTENT_TYPE_PLAYLIST: "playlist",
    LOCKUP_CONTENT_TYPE_PODCAST: "podcast",
  };

  // One lockupViewModel (home feed and watch sidebar) -> normalised item.
  function extractLockup(l) {
    if (!l || typeof l !== "object") return null;
    const kind = KIND_BY_CONTENT_TYPE[l.contentType] || "other";
    const meta = l.metadata && l.metadata.lockupMetadataViewModel;
    const title = (meta && meta.title && meta.title.content) || "";
    const rows = (meta && meta.metadata && meta.metadata.contentMetadataViewModel &&
      meta.metadata.contentMetadataViewModel.metadataRows) || [];
    const parts = rows.flatMap((r) => r.metadataParts || []);
    let channel = "";
    let viewCount = null;
    for (const p of parts) {
      const text = (p.text && p.text.content) || "";
      const label = p.accessibilityLabel || "";
      if (/\bviews?$/i.test(label) || /\bviews?$/i.test(text)) {
        viewCount = parseViews(label) ?? parseViews(text);
      } else if (!channel && text && !/\bago$/i.test(label) && !/\bago$/i.test(text) && text !== "Playlist") {
        channel = text;
      }
    }
    const badges = badgeTexts(l.contentImage);
    const durationText = badges.find((b) => parseDuration(b) !== null) || null;
    const id = l.contentId || null;
    return {
      kind,
      videoId: kind === "video" && VIDEO_ID.test(id || "") ? id : null,
      contentId: id,
      title,
      channel,
      durationSeconds: durationText ? parseDuration(durationText) : null,
      viewCount,
      isShort: false,
      isLive: badges.some((b) => /^live$/i.test(b)),
      isUpcoming: badges.some((b) => /^upcoming$/i.test(b)),
      description: "", // home-feed and sidebar data carry no description snippet
      source: "data",
    };
  }

  function extractShortsLockup(s) {
    const m = /([A-Za-z0-9_-]{11})$/.exec(s.entityId || "");
    const title = (s.overlayMetadata && s.overlayMetadata.primaryText && s.overlayMetadata.primaryText.content) || "";
    const viewsText = (s.overlayMetadata && s.overlayMetadata.secondaryText && s.overlayMetadata.secondaryText.content) || "";
    return {
      kind: "short", videoId: m ? m[1] : null, contentId: m ? m[1] : null, title, channel: "",
      durationSeconds: null, viewCount: parseViews(viewsText), isShort: true, isLive: false, isUpcoming: false,
      description: "", source: "data",
    };
  }

  // ytd-rich-item-renderer.data -> normalised item, or a non-video marker.
  function extractFromData(data) {
    const content = data && data.content;
    if (!content) return { kind: "unknown", videoId: null, source: "data" };
    if (content.lockupViewModel) return extractLockup(content.lockupViewModel);
    if (content.shortsLockupViewModel) return extractShortsLockup(content.shortsLockupViewModel);
    if (content.miniGameCardViewModel) return { kind: "game", videoId: null, title: "", source: "data" };
    if (content.adSlotRenderer) return { kind: "ad", videoId: null, title: "", source: "data" };
    return { kind: "unknown", videoId: null, source: "data", keys: Object.keys(content) };
  }

  function videoIdFromHref(href) {
    if (!href) return null;
    const m = /[?&]v=([A-Za-z0-9_-]{11})/.exec(href) || /\/shorts\/([A-Za-z0-9_-]{11})/.exec(href);
    return m ? m[1] : null;
  }

  // Fallback when the data object is unavailable: read visible text, anchored on element names.
  function extractFromDom(host) {
    const link = host.querySelector("a[href*='/watch?v='], a[href^='/shorts/']");
    const href = link ? link.getAttribute("href") : null;
    const videoId = videoIdFromHref(href);
    const isShort = !!(href && href.startsWith("/shorts/"));
    const titleEl = host.querySelector("h3 a, h3, [id='video-title']");
    const title = (titleEl && (titleEl.getAttribute("title") || titleEl.textContent) || "").trim();
    const meta = host.querySelector("yt-content-metadata-view-model");
    const metaParts = meta ? [...meta.querySelectorAll("span")].map((s) => s.textContent.trim()).filter(Boolean) : [];
    const viewsPart = metaParts.find((t) => /views?$/i.test(t));
    const channel = metaParts.find((t) => t !== viewsPart && !/ago$/i.test(t) && t !== "•") || "";
    const badge = [...host.querySelectorAll("yt-thumbnail-badge-view-model")].map((b) => b.textContent.trim())
      .find((t) => parseDuration(t) !== null);
    return {
      kind: videoId ? (isShort ? "short" : "video") : "unknown", videoId, contentId: videoId, title, channel,
      durationSeconds: badge ? parseDuration(badge) : null, viewCount: viewsPart ? parseViews(viewsPart) : null,
      isShort, isLive: false, isUpcoming: false, description: "", source: "dom",
    };
  }

  // --- language detection (code only, no model) ---------------------------------------
  const SCRIPT_LANGS = [
    [/[぀-ヿ]/, "ja"], [/[가-힯]/, "ko"], [/[一-鿿]/, "zh"],
    [/[ऀ-ॿ]/, "hi"], [/[ঀ-৿]/, "bn"], [/[਀-੿]/, "pa"],
    [/[஀-௿]/, "ta"], [/[ఀ-౿]/, "te"], [/[؀-ۿ]/, "arabic-script"],
    [/[֐-׿]/, "he"], [/[฀-๿]/, "th"], [/[Ѐ-ӿ]/, "ru"], [/[Ͱ-Ͽ]/, "el"],
  ];
  // Arabic script covers Urdu, Shahmukhi Punjabi, Persian and Arabic. Letters only Urdu uses
  // (retroflex ٹ ڈ ڑ, noon ghunna ں, bari ye ے, do-chashmi he ھ, gol he ہ) mark Urdu; Arabic-only
  // forms (ك ي ة ى) without any Persian/Urdu letter mark Arabic. Anything else is left
  // undecided so the model judges it.
  const URDU_ONLY = /[ٹڈڑںےۓھہۂ]/;
  const PERSO_URDU = /[پچژکگی]/;
  const ARABIC_ONLY = /[كيةى]/;
  function arabicScriptLang(t) {
    if (URDU_ONLY.test(t)) return "ur";
    if (ARABIC_ONLY.test(t) && !PERSO_URDU.test(t)) return "ar";
    return null;
  }
  const STOPWORDS = {
    en: "the and of to in is for on with how what why this that you your my are from at be it not all".split(" "),
    es: "el la los las de del que y en es por para con una un como más sin lo se su qué".split(" "),
    pt: "o a os as de do da que e em é para com uma um não como mais sem seu sua".split(" "),
    fr: "le la les de des du et en est pour avec une un que qui pas dans sur ce comment".split(" "),
    de: "der die das und ist für mit ein eine nicht auf den dem im zu von wie was ich".split(" "),
    it: "il lo la gli le di del della e è per con una un che non come più".split(" "),
    nl: "de het een en van is voor met niet op dat wat hoe".split(" "),
    id: "dan yang di ini itu untuk dengan tidak cara dari ke ada".split(" "),
    tr: "ve bir bu için ile ne nasıl çok daha değil".split(" "),
    "hi-Latn": "hai ka ki ke ko se mein aur nahi kya kaise ye yeh hain tha bhi".split(" "),
  };
  const STOP_INDEX = {};
  for (const [lang, words] of Object.entries(STOPWORDS)) for (const w of words) (STOP_INDEX[w] = STOP_INDEX[w] || []).push(lang);

  // Returns {lang, confidence}. lang is null when the text gives too little evidence.
  function detectLanguage(text) {
    const t = (text || "").normalize("NFC");
    const letters = t.replace(/[^\p{L}]/gu, "");
    if (letters.length < 3) return { lang: null, confidence: 0 };
    for (const [re, lang] of SCRIPT_LANGS) {
      const hits = (t.match(new RegExp(re.source, "g")) || []).length;
      if (hits / letters.length < 0.3) continue;
      const confidence = Math.min(1, hits / letters.length + 0.3);
      if (lang !== "arabic-script") return { lang, confidence };
      const sub = arabicScriptLang(t);
      return sub ? { lang: sub, confidence } : { lang: null, confidence: 0 };
    }
    const words = t.toLowerCase().split(/[^\p{L}']+/u).filter(Boolean);
    const scores = {};
    for (const w of words) for (const lang of STOP_INDEX[w] || []) scores[lang] = (scores[lang] || 0) + 1;
    if (/[ñ¿¡]/i.test(t)) scores.es = (scores.es || 0) + 2;
    if (/[ãõç]/i.test(t)) scores.pt = (scores.pt || 0) + 1.5;
    if (/[äöüß]/i.test(t)) scores.de = (scores.de || 0) + 1.5;
    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    if (!ranked.length) return { lang: null, confidence: 0 };
    const [best, top] = ranked[0];
    const second = ranked[1] ? ranked[1][1] : 0;
    const confidence = Math.max(0, Math.min(1, (top - second) / Math.max(2, words.length * 0.25)));
    return confidence >= 0.5 && top >= 2 ? { lang: best, confidence } : { lang: null, confidence };
  }

  // --- decision pipeline ---------------------------------------------------------------
  function normChannel(c) {
    return (c || "").trim().toLowerCase();
  }

  // Code rules checked before the model, in spec order. Returns {state, reason} or null when
  // the model must decide. Overrides win over everything; one function owns the order.
  function applyRules(item, settings, override) {
    if (override === "keep") return { state: "show", reason: "override:keep" };
    if (override === "hide") return { state: "hide", reason: "override:hide" };
    const channel = normChannel(item.channel);
    if (channel && (settings.allowlist || []).map(normChannel).includes(channel)) return { state: "show", reason: "rule:allowlist" };
    if (channel && (settings.blocklist || []).map(normChannel).includes(channel)) return { state: "hide", reason: "rule:blocklist" };
    if (item.isShort && settings.hideShorts) return { state: "hide", reason: "rule:shorts" };
    if (item.kind !== "video" && item.kind !== "short") {
      return settings.hideNonVideo ? { state: "hide", reason: `rule:non-video:${item.kind}` } : { state: "show", reason: `rule:non-video:${item.kind}` };
    }
    const allowed = (settings.allowedLanguages || []).map((l) => l.trim()).filter(Boolean);
    if (allowed.length) {
      const { lang } = detectLanguage(`${item.title} ${item.description || ""}`);
      // Unknown language passes through to the model; only a confident detection hides.
      if (lang && !allowed.some((a) => lang === a || lang.split("-")[0] === a)) return { state: "hide", reason: `rule:language:${lang}` };
    }
    return null;
  }

  // Goals that are scored: every saved goal with text that is not switched off.
  function activeGoals(settings) {
    return (settings.goals || []).filter((g) => g && g.id && !g.off && (g.text || "").trim());
  }

  // A goal's text is "<what I want> Not: a, b, or c." The editor shows the two parts
  // separately; joinGoal(splitGoal(t)) gives t back for the defaults (the proxy caches by
  // the exact text, so a changed byte means re-scoring).
  const NOT_MARK = " Not: ";
  function splitGoal(text) {
    const t = text || "";
    const at = t.indexOf(NOT_MARK);
    if (at < 0) return { want: t, nots: [] };
    const rest = t.slice(at + NOT_MARK.length).replace(/\.$/, "");
    const parts = rest.split(", ");
    if (parts.length > 1) parts[parts.length - 1] = parts[parts.length - 1].replace(/^or /, "");
    return { want: t.slice(0, at), nots: parts.filter(Boolean) };
  }

  function joinGoal(want, nots) {
    const items = (nots || []).map((n) => n.trim()).filter(Boolean);
    const head = (want || "").trim();
    if (!items.length) return head;
    const list = items.length === 1 ? items[0] : `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
    return `${head}${NOT_MARK}${list}.`;
  }

  function goalName(goals, id) {
    if (id === "earlier") return "An earlier goal";
    const g = (goals || []).find((x) => x.id === id);
    return (g && g.name) || id || "";
  }

  function languageName(code) {
    try {
      return new Intl.DisplayNames(["en"], { type: "language" }).of(code) || code;
    } catch {
      return code;
    }
  }

  const pct = (p) => `${Math.round(p * 100)}%`;
  const KIND_NAMES = { playlist: "Playlist", podcast: "Podcast", game: "Game", ad: "Ad", other: "Not a video", unknown: "Not a video" };

  // Reason string from the pipeline -> plain words for every surface. Nothing is stored;
  // the reason string stays the source of truth.
  // label: On goal | Maybe | Filtered | Too short | Kept | Hidden | Shown | Couldn't check
  function describe(reason, goals) {
    const r = reason || "";
    const scored = /^(show|uncertain|hide) p=([\d.]+) (\S+)$/.exec(r);
    if (scored) {
      const p = Number(scored[2]);
      const label = { show: "On goal", uncertain: "Maybe", hide: "Filtered" }[scored[1]];
      const out = { label, p, match: `${pct(p)} match`, goal: goalName(goals, scored[3]) };
      if (scored[1] === "hide") out.detail = `best match ${pct(p)}`;
      return out;
    }
    const dur = /^rule:min-duration:(\S+):(\d+)m p=([\d.]+)$/.exec(r);
    if (dur) {
      const p = Number(dur[3]);
      return { label: "Too short", p, match: `${pct(p)} match`, goal: goalName(goals, dur[1]), detail: `under ${dur[2]} min` };
    }
    if (r === "rule:shorts") return { label: "Filtered", detail: "Short" };
    const lang = /^rule:language:(.+)$/.exec(r);
    if (lang) return { label: "Filtered", detail: languageName(lang[1]) };
    const nv = /^rule:non-video:(.+)$/.exec(r);
    if (nv) return { label: "Filtered", detail: KIND_NAMES[nv[1]] || nv[1] };
    if (r === "rule:allowlist") return { label: "Shown", detail: "always-show channel" };
    if (r === "rule:blocklist") return { label: "Filtered", detail: "never-show channel" };
    if (r === "override:keep") return { label: "Kept", detail: "kept by you" };
    if (r === "override:hide") return { label: "Hidden", detail: "hidden by you" };
    return { label: "Couldn't check", detail: r };
  }

  // Facts from an aggregate for the dashboard's "What stood out". No advice, no thresholds.
  function insights(agg, goals) {
    const out = [];
    const named = agg.byGoal.filter((g) => g.goalId !== "earlier");
    for (const g of named) {
      if (g.offered > 0 && g.highlighted === 0) {
        const best = g.maxP == null ? "" : ` The best scored ${pct(g.maxP)}.`;
        out.push({ kind: "no-hits", goalId: g.goalId, text: `${goalName(goals, g.goalId)}: ${g.offered} offered, none on goal.${best}` });
      }
    }
    const nm = agg.nearMisses || [];
    if (nm.length) {
      const ps = nm.map((d) => d.p);
      out.push({ kind: "near-misses", text: `The top ${nm.length} near misses scored ${pct(Math.min(...ps))} to ${pct(Math.max(...ps))}.` });
    }
    const shares = named.filter((g) => g.offered > 0)
      .map((g) => ({ g, share: (g.highlighted + g.uncertain) / g.offered }))
      .sort((a, b) => b.share - a.share);
    if (shares.length >= 2) {
      const hi = shares[0];
      const lo = shares[shares.length - 1];
      if (hi.share !== lo.share) {
        out.push({ kind: "share", text: `${goalName(goals, hi.g.goalId)} let through the most (${pct(hi.share)}), ${goalName(goals, lo.g.goalId)} the least (${pct(lo.share)}).` });
      }
    }
    return out;
  }

  // After scoring: band the best p, then apply the minimum duration of the goal that produced
  // it. A video shorter than that goal's minimum is hidden; unknown duration passes.
  function decideScored(item, settings, p, goalId) {
    const state = band(p, settings.showThreshold, settings.hideThreshold);
    const reason = `${state} p=${p.toFixed(2)} ${goalId}`;
    const goal = (settings.goals || []).find((g) => g.id === goalId);
    const minMinutes = goal && Number(goal.minDurationMinutes) > 0 ? Number(goal.minDurationMinutes) : 0;
    if (state !== "hide" && minMinutes && item.durationSeconds != null && item.durationSeconds < minMinutes * 60) {
      return { state: "hide", reason: `rule:min-duration:${goalId}:${minMinutes}m p=${p.toFixed(2)}` };
    }
    return { state, reason };
  }

  // Feed drift: of the cards Jev scored (reason "show|uncertain|hide p=..."), how many fell
  // below the hide threshold. Rule hides, overrides and failed scores are left out.
  const SCORED = /^(show|uncertain|hide) p=/;
  function driftShare(reasons) {
    let scored = 0, rejected = 0;
    for (const r of reasons) {
      if (!SCORED.test(r || "")) continue;
      scored += 1;
      if (r.startsWith("hide ")) rejected += 1;
    }
    return { scored, rejected, fit: scored - rejected, percent: scored ? (100 * rejected) / scored : 0 };
  }

  // The drift condition: on at `percent` with at least `minScored` cards scored; once on, it
  // stays on until the share falls 5 points below `percent`, so it does not flicker.
  const DRIFT_MIN_SCORED = 20;
  const DRIFT_HYSTERESIS = 5;
  function driftOn(wasOn, share, percent) {
    if (!(percent > 0) || share.scored < DRIFT_MIN_SCORED) return false;
    if (share.percent >= percent) return true;
    return wasOn && share.percent > percent - DRIFT_HYSTERESIS;
  }

  // ---- the Jev request text --------------------------------------------------------------
  // formatVideo must equal proxy/prompt.py format_video byte for byte (the text the
  // evaluation measured); test/format_video_fixture.json pins both sides.
  function formatDurationText(seconds) {
    if (seconds === null || seconds === undefined) return "unknown";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  // Python's "{:.1f}" rounds an exact tie to even; toFixed rounds it up. A double is an exact
  // tie at one decimal only when 4x is an odd integer (x = 0.25, 1.25, 1.75 ...).
  function oneDecimalLikePython(x) {
    const t = x * 4;
    if (Number.isInteger(t) && t % 2 === 1) {
      let q = Math.floor(x * 10);
      if (q % 2) q += 1;
      return (q / 10).toFixed(1);
    }
    return x.toFixed(1);
  }

  function formatViewsText(n) {
    if (n === null || n === undefined) return "unknown";
    for (const [unit, size] of [["B", 1e9], ["M", 1e6], ["K", 1e3]]) {
      if (n >= size) return `${oneDecimalLikePython(n / size)}${unit}`;
    }
    return String(n);
  }

  function formatVideo(video) {
    const kind = video.isShort ? "Short" : "video";
    const lines = [
      `Title: ${video.title}`,
      `Channel: ${video.channel}`,
      `Duration: ${formatDurationText(video.durationSeconds)} (${kind})`,
      `Views: ${formatViewsText(video.viewCount)}`,
    ];
    if (video.description) lines.push(`Description: ${video.description}`);
    return lines.join("\n");
  }

  function band(p, show, hide) {
    if (p > show) return "show";
    if (p < hide) return "hide";
    return "uncertain";
  }

  // Local calendar day as YYYY-MM-DD, the same day the proxy's SQLite 'localtime' gives.
  function localDay(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function median(xs) {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // Dashboard numbers from /stats rows (one per local day and video) and the local rule tally.
  // Each row is decided again with decideScored at the current settings, so the dashboard and
  // the feed agree. Goal text that no current goal has goes to the "earlier" bucket.
  function aggregate(stats, tally, settings) {
    const goals = activeGoals(settings);
    const idByText = new Map(goals.map((g) => [g.text, g.id]));
    const empty = () => ({ offered: 0, highlighted: 0, uncertain: 0, hiddenScore: 0, hiddenDuration: 0, notJudged: 0 });
    const days = new Map();
    const hours = new Map();
    const byGoal = new Map();
    const byGoalDay = new Map();
    const decided = [];
    for (const r of stats.rows) {
      let best = null;
      for (const [text, p] of Object.entries(r.pByGoalText)) {
        if (!best || p > best.p) best = { p, goalId: idByText.get(text) || "earlier" };
      }
      // The feed treats a video as an error when any goal failed, so a video that some goal
      // never scored that day is not judged here either, whatever the other goals said.
      const partial = (r.goalTexts || []).some((t) => !(t in r.pByGoalText));
      if (partial) best = null;
      let kind;
      let reason = "not judged";
      if (!best) kind = "notJudged";
      else {
        const d = decideScored(r, settings, best.p, best.goalId);
        reason = d.reason;
        kind = d.state === "show" ? "highlighted" : d.state === "uncertain" ? "uncertain"
          : d.reason.startsWith("rule:min-duration") ? "hiddenDuration" : "hiddenScore";
      }
      const hour = new Date(r.firstSeen * 1000).getHours();
      for (const [map, key] of [[days, r.day], [hours, hour]]) {
        if (!map.has(key)) map.set(key, empty());
        const c = map.get(key);
        c.offered += 1;
        c[kind] += 1;
      }
      if (best) {
        if (!byGoal.has(best.goalId)) byGoal.set(best.goalId, { ...empty(), ps: [] });
        const g = byGoal.get(best.goalId);
        g.offered += 1;
        g[kind] += 1;
        g.ps.push(best.p);
        const dk = `${r.day}|${best.goalId}`;
        if (!byGoalDay.has(dk)) byGoalDay.set(dk, { day: r.day, goalId: best.goalId, offered: 0, visible: 0 });
        const gd = byGoalDay.get(dk);
        gd.offered += 1;
        if (kind === "highlighted" || kind === "uncertain") gd.visible += 1;
      }
      decided.push({ ...r, p: best ? best.p : null, goalId: best ? best.goalId : null, kind, reason });
    }

    // A video seen on several days appears once in the lists, at its highest p.
    const bestRow = new Map();
    for (const d of decided) {
      if (d.p == null) continue;
      const prev = bestRow.get(d.videoId);
      if (!prev || d.p > prev.p) bestRow.set(d.videoId, d);
    }
    const ranked = [...bestRow.values()].sort((a, b) => b.p - a.p);
    const pick = ({ videoId, title, channel, durationSeconds, day, p, goalId, kind, reason }) =>
      ({ videoId, title, channel, durationSeconds, day, p, goalId, kind, reason });

    const rules = { since: (tally && tally.since) || null, total: 0, byReason: {}, byDay: {} };
    for (const [day, ids] of Object.entries((tally && tally.days) || {})) {
      if (day < stats.since || day > stats.today) continue;
      for (const reason of Object.values(ids)) {
        const key = reason.replace(/^rule:/, "");
        rules.byReason[key] = (rules.byReason[key] || 0) + 1;
        rules.byDay[day] = (rules.byDay[day] || 0) + 1;
        rules.total += 1;
      }
    }

    const goalIds = [...goals.map((g) => g.id), ...(byGoal.has("earlier") ? ["earlier"] : [])];
    return {
      thresholds: { show: settings.showThreshold, hide: settings.hideThreshold },
      since: stats.since, today: stats.today, firstVerdictDay: stats.firstVerdictDay,
      totals: decided.reduce((c, d) => ((c.offered += 1), (c[d.kind] += 1), c), empty()),
      // The latest day with data, so the summary is not empty just after midnight.
      latestDay: days.size ? [...days.keys()].sort().pop() : stats.today,
      latestCounts: days.size ? days.get([...days.keys()].sort().pop()) : empty(),
      days: [...days.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, c]) => ({ day, ...c })),
      hours: Array.from({ length: 24 }, (_, hour) => ({ hour, ...(hours.get(hour) || empty()) })),
      byGoal: goalIds.map((id) => {
        const g = byGoal.get(id) || { ...empty(), ps: [] };
        const { ps, ...counts } = g;
        return { goalId: id, ...counts, medianP: median(ps), maxP: ps.length ? Math.max(...ps) : null };
      }),
      byGoalDay: [...byGoalDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)),
      rules,
      nearMisses: ranked.filter((d) => d.kind !== "highlighted").slice(0, 20).map(pick),
      highlighted: ranked.filter((d) => d.kind === "highlighted").map(pick),
      overrides: (stats.feedback || []).map((f) => ({ ...f, goalId: idByText.get(f.goalText) || "earlier" })),
    };
  }

  // Offered on the setup page as starting points; nothing is preset. Each follows the
  // "want. Not: a, b, or c." shape the settings page edits.
  const EXAMPLE_GOALS = [
    { id: "E1", name: "Home cooking", minDurationMinutes: 0, text: "Practical home cooking: technique, recipes with clear steps, meal prep and kitchen basics. Not: food challenges, mukbang, restaurant reviews, or celebrity chef drama." },
    { id: "E2", name: "Personal finance", minDurationMinutes: 8, text: "Personal finance fundamentals: budgeting, index investing, taxes and saving, explained with numbers. Not: get-rich schemes, crypto pumps, trading signals, or luxury lifestyle content." },
    { id: "E3", name: "Learning to code", minDurationMinutes: 8, text: "Learning to program: tutorials, project walkthroughs and computer science fundamentals with real code. Not: career drama, salary reveals, day-in-the-life vlogs, or tech news recaps." },
  ];

  const DEFAULT_SETTINGS = {
    goals: [],
    hideShorts: true,
    hideNonVideo: true,
    allowlist: [],
    blocklist: [],
    allowedLanguages: [],
    showThreshold: 0.8,
    hideThreshold: 0.1,
    settingsVersion: 4,
    // "direct": the service worker calls Jev with jevKey. "proxy": the local Python proxy.
    scorer: "direct",
    jevKey: "",
    dailyCallLimit: 3000,
    proxyUrl: "http://127.0.0.1:8787",
    proxySecret: "",
    autoLoadCap: 3,
    driftPercent: 80,
  };

  // Saved settings merged over the defaults. Version 2 lowered the hide threshold from 0.2 to
  // 0.1 (2026-11-14, after the blind labels): a saved 0.2 from version 1 was the old default,
  // so it moves to 0.1; any other saved value is the user's own choice and is kept.
  function migrateSettings(saved) {
    const s = { ...DEFAULT_SETTINGS, ...(saved || {}) };
    if (saved && (saved.settingsVersion || 1) < 2) {
      if (saved.hideThreshold === 0.2) s.hideThreshold = 0.1;
      s.settingsVersion = 2;
    }
    // Version 3 added short goal names, filled at the time for the then-built-in goals.
    if (saved && (saved.settingsVersion || 1) < 3) s.settingsVersion = 3;
    // Version 4 added direct mode. Anyone already set up with a proxy secret stays on the
    // proxy, with the 15,000-call cap that proxy uses, until they switch.
    if (saved && (saved.settingsVersion || 1) < 4) {
      if (saved.proxySecret && !saved.scorer) {
        s.scorer = "proxy";
        if (saved.dailyCallLimit === undefined) s.dailyCallLimit = 15000;
      }
      s.settingsVersion = 4;
    }
    return s;
  }

  // Ready to filter: a way to reach a scorer and at least one goal that is on.
  function setupComplete(settings) {
    const s = settings || {};
    const reachable = s.scorer === "proxy" ? !!s.proxySecret : !!s.jevKey;
    return reachable && activeGoals(s).length > 0;
  }

  const api = { VIDEO_ID, parseDuration, parseViews, extractLockup, extractShortsLockup, extractFromData,
    extractFromDom, videoIdFromHref, detectLanguage, applyRules, activeGoals, decideScored, band, migrateSettings, localDay, aggregate, DEFAULT_SETTINGS, EXAMPLE_GOALS, setupComplete,
    splitGoal, joinGoal, goalName, describe, insights, languageName, driftShare, driftOn, formatVideo };
  root.YFF = Object.assign(root.YFF || {}, api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
