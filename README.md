# Feed Filter

A Chrome extension that blurs YouTube home-feed and watch-sidebar cards until each video has been checked against goals you write, then shows what serves them and hides what doesn't. Videos are scored by [Jev](https://docs.typesafe.ai) from TypeSafe, with your own API key.

- Cards stay blurred until their verdict arrives, so nothing slips through unchecked.
- Videos that clearly serve a goal get an **ON GOAL** badge and a blue ring. Clearly off-goal videos are filtered out. Anything in between is shown normally.
- Every filtered card can be revealed with the reason, a maybe card asks "On goal?" on its thumbnail with Yes and No, and an on-goal card can be kept or hidden from its three-dot menu.
- When most of what YouTube offers is rejected, a notice above the feed says so and offers a search for each of your goals.
- A dashboard shows what was let through, by goal and over time.
- What each version added is listed on the [releases page](https://feedfilter.waqasrana.space/releases.html).
- Optional: with an Anthropic key, the dashboard also shows what YouTube is feeding you by topic, which topics no goal covers, and lets you turn one into a goal or an exclusion.

Desktop Chrome only. Not affiliated with YouTube or Google.

## Install

Feed Filter is not in the Chrome Web Store, so Chrome installs it as an unpacked extension.

1. Download `feed-filter-<version>.zip` from the [latest release](https://github.com/ranawaqas-ai/feed-filter/releases/latest).
2. Unzip it into a folder you will keep, for example `Documents/feed-filter-0.2.0`. Chrome loads the extension from this folder every time it starts, so do not delete it or leave it in Downloads if you clear that folder.
3. Open `chrome://extensions` and turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the unzipped folder, the one that contains `manifest.json`.
5. The setup page opens. Answer its two questions to make your first goal, paste your Jev key (create one at [console.typesafe.ai/keys](https://console.typesafe.ai/keys)) and set a daily call limit. "Save and check my feed" then opens YouTube and a panel reports how many videos on your home feed serve the goal.
6. Optional: click the puzzle icon in the toolbar and pin Feed Filter, so its popup is one click away.

Until setup is saved, YouTube looks as usual.

### Updating

Download the new zip and unzip its files over the same folder, replacing the old ones. Then click the reload arrow on Feed Filter's card in `chrome://extensions`. Your key, goals and history are kept.

Loading the new version from a different folder installs it as a separate extension, with its own empty settings. Remove the old one if you do that.

### Uninstalling

Click **Remove** on Feed Filter's card in `chrome://extensions`. This deletes the key, goals and history stored in Chrome. Then delete the folder.

## Cost

Each video is scored once per goal, and scores are cached for 30 days, so a video seen again costs nothing. A long evening on YouTube with three goals can use a few thousand calls. Calls are billed to your own TypeSafe account.

TypeSafe has no per-key spending limit. The **daily call limit** in the extension is the guard. Past it, new videos stay blurred until the next day. Calls used today are shown in Settings.

## What leaves your browser

For each video, the extension sends its video ID, title, channel, length, view count and whether it is a Short, together with your goal text, to `api.typesafe.ai`. A description field is part of the request and is always empty, because feed cards carry none. No cookies or account details are sent, and Jev never sees what you watched.

Your key is stored in this Chrome profile's extension storage and is sent only to `api.typesafe.ai`. Anyone with access to your Chrome profile can read it.

Scores, the per-day log the dashboard uses, your Keep and Hide choices and the list of videos you opened stay in the browser (IndexedDB) and are deleted after 30 days.

### If you add an Anthropic key

This part is off until you enter an Anthropic key in Settings. With a key, once a week (or when you press Refresh on the dashboard) the extension sends `api.anthropic.com` the titles and channel names of up to 1,000 videos from the last four weeks: videos YouTube offered you, and **videos you watched**. Claude groups them into topics. Your goals, video IDs, cookies and account details are not sent. The request is billed to your Anthropic account; at this size it costs roughly 0.25 US dollars. The Anthropic key is stored like the Jev key and sent only to `api.anthropic.com`.

## Writing goals

A goal works best as "what you want. Not: what to leave out." For example:

> Practical home cooking: technique, recipes with clear steps, meal prep and kitchen basics. Not: food challenges, mukbang, restaurant reviews, or celebrity chef drama.

Each video is checked against every goal that is on, and the best match decides. A goal can also have a minimum length, so short clips do not count for it.

## Development

| Command | What it covers |
|---|---|
| `node --test extension/test/*.test.mjs` | Extension logic: extraction from YouTube's card data, rules, bands, the Jev request text, the scorer (cache, cap, retries), the stats shape, settings migration, the feed topics (the numbers on the card, the request to Claude and its reply) |
| `cd e2e && npm install`, then `node e2e/seed_profile.mjs` and `node e2e/run_e2e.mjs` | End-to-end checks on youtube.com in a separate, logged-out Chrome for Testing profile. Needs `jev_api_key` in `.env`; one run uses about 1,000 Jev calls. |

`extension/src/shared/core.js` is the shared logic. After editing it, run `node extension/sync_core.mjs` to regenerate `core.main.js`, which the page-world bridge loads.

## Licence

MIT. See [LICENSE](LICENSE).
