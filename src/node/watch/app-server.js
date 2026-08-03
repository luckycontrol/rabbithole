import { spawn } from "node:child_process";
import readline from "node:readline";

function abortError() {
  return new DOMException("The operation was aborted", "AbortError");
}

function errorMessage(error) {
  if (typeof error === "string") return error;
  if (error && typeof error.message === "string") return error.message;
  return JSON.stringify(error);
}

/** Minimal newline-delimited JSON client for `codex app-server --stdio`. */
export class CodexAppServerClient {
  constructor({ command = "codex", args = ["app-server", "--stdio"], cwd, env, onStderr = () => {}, spawnProcess = spawn } = {}) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.onStderr = onStderr;
    this.spawnProcess = spawnProcess;
    this.nextId = 1;
    this.pending = new Map();
    this.notificationWaiters = new Set();
    this.child = null;
    this.closed = false;
  }

  async start() {
    if (this.child) return;
    this.child = this.spawnProcess(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", this.onStderr);
    this.child.once("error", (error) => this.failAll(error));
    this.child.once("exit", (code, signal) => {
      if (!this.closed) this.failAll(new Error(`Codex app-server exited (code=${code}, signal=${signal})`));
    });

    const lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleLine(line));
    await this.request("initialize", {
      clientInfo: { name: "rabbithole-watch", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify("initialized");
  }

  handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.failAll(new Error(`Codex app-server emitted invalid JSON: ${errorMessage(error)}`));
      return;
    }

    if (Object.hasOwn(message, "id")) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.cleanup();
      if (message.error) pending.reject(new Error(`Codex app-server request failed: ${errorMessage(message.error)}`));
      else pending.resolve(message.result);
      return;
    }

    if (typeof message.method === "string") {
      for (const waiter of [...this.notificationWaiters]) {
        if (waiter.method !== message.method || !waiter.predicate(message.params)) continue;
        this.notificationWaiters.delete(waiter);
        waiter.cleanup();
        waiter.resolve(message.params);
      }
    }
  }

  request(method, params, { signal } = {}) {
    if (!this.child || this.closed) return Promise.reject(new Error("Codex app-server is not running"));
    if (signal?.aborted) return Promise.reject(abortError());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        cleanup();
        reject(abortError());
      };
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        cleanup();
        reject(error);
      });
    });
  }

  notify(method, params) {
    if (!this.child || this.closed) throw new Error("Codex app-server is not running");
    const message = params === undefined ? { method } : { method, params };
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  waitForNotification(method, predicate = () => true, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const waiter = { method, predicate, resolve, reject, cleanup: () => {} };
      const onAbort = () => {
        this.notificationWaiters.delete(waiter);
        waiter.cleanup();
        reject(abortError());
      };
      waiter.cleanup = () => signal?.removeEventListener("abort", onAbort);
      this.notificationWaiters.add(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.notificationWaiters) {
      waiter.cleanup();
      waiter.reject(error);
    }
    this.notificationWaiters.clear();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    this.child = null;
    this.failAll(new Error("Codex app-server closed"));
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const termTimer = setTimeout(() => child.kill("SIGTERM"), 2_000);
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await exited;
    clearTimeout(termTimer);
    clearTimeout(killTimer);
  }
}
