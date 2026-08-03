const MAX_PARENT_CONTEXT_CHARS = 16_000;
const MAX_PARTIAL_ANSWER_CHARS = 8_000;
const MAX_TITLE_CHARS = 96;
const MAX_TOKENS = 4_096;

function trimTo(value, limit) {
  const text = String(value || "");
  return text.length <= limit ? text : `${text.slice(0, limit)}\n\n[truncated]`;
}

function titleFor(question) {
  const compact = String(question || "").replace(/\s+/g, " ").trim();
  if (!compact) return "Follow-up";
  return compact.length <= MAX_TITLE_CHARS ? compact : `${compact.slice(0, MAX_TITLE_CHARS - 1)}…`;
}

function samplingText(result) {
  return result?.content?.type === "text" ? String(result.content.text || "").trim() : "";
}

export function samplingRecoveryEnabled() {
  return /^(1|true|yes)$/i.test(String(process.env.RABBITHOLE_AUTO_RECOVER_STALLED || ""));
}

export function clientSupportsSampling(mcpServer) {
  return Boolean(mcpServer?.server?.getClientCapabilities?.()?.sampling);
}

function buildRecoveryPrompt({ event, parent, node }) {
  const partial = trimTo(node?.markdown, MAX_PARTIAL_ANSWER_CHARS);
  const parentMarkdown = trimTo(parent?.markdown, MAX_PARENT_CONTEXT_CHARS);
  const lens = event.lens ? `\nRequested style: ${event.lens}` : "";
  const continuation = partial
    ? `\nA previous answer began below. Continue directly from its end without repeating it:\n\n${partial}`
    : "";

  return [
    "Write the missing Rabbithole answer in clear GFM Markdown.",
    "Return only the answer body: no title, no preamble, and no discussion of this recovery request.",
    "Keep the answer focused on the selected text and question. Do not claim you inspected files or images you were not given.",
    `Parent title: ${event.parent_node_title || parent?.title || "Untitled"}`,
    `Lineage: ${(event.lineage || []).join(" → ") || "(root)"}`,
    `Selected text:\n${event.selected_text || "(whole document follow-up)"}`,
    `Question:\n${event.question || "Explain this."}`,
    lens,
    parentMarkdown ? `\nParent document context:\n${parentMarkdown}` : "",
    continuation,
  ].filter(Boolean).join("\n\n");
}

/**
 * Build the server-side fallback used after a connected agent has accepted a
 * branch_request but fails to answer it. Sampling is capability-gated: hosts
 * that do not advertise MCP sampling keep the existing saved-and-requeue flow.
 */
export function createSamplingStallRecovery(mcpServer) {
  return async ({ event, parent, node, signal }) => {
    if (!clientSupportsSampling(mcpServer)) return null;
    // A region image is intentionally left for the primary agent: the normal
    // flow tells it to read the local crop, while a sampling request cannot.
    if (event?.status !== "branch_request" || event.region) return null;

    const result = await mcpServer.server.createMessage({
      maxTokens: MAX_TOKENS,
      systemPrompt: "You are recovering a stalled Rabbithole answer on behalf of the connected agent.",
      messages: [{ role: "user", content: { type: "text", text: buildRecoveryPrompt({ event, parent, node }) } }],
    }, { signal });

    const content = samplingText(result);
    if (!content) throw new Error("Sampling recovery returned no text");
    return { title: titleFor(event.question), content };
  };
}
