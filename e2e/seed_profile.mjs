// Seeds the logged-out test profile with watch history so YouTube builds a home feed.
// Opens a handful of on-goal videos from search results; no sign-in, no clicks on ads.
// Run without the extension so seeding spends no Jev calls.
import { launch, sleep } from "./lib.mjs";

const QUERIES = ["transformer architecture lecture", "CUDA kernel optimization", "distributed systems lecture",
  "database internals lecture", "linux kernel scheduler talk"];
const WATCH_MS = 12000;

const browser = await launch({ withExtension: false });
const page = await browser.newPage();
let watched = 0;
for (const q of QUERIES) {
  await page.goto(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`, { waitUntil: "networkidle2" });
  const links = await page.$$eval("ytd-video-renderer a#thumbnail[href^='/watch?v=']", (as) =>
    as.slice(0, 2).map((a) => a.getAttribute("href").split("&")[0]));
  for (const href of links) {
    await page.goto(`https://www.youtube.com${href}`, { waitUntil: "domcontentloaded" });
    await sleep(WATCH_MS);
    watched += 1;
  }
}
await page.goto("https://www.youtube.com/", { waitUntil: "networkidle2" });
await sleep(4000);
const homeCards = await page.$$eval("ytd-rich-item-renderer", (els) => els.length);
console.log(`seed_profile: watched ${watched} videos; home feed now shows ${homeCards} cards`);
await browser.close();
