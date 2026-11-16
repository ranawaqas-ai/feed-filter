// Unit tests for extension/src/topics.js (the topic model client). Run: node --test extension/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const T = require("../src/topics.js");
const pass = (msg) => console.log(`PASS ${msg}`);

// A streamed reply, split at awkward places to exercise the buffer.
function sse(events, chunkSize = 37) {
  const raw = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const bytes = new TextEncoder().encode(raw);
  let at = 0;
  return { ok: true, status: 200, body: { getReader: () => ({ read: async () => {
    if (at >= bytes.length) return { done: true };
    const value = bytes.slice(at, at + chunkSize);
    at += chunkSize;
    return { done: false, value };
  } }) } };
}
const reply = (text, stop = "end_turn") => sse([
  { type: "message_start", message: { usage: { input_tokens: 120, output_tokens: 1 } } },
  { type: "content_block_delta", delta: { type: "text_delta", text: text.slice(0, 9) } },
  { type: "ping" },
  { type: "content_block_delta", delta: { type: "text_delta", text: text.slice(9) } },
  { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 44 } },
]);

test("TopicClient sends titles to Claude with the key and reads the streamed reply", async () => {
  const calls = [];
  const client = new T.TopicClient({ apiKey: "k-test", fetch: async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return reply('{"topics":[{"name":"Café cooking"}]}'); } });
  const out = await client.group(["1. A | B", "2. C | D"], ["Old topic", "Another"]);
  assert.equal(out.text, '{"topics":[{"name":"Café cooking"}]}', "text survives chunk boundaries inside a multi-byte character");
  assert.deepEqual(out.usage, { input: 120, output: 44 });
  const { url, init, body } = calls[0];
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(init.headers["x-api-key"], "k-test");
  assert.equal(init.headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(init.credentials, "omit");
  assert.deepEqual([body.model, body.stream, body.output_config.format.type, body.messages[0].content], ["claude-opus-5-5", true, "json_schema", "1. A | B\n2. C | D"]);
  assert.match(body.system, /Old topic; Another/);
  assert.doesNotMatch(T.requestBody(["1. A | B"], []).system, /earlier topic names/);
  pass("YFFTopics.TopicClient: one streamed request with the key, the numbered lines as the message and earlier topic names in the instructions");
});

test("TopicClient turns failures into short codes", async () => {
  const failing = (response) => new T.TopicClient({ apiKey: "k", fetch: async () => response });
  const code = (p) => p.then(() => "no error", (e) => e.code);
  assert.equal(await code(failing({ ok: false, status: 401 }).group(["1. a | b"])), "bad_key");
  assert.equal(await code(failing({ ok: false, status: 429 }).group(["1. a | b"])), "rate_limited");
  assert.equal(await code(failing({ ok: false, status: 529 }).group(["1. a | b"])), "claude_error:HTTP 529");
  assert.equal(await code(failing(reply("{}", "refusal")).group(["1. a | b"])), "refused");
  assert.equal(await code(failing(reply('{"topics":[', "max_tokens")).group(["1. a | b"])), "reply_too_long");
  assert.equal(await code(new T.TopicClient({ apiKey: "k", fetch: async () => { throw new TypeError("Failed to fetch"); } }).group(["1. a | b"])), "claude_error:connection");
  assert.equal(await code(failing(sse([{ type: "error", error: { type: "overloaded_error" } }])).group(["1. a | b"])), "claude_error:overloaded_error");
  assert.deepEqual(await failing({ ok: true, status: 200 }).check(), { ok: true, model: "claude-opus-5-5" });
  assert.deepEqual(await failing({ ok: false, status: 401 }).check(), { error: "Claude rejected the key" });
  assert.equal(T.errorText("bad_key"), "Claude rejected the key");
  pass("YFFTopics.TopicClient: rejected key, rate limit, HTTP error, refusal, cut-off reply, no connection and a stream error each give one code");
});
