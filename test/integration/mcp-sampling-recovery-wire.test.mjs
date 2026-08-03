import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const storage = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-mcp-sampling-wire-"));

function waitFor(predicate, label) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 2_000;
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for ${label}`));
      }
    }, 5);
  });
}

async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 5_000 });
  assert.equal(result.isError, undefined, `${name} failed: ${JSON.stringify(result)}`);
  return JSON.parse(result.content[0].text);
}

let stderr = "";
let resolveUrl;
const urlPromise = new Promise((resolve) => { resolveUrl = resolve; });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, "bin/mcp-server.js")],
  cwd: ROOT,
  stderr: "pipe",
  env: {
    ...process.env,
    RABBITHOLE_DIR: storage,
    RABBITHOLE_NO_BROWSER: "1",
    RABBITHOLE_AUTO_RECOVER_STALLED: "1",
    RABBITHOLE_ANSWER_WATCHDOG_MS: "25",
    RABBITHOLE_MAX_BLOCK_MS: "1000",
  },
});
transport.stderr.on("data", (chunk) => {
  const text = chunk.toString();
  stderr += text;
  const match = /listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(text);
  if (match) resolveUrl(match[1]);
});

const samplingRequests = [];
const client = new Client(
  { name: "mcp-sampling-recovery-wire", version: "1.0" },
  { capabilities: { sampling: { context: {} } } }
);
client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
  samplingRequests.push(request.params);
  return {
    model: "test-model",
    role: "assistant",
    content: { type: "text", text: "Recovered by the connected Codex client." },
  };
});

try {
  await client.connect(transport);
  const openPromise = callTool(client, "open_rabbithole", { title: "Sampling wire", content: "Root document context." });
  const url = await urlPromise;
  const initialSnapshot = await fetch(`${url}/snapshot-hole`).then((response) => response.json());
  const submit = await fetch(`${url}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "branch_request",
      parent_id: initialSnapshot.root_id,
      request_id: "wire-request",
      node_id: "wire-node",
      selected_text: "Root document context.",
      question: "Why is this recovered?",
    }),
  });
  assert.equal(submit.status, 200, `branch request failed: ${await submit.text()}`);
  const branch = await openPromise;
  assert.equal(branch.status, "branch_request");
  assert.equal(branch.request_id, "wire-request");

  await waitFor(() => samplingRequests.length === 1, `sampling request; stderr=${stderr}`);
  const snapshot = await fetch(`${url}/snapshot-hole`).then((response) => response.json());
  const node = snapshot.nodes.find((entry) => entry.id === "wire-node");
  assert.equal(node.status, "answered");
  assert.equal(node.markdown, "Recovered by the connected Codex client.");
  assert.match(samplingRequests[0].messages[0].content.text, /Why is this recovered/);
  assert.match(stderr, /stalled-branch sampling recovery enabled/);
  console.log("ok MCP sampling recovery wire: server invokes a sampling-capable client after a stall");
} finally {
  await client.close().catch(() => {});
  await fs.rm(storage, { recursive: true, force: true });
}
