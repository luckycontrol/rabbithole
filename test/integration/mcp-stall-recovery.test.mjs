import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.RABBITHOLE_NO_BROWSER = "1";
process.env.RABBITHOLE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-mcp-stall-recovery-"));

const { createSamplingStallRecovery, samplingRecoveryEnabled } = await import("../../src/node/mcp/sampling-recovery.js");
const { closeAllSessions, createSession } = await import("../../src/node/sessions.js");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function rootNode() {
  return {
    id: "root",
    parent_id: null,
    title: "Root",
    markdown: "Root context explains the system.",
    base_url: null,
    base_url_source: null,
    origin: null,
    position: { x: 0, y: 0 },
    size: null,
    font_scale: 1,
    collapsed: false,
    status: "answered",
    read: true,
    created_at: new Date().toISOString(),
  };
}

async function makeSession(recoverStalledBranch) {
  return createSession({
    holeId: `stall-recovery-${Math.random().toString(36).slice(2)}`,
    title: "Stall recovery",
    rootId: "root",
    nodes: [rootNode()],
    assetNames: new Set(),
    isResume: false,
    renderPage: () => "<!doctype html><title>test</title>",
    recoverStalledBranch,
    answerWatchdogMs: 25,
  });
}

function ask(session, requestId, nodeId, question = "Explain this") {
  return session.handleBranchRequest({
    parent_id: "root",
    request_id: requestId,
    node_id: nodeId,
    selected_text: "Root context",
    question,
  });
}

async function runAutomaticRecoveryFixture() {
  const recovered = [];
  const session = await makeSession(async ({ event, parent, node }) => {
    recovered.push({ requestId: event.request_id, parent: parent?.title, partial: node.markdown });
    return { title: "Recovered answer", content: `Recovered: ${event.question}` };
  });

  const firstWait = session.waitForEvent();
  const firstAsk = ask(session, "req-first", "node-first", "What does this mean?");
  const delivered = await firstWait;
  assert.equal(delivered.status, "branch_request");
  assert.equal(delivered.request_id, firstAsk.request_id);

  await waitFor(() => session.nodes.get(firstAsk.node_id)?.status === "answered", "first sampled answer");
  await waitFor(() => session.agentAttached && session.autoRecoveryMode, "recovered connection state");
  assert.equal(session.nodes.get(firstAsk.node_id).markdown, "Recovered: What does this mean?");
  assert.equal(session.nodes.get(firstAsk.node_id).title, "Recovered answer");
  assert.equal(session.agentAttached, true, "a successful sampled recovery should restore the live state");
  assert.equal(session.autoRecoveryMode, true, "later asks should use the recovered connection automatically");

  const secondAsk = ask(session, "req-second", "node-second", "And what follows?");
  await waitFor(() => session.nodes.get(secondAsk.node_id)?.status === "answered", "automatic follow-up recovery");
  assert.equal(session.nodes.get(secondAsk.node_id).markdown, "Recovered: And what follows?");
  assert.deepEqual(recovered.map((entry) => entry.requestId), ["req-first", "req-second"]);
  assert.equal(recovered[0].parent, "Root");
  console.log("ok stalled recovery: sampling completes the stalled branch and later asks");
}

async function runManualTakeoverFixture() {
  let releaseRecovery;
  let recoveryStarted;
  const recoveryStartedPromise = new Promise((resolve) => { recoveryStarted = resolve; });
  const recoveryReleasePromise = new Promise((resolve) => { releaseRecovery = resolve; });
  const session = await makeSession(async () => {
    recoveryStarted();
    await recoveryReleasePromise;
    return { title: "Late recovery", content: "This must not win." };
  });

  const firstWait = session.waitForEvent();
  const pending = ask(session, "req-manual", "node-manual", "Can the agent take over?");
  await firstWait;
  await recoveryStartedPromise;

  const controller = new AbortController();
  const manualWait = session.answerBranch({
    requestId: pending.request_id,
    title: "Manual answer",
    content: "The returned Codex agent wins.",
    signal: controller.signal,
  });
  controller.abort();
  await manualWait;
  releaseRecovery();
  await sleep(20);

  assert.equal(session.nodes.get(pending.node_id).markdown, "The returned Codex agent wins.");
  assert.equal(session.nodes.get(pending.node_id).title, "Manual answer");
  console.log("ok stalled recovery: a returned MCP agent cancels the sampling fallback");
}

async function runSamplingAdapterFixture() {
  const previous = process.env.RABBITHOLE_AUTO_RECOVER_STALLED;
  process.env.RABBITHOLE_AUTO_RECOVER_STALLED = "1";
  assert.equal(samplingRecoveryEnabled(), true);
  if (previous === undefined) delete process.env.RABBITHOLE_AUTO_RECOVER_STALLED;
  else process.env.RABBITHOLE_AUTO_RECOVER_STALLED = previous;

  let request;
  const recovery = createSamplingStallRecovery({
    server: {
      getClientCapabilities: () => ({ sampling: {} }),
      createMessage: async (params) => {
        request = params;
        return { content: { type: "text", text: "Sampled markdown answer" } };
      },
    },
  });
  const result = await recovery({
    event: {
      status: "branch_request",
      request_id: "req-sample",
      parent_node_title: "Root",
      selected_text: "Selected context",
      question: "Why now?",
      lens: "deeper",
      lineage: ["Root"],
    },
    parent: rootNode(),
    node: { markdown: "" },
  });

  assert.equal(request.maxTokens, 4096);
  assert.match(request.messages[0].content.text, /Selected context/);
  assert.match(request.messages[0].content.text, /Root context explains the system/);
  assert.deepEqual(result, { title: "Why now?", content: "Sampled markdown answer" });

  const unsupported = createSamplingStallRecovery({
    server: {
      getClientCapabilities: () => ({}),
      createMessage: async () => { throw new Error("must not sample without the capability"); },
    },
  });
  assert.equal(await unsupported({ event: { status: "branch_request" }, parent: rootNode(), node: {} }), null);

  const regionResult = await recovery({
    event: { status: "branch_request", region: { image_path: "/tmp/selection.png" } },
    parent: rootNode(),
    node: {},
  });
  assert.equal(regionResult, null, "sampling must not claim image-region requests");
  console.log("ok stalled recovery: capability-gated sampling adapter");
}

try {
  await runAutomaticRecoveryFixture();
  await runManualTakeoverFixture();
  await runSamplingAdapterFixture();
} finally {
  await closeAllSessions("mcp_stall_recovery_test_complete");
}

console.log("MCP stalled recovery verification passed");
