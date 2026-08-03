import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function inheritedEnvironment(overrides) {
  return Object.fromEntries(
    Object.entries({ ...process.env, ...overrides }).filter(([, value]) => typeof value === "string")
  );
}

/** Persistent MCP connection used for the entire browser session. */
export class RabbitholeMcpClient {
  constructor({ mcpServerPath, cwd, dataDir, maxBlockMs = 240_000, onStderr = () => {} }) {
    this.client = new Client({ name: "rabbithole-watch", version: "0.1.0" }, { capabilities: {} });
    this.transport = new StdioClientTransport({
      command: process.execPath,
      args: [mcpServerPath],
      cwd,
      env: inheritedEnvironment({
        RABBITHOLE_MAX_BLOCK_MS: String(maxBlockMs),
        ...(dataDir ? { RABBITHOLE_DIR: path.resolve(dataDir) } : {}),
      }),
      stderr: "pipe",
    });
    this.transport.stderr?.setEncoding("utf8");
    this.transport.stderr?.on("data", onStderr);
  }

  start() {
    return this.client.connect(this.transport);
  }

  callTool(tool, args, { signal } = {}) {
    return this.client.callTool(
      { name: tool, arguments: args },
      undefined,
      { signal, timeout: 600_000, maxTotalTimeout: 600_000 }
    );
  }

  close() {
    return this.client.close();
  }
}
