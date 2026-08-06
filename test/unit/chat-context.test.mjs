import assert from "node:assert/strict";
import {
  collectPriorTurns,
  describeChatContext,
  normalizeChatContextRef,
  resolveChatContext,
} from "../../src/core/chat-context.js";
import { createPendingBranchNode } from "../../src/core/model.js";

// ---- normalizeChatContextRef: format-only, both-or-neither -----------------

assert.equal(normalizeChatContextRef(null), null);
assert.equal(normalizeChatContextRef(undefined), null);
assert.equal(normalizeChatContextRef({}), null, "neither id present");
assert.equal(normalizeChatContextRef({ chat_context_id: "page" }), null, "thread id missing");
assert.equal(normalizeChatContextRef({ chat_thread_id: "thread" }), null, "context id missing");
assert.deepEqual(
  normalizeChatContextRef({ chat_context_id: "  page  ", chat_thread_id: "thread" }),
  { chat_context_id: "page", chat_thread_id: "thread" },
  "trims whitespace"
);
assert.equal(
  normalizeChatContextRef({ chat_context_id: "x".repeat(200), chat_thread_id: "thread" }).chat_context_id.length,
  128,
  "caps id length"
);

// ---- createPendingBranchNode: normalizes chat ref onto origin --------------

const parent = { id: "page", parent_id: "root", title: "Page", markdown: "Page body" };
const nodeWithChat = createPendingBranchNode(
  { parent_id: "page", node_id: "turn-1", question: "What is X?", chat_context_id: "page", chat_thread_id: "thread-1" },
  parent
);
assert.equal(nodeWithChat.origin.chat_context_id, "page");
assert.equal(nodeWithChat.origin.chat_thread_id, "thread-1");

const nodeWithoutChat = createPendingBranchNode({ parent_id: "page", node_id: "turn-2", question: "Ordinary follow-up" }, parent);
assert.equal("chat_context_id" in nodeWithoutChat.origin, false, "no chat fields when payload omits them");
assert.equal("chat_thread_id" in nodeWithoutChat.origin, false);

// ---- resolveChatContext: ancestor + thread-consistency validation ---------

function nodeMap(entries) {
  return new Map(entries.map((n) => [n.id, n]));
}

const root = { id: "root", parent_id: "", title: "Root", markdown: "Root body", status: "answered", origin: {} };
const contextPage = { id: "page", parent_id: "root", title: "Page", markdown: "Page body", status: "answered", origin: {} };
const turn1 = {
  id: "turn-1",
  parent_id: "page",
  title: "Turn 1",
  markdown: "Answer 1",
  status: "answered",
  created_at: "2026-01-01T00:00:00.000Z",
  origin: { question: "First question?", chat_context_id: "page", chat_thread_id: "thread-1" },
};
const turn2 = {
  id: "turn-2",
  parent_id: "page",
  title: "Turn 2",
  markdown: "Answer 2",
  status: "answered",
  created_at: "2026-01-01T00:05:00.000Z",
  origin: { question: "Second question?", chat_context_id: "page", chat_thread_id: "thread-1" },
};
const pendingTurn = {
  id: "turn-3",
  parent_id: "page",
  title: "Turn 3",
  markdown: "",
  status: "pending",
  created_at: "2026-01-01T00:10:00.000Z",
  origin: { question: "Third question, unanswered", chat_context_id: "page", chat_thread_id: "thread-1" },
};
const nodes = nodeMap([root, contextPage, turn1, turn2, pendingTurn]);

const validRef = { chat_context_id: "page", chat_thread_id: "thread-1" };
const resolved = resolveChatContext(nodes, "page", validRef);
assert.ok(resolved, "resolves when context page is an ancestor(-or-self) of the parent");
assert.equal(resolved.contextNode.id, "page");
assert.deepEqual(
  resolved.priorTurns.map((t) => t.question),
  ["First question?", "Second question?"],
  "chronological, answered-only turns"
);

assert.equal(resolveChatContext(nodes, "page", null), null, "no ref: no chat context");
assert.equal(resolveChatContext(nodes, "page", { chat_context_id: "missing", chat_thread_id: "thread-1" }), null, "unknown context node");
assert.equal(
  resolveChatContext(nodes, "root", { chat_context_id: "page", chat_thread_id: "thread-1" }),
  null,
  "context page must be an ancestor of the parent, not a descendant"
);

// A thread id reused under a different context id anywhere in the tree is a spoofed/invalid pairing.
const spoofedNodes = nodeMap([root, contextPage, turn1, { ...turn2, origin: { ...turn2.origin, chat_context_id: "root" } }]);
assert.equal(
  resolveChatContext(spoofedNodes, "page", validRef),
  null,
  "falls back when the thread id is already bound to a different context id"
);

// ---- collectPriorTurns: limit keeps the most recent turns ------------------

const many = nodeMap([
  root,
  contextPage,
  ...Array.from({ length: 5 }, (_, i) => ({
    id: `t${i}`,
    parent_id: "page",
    status: "answered",
    created_at: `2026-01-01T00:0${i}:00.000Z`,
    markdown: `Answer ${i}`,
    origin: { question: `Q${i}`, chat_context_id: "page", chat_thread_id: "thread-1" },
  })),
]);
const limited = collectPriorTurns(many, validRef, { limit: 2 });
assert.deepEqual(limited.map((t) => t.question), ["Q3", "Q4"], "keeps the newest N in chronological order");
assert.deepEqual(collectPriorTurns(many, null), [], "no ref: no turns");

// ---- describeChatContext: wire/prompt shape --------------------------------

const described = describeChatContext(resolved);
assert.equal(described.context_title, "Page");
assert.equal(described.context_markdown, "Page body");
assert.deepEqual(described.prior_turns, [
  { question: "First question?", answer: "Answer 1" },
  { question: "Second question?", answer: "Answer 2" },
]);

console.log("ok chat-context: normalization, ancestor + thread validation, chronological turns, wire shape");
