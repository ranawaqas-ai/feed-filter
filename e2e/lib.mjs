// Shared helpers for the end-to-end runs in a separate Chrome for Testing profile.
import puppeteer from "puppeteer";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");
export const EXT_PATH = path.join(ROOT, "extension");
// The loaded extension's id: unpacked extensions get one from their folder path, so it is
// read from the service worker once launch() starts the browser.
export let EXT_ID = null;
export const PROFILE = path.join(here, "profile", "test");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reads one value from .env without printing it.
export function envValue(name) {
  for (const line of readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
    const [k, ...rest] = line.trim().split("=");
    if (k === name) return rest.join("=").trim().replace(/^["']|["']$/g, "");
  }
  throw new Error(`${name} missing from .env`);
}

// Chrome for Testing started a cached copy of the extension's service worker after
// background.js changed on disk (e2e run 16). Clearing the test profile's service-worker
// store before launch makes it run the current file; sites re-register theirs.
export async function launch({ withExtension }) {
  if (withExtension) rmSync(path.join(PROFILE, "Default", "Service Worker"), { recursive: true, force: true });
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: PROFILE,
    defaultViewport: { width: 1440, height: 1000 },
    enableExtensions: withExtension ? [EXT_PATH] : false,
    args: ["--window-size=1460,1100"],
  });
  if (withExtension) {
    const target = await browser.waitForTarget(isExtWorker, { timeout: 20000 });
    EXT_ID = new URL(target.url()).host;
  }
  return browser;
}

const isExtWorker = (t) => t.type() === "service_worker" && /^chrome-extension:\/\/[a-p]{32}\/src\/background\.js$/.test(t.url());

export async function extensionWorker(browser) {
  const target = await browser.waitForTarget(isExtWorker, { timeout: 20000 });
  return target.worker();
}

export async function setSettings(browser, patch) {
  const worker = await extensionWorker(browser);
  await worker.evaluate(async (p) => {
    const { settings } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...self.YFF.DEFAULT_SETTINGS, ...(settings || {}), ...p } });
  }, patch);
}

// Blocks (or unblocks) the service worker's requests to Jev through the DevTools protocol,
// so a run can see what the page does when the scorer cannot be reached.
export async function blockJev(browser, on) {
  const worker = await extensionWorker(browser);
  await worker.client.send("Network.enable");
  await worker.client.send("Network.setBlockedURLs", { urls: on ? ["*api.typesafe.ai*"] : [] });
}

export function pct(values, q) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.round(q * (s.length - 1)))];
}
