import assert from "node:assert/strict";
import { AnthropicDirectBrain, parseAnthropicSseEvent } from "../src/web/brain/anthropic-messages.js";
import { ProviderError, normalizeProviderError } from "../src/web/brain/errors.js";
import { adaptBranchGeneration, adaptTextGeneration } from "../src/web/brain/generation-events.js";
import { OpenAICompatibleBrain, parseOpenAISseEvent, streamOpenAICompatible } from "../src/web/brain/openai-compatible.js";
import { TitleSentinelParser } from "../src/web/brain/title-sentinel.js";

async function collect(iterable) {
  const out = [];
  for await (const value of iterable) out.push(value);
  return out;
}

function chunksOf(source, cuts) {
  const encoder = new TextEncoder();
  const parts = [];
  let start = 0;
  for (const end of cuts) {
    parts.push(encoder.encode(source.slice(start, end)));
    start = end;
  }
  parts.push(encoder.encode(source.slice(start)));
  return parts;
}

function responseFromChunks(chunks) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { status: 200 });
}

const openAiWire = [
  'data: {"choices":[{"delta":{"content":"alpha"}}]}',
  'data: {"choices":[{"delta":{"content":" beta"}}]}',
  "data: [DONE]",
].join("\r\n\r\n") + "\r\n\r\n";
const originalFetch = globalThis.fetch;
try {
  for (let offset = 0; offset <= openAiWire.length; offset += 1) {
    globalThis.fetch = async () => responseFromChunks(chunksOf(openAiWire, [offset]));
    assert.deepEqual(await collect(streamOpenAICompatible({ url: "https://example.test/chat/completions", body: {} })), ["alpha", " beta"]);
  }
} finally {
  globalThis.fetch = originalFetch;
}
assert.equal(parseOpenAISseEvent('data: {"choices":[{"message":{"content":"one"}}]}\ndata: {"choices":[{"delta":{"content":" two"}}]}'), "one two");
assert.equal(parseOpenAISseEvent("data: [DONE]"), "");
console.log("ok stage18: OpenAI SSE arbitrary fragmentation, multi-event chunks, CRLF, and DONE");

const anthropicEvent = 'event: content_block_delta\r\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}';
assert.equal(parseAnthropicSseEvent(anthropicEvent), "hello");
assert.equal(parseAnthropicSseEvent('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"a"}}\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"b"}}'), "ab");
assert.equal(parseAnthropicSseEvent("data: [DONE]"), "");
console.log("ok stage18: Anthropic SSE multi-data events, CRLF, and DONE");

const anthropicWire = [
  'event: content_block_delta\r\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"alpha"}}',
  'event: content_block_delta\r\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" beta"}}',
  "data: [DONE]",
].join("\r\n\r\n") + "\r\n\r\n";
const rawAnthropic = new AnthropicDirectBrain({ apiKey: "fixture" });
try {
  for (let offset = 0; offset <= anthropicWire.length; offset += 1) {
    globalThis.fetch = async () => responseFromChunks(chunksOf(anthropicWire, [offset]));
    assert.deepEqual(await collect(rawAnthropic.streamMessagesApi({ messages: [], model: "fixture" })), ["alpha", " beta"]);
  }
} finally {
  globalThis.fetch = originalFetch;
}
console.log("ok stage18: Anthropic SSE arbitrary fragmentation and multi-event chunks");

function parseTitle(chunks, fallbackTitle = "Fallback") {
  const parser = new TitleSentinelParser({ fallbackTitle });
  let text = "";
  for (const chunk of chunks) text += parser.push(chunk);
  text += parser.finish();
  return { title: parser.title, text };
}
const sentinelStream = "TITLE: Fragmented title\n\n# Body\nExact bytes.";
for (let offset = 0; offset <= sentinelStream.length; offset += 1) {
  assert.deepEqual(parseTitle([sentinelStream.slice(0, offset), sentinelStream.slice(offset)]), {
    title: "Fragmented title", text: "# Body\nExact bytes.",
  }, `title sentinel split offset ${offset}`);
}
assert.deepEqual(parseTitle(["TITLE: Start\nbody"]), { title: "Start", text: "body" });
assert.deepEqual(parseTitle(["TITLE: End"]), { title: "End", text: "" });
assert.deepEqual(parseTitle(["plain body"]), { title: "Fallback", text: "plain body\n" });
assert.deepEqual(parseTitle(["TITLE:"]), { title: "Fallback", text: "TITLE:\n" });
assert.deepEqual(parseTitle(["TITLE: partial"]), { title: "partial", text: "" });
console.log("ok stage18: title sentinel full fragmentation sweep and terminal edge cases");

