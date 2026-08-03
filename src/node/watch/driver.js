import path from "node:path";
import { CodexAppServerClient } from "./app-server.js";
import { RabbitholeMcpClient } from "./mcp-client.js";
import { splitMarkdownChunks } from "./runner.js";

const ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "content"],
  properties: {
    title: { type: "string", description: "A short title of a few words" },
    content: { type: "string", description: "The complete GFM markdown answer" },
  },
};

const TRANSCRIPTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["content"],
  properties: { content: { type: "string", description: "Markdown transcription for these pages" } },
};

export function buildCodexAppServerArgs() {
  return ["app-server", "--stdio"];
}

function parseToolResult(result, tool) {
  if (result?.isError) {
    const text = result.content?.find((entry) => entry?.type === "text")?.text;
    throw new Error(`${tool} failed: ${text || JSON.stringify(result)}`);
  }
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = result?.content?.find((entry) => entry?.type === "text")?.text;
  if (typeof text !== "string") throw new Error(`${tool} returned no JSON text content`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${tool} returned invalid JSON: ${error.message}`);
  }
}

function branchPrompt(event) {
  return [
    "Answer the Rabbithole branch request below. Return only the requested structured output.",
    "Use focused, self-contained GFM markdown. Honor the lens and the user's language.",
    "If selected_text is empty, treat it as a conversational follow-up about the parent document.",
    "The rehydration tree is authoritative context when present.",
    "Do not invoke tools, inspect files, or ask for confirmation.",
    "",
    JSON.stringify({
      parent_node_title: event.parent_node_title,
      lineage: event.lineage,
      selected_text: event.selected_text,
      question: event.question,
      lens: event.lens,
      rehydration: event.rehydration,
    }, null, 2),
  ].join("\n");
}

function conversionPrompt(event, pages) {
  return [
    "Transcribe the attached PDF page images in page-number order.",
    "Return only the requested structured output and do not invoke tools.",
    "Apply these Rabbithole rules exactly:",
    String(event.rules || "Preserve headings, prose, math, tables, and figure references in markdown."),
    "",
    `Pages in this batch: ${pages.map((page) => page.n).join(", ")}`,
  ].join("\n");
}

function parseStructuredAgentMessage(notification) {
  const turn = notification?.turn;
  if (turn?.status !== "completed") {
    throw new Error(`Codex answer turn ended with status ${turn?.status || "unknown"}: ${JSON.stringify(turn?.error)}`);
  }
  const message = [...(turn.items || [])].reverse().find((item) => item?.type === "agentMessage");
  if (!message?.text) throw new Error("Codex answer turn returned no agent message");
  try {
    return JSON.parse(message.text);
  } catch (error) {
    throw new Error(`Codex answer was not valid structured JSON: ${error.message}`);
  }
}

export class CodexWatchDriver {
  constructor({
    codexCommand = "codex",
    mcpServerPath,
    cwd,
    dataDir,
    model,
    effort,
    maxBlockMs = 240_000,
    onStderr = () => {},
    appClientFactory,
    mcpClientFactory,
  }) {
    if (!mcpServerPath) throw new Error("mcpServerPath is required");
    this.cwd = path.resolve(cwd || process.cwd());
    this.model = model;
    this.effort = effort;
    this.client = appClientFactory?.() || new CodexAppServerClient({
      command: codexCommand,
      args: buildCodexAppServerArgs(),
      cwd: this.cwd,
      env: process.env,
      onStderr,
    });
    this.mcp = mcpClientFactory?.() || new RabbitholeMcpClient({
      mcpServerPath: path.resolve(mcpServerPath),
      cwd: this.cwd,
      dataDir,
      maxBlockMs,
      onStderr,
    });
    this.threadId = null;
  }

  async start({ signal } = {}) {
    await Promise.all([this.client.start(), this.mcp.start()]);
    const result = await this.client.request("thread/start", {
      cwd: this.cwd,
      runtimeWorkspaceRoots: [this.cwd],
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      ...(this.model ? { model: this.model } : {}),
      baseInstructions: "You answer Rabbithole learning questions. Follow each prompt and return the required structured output.",
      developerInstructions: "Do not use tools or ask for confirmation. Answer directly from the supplied context and attached images.",
    }, { signal });
    this.threadId = result?.thread?.id;
    if (!this.threadId) throw new Error("Codex app-server did not return a thread id");
  }

  async callTool(tool, args, { signal } = {}) {
    const result = await this.mcp.callTool(tool, args, { signal });
    return parseToolResult(result, tool);
  }

  open(holeId, options) {
    return this.callTool("open_rabbithole", { hole_id: holeId }, options);
  }

  async runStructuredTurn({ prompt, images = [], schema, signal }) {
    const completionController = new AbortController();
    const relayAbort = () => completionController.abort();
    signal?.addEventListener("abort", relayAbort, { once: true });
    const completed = this.client.waitForNotification(
      "turn/completed",
      (params) => params?.threadId === this.threadId,
      { signal: completionController.signal }
    );
    let started;
    try {
      started = await this.client.request("turn/start", {
        threadId: this.threadId,
        input: [
          { type: "text", text: prompt, text_elements: [] },
          ...images.map((imagePath) => ({ type: "localImage", path: imagePath, detail: "original" })),
        ],
        outputSchema: schema,
        ...(this.effort ? { effort: this.effort } : {}),
      }, { signal });
    } catch (error) {
      completionController.abort();
      await completed.catch(() => {});
      signal?.removeEventListener("abort", relayAbort);
      throw error;
    }
    const turnId = started?.turn?.id;
    const notification = await completed.finally(() => signal?.removeEventListener("abort", relayAbort));
    if (turnId && notification?.turn?.id !== turnId) {
      throw new Error(`Received completion for unexpected turn ${notification?.turn?.id}`);
    }
    return parseStructuredAgentMessage(notification);
  }

  generateBranch(event, { signal } = {}) {
    const images = event.region?.image_path ? [event.region.image_path] : [];
    return this.runStructuredTurn({ prompt: branchPrompt(event), images, schema: ANSWER_SCHEMA, signal });
  }

  async answer(event, answer, { signal } = {}) {
    const chunks = splitMarkdownChunks(answer.content);
    for (const content of chunks.slice(0, -1)) {
      await this.callTool("answer_branch", {
        session_id: event.session_id,
        request_id: event.request_id,
        content,
        partial: true,
      }, { signal });
    }
    return this.callTool("answer_branch", {
      session_id: event.session_id,
      request_id: event.request_id,
      title: String(answer.title || "Answer"),
      content: chunks.at(-1) || "",
    }, { signal });
  }

  async convert(event, { signal } = {}) {
    const pages = Array.isArray(event.pages) ? event.pages : [];
    if (pages.length === 0) throw new Error("convert_request contained no pages");
    const batchSize = 5;
    for (let index = 0; index < pages.length; index += batchSize) {
      const batch = pages.slice(index, index + batchSize);
      const answer = await this.runStructuredTurn({
        prompt: conversionPrompt(event, batch),
        images: batch.map((page) => page.image_path),
        schema: TRANSCRIPTION_SCHEMA,
        signal,
      });
      const isFinal = index + batchSize >= pages.length;
      const content = `${index > 0 ? "\n\n" : ""}${answer.content || ""}`;
      if (!isFinal) {
        await this.callTool("answer_branch", {
          session_id: event.session_id,
          request_id: event.request_id,
          content,
          partial: true,
        }, { signal });
      } else {
        return this.callTool("answer_branch", {
          session_id: event.session_id,
          request_id: event.request_id,
          title: "Text version",
          content,
        }, { signal });
      }
    }
    throw new Error("PDF conversion did not produce a final batch");
  }

  async close() {
    await Promise.allSettled([this.mcp.close(), this.client.close()]);
  }
}
