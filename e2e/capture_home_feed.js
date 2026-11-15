// Captures the home feed's card data for the extraction tests. Paste into the DevTools
// console on https://www.youtube.com/ after scrolling far enough (it downloads
// yt_home_capture.json), or let e2e/capture_logged_out.mjs run it in the logged-out test
// profile (it sets window.__yffNoDownload and reads window.__yffCapture). Read-only: no
// clicks, no requests.
// Tracking params, commands, image URLs, avatars and tokens are dropped; titles, channels,
// counts and badges are kept, along with 9 stripped DOM samples.
(() => {
  const DROP = /^(trackingParams|loggingDirectives|clickTrackingParams|commandRuns|onTap|innertubeCommand|rendererContext|visibilityTrackingParams|sources|avatar|image|onFocusEffect|serviceEndpoint|navigationEndpoint|command|commands|menu|itemPlayback|inlinePlaybackEndpoint|onLongPress|thumbnail|thumbnails|webCommandMetadata|loggingContext|accessibilityContext|params|token|continuationCommand|animationActivationEntityKey|animationActivationEntitySelectorType)$/;
  const clean = (o) => {
    if (Array.isArray(o)) return o.map(clean);
    if (o && typeof o === "object") {
      const r = {};
      for (const [k, v] of Object.entries(o)) if (!DROP.test(k)) r[k] = clean(v);
      return r;
    }
    if (typeof o === "string" && /^https?:\/\//.test(o)) return "<url>";
    if (typeof o === "string" && /^RDGMEM/.test(o)) return "<personal-mix-id>"; // personalised mix ids
    return o;
  };
  const all = [...document.querySelectorAll("ytd-rich-item-renderer")];
  const cards = all.map((el, i) => {
    const shelf = el.closest("ytd-rich-shelf-renderer");
    const inner = el.querySelector("#content > *");
    const link = el.querySelector("a[href^='/watch'], a[href^='/shorts']")?.getAttribute("href") ?? null;
    return { index: i, innerTag: inner ? inner.tagName.toLowerCase() : null, inShelf: !!shelf,
      shelfTitle: shelf?.querySelector("#title")?.textContent?.trim() ?? null,
      linkPath: link ? link.split("&")[0].replace(/RDGMEM[A-Za-z0-9_-]+/, "<personal-mix-id>") : null, data: clean(el.data) };
  });
  const domSamples = [];
  const pick = (sel, k) => all.filter((e) => e.querySelector(sel)).slice(0, k);
  for (const el of [...pick("yt-lockup-view-model", 6), ...pick("ytm-shorts-lockup-view-model-v2", 2), ...pick("ytd-mini-game-card-view-model", 1)]) {
    const c = el.cloneNode(true);
    c.querySelectorAll("img, source, yt-img-shadow, svg, path, style, script").forEach((n) => n.remove());
    c.querySelectorAll("*").forEach((n) => {
      for (const a of [...n.attributes]) {
        if (a.name === "href") n.setAttribute("href", a.value.split("&")[0]);
        else if (!/^(id|class|aria-label|title|href|role|hidden)$/.test(a.name)) n.removeAttribute(a.name);
      }
    });
    domSamples.push(c.outerHTML);
  }
  const signedIn = !!document.querySelector("ytd-topbar-menu-button-renderer #avatar-btn, button#avatar-btn");
  const text = JSON.stringify({ capturedAt: new Date().toISOString(), page: "home", signedIn, cards, domSamples });
  window.__yffCapture = text;
  if (window.__yffNoDownload) return { cards: cards.length, domSamples: domSamples.length, kb: Math.round(text.length / 1024) };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = "yt_home_capture.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  return { cards: cards.length, domSamples: domSamples.length, kb: Math.round(text.length / 1024) };
})();
