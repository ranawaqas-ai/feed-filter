// Read-only probe of the watch-page sidebar structure in the separate test profile.
import puppeteer from "puppeteer";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const browser = await puppeteer.launch({ headless: false, userDataDir: path.join(here, "profile", "probe"),
  defaultViewport: { width: 1400, height: 1000 } });
const page = await browser.newPage();
await page.goto("https://www.youtube.com/watch?v=kCc8FmEb1nY", { waitUntil: "networkidle2", timeout: 60000 });
await new Promise((r) => setTimeout(r, 5000));
const report = await page.evaluate(() => {
  const root = document.querySelector("ytd-watch-next-secondary-results-renderer");
  if (!root) return { root: false };
  const lockups = [...root.querySelectorAll("yt-lockup-view-model")];
  const first = lockups[0];
  const chain = [];
  for (let n = first; n && n !== root; n = n.parentElement) chain.push(n.tagName.toLowerCase() + (n.id ? "#" + n.id : ""));
  const holders = [];
  for (let n = first; n && n !== root; n = n.parentElement) {
    for (const k of ["data", "__data", "componentProps", "props"]) if (n[k]) holders.push(`${n.tagName.toLowerCase()}.${k}: ${Object.keys(n[k]).slice(0, 6).join(",")}`);
  }
  return { root: true, lockups: lockups.length, compact: root.querySelectorAll("ytd-compact-video-renderer").length,
    chain, holders, otherTags: [...new Set([...root.querySelectorAll("#contents > *")].map((e) => e.tagName.toLowerCase()))] };
});
console.log(JSON.stringify(report, null, 2));
await browser.close();
