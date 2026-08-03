import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RabbitholeMcpClient } from "../../src/node/watch/mcp-client.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-watch-mcp-"));
const previousNoBrowser = process.env.RABBITHOLE_NO_BROWSER;
process.env.RABBITHOLE_NO_BROWSER = "1";

const client = new RabbitholeMcpClient({
  mcpServerPath: path.join(ROOT, "bin", "mcp-server.js"),
  cwd: ROOT,
  dataDir: path.join(temporaryRoot, "data"),
  maxBlockMs: 30,
});

function parseResult(result) {
  assert.equal(result.isError, undefined);
  const text = result.content.find((entry) => entry.type === "text")?.text;
  assert.equal(typeof text, "string");
  return JSON.parse(text);
}

try {
  await client.start();
  const first = parseResult(await client.callTool("open_rabbithole", {
    title: "Persistent watcher fixture",
    content: "The MCP child must survive between calls.",
  }));
  assert.equal(first.status, "keep_listening");
  assert.equal(typeof first.hole_id, "string");

  const second = parseResult(await client.callTool("open_rabbithole", { hole_id: first.hole_id }));
  assert.equal(second.status, "keep_listening");
  assert.equal(second.hole_id, first.hole_id);
  assert.equal(second.session_id, first.session_id, "re-arm must use the same live MCP session");
} finally {
  await client.close();
  if (previousNoBrowser === undefined) delete process.env.RABBITHOLE_NO_BROWSER;
  else process.env.RABBITHOLE_NO_BROWSER = previousNoBrowser;
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

console.log("ok watch MCP client: one persistent child re-arms the same live session");
