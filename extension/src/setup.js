// First-run setup in three steps: what the extension does, a goal from two answers, then the
// Jev key (tested before saving) and the daily call limit. Saving marks the first run as
// pending and sends this tab to YouTube, where the content script reports how the feed scores.
(async function () {
  const Y = self.YFF;
  const P = self.YFFPage;
  const $ = P.$;
  const { settings: saved } = await chrome.storage.local.get("settings");
  const settings = Y.migrateSettings(saved);
  const first = (settings.goals || [])[0] || null; // on a set-up install this page edits the first goal

  // What filled the two boxes: the first saved goal or an example. Its name and shortest
  // length are kept for as long as the first answer is left as it was filled.
  let base = null;

  function fill(goal) {
    const parts = Y.splitGoal(goal.text || "");
    $("need").value = parts.want;
    $("skip").value = parts.nots.join(", ");
    base = { id: goal.id, name: goal.name || "", minDurationMinutes: goal.minDurationMinutes || 0, need: parts.want.trim(), skip: $("skip").value, text: goal.text || "" };
    renderDraft();
  }

  function currentGoal() {
    const draft = Y.draftGoal($("need").value, $("skip").value);
    const asFilled = !!base && base.need === $("need").value.trim();
    return {
      id: first ? first.id : asFilled ? base.id : `U${Date.now().toString(36)}`,
      name: (asFilled && base.name) || draft.name,
      text: asFilled && base.skip === $("skip").value ? base.text : draft.text, // an untouched goal keeps its exact text, which the score cache is keyed by
      minDurationMinutes: asFilled ? base.minDurationMinutes : (first && first.minDurationMinutes) || 0,
    };
  }

  function renderDraft() {
    const goal = currentGoal();
    $("draft").hidden = !goal.text;
    $("draftName").textContent = goal.name;
    const parts = Y.splitGoal(goal.text);
    const box = $("draftText");
    box.textContent = parts.want;
    if (parts.nots.length) {
      const not = document.createElement("span");
      not.className = "not";
      not.textContent = goal.text.slice(parts.want.length);
      box.appendChild(not);
    }
    for (const chip of $("examples").children) chip.setAttribute("aria-pressed", String(!!base && base.id === chip.dataset.id && base.need === $("need").value.trim()));
  }

  for (const example of Y.EXAMPLE_GOALS) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.dataset.id = example.id;
    chip.textContent = example.name;
    chip.addEventListener("click", () => { fill(example); $("goalMsg").textContent = ""; });
    $("examples").appendChild(chip);
  }
  $("need").addEventListener("input", renderDraft);
  $("skip").addEventListener("input", renderDraft);

  const STEPS = { welcome: "h0", stepGoal: "h1", stepKey: "h2" };
  function show(step) {
    for (const id of Object.keys(STEPS)) $(id).hidden = id !== step;
    $(STEPS[step]).focus();
    window.scrollTo(0, 0);
  }

  $("start").addEventListener("click", () => show("stepGoal"));
  $("backToWelcome").addEventListener("click", () => show("welcome"));
  $("backToGoal").addEventListener("click", () => show("stepGoal"));
  $("toKey").addEventListener("click", () => {
    if (!$("need").value.trim()) { $("goalMsg").textContent = "Answer the first question to continue."; $("need").focus(); return; }
    $("goalMsg").textContent = "";
    show("stepKey");
  });

  function keyStatus(kind, text) {
    $("keyDot").hidden = !kind;
    if (kind) $("keyDot").className = `dot ${kind}`;
    $("keyText").textContent = text || "";
  }

  async function testKey() {
    const jevKey = $("jevKey").value.trim();
    if (!jevKey) { keyStatus("bad", "Paste your key first"); return false; }
    keyStatus("wait", "Checking\u2026");
    const h = await P.health({ jevKey });
    if (h.ok) keyStatus("ok", `Key works \u00b7 Jev answered in ${h.ms} ms`);
    else keyStatus("bad", `Can't use this key: ${h.error}`);
    return h.ok;
  }

  $("testKey").addEventListener("click", testKey);
  P.bindKeyReveal($("revealKey"), $("jevKey"));

  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("msg").textContent = "";
    if ($("stepKey").hidden) { $("toKey").click(); return; } // Enter pressed on the goal step
    const limit = Number($("dailyCallLimit").value);
    if (!(Number.isInteger(limit) && limit > 0)) { $("msg").textContent = "The daily call limit must be a whole number above 0."; return; }
    $("save").disabled = true;
    const ok = await testKey();
    $("save").disabled = false;
    if (!ok) { $("msg").textContent = "The key did not work, so nothing was saved."; return; }
    const next = { ...settings, jevKey: $("jevKey").value.trim(), dailyCallLimit: limit, goals: [currentGoal(), ...(settings.goals || []).slice(1)] };
    await chrome.storage.local.set({ settings: next, firstRun: "pending" });
    location.assign("https://www.youtube.com/");
  });

  $("jevKey").value = settings.jevKey || "";
  $("dailyCallLimit").value = String(settings.dailyCallLimit);
  if (first) fill(first);
  else renderDraft();
  show(Y.setupComplete(settings) ? "stepGoal" : "welcome");
})();
