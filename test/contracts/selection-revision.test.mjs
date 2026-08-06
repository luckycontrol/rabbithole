// A selection revision hands the agent a span of a card and splices back what
// it returns. Everything that protects that splice lives on the wire: the span
// is validated before the request goes out and again before the result is
// announced, the reply streams as a fragment rather than as a card, and the
// card itself does not move until the browser applies it.
//
// The MCP session and the BYOK direct host implement the same exchange
// separately, so both are driven here rather than only the one the terminal
// happens to use.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openRabbithole, answerBranch } from "../../src/node/rabbithole.js";
import { closeAllSessions, getSession } from "../../src/node/sessions.js";
import { DirectRabbitholeHost } from "../../src/web/transport/direct-host.js";

process.env.RABBITHOLE_NO_BROWSER = "1";
process.env.RABBITHOLE_MAX_BLOCK_MS = "50";
process.env.RABBITHOLE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-selection-revision-"));

const CARD = "Opening paragraph.\n\nThe passage under revision.\n\nClosing paragraph.\n";
const REGION = { md_start: 20, md_end: 49, region_markdown: "The passage under revision.\n\n", selected_text: "under revision" };

async function postEvent(session, payload) {
  const res = await fetch(`${session.url}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

async function seedAnsweredCard(session, { nodeId, requestId }) {
  const posted = await postEvent(session, {
    type: "branch_request", request_id: requestId, node_id: nodeId, parent_id: session.rootId,
    selected_text: "Root", question: "Explain", branch_type: "selection",
    anchor: { offset_start: 0, offset_end: 4 },
    position: { x: 480, y: 0 }, size: { w: 420, h: 360 },
  });
  assert.equal(posted.status, 200);
  await openRabbithole({ holeId: session.holeId });
  await answerBranch({ sessionId: session.id, requestId, title: "Answer", content: CARD });
  assert.equal(session.nodes.get(nodeId).markdown, CARD, "the card should be answered before revising it");
}

async function runSessionWire() {
  const opened = await openRabbithole({ title: "Selection Revision Root", content: "Root document.\n" });
  const session = getSession(opened.session_id);
  const nodeId = "selection-revision-card";
  await seedAnsweredCard(session, { nodeId, requestId: "seed-answer" });

  assert.equal(CARD.slice(REGION.md_start, REGION.md_end), REGION.region_markdown,
    "the fixture region must quote the card it is taken from");

  const stale = await postEvent(session, {
    type: "revision_request", request_id: "stale-span", node_id: nodeId, instruction: "Tighten this",
    selection: { ...REGION, region_markdown: "Text that is not in this card.\n" },
  });
  assert.equal(stale.status, 409, "a span that no longer quotes the card must be refused");
  console.log("ok selection revision wire: a stale span is refused before the agent sees it");

  const requestId = "revise-passage";
  const accepted = await postEvent(session, {
    type: "revision_request", request_id: requestId, node_id: nodeId,
    instruction: "Say it in one sentence", selection: REGION,
  });
  assert.deepEqual(accepted.body, { ok: true, node_id: nodeId, request_id: requestId });

  const event = await openRabbithole({ holeId: session.holeId });
  assert.equal(event.status, "revision_request");
  assert.equal(event.current_markdown, CARD, "the whole card travels as context");
  assert.deepEqual(event.selection, REGION, "the region travels with the request");
  assert.match(event.response_contract, /ONLY the replacement Markdown/,
    "the contract must tell the agent to return the fragment alone");
  console.log("ok selection revision wire: the region and a fragment contract reach the agent");

  const partial = await answerBranch({ sessionId: session.id, requestId, content: "A tighter passage", partial: true });
  assert.deepEqual(partial, { ok: true, node_id: nodeId, request_id: requestId, partial: true, revision: true });
  const progress = session.outboundEvents.at(-1).data;
  assert.equal(progress.type, "revision_progress");
  assert.equal(progress.scope, "selection", "progress must announce itself as a fragment");
  assert.equal(progress.fragment, "A tighter passage");
  assert.equal(progress.markdown, undefined, "a fragment is not a card and carries no whole markdown");
  assert.equal(session.nodes.get(nodeId).markdown, CARD,
    "streaming must not touch the card before the browser applies it");

  await answerBranch({ sessionId: session.id, requestId, title: "ignored", content: ".\n\n" });
  const ready = session.outboundEvents.at(-1).data;
  assert.equal(ready.type, "revision_ready");
  assert.equal(ready.scope, "selection");
  assert.equal(ready.fragment, "A tighter passage.\n\n", "chunks concatenate verbatim");
  assert.equal(ready.stale, false, "the span still quotes the card");
  assert.equal(session.nodes.get(nodeId).markdown, CARD,
    "a ready fragment remains a preview until the browser applies it");
  console.log("ok selection revision wire: the fragment streams without moving the card");

  const spliced = CARD.slice(0, REGION.md_start) + ready.fragment + CARD.slice(REGION.md_end);
  const applied = await postEvent(session, { type: "answer_node_content", node_id: nodeId, markdown: spliced });
  assert.equal(applied.body.ok, true);
  assert.equal(session.nodes.get(nodeId).markdown,
    "Opening paragraph.\n\nA tighter passage.\n\nClosing paragraph.\n",
    "applying replaces only the region");
  console.log("ok selection revision wire: applying the splice changes only the region");

  // Anchors move with the text they point at, so the surface that rewrote it
  // reports where they landed through the same transport.
  const anchored = await postEvent(session, {
    type: "node_origin", node_id: nodeId,
    origin: { selected_text: "Root", question: "Explain", anchor: { offset_start: 3, offset_end: 7 } },
  });
  assert.equal(anchored.status, 200);
  assert.deepEqual(session.nodes.get(nodeId).origin.anchor, { offset_start: 3, offset_end: 7 },
    "a re-anchored origin must persist through the browser transport");
  console.log("ok selection revision wire: moved anchors persist");

  await closeAllSessions();
}

// The BYOK host runs the same exchange against a provider rather than an
// agent, so it gets a stub that streams a fragment back.
async function runDirectHostWire() {
  const emitted = [];
  const store = {
    async saveHole() {},
    async loadHole() { return null; },
  };
  const host = new DirectRabbitholeHost({
    store,
    hole: {
      id: "direct-selection", title: "Direct", root_id: "root",
      nodes: [
        { id: "root", parent_id: null, title: "Direct", markdown: "Root.\n", status: "answered", origin: null },
        { id: "card", parent_id: "root", title: "Card", markdown: CARD, status: "answered",
          origin: { selected_text: "Root", question: "Explain", anchor: { offset_start: 0, offset_end: 4 } } },
      ],
    },
    brain: {
      async *reviseSelection(context) {
        assert.equal(context.region_markdown, REGION.region_markdown,
          "the provider must be handed the region, not just the card");
        assert.equal(context.markdown, CARD, "the whole card must travel as context");
        assert.equal(context.selected_text, "under revision");
        yield { type: "text", delta: "A tighter" };
        yield { type: "text", delta: " passage.\n\n" };
      },
    },
  });
  host.emit = (event) => { emitted.push(event); };

  // The direct host reports refusals back through the same return value the
  // browser posts against rather than by throwing.
  const stale = await host.handleBrowserEvent({
    type: "revision_request", request_id: "direct-stale", node_id: "card", instruction: "Tighten",
    selection: { ...REGION, region_markdown: "Not in this card.\n" },
  });
  assert.equal(stale.ok, false, "the direct host must refuse a stale span too");
  assert.match(stale.error, /changed since that passage was selected/);
  assert.equal(emitted.length, 0, "a refused span must not reach the provider");

  await host.handleBrowserEvent({
    type: "revision_request", request_id: "direct-revise", node_id: "card",
    instruction: "Say it in one sentence", selection: REGION,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  const ready = emitted.at(-1);
  assert.equal(ready.type, "revision_ready");
  assert.equal(ready.scope, "selection");
  assert.equal(ready.fragment, "A tighter passage.\n\n");
  assert.equal(ready.stale, false);
  assert.equal(host.state.nodes.get("card").markdown, CARD,
    "the direct host must not move the card before the browser applies it");
  const progress = emitted.filter((event) => event.type === "revision_progress");
  assert(progress.length >= 1, "the fragment should stream as it arrives");
  assert.equal(progress[0].scope, "selection");
  console.log("ok selection revision wire: the BYOK host runs the same fragment exchange");
}

await runSessionWire();
await runDirectHostWire();
console.log("selection revision contract verification passed");
