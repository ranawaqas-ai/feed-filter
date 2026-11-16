// The topic model: once a week the service worker sends titles and channel names from the
// local log to Claude, with the user's own Anthropic key, and gets back topics. Only this file
// calls api.anthropic.com. The reply is streamed, because Chrome stops a service worker whose
// fetch has not answered within 30 seconds.
// Loaded with importScripts in the service worker and with require() in the unit tests.
(function (root) {
  "use strict";

  const API_URL = "https://api.anthropic.com/v1/messages";
  const MODELS_URL = "https://api.anthropic.com/v1/models?limit=1";
  const MODEL = "claude-opus-5-5";
  const API_VERSION = "2026-10-21";
  // Lets a refused request be answered by another model in the same call.
  const FALLBACK_BETA = "server-side-fallback-2026-07-01";
  const MAX_TOPICS = 12;
  const SCHEMA = {
    type: "object", additionalProperties: false, required: ["topics"],
    properties: { topics: { type: "array", items: {
      type: "object", additionalProperties: false, required: ["name", "sentence", "items"],
      properties: { name: { type: "string" }, sentence: { type: "string" }, items: { type: "array", items: { type: "integer" } } } } } },
  };
  const SYSTEM =
    "You group YouTube videos into topics. Each line of the user's message is 'number. title | channel'. " +
    `Return at most ${MAX_TOPICS} topics. Each topic has a short plain name of 2 to 5 words, one sentence that describes ` +
    "what its videos are about in the way a person would write a viewing goal, and the numbers of its videos. " +
    "Put a video in at most one topic, and leave out videos that fit no topic. " +
    "Name a topic by its subject, not by one event or one channel, so the name still fits next week.";

  class TopicError extends Error {
    constructor(code) {
      super(code);
      this.code = code;
    }
  }

  function headers(apiKey) {
    return { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": API_VERSION,
      // The API refuses requests that carry a browser Origin unless this is set.
      "anthropic-dangerous-direct-browser-access": "true" };
  }

  function requestBody(lines, previousNames) {
    const keep = previousNames && previousNames.length
      ? ` Where one of these earlier topic names still fits, use it unchanged: ${previousNames.join("; ")}.` : "";
    return { model: MODEL, max_tokens: 32000, stream: true, fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM + keep, messages: [{ role: "user", content: lines.join("\n") }] };
  }

  // Server-sent events -> the reply text, why it stopped and the token counts.
  async function readStream(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let stop = null;
    let usage = {};
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const data = buffer.slice(0, end).split("\n").find((l) => l.startsWith("data: "));
        buffer = buffer.slice(end + 2);
        if (!data) continue;
        const ev = JSON.parse(data.slice(6));
        if (ev.type === "message_start") usage = { ...ev.message.usage };
        else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") text += ev.delta.text;
        else if (ev.type === "message_delta") {
          stop = ev.delta.stop_reason;
          usage = { ...usage, ...ev.usage };
        } else if (ev.type === "error") throw new TopicError(`claude_error:${(ev.error && ev.error.type) || "stream"}`);
      }
    }
    return { text, stop, usage: { input: usage.input_tokens || 0, output: usage.output_tokens || 0 } };
  }

  function statusError(status) {
    if (status === 401 || status === 403) return new TopicError("bad_key");
    if (status === 429) return new TopicError("rate_limited");
    return new TopicError(`claude_error:HTTP ${status}`);
  }

  class TopicClient {
    constructor({ apiKey, fetch }) {
      this.apiKey = apiKey;
      this.fetch = fetch;
    }

    // lines: "n. title | channel". Resolves {text, usage}; throws a TopicError with a short code.
    async group(lines, previousNames) {
      let response;
      try {
        response = await this.fetch(API_URL, { method: "POST", credentials: "omit",
          headers: { ...headers(this.apiKey), "anthropic-beta": FALLBACK_BETA }, body: JSON.stringify(requestBody(lines, previousNames)) });
      } catch (err) {
        throw new TopicError("claude_error:connection");
      }
      if (!response.ok) throw statusError(response.status);
      const out = await readStream(response);
      if (out.stop === "refusal") throw new TopicError("refused");
      if (out.stop === "max_tokens") throw new TopicError("reply_too_long");
      return out;
    }

    // For the "Test" button: is the key accepted?
    async check() {
      let response;
      try {
        response = await this.fetch(MODELS_URL, { method: "GET", credentials: "omit", headers: headers(this.apiKey) });
      } catch (err) {
        return { error: "Claude unreachable" };
      }
      return response.ok ? { ok: true, model: MODEL } : { error: statusError(response.status).code === "bad_key" ? "Claude rejected the key" : `Claude error (HTTP ${response.status})` };
    }
  }

  const ERROR_TEXT = { bad_key: "Claude rejected the key", rate_limited: "Claude's rate limit was reached", refused: "Claude declined the request",
    reply_too_long: "the reply was cut off", "claude_error:connection": "Claude could not be reached" };
  const errorText = (code) => ERROR_TEXT[code] || String(code);

  const api = { API_URL, MODEL, API_VERSION, MAX_TOPICS, TopicClient, TopicError, requestBody, readStream, errorText };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.YFFTopics = api;
})(typeof self !== "undefined" ? self : globalThis);
