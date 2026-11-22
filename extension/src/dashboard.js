// Dashboard: what the feed offered, what got through per goal, and why.
// Scored rows come from the service worker's verdict log (IndexedDB);
// rule hides come from the local tally. YFF.aggregate decides every row with the same
// decideScored the feed uses, at the current settings.
(function () {
  const Y = self.YFF;
  const P = self.YFFPage;
  const $ = P.$;
  const esc = P.esc;
  const num = P.num;
  const SERIES = [
    { key: "highlighted", label: "On goal", cls: "sw-ongoal", color: "var(--ongoal)" },
    { key: "uncertain", label: "Maybe", cls: "sw-maybe", color: "var(--maybe)" },
    { key: "hiddenScore", label: "Low match", cls: "sw-filtered", color: "var(--filtered)" },
    { key: "hiddenDuration", label: "Too short", cls: "sw-tooshort", color: "var(--tooshort)" },
    { key: "hiddenAbout", label: "Kind or clickbait", cls: "sw-byrule", color: "var(--byrule)" },
    { key: "notJudged", label: "Not checked", cls: "sw-notjudged", color: "var(--notjudged)" },
  ];
  const RANGE_KEY = "yff-dashboard-days";
  const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "-");
  const pctP = (p) => (p == null ? "-" : `${Math.round(p * 100)}%`);
  const fmtDur = (s) => (s == null ? "" : s >= 3600
    ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
    : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);
  const dayLong = (d) => new Date(`${d}T12:00:00`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  const dayShort = P.dayShort;
  const watchUrl = (id) => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;

  let settings = null;
  let days = 14;
  try {
    days = Number(localStorage.getItem(RANGE_KEY)) || 14;
  } catch (err) {
    // storage blocked; keep the default
  }

  function seg(n, cls, minPx) {
    return n ? `<span class="${cls}" style="flex:${n};${minPx ? `min-width:${minPx}px` : ""}"></span>` : "";
  }

  function renderHeadline(a) {
    const t = a.totals;
    const through = t.highlighted + t.uncertain;
    const filtered = t.hiddenScore + t.hiddenDuration + t.hiddenAbout;
    $("dateLine").textContent = a.since === a.today ? dayLong(a.today) : `${dayShort(a.since)} to ${dayLong(a.today)}`;
    $("headline").textContent = `${num(through)} of ${num(t.offered)} videos got through`;
    $("headSub").textContent = t.offered
      ? `${pct(through, t.offered)} of what YouTube offered you. ${num(t.highlighted)} ${t.highlighted === 1 ? "was" : "were"} squarely on goal.`
      : "Nothing scored in this range yet.";
    $("metrics").innerHTML = SERIES.map((s, i) =>
      `<div class="mt${i ? "" : " first"}"><div class="ml"><span class="dot ${s.cls}"></span>${esc(s.label)}</div><div class="mv">${num(t[s.key])}</div></div>`).join("");
    $("bigsplit").innerHTML = SERIES.map((s, i) => seg(t[s.key], s.cls, i === 0 ? 4 : 0)).join("");
    $("bigsplit").setAttribute("aria-label", `Of ${t.offered} offered: ` + SERIES.map((s) => `${t[s.key]} ${s.label.toLowerCase()}`).join(", "));
    $("letLabel").textContent = `Let through ${num(through)} (${pct(through, t.offered)})`;
    $("filtLabel").textContent = `Filtered ${num(filtered)} (${pct(filtered, t.offered)})`;
  }

  const INS_ICONS = {
    "no-hits": '<path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
    "near-misses": '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    share: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  };
  function renderInsights(a) {
    const list = Y.insights(a, settings.goals);
    $("insights").innerHTML = list.length
      ? list.map((i) => `<div class="ins"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${INS_ICONS[i.kind] || ""}</svg><div>${esc(i.text)}</div></div>`).join("")
      : '<p class="muted">Nothing stands out yet.</p>';
  }

  function renderHours(a) {
    const max = Math.max(...a.hours.map((h) => h.offered), 1);
    $("hours").innerHTML = a.hours.map((h) =>
      `<span style="height:${(100 * h.offered) / max}%" title="${String(h.hour).padStart(2, "0")}:00, ${h.offered} videos"></span>`).join("");
    const busy = a.hours.filter((h) => h.offered).sort((x, y) => y.offered - x.offered);
    const note = busy.slice(0, 3).map((h) => `${num(h.offered)} at ${String(h.hour).padStart(2, "0")}:00`).join(" · ");
    $("hoursNote").textContent = busy.length ? note + (busy.length > 3 ? ` · ${busy.length - 3} more hours` : "") : "No videos in this range.";
    $("hours").setAttribute("aria-label", note || "No videos");
  }

  // The outcomes a scored video can have; "Not checked" videos have no goal and no kind.
  const SCORED_SERIES = SERIES.filter((s) => s.key !== "notJudged");
  const breakdown = (name, c) => `<div class="gbar" role="img" aria-label="${esc(`${name}: ${c.offered} offered, ` + SCORED_SERIES.map((s) => `${c[s.key]} ${s.label.toLowerCase()}`).join(", "))}">${SCORED_SERIES.map((s) => seg(c[s.key], s.cls)).join("")}</div>`;

  function renderGoals(a) {
    const head = '<div class="ggrid hd"><span>Goal</span><span class="n">Offered</span><span>Breakdown</span><span class="n">Got through</span><span class="n">Typical match</span></div>';
    $("goals").innerHTML = head + a.byGoal.map((g) => {
      const name = Y.goalName(settings.goals, g.goalId);
      return `<div class="ggrid"><span style="font-weight:500">${esc(name)}</span><span class="n">${num(g.offered)}</span>` +
        breakdown(name, g) +
        `<span class="n">${g.offered ? pct(g.highlighted + g.uncertain, g.offered) : "-"}</span><span class="n muted">${pctP(g.medianP)}</span></div>`;
    }).join("");
  }

  function renderKinds(a) {
    $("kinds").innerHTML = a.byKind.length
      ? '<div class="ggrid hd"><span>Kind</span><span class="n">Offered</span><span>Breakdown</span><span class="n">Got through</span></div>' +
        a.byKind.map((k) => `<div class="ggrid"><span style="font-weight:500">${esc(k.kind)}</span><span class="n">${num(k.offered)}</span>` +
          breakdown(k.kind, k) + `<span class="n">${pct(k.highlighted + k.uncertain, k.offered)}</span></div>`).join("")
      : '<p class="muted">Kinds appear once videos have been checked with this version.</p>';
  }

  function renderBait(a) {
    const { onGoal, maybe, corrected } = a.clickbait;
    const line = (name, c) => `<div style="display:flex;justify-content:space-between;margin-top:20px"><span style="font-weight:500">${name}</span><span>${num(c.labelled)} of ${num(c.checked)}</span></div>
      <div class="gbar" style="margin-top:6px"><span class="sw-filtered" style="width:${c.checked ? (100 * c.labelled) / c.checked : 0}%"></span></div>`;
    $("bait").innerHTML = settings.clickbait === "off" ? '<p class="muted">Clickbait labels are off in Settings.</p>'
      : line("On goal", onGoal) + line("Maybe", maybe) +
        `<div class="rrow" style="margin-top:20px;border-top:1px solid var(--divider)"><span>Marked \u201cNot clickbait\u201d by you</span><span>${num(corrected)}</span></div>`;
  }

  function table(cols, rows) {
    const head = cols.map((c) => `<th class="${c.n ? "n" : ""}">${esc(c.h)}</th>`).join("");
    const body = rows.map((r) => `<tr>${cols.map((c) => `<td class="${c.n ? "n" : ""}">${c.f(r)}</td>`).join("")}</tr>`).join("");
    return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }

  // Stacked bars, one per day, 2px surface gaps between segments.
  function renderTime(a) {
    const enough = a.days.length >= 2;
    $("timeCard").hidden = !enough;
    $("timeEmpty").hidden = enough;
    if (!enough) {
      $("timeEmptyText").textContent = `Trends over time appear once there are two days of data in this range. ${a.days.length} day recorded so far.`;
      return;
    }
    $("timeLegend").innerHTML = SERIES.map((s) => `<span><span class="dot ${s.cls}"></span>${esc(s.label)}</span>`).join("");
    const buckets = a.days.map((d) => ({ ...d, label: dayShort(d.day) }));
    const chart = $("timeChart");
    chart.querySelectorAll("svg").forEach((n) => n.remove());
    const H = 220, padL = 40, padB = 24, padT = 8;
    const slot = Math.max(18, Math.min(56, Math.floor((Math.max(chart.clientWidth, 320) - padL) / buckets.length)));
    const W = padL + slot * buckets.length;
    const max = Math.max(...buckets.map((b) => b.offered), 1);
    const mag = Math.pow(10, Math.floor(Math.log10(max)));
    const top = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * mag).find((t) => t >= max);
    const y = (v) => padT + (H - padT - padB) * (1 - v / top);
    let svg = `<svg width="${W}" height="${H}" role="img" aria-label="Stacked bars of videos offered per day by outcome">`;
    for (const t of [0, top / 2, top]) {
      svg += `<line x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}" stroke="var(--divider)"/>`;
      svg += `<text x="${padL - 6}" y="${y(t) + 4}" text-anchor="end">${Math.round(t)}</text>`;
    }
    const barW = Math.max(8, slot - 8);
    buckets.forEach((b, i) => {
      const x = padL + i * slot + (slot - barW) / 2;
      let acc = 0;
      SERIES.forEach((s) => {
        const v = b[s.key];
        if (!v) return;
        const y0 = y(acc), y1 = y(acc + v);
        svg += `<rect x="${x}" y="${y1}" width="${barW}" height="${Math.max(1, y0 - y1 - 2)}" rx="2" fill="${s.color}"/>`;
        acc += v;
      });
      svg += `<rect class="hit" data-i="${i}" x="${padL + i * slot}" y="${padT}" width="${slot}" height="${H - padT - padB}" fill="transparent"/>`;
      if (buckets.length <= 16 || i % Math.ceil(buckets.length / 12) === 0) {
        svg += `<text x="${x + barW / 2}" y="${H - 8}" text-anchor="middle">${esc(b.label)}</text>`;
      }
    });
    chart.insertAdjacentHTML("beforeend", svg + "</svg>");
    const tip = $("tip");
    chart.querySelectorAll("rect.hit").forEach((r) => {
      r.addEventListener("mousemove", (e) => {
        const b = buckets[Number(r.dataset.i)];
        tip.innerHTML = `<b>${esc(b.label)}</b>, ${b.offered} offered<br>` + SERIES.map((s) => `${esc(s.label)}: ${b[s.key]}`).join("<br>");
        const box = chart.getBoundingClientRect();
        tip.style.left = `${Math.min(e.clientX - box.left + chart.scrollLeft + 12, chart.scrollWidth - 180)}px`;
        tip.style.top = `${e.clientY - box.top + 12}px`;
        tip.style.display = "block";
      });
      r.addEventListener("mouseleave", () => { tip.style.display = "none"; });
    });
    $("timeTable").innerHTML = table([{ h: "Day", f: (b) => esc(b.label) }, { h: "Offered", n: 1, f: (b) => b.offered },
      ...SERIES.map((s) => ({ h: s.label, n: 1, f: (b) => b[s.key] }))], buckets);
  }

  // Thumbnails are YouTube's own images for the video id (the ones the feed already showed).
  function videoRow(r, corner, line) {
    return `<div class="vrow">
      <a class="thumb" href="${watchUrl(r.videoId)}" target="_blank" rel="noopener" tabindex="-1">
        <img class="thumb" src="https://i.ytimg.com/vi/${encodeURIComponent(r.videoId)}/mqdefault.jpg" alt="" loading="lazy" referrerpolicy="no-referrer">
        ${corner ? `<span class="dur">${esc(corner)}</span>` : ""}</a>
      <div style="flex:1;min-width:0">
        <a class="title" href="${watchUrl(r.videoId)}" target="_blank" rel="noopener">${esc(r.title || r.videoId)}</a>
        <div class="meta">${esc(r.channel || "")}</div>
        <div class="meta">${line}</div>
      </div></div>`;
  }

  // Long lists show their first few rows; a button under the list reveals the rest.
  const LIST_LIMIT = 5;
  function renderList(el, rows, emptyText) {
    if (!rows.length) {
      el.innerHTML = `<p class="muted">${emptyText}</p>`;
      return;
    }
    const rest = rows.slice(LIST_LIMIT);
    el.innerHTML = rows.slice(0, LIST_LIMIT).join("") + (rest.length
      ? `<div class="more" hidden>${rest.join("")}</div><button class="pill text small morebtn" type="button" aria-expanded="false">Show ${rest.length} more</button>`
      : "");
    const btn = el.querySelector(".morebtn");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const more = el.querySelector(".more");
      more.hidden = !more.hidden;
      btn.setAttribute("aria-expanded", String(!more.hidden));
      btn.textContent = more.hidden ? `Show ${rest.length} more` : "Show fewer";
    });
  }

  const OUTCOME = { uncertain: "Maybe, shown", hiddenScore: "Filtered, low match", hiddenDuration: "Filtered, too short", hiddenAbout: "Filtered, kind or clickbait", highlighted: "On goal" };
  function renderLists(a) {
    const goal = (id) => esc(Y.goalName(settings.goals, id));
    renderList($("nearMisses"), a.nearMisses.map((r) => videoRow(r, pctP(r.p), `${goal(r.goalId)} · ${esc(OUTCOME[r.kind] || r.kind)}`)), "Nothing yet.");
    $("onGoalTitle").textContent = a.since === a.today ? "On goal today" : "On goal";
    $("onGoalSub").textContent = a.highlighted.length
      ? `${a.highlighted.length} video${a.highlighted.length === 1 ? "" : "s"} cleared the highlight mark, best match first` : "Videos that clear the highlight mark show up here";
    renderList($("highlighted"), a.highlighted.map((r) => videoRow(r, fmtDur(r.durationSeconds), `<span class="match">${pctP(r.p)} match · ${goal(r.goalId)}</span>`)),
      "Nothing on goal in this range.");
    renderList($("overrides"), [...a.overrides].reverse().map((o) => `<div class="vrow" style="align-items:center">
          <span class="badge ${o.action === "keep" ? "keep" : "hide"}">${o.action === "keep" ? "Kept" : "Hidden"}</span>
          <div style="flex:1;min-width:0"><a class="title" href="${watchUrl(o.videoId)}" target="_blank" rel="noopener" style="color:var(--text)">${esc(o.title || o.videoId)}</a>
          <div class="meta">${goal(o.goalId)} · scored ${pctP(o.p)} · ${esc(new Date(o.ts * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))}</div></div></div>`),
      "No corrections yet. Use Keep or Hide in a card's menu.");
  }

  function ruleLabel(k) {
    const d = Y.describe(`rule:${k}`);
    return d.detail ? d.detail.charAt(0).toUpperCase() + d.detail.slice(1) : k;
  }

  function renderRules(a) {
    const about = Object.entries(a.aboutBlocks).sort((x, y) => y[1] - x[1])
      .map(([label, n]) => `<div class="rrow"><span>${esc(label)}</span><span>${num(n)}</span></div>`).join("");
    $("aboutRules").innerHTML = about ? `<p class="sub" style="margin-top:16px">After scoring, by kind or clickbait title</p>${about}` : "";
    const rows = Object.entries(a.rules.byReason).sort((x, y) => y[1] - x[1]);
    if (!a.rules.since || !rows.length) {
      $("rules").innerHTML = `<div class="empty"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>
        <b>Counting has just started</b><div style="max-width:320px;margin-top:6px">Rule blocks are counted in this browser from when the extension was last updated. Browse YouTube and they'll appear here.</div></div>`;
      return;
    }
    $("rules").innerHTML = rows.map(([k, n]) => `<div class="rrow"><span>${esc(ruleLabel(k))}</span><span>${num(n)}</span></div>`).join("") +
      `<p class="small muted" style="margin:12px 0 0">Counted in this browser since ${esc(dayShort(a.rules.since))}.</p>`;
  }

  // ---- feed profile: what YouTube is feeding you, by topic ---------------------------------
  // Topics come from the weekly grouping in the service worker; the numbers are counted here
  // from the local log by YFF.feedProfile. It always covers this week, whatever range is chosen.
  const DISMISSED_KEY = "profileDismissed"; // topic names marked "Not for me"
  const GOALED_KEY = "profileGoaled"; // topic names saved as a goal on the settings page
  const searchUrl = (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
  const goalQuery = (g) => g.name || Y.splitGoal(g.text || "").want.slice(0, 80) || g.id;

  function topicNote(t, goal) {
    const parts = [!t.covered ? "no goal" : goal ? `your goal \u201c${goal.name || goal.id}\u201d` : "covered by your goals"];
    if (t.change !== null) parts.push(`${t.change > 0 ? "up" : "down"} from ${Math.max(0, t.share - t.change)}% four weeks ago`);
    let text = parts.join(", ");
    if (t.watched) text += `. You watched ${num(t.watched)} video${t.watched === 1 ? "" : "s"} like this.`;
    return text;
  }

  function topicRow(t, i, top) {
    const goal = t.covered ? Y.activeGoals(settings).find((g) => g.id === t.goalId) : null;
    let acts = "";
    if (!t.covered) {
      const not = `<button class="pill${t.watched ? " text" : ""} small" type="button" data-act="not" data-i="${i}">Not for me</button>`;
      const make = `<button class="pill${t.watched ? "" : " text"} small" type="button" data-act="goal" data-i="${i}">Make it a goal</button>`;
      acts = t.watched ? make + not : not + make; // the likelier choice comes first
    } else if (t.fading && goal) acts = `<a class="pill text small" href="${esc(searchUrl(goalQuery(goal)))}" target="_blank" rel="noopener">Find more</a>`;
    return `<div class="trow"><div class="tpct">${t.share}%</div>
      <div><div class="tname">${esc(t.name)}</div>
        <div class="tbar"><span style="width:${top ? Math.round((100 * t.share) / top) : 0}%;background:var(${t.covered ? "--ongoal" : "--filtered"})"></span></div>
        <div class="tnote">${esc(topicNote(t, goal))}</div></div>
      <div class="tact">${acts}</div></div>`;
  }

  // Topics already decided on are kept out of the list above and shown here on request.
  function decidedList(dismissed, goaled) {
    const rows = [...dismissed.map((n) => [n, "Not for you"]), ...goaled.map((n) => [n, "Made a goal"])];
    if (!rows.length) return "";
    return `<details class="pdone"><summary>Decided earlier (${rows.length})</summary>
      ${rows.reverse().map(([n, what]) => `<div class="rrow"><span>${esc(n)}</span><span class="muted">${what}</span></div>`).join("")}</details>`;
  }

  async function loadProfile() {
    let r;
    try {
      r = await chrome.runtime.sendMessage({ type: "profile" });
    } catch (err) {
      r = { error: "extension not ready" };
    }
    const body = $("profileBody");
    const refresh = $("profileRefresh");
    if (!r || r.rows === undefined) {
      body.innerHTML = `<p class="muted" style="margin:16px 0 0">Could not load the feed profile: ${esc(r && r.error ? (r.error.text || r.error) : "no response")}.</p>`;
      return;
    }
    if (!r.hasKey) {
      refresh.hidden = true;
      body.innerHTML = `<p class="muted" style="margin:16px 0 0">Add an Anthropic key in <a href="options.html#topicsSec">Settings</a> to see your feed by topic.
        Once a week, the titles and channel names of videos YouTube offered you and videos you watched are sent to Claude to be grouped.</p>`;
      return;
    }
    refresh.hidden = false;
    refresh.disabled = !!r.running;
    refresh.textContent = r.running ? "Grouping…" : "Refresh";
    const failed = r.error ? `<div class="pfoot" style="color:var(--bad)">The last update on ${esc(dayShort(r.error.day))} failed: ${esc(r.error.text)}.</div>` : "";
    const { [DISMISSED_KEY]: dismissed = [], [GOALED_KEY]: goaled = [] } = await chrome.storage.local.get([DISMISSED_KEY, GOALED_KEY]);
    const profile = Y.feedProfile({ rows: r.rows, watched: r.watched, result: r.result, settings, today: r.today, decided: [...dismissed, ...goaled] });
    window.__yffProfile = profile; // read by the e2e check
    if (!profile) {
      body.innerHTML = `<p class="muted" style="margin:16px 0 0">No topics yet. Press Refresh to group the last four weeks of your feed now; after that it updates once a week.</p>${failed}`;
      return;
    }
    const top = Math.max(0, ...profile.topics.map((t) => t.share));
    body.innerHTML = `<div class="lead">${esc(profile.headline)}</div>
      <div style="margin-top:12px">${profile.topics.map((t, i) => topicRow(t, i, top)).join("") || (profile.decidedShare ? "" : '<p class="muted">Topics are listed once they have appeared on several days.</p>')}</div>
      <div class="pfoot">Updated ${esc(dayShort(profile.day))} from ${num(r.result.sent)} videos.${profile.decidedShare ? ` Topics you already decided on are ${profile.decidedShare}% of this week's feed.` : ""}${profile.other ? ` The other ${profile.other}% is smaller topics and one-off videos.` : ""}</div>${decidedList(dismissed, goaled)}${failed}`;
    body.querySelectorAll("button[data-act]").forEach((b) => b.addEventListener("click", () => {
      const t = profile.topics[Number(b.dataset.i)];
      if (b.dataset.act === "goal") {
        location.href = `options.html#${new URLSearchParams({ goalName: t.name, goalText: t.sentence || t.name })}`;
        return;
      }
      notForMe(t, dismissed);
    }));
  }

  async function notForMe(t, dismissed) {
    const on = Y.activeGoals(settings);
    const names = on.map((g) => g.name || g.id).join(", ");
    if (!confirm(`Add "${t.name}" to the "But not" tags of ${on.length === 1 ? "your goal" : "these goals"}: ${names}?\n\nVideos are scored again against the changed goals, which uses Jev calls.`)) return;
    const { settings: saved } = await chrome.storage.local.get("settings");
    const current = Y.migrateSettings(saved);
    await chrome.storage.local.set({ settings: { ...current, goals: Y.goalsExcluding(current.goals, t.name) }, [DISMISSED_KEY]: [...new Set([...dismissed, t.name])].slice(-50) });
    load();
  }

  $("profileRefresh").addEventListener("click", async () => {
    $("profileRefresh").disabled = true;
    $("profileRefresh").textContent = "Grouping…";
    await chrome.runtime.sendMessage({ type: "topics" }).catch(() => null);
    loadProfile();
  });

  async function load() {
    document.querySelectorAll("#range .chip").forEach((c) => c.setAttribute("aria-pressed", String(Number(c.dataset.days) === days)));
    $("error").hidden = true;
    delete document.body.dataset.loaded;
    const r = await P.loadAggregate(days);
    settings = r.settings;
    const ok = !r.error;
    $("topDot").className = `dot ${ok ? "ok" : "bad"}`;
    $("topStatus").textContent = ok ? "Scorer connected" : "Scorer offline";
    if (!ok) {
      $("error").textContent = `Could not load scores: ${r.error}.`;
      $("error").hidden = false;
      $("body").hidden = true;
      $("dateLine").textContent = "";
      return;
    }
    const a = r.agg;
    window.__yffDashboard = a; // read by the e2e check
    $("body").hidden = false;
    renderHeadline(a);
    renderInsights(a);
    renderHours(a);
    renderGoals(a);
    renderKinds(a);
    renderBait(a);
    renderTime(a);
    renderLists(a);
    renderRules(a);
    await loadProfile();
    $("basis").textContent = `Sorted at your current marks: highlight above ${pctP(a.thresholds.show)}, filter below ${pctP(a.thresholds.hide)}. ` +
      `Scores recorded since ${a.firstVerdictDay ? dayShort(a.firstVerdictDay) : "-"}.`;
    document.body.dataset.loaded = "1";
  }

  document.querySelectorAll("#range .chip").forEach((c) => c.addEventListener("click", () => {
    days = Number(c.dataset.days);
    try {
      localStorage.setItem(RANGE_KEY, String(days));
    } catch (err) {
      // storage blocked; the choice lasts for this visit only
    }
    load();
  }));
  load();
})();
