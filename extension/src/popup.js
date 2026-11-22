// Popup: this tab's counts, the reveal and pause switches, today's totals, and an offline
// state when the scorer cannot be reached.
(async function () {
  const Y = self.YFF;
  const P = self.YFFPage;
  const $ = P.$;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const { settings: saved } = await chrome.storage.local.get("settings");
  const settings = Y.migrateSettings(saved);

  const openDashboard = (e) => { e.preventDefault(); chrome.tabs.create({ url: chrome.runtime.getURL("src/dashboard.html") }); };
  $("dashboard").addEventListener("click", openDashboard);
  $("options").addEventListener("click", (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

  const active = Y.activeGoals(settings);
  $("goals").innerHTML = active.length
    ? active.map((g) => `<span class="chip">${P.esc(g.name || g.id)}</span>`).join("")
    : '<span class="muted">No goal set. Add one in Settings.</span>';

  if (!Y.setupComplete(settings)) {
    $("online").hidden = true;
    $("setup").hidden = false;
    $("dot").className = "dot wait";
    $("statusText").textContent = "Not set up yet";
    $("openSetup").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("src/setup.html") }));
    return;
  }

  function setStatus(kind, text) {
    $("dot").className = `dot ${kind}`;
    $("statusText").textContent = text;
  }

  function showOffline(why) {
    setStatus("bad", "Scorer offline");
    $("online").hidden = true;
    $("offline").hidden = false;
    $("offWhy").textContent = why ? `(${why})` : "";
  }

  function showOnline() {
    setStatus("ok", "Scorer connected");
    $("online").hidden = false;
    $("offline").hidden = true;
  }

  async function tabState() {
    if (!tab) return null;
    try {
      return await chrome.tabs.sendMessage(tab.id, { type: "getState" });
    } catch (err) {
      return null; // not a YouTube tab, or the page loaded before the extension
    }
  }

  function renderCounts(state) {
    if (!state) {
      $("countsBlock").hidden = true;
      $("noTab").hidden = false;
      $("reveal").disabled = $("off").disabled = true;
      return;
    }
    const c = state.counts;
    const through = c.shown + c.uncertain;
    const total = through + c.hidden + c.pending;
    $("through").textContent = `${P.num(through)} of ${P.num(total)} videos let through`;
    $("sub").textContent = c.pending ? `On this page · checking ${c.pending} more` : "On this page";
    for (const k of ["shown", "uncertain", "hidden"]) $(k).textContent = P.num(c[k]);
    const seg = (n, cls) => (n ? `<span class="${cls}" style="flex:${n}"></span>` : "");
    $("split").innerHTML = seg(c.shown, "sw-ongoal") + seg(c.uncertain, "sw-maybe") + seg(c.hidden, "sw-filtered") + seg(c.pending, "");
    $("split").setAttribute("aria-label", `${c.shown} on goal, ${c.uncertain} maybe, ${c.hidden} filtered, ${c.pending} still checking`);
    $("bait").hidden = !c.clickbait;
    $("baitText").textContent = `${P.num(c.clickbait)} clickbait title${c.clickbait === 1 ? "" : "s"} labelled`;
    $("reveal").checked = state.reveal;
    $("off").checked = state.off;
  }

  async function today() {
    const r = await P.loadAggregate(1);
    if (r.error) {
      $("today").textContent = "";
      return;
    }
    const c = r.agg.latestCounts;
    const label = r.agg.latestDay === r.agg.today ? "Today" : r.agg.latestDay;
    $("today").innerHTML = `${P.esc(label)}: ${P.num(c.highlighted + c.uncertain)} of ${P.num(c.offered)} offered videos got through · <a href="#" id="seeWhy">See why</a>`;
    $("seeWhy").addEventListener("click", openDashboard);
  }

  async function check() {
    setStatus("wait", "Checking the scorer…");
    const [state, h] = await Promise.all([tabState(), P.health()]);
    renderCounts(state);
    if (!h.ok || (state && state.scorerDown)) showOffline(h.ok ? "the last batch failed" : h.error);
    else showOnline();
    if (h.ok) today();
    return { state, h };
  }

  $("reveal").addEventListener("change", (e) => chrome.tabs.sendMessage(tab.id, { type: "reveal", on: e.target.checked }));
  $("off").addEventListener("change", (e) => chrome.tabs.sendMessage(tab.id, { type: "setTabOff", off: e.target.checked }));
  $("unfiltered").addEventListener("click", async () => {
    if (tab) await chrome.tabs.sendMessage(tab.id, { type: "setTabOff", off: true }).catch(() => {});
    window.close();
  });
  $("retry").addEventListener("click", async () => {
    const h = await P.health();
    if (h.ok && tab) {
      await chrome.tabs.sendMessage(tab.id, { type: "retry" }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1500)); // let the retried batch come back
    }
    await check();
  });

  check();
})();
