// What does a fresh, logged-out Chrome for Testing profile see on the YouTube home page?
// Read-only: counts feed cards and lists element types. No sign-in, no clicks.
import puppeteer from "puppeteer";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const browser = await puppeteer.launch({
  headless: false,
  userDataDir: path.join(here, "profile", "probe"),
  defaultViewport: { width: 1400, height: 1000 },
});
const page = await browser.newPage();
await page.goto("https://www.youtube.com/", { waitUntil: "networkidle2", timeout: 60000 });
await new Promise((r) => setTimeout(r, 4000));
const report = await page.evaluate(() => {
  const count = (sel) => document.querySelectorAll(sel).length;
  const text = document.querySelector("ytd-browse[page-subtype='home'] #contents")?.innerText?.slice(0, 300) ?? "";
  return {
    url: location.href,
    title: document.title,
    rich_items: count("ytd-rich-item-renderer"),
    lockups: count("yt-lockup-view-model"),
    rich_sections: count("ytd-rich-section-renderer"),
    watch_links: count("a[href^='/watch']"),
    shorts_links: count("a[href^='/shorts']"),
    consent: !!document.querySelector("ytd-consent-bump-v2-lightbox, tp-yt-paper-dialog"),
    feed_text_start: text,
  };
});
console.log(JSON.stringify(report, null, 2));
await browser.close();
