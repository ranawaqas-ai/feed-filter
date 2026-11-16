# Feed Filter

A Chrome extension that blurs YouTube home-feed and watch-sidebar cards until each video has been checked against goals you write, then shows what serves them and hides what doesn't. Videos are scored by [Jev](https://docs.typesafe.ai) from TypeSafe, with your own API key.

- Cards stay blurred until their verdict arrives, so nothing slips through unchecked.
- Videos that clearly serve a goal get an **ON GOAL** badge and a blue ring. Clearly off-goal videos are filtered out. Anything in between is shown normally.
- Every filtered card can be revealed with the reason, and any card can be kept or hidden by hand from its three-dot menu.
- When most of what YouTube offers is rejected, a notice above the feed says so and offers a search for each of your goals.
- A dashboard shows what was let through, by goal and over time.

Desktop Chrome only. Not affiliated with YouTube or Google.

## Install

1. Download or clone this repository.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose the `extension` folder.
3. The setup page opens. Paste your Jev key (create one at [console.typesafe.ai/keys](https://console.typesafe.ai/keys)), pick or write your goals, and set a daily call limit.

Until setup is saved, YouTube looks as usual.

## Cost

Each video is scored once per goal, and scores are cached for 30 days, so a video seen again costs nothing. A long evening on YouTube with three goals can use a few thousand calls. Calls are billed to your own TypeSafe account.

TypeSafe has no per-key spending limit. The **daily call limit** in the extension is the guard. Past it, new videos stay blurred until the next day. Calls used today are shown in Settings.

## What leaves your browser

For each video, the extension sends its video ID, title, channel, length, view count and whether it is a Short, together with your goal text, to `api.typesafe.ai`. A description field is part of the request and is always empty, because feed cards carry none. Nothing else is sent: no cookies, account details or watch history.

Your key is stored in this Chrome profile's extension storage and is sent only to `api.typesafe.ai`. Anyone with access to your Chrome profile can read it.

Scores, the per-day log the dashboard uses, and your Keep and Hide choices stay in the browser (IndexedDB) and are deleted after 30 days.

## Writing goals

A goal works best as "what you want. Not: what to leave out." For example:

> Practical home cooking: technique, recipes with clear steps, meal prep and kitchen basics. Not: food challenges, mukbang, restaurant reviews, or celebrity chef drama.

Each video is checked against every goal that is on, and the best match decides. A goal can also have a minimum length, so short clips do not count for it.

## Development

| Command | What it covers |
|---|---|
| `node --test extension/test/*.test.mjs` | Extension logic: extraction from YouTube's card data, rules, bands, the Jev request text, the scorer (cache, cap, retries), the stats shape, settings migration |
| `cd e2e && npm install`, then `node e2e/seed_profile.mjs` and `node e2e/run_e2e.mjs` | End-to-end checks on youtube.com in a separate, logged-out Chrome for Testing profile. Needs `jev_api_key` in `.env`; one run uses about 1,000 Jev calls. |

`extension/src/shared/core.js` is the shared logic. After editing it, run `node extension/sync_core.mjs` to regenerate `core.main.js`, which the page-world bridge loads.

## Licence

MIT. See [LICENSE](LICENSE).
