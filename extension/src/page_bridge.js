// MAIN-world bridge. Content scripts run in an isolated world and cannot read the
// properties YouTube's page code sets on elements (the card's data object), so this
// script reads them, normalises them with YFF.extractFromData / extractLockup and writes
// the result to a data-yff-meta attribute that the content script can read.
// It sends nothing anywhere and never touches cookies or account data.
(function () {
  "use strict";
  const Y = globalThis.YFF;
  const HOME = "ytd-rich-item-renderer";
  const SIDEBAR = "ytd-watch-next-secondary-results-renderer yt-lockup-view-model";
  const seen = new WeakMap(); // host -> source object last used, to skip unchanged cards

  function sidebarMeta(el) {
    const link = el.querySelector("a[href*='/watch?v=']");
    const vid = Y.videoIdFromHref(link && link.getAttribute("href"));
    const section = el.closest("ytd-item-section-renderer");
    const contents = section && section.data && section.data.contents;
    if (!vid || !Array.isArray(contents)) return { source: null, meta: null };
    const entry = contents.find((c) => c && c.lockupViewModel && c.lockupViewModel.contentId === vid);
    return entry ? { source: entry, meta: Y.extractLockup(entry.lockupViewModel) } : { source: null, meta: null };
  }

  function stamp(el) {
    let source;
    let meta;
    try {
      if (el.tagName === "YTD-RICH-ITEM-RENDERER") {
        source = el.data;
        if (!source) return;
        if (seen.get(el) === source && el.hasAttribute("data-yff-meta")) return;
        meta = Y.extractFromData(source);
      } else {
        ({ source, meta } = sidebarMeta(el));
        if (!meta) return;
        if (seen.get(el) === source && el.hasAttribute("data-yff-meta")) return;
      }
    } catch (err) {
      return; // unexpected structure: leave the card unstamped (it stays blurred; the content script falls back to the DOM)
    }
    seen.set(el, source);
    const json = JSON.stringify(meta);
    if (el.getAttribute("data-yff-meta") !== json) el.setAttribute("data-yff-meta", json);
  }

  let queued = false;
  function scanSoon() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      for (const el of document.querySelectorAll(`${HOME}, ${SIDEBAR}`)) stamp(el);
    });
  }

  function start() {
    new MutationObserver(scanSoon).observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener("yt-navigate-finish", scanSoon);
    // Data objects are sometimes assigned without a DOM mutation (card reuse); a slow sweep catches them.
    setInterval(scanSoon, 750);
    scanSoon();
  }

  if (document.documentElement) start();
  else document.addEventListener("readystatechange", start, { once: true });
})();
