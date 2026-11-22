// Pure logic shared by the page bridge (MAIN world), the content script and Node tests:
// extraction from YouTube's data objects, parsing, language detection, rules and bands.
// No chrome.* APIs and no DOM access except in extractFromDom.
(function (root) {
  "use strict";

  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
  // The elements decided as cards: home grid items and watch-page sidebar items.
  const HOME_CARD = "ytd-rich-item-renderer";
  const SIDEBAR_CARD = "ytd-watch-next-secondary-results-renderer yt-lockup-view-model";

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
  // separately; joinGoal(splitGoal(t)) gives t back for the defaults (scores are cached by
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

  // The first-run goal, from the setup page's two answers: what the user needs from YouTube,
  // and what pulls them in that they would rather skip (commas or new lines between items).
  function draftGoal(need, skip) {
    let want = (need || "").trim().replace(/\s+/g, " ");
    const nots = (skip || "").split(/[,\n]/).map((s) => s.trim().replace(/\.$/, "").replace(/^or /, "")).filter(Boolean);
    const name = want.split(/[.:,]/)[0].trim().slice(0, 40).trim();
    if (nots.length && want && !/[.!?]$/.test(want)) want += ".";
    return { name, text: joinGoal(want, nots) };
  }

  // What the first-run panel reports for the home cards on the page, from their states.
  // Cards that could not be judged are counted apart, so "N of M" covers verdicts only.
  function feedScore(states) {
    const c = { onGoal: 0, maybe: 0, hidden: 0, failed: 0, pending: 0 };
    for (const s of states) {
      if (s === "show" || s === "revealed") c.onGoal += 1;
      else if (s === "uncertain") c.maybe += 1;
      else if (s === "hide") c.hidden += 1;
      else if (s === "error") c.failed += 1;
      else c.pending += 1;
    }
    c.checked = c.onGoal + c.maybe + c.hidden;
    return c;
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
    const about = /^rule:(?:kind:(\S+):(\S+)|clickbait:(\S+)) p=([\d.]+)$/.exec(r);
    if (about) {
      const p = Number(about[4]);
      const goal = goalName(goals, about[1] || about[3]);
      return { label: "Filtered", p, match: `${pct(p)} match`, goal, byRule: true, detail: about[2] ? `${about[2]}, off for ${goal}` : "Clickbait title" };
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

  // ---- what Jev says about the video itself: its kind and whether the title is clickbait --------
  // The keys and descriptions are the Choice criteria sent to Jev, as measured on 2026-11-23.
  const KINDS = {
    Tutorial: "Shows how to do or make something, step by step, so the viewer can do it too",
    Lecture: "Explains a subject in depth: a course, talk, lecture or documentary",
    News: "Reports or recaps recent events, releases or announcements",
    Opinion: "Argues a view, rants, predicts or gives advice without teaching a skill",
    Review: "Tests, compares or ranks products, tools or places",
    Entertainment: "Made to amuse: challenges, comedy, gaming, music, stunts, vlogs",
    Other: "None of the other kinds fits",
  };
  const KIND_LIST = Object.keys(KINDS).filter((k) => k !== "Other");
  const NOT_SURE = "Not sure";
  const KIND_SURE = 0.7; // below this the video has no kind
  const CLICKBAIT_AT = 0.9;

  // about: {clickbait, kind, kindP}, or null when Jev was not asked or the call failed.
  function kindOf(about) {
    return about && about.kindP >= KIND_SURE && KIND_LIST.includes(about.kind) ? about.kind : null;
  }

  // Measured on English titles only, so a title confidently in another language is never labelled.
  function isClickbait(about, title, settings) {
    if (!about || settings.clickbait === "off" || !(about.clickbait >= CLICKBAIT_AT)) return false;
    const { lang } = detectLanguage(title);
    return !lang || lang === "en";
  }

  // "Not clickbait" is stored beside the Keep and Hide choices, which use v:<videoId>.
  const notClickbaitKey = (videoId) => `c:${videoId}`;
  function withoutClickbait(rows, overrides) {
    return rows.map((r) => (r.about && (overrides || {})[notClickbaitKey(r.videoId)] ? { ...r, about: { ...r.about, clickbait: 0 } } : r));
  }

  // After scoring: band the best p, then apply the minimum duration of the goal that produced
  // it. A video shorter than that goal's minimum is hidden; unknown duration passes. Then the
  // kinds that goal has turned off, then clickbait maybes when the setting filters them.
  function decideScored(item, settings, p, goalId, about) {
    const state = band(p, settings.showThreshold, settings.hideThreshold);
    const reason = `${state} p=${p.toFixed(2)} ${goalId}`;
    const goal = (settings.goals || []).find((g) => g.id === goalId);
    const minMinutes = goal && Number(goal.minDurationMinutes) > 0 ? Number(goal.minDurationMinutes) : 0;
    if (state !== "hide" && minMinutes && item.durationSeconds != null && item.durationSeconds < minMinutes * 60) {
      return { state: "hide", reason: `rule:min-duration:${goalId}:${minMinutes}m p=${p.toFixed(2)}` };
    }
    const kind = kindOf(about);
    if (state !== "hide" && kind && goal && (goal.kindsOff || []).includes(kind)) {
      return { state: "hide", reason: `rule:kind:${goalId}:${kind} p=${p.toFixed(2)}` };
    }
    if (state === "uncertain" && settings.clickbait === "hide" && isClickbait(about, item.title, settings)) {
      return { state: "hide", reason: `rule:clickbait:${goalId} p=${p.toFixed(2)}` };
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
  // formatVideo must produce the text the evaluation measured, byte for byte;
  // test/format_video_fixture.json pins it.
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

  // The only fields of a card that leave the browser (to Jev, and into the local log).
  function videoPayload(meta) {
    return {
      videoId: meta.videoId, title: meta.title || "", channel: meta.channel || "",
      durationSeconds: meta.durationSeconds ?? null, viewCount: meta.viewCount ?? null,
      isShort: !!meta.isShort, description: meta.description || "",
    };
  }

  // Short, stable key for the goals' ids and texts, so an edited goal does not reuse old p values.
  function goalsKey(goals) {
    const text = goals.map((g) => `${g.id}\u0000${g.text}`).join("\u0001");
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return (h >>> 0).toString(36);
  }

  // What a card element currently shows. When it changes, the card is decided again.
  function cardKey(meta) {
    return meta.videoId || meta.contentId || `${meta.kind}:${meta.title || ""}`;
  }

  // Id for the rule-hide tally. A card with no id and no title (an ad) is counted per card
  // element, by the id the caller gives it, so four ads count as four.
  function tallyId(meta, elementId) {
    return meta.videoId || meta.contentId || (meta.title ? `${meta.kind}:${meta.title}`.slice(0, 120) : `${meta.kind}:${elementId}`);
  }

  // Local calendar day as YYYY-MM-DD.
  function localDay(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function median(xs) {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // One log row decided as the feed would decide it now: its best goal and what happened to it.
  function decideRow(r, settings, idByText) {
    let best = null;
    for (const [text, p] of Object.entries(r.pByGoalText)) {
      if (!best || p > best.p) best = { p, goalId: idByText.get(text) || "earlier" };
    }
    // The feed treats a video as an error when any goal failed, so a video that some goal
    // never scored that day is not judged here either, whatever the other goals said.
    const partial = (r.goalTexts || []).some((t) => !(t in r.pByGoalText));
    if (partial || !best) return { best: null, kind: "notJudged", reason: "not judged" };
    const d = decideScored(r, settings, best.p, best.goalId, r.about);
    const kind = d.state === "show" ? "highlighted" : d.state === "uncertain" ? "uncertain"
      : d.reason.startsWith("rule:min-duration") ? "hiddenDuration" : d.reason.startsWith("rule:") ? "hiddenAbout" : "hiddenScore";
    return { best, kind, reason: d.reason };
  }

  // Dashboard numbers from the stats rows (one per local day and video) and the local rule tally.
  // Each row is decided again with decideScored at the current settings, so the dashboard and
  // the feed agree. Goal text that no current goal has goes to the "earlier" bucket.
  function aggregate(stats, tally, settings) {
    const goals = activeGoals(settings);
    const idByText = new Map(goals.map((g) => [g.text, g.id]));
    const empty = () => ({ offered: 0, highlighted: 0, uncertain: 0, hiddenScore: 0, hiddenDuration: 0, hiddenAbout: 0, notJudged: 0 });
    const byKind = new Map();
    const aboutBlocks = {}; // plain words -> videos hidden by a goal's kinds or as clickbait
    const bait = { onGoal: { labelled: 0, checked: 0 }, maybe: { labelled: 0, checked: 0 } };
    const days = new Map();
    const hours = new Map();
    const byGoal = new Map();
    const byGoalDay = new Map();
    const decided = [];
    for (const r of stats.rows) {
      const { best, kind, reason } = decideRow(r, settings, idByText);
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
      if (best && r.about) {
        const name = kindOf(r.about) || NOT_SURE;
        if (!byKind.has(name)) byKind.set(name, empty());
        byKind.get(name).offered += 1;
        byKind.get(name)[kind] += 1;
      }
      if (kind === "hiddenAbout") {
        const { detail } = describe(reason, goals);
        aboutBlocks[detail] = (aboutBlocks[detail] || 0) + 1;
      }
      const side = kind === "highlighted" ? bait.onGoal : kind === "uncertain" || reason.startsWith("rule:clickbait:") ? bait.maybe : null;
      if (side && r.about && settings.clickbait !== "off") {
        side.checked += 1;
        if (isClickbait(r.about, r.title, settings)) side.labelled += 1;
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
      byKind: [...KIND_LIST, NOT_SURE].filter((k) => byKind.has(k)).map((k) => ({ kind: k, ...byKind.get(k) })),
      aboutBlocks,
      clickbait: { ...bait, corrected: (stats.feedback || []).filter((f) => f.action === "notClickbait").length },
      rules,
      nearMisses: ranked.filter((d) => d.kind !== "highlighted").slice(0, 20).map(pick),
      highlighted: ranked.filter((d) => d.kind === "highlighted").map(pick),
      overrides: (stats.feedback || []).filter((f) => f.action !== "notClickbait").map((f) => ({ ...f, goalId: idByText.get(f.goalText) || "earlier" })),
    };
  }

  // ---- feed profile: what YouTube is offering, by topic -----------------------------------
  // A generative model groups titles into topics once a week (topics.js). Everything else on
  // the dashboard card is counted here from the local log.
  const PROFILE = { days: 28, maxItems: 1000, maxTopics: 6, minDays: 3, minItems: 20, move: 5 };

  // "YYYY-MM-DD" n days before the local day `day`.
  function dayBefore(day, n) {
    const [y, m, d] = day.split("-").map(Number);
    return localDay(new Date(y, m - 1, d - n));
  }

  // The videos sent to the model: each offered or watched video once, newest first.
  function profileItems(rows, watched) {
    const byId = new Map();
    for (const r of [...rows, ...watched]) {
      if (!r.videoId || !r.title) continue;
      const prev = byId.get(r.videoId);
      if (!prev || r.day > prev.day) byId.set(r.videoId, { videoId: r.videoId, title: r.title, channel: r.channel || "", day: r.day });
    }
    return [...byId.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0)).slice(0, PROFILE.maxItems);
  }

  function profileLines(items) {
    return items.map((v, i) => `${i + 1}. ${v.title.replace(/\s+/g, " ")} | ${v.channel.replace(/\s+/g, " ")}`);
  }

  // The model's reply -> topics holding video ids. A number outside the list or already used
  // is dropped; a reply of the wrong shape throws.
  function topicsFromReply(text, items) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error("the model's reply was not JSON");
    }
    if (!parsed || !Array.isArray(parsed.topics)) throw new Error("the model's reply had no topics");
    const used = new Set();
    const topics = [];
    for (const t of parsed.topics) {
      if (!t || typeof t.name !== "string" || !t.name.trim() || !Array.isArray(t.items)) continue;
      const videoIds = [];
      for (const n of t.items) {
        const item = Number.isInteger(n) ? items[n - 1] : null;
        if (!item || used.has(item.videoId)) continue;
        used.add(item.videoId);
        videoIds.push(item.videoId);
      }
      if (videoIds.length) topics.push({ name: t.name.trim().slice(0, 60), sentence: String(t.sentence || "").trim().slice(0, 240), videoIds });
    }
    if (!topics.length) throw new Error("the model's reply had no usable topics");
    return topics;
  }

  // The card's data. rows: log rows of the last 28 days; watched: [{day, videoId}];
  // result: {day, oldestDay, topics: [{name, sentence, videoIds}]} from the last run, or null.
  function feedProfile({ rows, watched, result, settings, today, decided = [] }) {
    if (!result || !result.topics || !result.topics.length) return null;
    const goals = activeGoals(settings);
    // Log rows are keyed by the goal text they were scored with. Adding a "But not" tag changes
    // that text, so a row also belongs to the goal with the same text before " Not: ".
    const byText = new Map(goals.map((g) => [g.text, g.id]));
    const byWant = new Map(goals.map((g) => [splitGoal(g.text).want, g.id]));
    const idByText = { get: (text) => byText.get(text) || byWant.get(splitGoal(text).want) };
    const topicOf = new Map();
    result.topics.forEach((t, i) => t.videoIds.forEach((id) => topicOf.set(id, i)));
    const weekStart = dayBefore(today, 6);
    const prevStart = dayBefore(today, 27);
    const prevEnd = dayBefore(today, 21);
    const stats = result.topics.map(() => ({ week: new Set(), prev: new Set(), days: new Set(), videos: new Map(), watched: new Set() }));
    const weekAll = new Set();
    const prevAll = new Set();
    const logDays = new Set();
    for (const r of rows) {
      logDays.add(r.day);
      const inWeek = r.day >= weekStart && r.day <= today;
      const inPrev = r.day >= prevStart && r.day <= prevEnd;
      if (inWeek) weekAll.add(r.videoId);
      if (inPrev) prevAll.add(r.videoId);
      const s = stats[topicOf.get(r.videoId)];
      if (!s) continue;
      if (inWeek) s.week.add(r.videoId);
      if (inPrev) s.prev.add(r.videoId);
      s.days.add(r.day);
      const d = decideRow(r, settings, idByText);
      const seen = s.videos.get(r.videoId);
      const visible = d.kind === "highlighted" || d.kind === "uncertain";
      if (!seen || (visible && !seen.visible)) s.videos.set(r.videoId, { visible, goalId: d.best ? d.best.goalId : null });
    }
    for (const w of watched) {
      const s = stats[topicOf.get(w.videoId)];
      if (s) s.watched.add(w.videoId);
    }
    const share = (n, total) => (total ? (100 * n) / total : 0);
    // A topic seen on few days is YouTube exploring. A log younger than that asks for every day it has.
    const minDays = Math.min(PROFILE.minDays, logDays.size);
    const main = result.topics.map((t, i) => {
      const s = stats[i];
      const seen = [...s.videos.values()];
      const visible = seen.filter((v) => v.visible);
      const covered = seen.length > 0 && visible.length * 2 >= seen.length;
      const counts = new Map();
      for (const v of visible) if (v.goalId && v.goalId !== "earlier") counts.set(v.goalId, (counts.get(v.goalId) || 0) + 1);
      const goalId = covered && counts.size ? [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;
      const now = share(s.week.size, weekAll.size);
      // Both weeks are grouped by the same run, so they compare like with like. The older
      // week must have been sent in full (the list is capped) and hold enough videos.
      const comparable = prevAll.size >= PROFILE.minItems && !!result.oldestDay && result.oldestDay <= prevStart;
      const change = comparable ? Math.round(now - share(s.prev.size, prevAll.size)) : null;
      return { name: t.name, sentence: t.sentence, share: Math.round(now), videos: s.week.size, days: s.days.size,
        change: change !== null && Math.abs(change) >= PROFILE.move ? change : null,
        watched: s.watched.size, covered, goalId,
        fading: covered && change !== null && change <= -PROFILE.move };
    }).filter((t) => t.videos > 0 && t.days >= minDays).sort((a, b) => b.share - a.share);
    // A topic already marked "Not for me" or made a goal leaves the list while no goal covers
    // it, so the next undecided topic takes its place. Once covered it is listed like any other.
    const isDecided = (t) => !t.covered && decided.includes(t.name);
    const decidedShare = main.filter(isDecided).reduce((n, t) => n + t.share, 0);
    const topics = main.filter((t) => !isDecided(t)).slice(0, PROFILE.maxTopics);
    const top = topics.find((t) => !t.covered);
    const headline = !weekAll.size ? "Nothing was scored this week yet."
      : !topics.length ? (decidedShare ? "You have decided on every main topic in this week's feed." : "No topic stands out in this week's feed yet.")
      : top ? `${top.share}% of your feed this week is ${top.name}, and no goal covers it.`
      : "Every main topic in your feed this week is covered by a goal.";
    return { day: result.day, weekVideos: weekAll.size, headline, topics, decidedShare,
      other: Math.max(0, 100 - decidedShare - topics.reduce((n, t) => n + t.share, 0)) };
  }

  // "Not for me": the topic joins the "But not" tags of every goal that is on. Commas would
  // split the tag when the goal text is read back, so they are dropped.
  function goalsExcluding(goals, topicName) {
    const tag = String(topicName || "").replace(/[,.]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    if (!tag) return goals;
    return goals.map((g) => {
      if (g.off) return g;
      const { want, nots } = splitGoal(g.text);
      return nots.includes(tag) ? g : { ...g, text: joinGoal(want, [...nots, tag]) };
    });
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
    settingsVersion: 5,
    jevKey: "", // the service worker calls Jev with it
    anthropicKey: "", // optional; the service worker groups feed titles into topics with it
    dailyCallLimit: 3000,
    autoLoadCap: 3,
    driftPercent: 80,
    clickbait: "label", // off | label | hide (filters maybe videos only)
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
    // Version 4 added scoring with the user's own Jev key, beside a local Python proxy.
    // Version 5 removed the proxy: its settings are dropped, and a profile that used it has
    // no Jev key yet, so it counts as not set up until one is entered on the setup page.
    if (saved && (saved.settingsVersion || 1) < 5) s.settingsVersion = 5;
    delete s.scorer;
    delete s.proxyUrl;
    delete s.proxySecret;
    return s;
  }

  // Ready to filter: a Jev key and at least one goal that is on.
  function setupComplete(settings) {
    const s = settings || {};
    return !!s.jevKey && activeGoals(s).length > 0;
  }

  const api = { VIDEO_ID, HOME_CARD, SIDEBAR_CARD, videoPayload, goalsKey, cardKey, tallyId, parseDuration, parseViews, extractLockup, extractShortsLockup, extractFromData,
    extractFromDom, videoIdFromHref, detectLanguage, applyRules, activeGoals, decideScored, band, migrateSettings, localDay, aggregate, DEFAULT_SETTINGS, EXAMPLE_GOALS, setupComplete,
    splitGoal, joinGoal, draftGoal, feedScore, goalName, describe, insights, languageName, driftShare, driftOn, formatVideo, formatDurationText,
    KINDS, KIND_LIST, NOT_SURE, KIND_SURE, CLICKBAIT_AT, kindOf, isClickbait, notClickbaitKey, withoutClickbait,
    PROFILE, profileItems, profileLines, topicsFromReply, feedProfile, goalsExcluding };
  root.YFF = Object.assign(root.YFF || {}, api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
