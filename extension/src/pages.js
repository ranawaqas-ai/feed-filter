// Helpers shared by the popup, settings and dashboard pages (not the content script).
(function () {
  const Y = self.YFF;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (n) => Number(n || 0).toLocaleString("en-US");

  // Saved settings, the local rule tally and /stats for the last `days` days, run through
  // YFF.aggregate. `settingsOverride` lets the settings page preview unsaved values.
  async function loadAggregate(days, settingsOverride) {
    const got = await chrome.storage.local.get(null);
    const settings = settingsOverride || Y.migrateSettings(got.settings);
    const tally = { since: got.tallySince || null, days: {} };
    for (const [k, v] of Object.entries(got)) if (k.startsWith("tally:")) tally.days[k.slice(6)] = v;
    let stats;
    try {
      stats = await chrome.runtime.sendMessage({ type: "stats", days });
    } catch (err) {
      stats = { error: "extension not ready" };
    }
    if (!stats || stats.error) return { error: stats ? stats.error : "no response", settings, tally };
    return { stats, tally, settings, agg: Y.aggregate(stats, tally, settings) };
  }

  async function health(unsaved) {
    const t0 = performance.now();
    let r;
    try {
      r = await chrome.runtime.sendMessage({ type: "health", unsaved });
    } catch (err) {
      r = { error: "extension not ready" };
    }
    return { ok: !!r && !r.error, error: r ? r.error : "no response", ms: Math.round(performance.now() - t0), body: r };
  }

  self.YFFPage = { esc, num, loadAggregate, health };
})();
