// Settings page: goals, rules, sensitivity and the scorer connection, stored in
// chrome.storage.local under "settings". Edits go to a draft; Save writes it.
// Goal text is only rebuilt from its parts (want + "But not" tags) when that goal is
// edited, because the proxy caches scores by the exact text.
(async function () {
  const Y = self.YFF;
  const P = self.YFFPage;
  const $ = (id) => document.getElementById(id);
  const esc = P.esc;
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const LENGTHS = [0, 4, 8, 20];

  let saved = Y.migrateSettings((await chrome.storage.local.get("settings")).settings);
  let draft = clone(saved);
  let openGoal = 0; // index of the expanded goal
  let history = null; // {stats, tally} from one /stats call, for the live counts

  // ---- dirty state ----------------------------------------------------------------------
  function changeCount() {
    let n = 0;
    const keys = new Set([...Object.keys(saved), ...Object.keys(draft)]);
    for (const k of keys) {
      if (k === "goals") continue;
      if (JSON.stringify(saved[k]) !== JSON.stringify(draft[k])) n += 1;
    }
    const byId = new Map(saved.goals.map((g) => [g.id, JSON.stringify(g)]));
    for (const g of draft.goals) if (byId.get(g.id) !== JSON.stringify(g)) n += 1;
    for (const id of byId.keys()) if (!draft.goals.some((g) => g.id === id)) n += 1;
    return n;
  }

  function changed() {
    const n = changeCount();
    $("dirty").textContent = n ? `${n} unsaved change${n === 1 ? "" : "s"}` : "";
    $("save").disabled = $("discard").disabled = !n;
    renderTiles();
  }

  function say(text, bad) {
    $("msg").textContent = text;
    $("msg").className = bad ? "bad" : "";
    if (text) setTimeout(() => { if ($("msg").textContent === text) $("msg").textContent = ""; }, 5000);
  }

  // ---- tag editors (But not, languages, channels) -----------------------------------------
  // items: array to edit in place; label(item) gives the display text; parse(text) turns the
  // typed text into an item (or null). onChange runs after every add or remove.
  function tagEditor(box, items, { label = (x) => x, parse = (t) => t.trim() || null, placeholder, onChange }) {
    const render = () => {
      box.innerHTML = items.map((x, i) =>
        `<span class="chip">${esc(label(x))}<button class="x" type="button" data-i="${i}" aria-label="Remove ${esc(label(x))}">×</button></span>`).join("") +
        `<input class="input addtag" type="text" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}">`;
      box.querySelectorAll(".x").forEach((b) => b.addEventListener("click", () => {
        items.splice(Number(b.dataset.i), 1);
        render();
        onChange();
      }));
      const input = box.querySelector("input");
      input.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== ",") return;
        e.preventDefault();
        const v = parse(input.value.replace(/,$/, ""));
        if (v == null) return say(`"${input.value}" was not added.`, true);
        if (!items.includes(v)) items.push(v);
        render();
        onChange();
        box.querySelector("input").focus();
      });
    };
    render();
  }

  // ---- goals ------------------------------------------------------------------------------
  function lengthLabel(m) {
    return m ? `${m} min or longer` : "Any length";
  }

  function goalStat(g) {
    if (!history) return "";
    const day = latestDayAgg();
    if (!day) return "";
    const row = day.agg.byGoal.find((x) => x.goalId === g.id);
    if (!row || !row.offered) return `On ${dayLabel(day.agg.latestDay)}: no video matched this goal best.`;
    return `On ${dayLabel(day.agg.latestDay)}: ${P.num(row.offered)} videos matched this goal best. ` +
      `${P.num(row.highlighted)} were on goal and ${P.num(row.highlighted + row.uncertain)} got through.`;
  }

  function renderGoals() {
    const box = $("goals");
    box.innerHTML = "";
    draft.goals.forEach((g, i) => {
      const el = document.createElement("div");
      if (i === openGoal) {
        const parts = Y.splitGoal(g.text);
        const lengths = LENGTHS.includes(Number(g.minDurationMinutes) || 0) ? LENGTHS : [...LENGTHS, Number(g.minDurationMinutes)].sort((a, b) => a - b);
        el.className = "goal-open";
        el.innerHTML = `
          <div class="gh"><span>${esc(g.name || g.id)}</span>
            <span class="switch" title="Goal on"><input type="checkbox" class="gon" role="switch" aria-label="Goal on" ${g.off ? "" : "checked"}><span class="track"></span><span class="knob"></span></span></div>
          <div class="row"><label class="rl" for="gname">Name</label><div class="rc"><input id="gname" class="input" value="${esc(g.name || "")}" placeholder="${esc(g.id)}"></div></div>
          <div class="row"><label class="rl" for="gwant">I want videos about</label><div class="rc"><textarea id="gwant" class="input" rows="3">${esc(parts.want)}</textarea></div></div>
          <div class="row"><span class="rl">But not</span><div class="rc"><div class="tags" id="gnots"></div><div class="hint">Press Enter to add. These are sent to the scorer as part of the goal.</div></div></div>
          <div class="row"><span class="rl">Shortest video to show</span><div class="rc chips" role="group" aria-label="Shortest video to show">
            ${lengths.map((m) => `<button class="chip" type="button" data-min="${m}" aria-pressed="${(Number(g.minDurationMinutes) || 0) === m}">${m ? `${m} min` : "Any"}</button>`).join("")}
          </div></div>
          <div style="display:flex;align-items:center;gap:16px;margin-top:8px">
            <div class="gstat" style="flex:1">${esc(goalStat(g))}</div>
            <button class="pill text gdel" type="button" ${draft.goals.length === 1 ? "disabled" : ""}>Remove goal</button>
          </div>`;
        let nots = parts.nots;
        const rebuild = () => { g.text = Y.joinGoal(el.querySelector("#gwant").value, nots); changed(); };
        el.querySelector(".gon").addEventListener("change", (e) => {
          if (e.target.checked) delete g.off;
          else g.off = true;
          changed();
        });
        el.querySelector("#gname").addEventListener("input", (e) => {
          const v = e.target.value.trim();
          if (v) g.name = v;
          else delete g.name;
          el.querySelector(".gh span").textContent = v || g.id;
          changed();
        });
        el.querySelector("#gwant").addEventListener("input", rebuild);
        tagEditor(el.querySelector("#gnots"), nots, { placeholder: "Add something to skip", onChange: rebuild });
        el.querySelectorAll("[data-min]").forEach((b) => b.addEventListener("click", () => {
          g.minDurationMinutes = Number(b.dataset.min);
          renderGoals();
          changed();
        }));
        el.querySelector(".gdel").addEventListener("click", () => {
          draft.goals.splice(i, 1);
          openGoal = Math.max(0, i - 1);
          renderGoals();
          changed();
        });
      } else {
        el.className = `goal-row${g.off ? " off" : ""}`;
        el.innerHTML = `
          <div class="gtext"><div class="gname">${esc(g.name || g.id)}</div><div class="gwant">${esc(Y.splitGoal(g.text).want || "No description yet")}</div></div>
          <span class="glen">${esc(lengthLabel(Number(g.minDurationMinutes) || 0))}</span>
          <span class="switch"><input type="checkbox" class="gon" role="switch" aria-label="${esc(g.name || g.id)} on" ${g.off ? "" : "checked"}><span class="track"></span><span class="knob"></span></span>
          <button class="iconbtn" type="button" aria-label="Edit ${esc(g.name || g.id)}"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"/></svg></button>`;
        el.querySelector(".gon").addEventListener("click", (e) => e.stopPropagation());
        el.querySelector(".gon").addEventListener("change", (e) => {
          if (e.target.checked) delete g.off;
          else g.off = true;
          el.classList.toggle("off", !!g.off);
          changed();
        });
        el.addEventListener("click", () => {
          openGoal = i;
          renderGoals();
        });
      }
      box.appendChild(el);
    });
  }

  $("addGoal").addEventListener("click", () => {
    const used = new Set(draft.goals.map((g) => g.id));
    let n = draft.goals.length + 1;
    while (used.has(`G${n}`)) n += 1;
    draft.goals.push({ id: `G${n}`, name: "New goal", text: "", minDurationMinutes: 0 });
    openGoal = draft.goals.length - 1;
    renderGoals();
    changed();
    $("gwant").focus();
  });

  // ---- rules --------------------------------------------------------------------------------
  function renderRules() {
    $("hideShorts").checked = draft.hideShorts;
    $("hideNonVideo").checked = draft.hideNonVideo;
    tagEditor($("langs"), draft.allowedLanguages, {
      label: Y.languageName,
      placeholder: "Add a language code, like es",
      parse: (t) => {
        const code = t.trim().toLowerCase();
        return /^[a-z]{2,3}(-[a-z]{2,4})?$/i.test(code) && Y.languageName(code) !== code ? code : null;
      },
      onChange: changed,
    });
    tagEditor($("allowlist"), draft.allowlist, { placeholder: "Add a channel", onChange: changed });
    tagEditor($("blocklist"), draft.blocklist, { placeholder: "Add a channel", onChange: changed });
  }
  $("hideShorts").addEventListener("change", (e) => { draft.hideShorts = e.target.checked; changed(); });
  $("hideNonVideo").addEventListener("change", (e) => { draft.hideNonVideo = e.target.checked; changed(); });

  // ---- sensitivity ------------------------------------------------------------------------
  const toPct = (v) => Math.round(v * 100);
  function dayLabel(day) {
    return new Date(`${day}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }

  // The latest day with scores, decided at the draft's thresholds and goals.
  function latestDayAgg() {
    if (!history || !history.stats.rows.length) return null;
    const last = history.stats.rows.reduce((m, r) => (r.day > m ? r.day : m), "");
    const stats = { ...history.stats, rows: history.stats.rows.filter((r) => r.day === last) };
    return { agg: Y.aggregate(stats, history.tally, draft) };
  }

  function renderScale() {
    const h = toPct(draft.hideThreshold);
    const s = toPct(draft.showThreshold);
    $("hideRange").value = h;
    $("showRange").value = s;
    $("bar").innerHTML = `<span class="sw-filtered" style="width:${h}%"></span><span style="width:${s - h}%;background:var(--switch-off)"></span><span class="sw-ongoal" style="width:${100 - s}%"></span>`;
    $("hideVal").style.left = `${h}%`;
    $("hideVal").textContent = `${h}%`;
    $("showVal").style.left = `${s}%`;
    $("showVal").textContent = `${s}%`;
    $("t1l").textContent = `Below ${h}%: filter out`;
    $("t2l").textContent = `${h} to ${s}%: show`;
    $("t3l").textContent = `Above ${s}%: highlight`;
  }

  function renderTiles() {
    const day = latestDayAgg();
    if (!day) {
      for (const id of ["t1n", "t2n", "t3n"]) $(id).textContent = history ? "No scores yet" : "Scorer offline, no counts";
      $("tilesHint").textContent = "";
      return;
    }
    const c = day.agg.latestCounts;
    const on = `on ${dayLabel(day.agg.latestDay)}`;
    $("t1n").textContent = `${P.num(c.hiddenScore)} videos ${on}`;
    $("t2n").textContent = `${P.num(c.uncertain)} videos ${on}`;
    $("t3n").textContent = `${P.num(c.highlighted)} videos ${on}`;
    $("tilesHint").textContent = `Counts update as you drag, from your own feed history.` +
      (c.hiddenDuration ? ` Another ${P.num(c.hiddenDuration)} scored higher but were shorter than their goal allows.` : "");
  }

  function onRange(which) {
    let h = Number($("hideRange").value);
    let s = Number($("showRange").value);
    if (h > s) {
      if (which === "hide") h = s;
      else s = h;
    }
    draft.hideThreshold = h / 100;
    draft.showThreshold = s / 100;
    renderScale();
    changed();
  }
  $("hideRange").addEventListener("input", () => onRange("hide"));
  $("showRange").addEventListener("input", () => onRange("show"));

  const cap = $("autoLoadCap");
  cap.innerHTML = `<option value="0">Never stop</option>` +
    Array.from({ length: 10 }, (_, i) => `<option value="${i + 1}">${i + 1} empty page${i ? "s" : ""}</option>`).join("");
  cap.addEventListener("change", () => { draft.autoLoadCap = Number(cap.value); changed(); });

  const drift = $("driftPercent");
  const DRIFT_STEPS = [50, 60, 70, 80, 90];
  drift.innerHTML = `<option value="0">Never</option>` + DRIFT_STEPS.map((n) => `<option value="${n}">${n}%</option>`).join("");
  drift.addEventListener("change", () => { draft.driftPercent = Number(drift.value); changed(); });

  // ---- connection ---------------------------------------------------------------------------
  function connStatus(kind, text) {
    $("connDot").className = `dot ${kind}`;
    $("connText").textContent = text;
    $("topDot").className = `dot ${kind}`;
    $("topStatus").textContent = kind === "ok" ? "Scorer connected" : kind === "bad" ? "Scorer offline" : "Checking…";
  }

  // Direct: listing Jev's models proves the key without scoring anything. Proxy: health, then
  // an empty /judge, rejected with 422 only after the secret check passes.
  async function testConnection() {
    connStatus("wait", "Checking…");
    if (draft.scorer === "direct") {
      if (!draft.jevKey) return connStatus("bad", "Add your Jev key");
      const h = await P.health({ scorer: "direct", jevKey: draft.jevKey });
      return h.ok ? connStatus("ok", `Key works · Jev answered in ${h.ms} ms`) : connStatus("bad", `Can't use the key: ${h.error}`);
    }
    const unsaved = { scorer: "proxy", proxyUrl: $("proxyUrl").value.trim(), proxySecret: $("proxySecret").value.trim() };
    const h = await P.health(unsaved);
    if (!h.ok) return connStatus("bad", `Can't connect: ${h.error}`);
    const probe = await chrome.runtime.sendMessage({ type: "testJudge", unsaved, body: { goal: "connection test", videos: [] } });
    if (probe.error === "proxy HTTP 422") connStatus("ok", `Connected · answered in ${h.ms} ms`);
    else connStatus("bad", `Reached the scorer, but: ${probe.error || "unexpected reply"}`);
  }
  $("test").addEventListener("click", testConnection);

  function renderScorer() {
    const direct = draft.scorer === "direct";
    $("scorerDirect").checked = direct;
    $("scorerProxy").checked = !direct;
    $("directFields").hidden = !direct;
    $("proxyFields").hidden = direct;
    $("connDesc").textContent = direct
      ? "This browser sends each video's title, channel, length and view count with your goal to Jev (api.typesafe.ai), using your key."
      : "The scorer runs on this computer. Only titles, channels and lengths are sent to it.";
  }
  for (const r of document.querySelectorAll('input[name="scorer"]')) {
    r.addEventListener("change", () => { draft.scorer = r.value; renderScorer(); changed(); testConnection(); });
  }
  async function showUsage() {
    const u = await chrome.runtime.sendMessage({ type: "usage" }).catch(() => null);
    $("callsToday").textContent = u && u.callsToday !== null ? `Used today: ${P.num(u.callsToday)} of ${P.num(u.dailyCap)}.` : "";
  }
  showUsage();
  $("jevKey").addEventListener("input", (e) => { draft.jevKey = e.target.value.trim(); changed(); });
  $("dailyCallLimit").addEventListener("input", (e) => { draft.dailyCallLimit = Number(e.target.value); changed(); });
  $("revealKey").addEventListener("click", () => {
    const shown = $("jevKey").type === "text";
    $("jevKey").type = shown ? "password" : "text";
    $("revealKey").textContent = shown ? "Show" : "Hide";
  });
  $("proxyUrl").addEventListener("input", (e) => { draft.proxyUrl = e.target.value.trim(); changed(); });
  $("proxySecret").addEventListener("input", (e) => { draft.proxySecret = e.target.value.trim(); changed(); });
  $("reveal").addEventListener("click", () => {
    const shown = $("proxySecret").type === "text";
    $("proxySecret").type = shown ? "password" : "text";
    $("reveal").textContent = shown ? "Show" : "Hide";
  });

  // ---- save and discard ---------------------------------------------------------------------
  // A scorer outside localhost needs host permission for its origin.
  async function ensureHostPermission(url) {
    const origin = new URL(url).origin + "/*";
    if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/\*$/.test(origin)) return true;
    return chrome.permissions.request({ origins: [origin] });
  }

  function validate(s) {
    if (!(s.hideThreshold >= 0 && s.showThreshold <= 1 && s.hideThreshold <= s.showThreshold)) throw new Error("The filter mark must be at or below the highlight mark.");
    if (!s.goals.some((g) => !g.off && (g.text || "").trim())) throw new Error("Turn on at least one goal with a description.");
    if (s.scorer === "direct") {
      if (!s.jevKey) throw new Error("Add your Jev key, or choose the local proxy.");
      if (!(Number.isInteger(s.dailyCallLimit) && s.dailyCallLimit > 0)) throw new Error("The daily call limit must be a whole number above 0.");
    } else {
      new URL(s.proxyUrl); // throws on a bad address
    }
  }

  $("save").addEventListener("click", async () => {
    try {
      validate(draft);
      if (draft.scorer === "proxy" && !(await ensureHostPermission(draft.proxyUrl))) throw new Error("Permission for the scorer address was not granted.");
      await chrome.storage.local.set({ settings: draft });
      saved = clone(draft);
      changed();
      say("Saved");
    } catch (err) {
      say(err.message, true);
    }
  });

  $("discard").addEventListener("click", () => {
    draft = clone(saved);
    fill();
    say("Changes discarded");
  });

  function fill() {
    openGoal = Math.min(openGoal, draft.goals.length - 1);
    renderGoals();
    renderRules();
    renderScale();
    cap.value = String(Number(draft.autoLoadCap) || 0);
    drift.value = String(DRIFT_STEPS.includes(Number(draft.driftPercent)) ? Number(draft.driftPercent) : 0);
    renderScorer();
    $("jevKey").value = draft.jevKey || "";
    $("dailyCallLimit").value = String(draft.dailyCallLimit);
    $("proxyUrl").value = draft.proxyUrl;
    $("proxySecret").value = draft.proxySecret;
    changed();
  }

  fill();
  testConnection();
  const r = await P.loadAggregate(14, saved);
  if (!r.error) {
    history = { stats: r.stats, tally: r.tally };
    renderGoals();
    renderTiles();
  }
  document.body.dataset.loaded = "1";
})();