const existing = new ProviderError("rate", { status: 429, code: "rate_limit" });
assert.strictEqual(normalizeProviderError(existing), existing);
const aborted = normalizeProviderError({ name: "AbortError" });
assert.equal(aborted.name, "ProviderError");
assert.equal(aborted.status, null);
assert.equal(aborted.code, "abort");
assert.equal(aborted.retryable, true);
const network = normalizeProviderError(new TypeError("socket closed"));
assert.equal(network.message, "socket closed");
assert.equal(network.code, "network");
assert.equal(network.retryable, true);
console.log("ok stage18: provider error normalization shapes");

async function* fixtureChunks(parts) { yield* parts; }
const rawBranch = "TITLE: Adapter title\n\nParagraph one.\nParagraph two.";
const branchEvents = await collect(adaptBranchGeneration(fixtureChunks(["TITLE: Ad", "apter title\n\nPara", "graph one.\nParagraph two."])));
assert.deepEqual(branchEvents.filter((event) => event.type === "title"), [{ type: "title", title: "Adapter title" }]);
assert.equal(branchEvents.filter((event) => event.type === "text").map((event) => event.delta).join(""), rawBranch.slice(rawBranch.indexOf("\n\n") + 2));
const rawAuthor = "# Heading\r\n\r\nByte-exact body ☃";
for (const events of [
  await collect(adaptTextGeneration(fixtureChunks(["# Head", "ing\r\n", "\r\nByte-exact body ☃"]))),
  await collect(adaptTextGeneration(fixtureChunks([rawAuthor]))),
]) {
  assert.equal(events.some((event) => event.type === "title"), false);
  assert.equal(events.map((event) => event.delta).join(""), rawAuthor);
}
console.log("ok stage18: pure branch and author adapters preserve exact text bytes");

const openAiBrain = new OpenAICompatibleBrain({ baseUrl: "https://example.test", answerModel: "fixture" });
try {
  globalThis.fetch = async (_url, options) => {
    const messages = JSON.parse(options.body).messages;
    const isBranch = messages[0].content.includes("TITLE: <short node title>");
    const text = isBranch ? "TITLE: Brain title\nBody" : rawAuthor;
    const wire = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`;
    return responseFromChunks(chunksOf(wire, [1, 7, 19]));
  };
  const branch = await collect(openAiBrain.answerBranch({ fallbackTitle: "Fallback" }, new AbortController().signal));
  assert.deepEqual(branch, [{ type: "title", title: "Brain title" }, { type: "text", delta: "Body" }]);
  for (const events of [
    await collect(openAiBrain.authorExplainer({ question: "why" }, new AbortController().signal)),
    await collect(openAiBrain.authorDocument({ markdown: "source" }, new AbortController().signal)),
  ]) {
    assert.equal(events.some((event) => event.type === "title"), false);
    assert.equal(events.map((event) => event.delta).join(""), rawAuthor);
  }
} finally {
  globalThis.fetch = originalFetch;
}

class FixtureAnthropicBrain extends AnthropicDirectBrain {
  async *streamMessagesApi() { yield "TITLE: Direct title\nBody"; }
}
const anthropic = new FixtureAnthropicBrain({ apiKey: "fixture" });
assert.deepEqual(await collect(anthropic.answerBranchMessagesApi({ fallbackTitle: "Fallback" })), [
  { type: "title", title: "Direct title" }, { type: "text", delta: "Body" },
]);
for (const events of [
  await collect(anthropic.authorExplainerMessagesApi({ question: "why" })),
  await collect(anthropic.authorDocumentMessagesApi({ markdown: "source" })),
]) assert.equal(events.some((event) => event.type === "title"), false);
console.log("ok stage18: both brain implementations expose GenerationEvent on all surfaces");
