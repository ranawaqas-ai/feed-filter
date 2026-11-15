// Captures the home feed of the logged-out test profile (e2e/profile/) into
// e2e/fixtures/home_feed_loggedout.json, for the extension's extraction tests. The profile is
// signed out and was seeded only by e2e/seed_profile.mjs, so the capture holds no one's account.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT, launch, sleep } from "./lib.mjs";

const browser = await launch({ withExtension: false });
const page = await browser.newPage();
await page.goto("https://www.youtube.com/", { waitUntil: "domcontentloaded" });
await sleep(4000);
for (let i = 0; i < 12; i++) {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await sleep(1500);
}
const snippet = readFileSync(path.join(ROOT, "e2e/capture_home_feed.js"), "utf8");
const summary = await page.evaluate(`window.__yffNoDownload = true; ${snippet}`);
const text = await page.evaluate(() => window.__yffCapture);
const capture = JSON.parse(text);
if (capture.signedIn) throw new Error("the test profile is signed in; refusing to save a signed-in capture");
writeFileSync(path.join(ROOT, "e2e/fixtures/home_feed_loggedout.json"), JSON.stringify(capture) + "\n");
console.log(`capture_logged_out: ${summary.cards} cards, ${summary.domSamples} DOM samples, ${summary.kb} KB, signedIn=${capture.signedIn}`);
await browser.close();
