#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { CodexWatchDriver } from "../src/node/watch/driver.js";
import { runWatchLoop } from "../src/node/watch/runner.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MCP_SERVER_PATH = path.join(PACKAGE_ROOT, "bin", "mcp-server.js");

function usage() {
  return [
    "Usage: rabbithole-watch <hole_id> [options]",
    "",
    "Keep a Rabbithole attached and answer branch requests with the local Codex login.",
    "",
    "Options:",
    "  --codex <path>       Codex executable (default: codex)",
    "  --cwd <path>         Working directory for answer turns",
    "  --data-dir <path>    Rabbithole storage directory (or use RABBITHOLE_DIR)",
    "  --model <model>      Codex model override",
    "  --effort <level>     Reasoning effort override",
    "  --max-retries <n>    Stop after n retries (default: unlimited)",
    "  -h, --help           Show this help",
  ].join("\n");
}

export function parseArgs(argv) {
  const options = { codexCommand: process.env.CODEX_BIN || "codex", cwd: PACKAGE_ROOT, maxRetries: Infinity };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") return { ...options, help: true };
    if (!arg.startsWith("-") && !options.holeId) { options.holeId = arg; continue; }
    const key = { "--codex": "codexCommand", "--cwd": "cwd", "--data-dir": "dataDir", "--model": "model", "--effort": "effort", "--max-retries": "maxRetries" }[arg];
    if (!key) throw new Error(`Unknown argument: ${arg}`);
    const value = argv[++index];
    if (value === undefined) throw new Error(`${arg} requires a value`);
    options[key] = key === "maxRetries" ? Number(value) : value;
  }
  if (!Number.isInteger(options.maxRetries) && options.maxRetries !== Infinity) throw new Error("--max-retries must be an integer");
  if (options.maxRetries < 0) throw new Error("--max-retries cannot be negative");
  return options;
}

function log(message) {
  process.stderr.write(`[rabbithole-watch] ${message}\n`);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) { process.stdout.write(`${usage()}\n`); return; }
  if (!options.holeId) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 2;
    return;
  }

  const abortController = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => abortController.abort());
  let failures = 0;
  while (!abortController.signal.aborted) {
    const driver = new CodexWatchDriver({
      ...options,
      mcpServerPath: MCP_SERVER_PATH,
      onStderr: (chunk) => process.stderr.write(chunk),
    });
    try {
      await driver.start({ signal: abortController.signal });
      log(`listening on ${options.holeId}`);
      const result = await runWatchLoop({
        holeId: options.holeId,
        driver,
        signal: abortController.signal,
        onStatus: (event) => {
          if (event.status !== "keep_listening") log(`event: ${event.status}`);
        },
      });
      log(`session ended: ${result.reason || result.status}`);
      return;
    } catch (error) {
      if (abortController.signal.aborted || error?.name === "AbortError") return;
      failures += 1;
      log(`connection failed (${failures}): ${error.message}`);
      if (failures > options.maxRetries) throw error;
      const backoffMs = Math.min(30_000, 1_000 * (2 ** Math.min(failures - 1, 5)));
      log(`resuming the same hole in ${Math.round(backoffMs / 1_000)}s`);
      await delay(backoffMs, undefined, { signal: abortController.signal }).catch(() => {});
    } finally {
      await driver.close().catch(() => {});
    }
  }
}

main().catch((error) => {
  log(`fatal: ${error.stack || error.message}`);
  process.exitCode = 1;
});
