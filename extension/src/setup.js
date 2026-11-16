// First-run setup: the Jev key (tested before saving), goals from editable examples or the
// user's own, and the daily call limit.
(async function () {
  const Y = self.YFF;
  const P = self.YFFPage;
  const $ = P.$;
  const { settings: saved } = await chrome.storage.local.get("settings");
  const settings = Y.migrateSettings(saved);

  // Goals already saved come first (checked); the examples follow, unchecked.
  const drafts = [
    ...(settings.goals || []).map((g) => ({ ...g, on: !g.off })),
    ...Y.EXAMPLE_GOALS.filter((e) => !(settings.goals || []).some((g) => g.id === e.id)).map((g) => ({ ...g, on: false })),
  ];
  let ownCount = 0;

  function renderGoals() {
    const box = $("goals");
    box.textContent = "";
    drafts.forEach((g, i) => {
      const el = document.createElement("div");
      el.className = `goal${g.on ? " on" : ""}`;
      el.innerHTML = `<div class="top"><input type="checkbox" aria-label="Use this goal"><input class="input" aria-label="Goal name" maxlength="40"></div>` +
        `<textarea class="input" aria-label="Goal description" maxlength="2000"></textarea>`;
      const [check, name] = el.querySelectorAll("input");
      const text = el.querySelector("textarea");
      check.checked = g.on;
      name.value = g.name || "";
      name.placeholder = "Short name, for example Home cooking";
      text.value = g.text || "";
      text.placeholder = "What you want to watch. Not: what to leave out.";
      check.addEventListener("change", () => { drafts[i].on = check.checked; el.classList.toggle("on", check.checked); });
      name.addEventListener("input", () => { drafts[i].name = name.value; });
      text.addEventListener("input", () => {
        drafts[i].text = text.value;
        if (text.value.trim() && !drafts[i].on) { drafts[i].on = check.checked = true; el.classList.add("on"); }
      });
      box.appendChild(el);
    });
  }

  $("addGoal").addEventListener("click", () => {
    ownCount += 1;
    drafts.push({ id: `U${Date.now().toString(36)}${ownCount}`, name: "", text: "", minDurationMinutes: 0, on: true });
    renderGoals();
    const areas = $("goals").querySelectorAll("textarea");
    areas[areas.length - 1].focus();
  });

  function keyStatus(kind, text) {
    $("keyDot").hidden = !kind;
    if (kind) $("keyDot").className = `dot ${kind}`;
    $("keyText").textContent = text || "";
  }

  async function testKey() {
    const jevKey = $("jevKey").value.trim();
    if (!jevKey) { keyStatus("bad", "Paste your key first"); return false; }
    keyStatus("wait", "Checking…");
    const h = await P.health({ jevKey });
    if (h.ok) keyStatus("ok", `Key works · Jev answered in ${h.ms} ms`);
    else keyStatus("bad", `Can't use this key: ${h.error}`);
    return h.ok;
  }

  $("testKey").addEventListener("click", testKey);
  P.bindKeyReveal($("revealKey"), $("jevKey"));
  $("openYouTube").addEventListener("click", () => chrome.tabs.create({ url: "https://www.youtube.com/" }));

  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("msg").textContent = "";
    const chosen = drafts.filter((g) => g.on && (g.text || "").trim());
    const limit = Number($("dailyCallLimit").value);
    if (!chosen.length) { $("msg").textContent = "Pick or write at least one goal."; return; }
    if (!(Number.isInteger(limit) && limit > 0)) { $("msg").textContent = "The daily call limit must be a whole number above 0."; return; }
    $("save").disabled = true;
    const ok = await testKey();
    $("save").disabled = false;
    if (!ok) { $("msg").textContent = "The key did not work, so nothing was saved."; return; }
    const goals = chosen.map(({ id, name, text, minDurationMinutes }) => ({
      id, name: (name || "").trim() || Y.splitGoal(text.trim()).want.slice(0, 40), text: text.trim(), minDurationMinutes: minDurationMinutes || 0 }));
    const next = { ...settings, jevKey: $("jevKey").value.trim(), dailyCallLimit: limit, goals };
    await chrome.storage.local.set({ settings: next });
    $("form").hidden = true;
    $("done").hidden = false;
  });

  $("jevKey").value = settings.jevKey || "";
  $("dailyCallLimit").value = String(settings.dailyCallLimit);
  renderGoals();
})();
