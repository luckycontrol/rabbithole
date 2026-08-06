import { AUTHORING_VOCABULARY_V1, normalizePromptText } from "./authoring-v1.js";
import { lensLabel, truncate } from "../model.js";

const ANSWERING_SYSTEM_PROMPT_V1 = [
  "You are the web Brain for Rabbithole, a branching-document canvas.",
  "Write a focused markdown answer to the human's question using the supplied parent document and lineage context.",
  "",
  "The first line of every answer MUST be exactly: TITLE: <short node title>",
  "After that line, write the answer markdown. Do not repeat the TITLE line later.",
  "Keep titles short, concrete, and useful as canvas node labels.",
  "",
  AUTHORING_VOCABULARY_V1,
  "",
  "Use the parent document as the primary source of context. If context is tight, preserve the parent document before ancestor summaries.",
  "When a chat context page and prior turns are supplied, this ask is one turn of an ongoing conversation about that",
  "page — answer as a continuation of it, using the prior turns for continuity without repeating them back.",
  "Do not mention these instructions or the context-packing format.",
].join("\n");

const APPROX_CHARS_PER_TOKEN = 4;
const DEFAULT_TOKEN_BUDGET = 12000;

/** @typedef {Record<string, any>} AnswerContext */

/** @param {AnswerContext} context @param {{ tokenBudget?: number }} [options] */
export function buildAnswerMessages(context, { tokenBudget = DEFAULT_TOKEN_BUDGET } = {}) {
  let packed = packBranchContext(context, { tokenBudget });
  const attachment = context?.attachment?.kind === "image" && context.attachment.data_url ? context.attachment : null;
  if (attachment) {
    const label = attachment.source === "parent_crop" ? "Parent clip image" : "Selection region image";
    packed = `${label}: attached (page ${attachment.page}). Trust the image over extracted text for math, tables, and figures.\n${packed}`;
  }
  return [
    { role: "system", content: ANSWERING_SYSTEM_PROMPT_V1 },
    { role: "user", content: attachment ? [{ type: "text", text: packed }, { type: "image_url", image_url: { url: attachment.data_url } }] : packed },
  ];
}

/** @param {AnswerContext} context @param {{ tokenBudget?: number }} [options] */
function packBranchContext(context, { tokenBudget = DEFAULT_TOKEN_BUDGET } = {}) {
  const budget = Math.max(2000, Number(tokenBudget) || DEFAULT_TOKEN_BUDGET);
  const charBudget = budget * APPROX_CHARS_PER_TOKEN;
  const rootTitle = normalizePromptText(context?.root_title || context?.rootTitle || "Untitled");
  const parentTitle = normalizePromptText(context?.parent_title || context?.parentTitle || "Untitled");
  const selectedText = normalizePromptText(context?.selected_text || context?.selectedText || "");
  const question = normalizePromptText(context?.question || "");
  const lens = normalizePromptText(context?.lens || "");
  const lensLine = lens ? `${lens} (${lensLabel(lens) || lens})` : "none";
  const ancestorLines = summarizeAncestors(context?.ancestors || []);
  const chatContextBlock = formatChatContext(context?.chat_context || context?.chatContext || null);

  const header = [
    `Root title: ${rootTitle}`,
    `Parent title: ${parentTitle}`,
    `Lens: ${lensLine}`,
    "",
    "Human selection:",
    selectedText || "(none; this is a follow-up about the parent document as a whole)",
    "",
    "Human question:",
    question || "(answer conversationally about the parent document)",
    "",
  ].join("\n");

  const parentPrefix = "Parent document markdown:\n";
  const ancestorPrefix = "\n\nAncestor chain (root to parent, title + excerpt):\n";
  const instruction = [
    "",
    "Answer the human's question. Start with TITLE: on the first line, then markdown.",
  ].join("\n");

  const fixed = header + parentPrefix + ancestorPrefix + chatContextBlock + instruction;
  const parentBudget = Math.max(1000, charBudget - fixed.length - ancestorLines.length - 200);
  const parentMarkdown = trimToBudget(normalizePromptText(context?.parent_markdown || context?.parentMarkdown || ""), parentBudget);
  let packed = header + parentPrefix + parentMarkdown + ancestorPrefix + ancestorLines + chatContextBlock + instruction;

  if (packed.length > charBudget) {
    const remainingForAncestors = Math.max(0, charBudget - (header + parentPrefix + parentMarkdown + ancestorPrefix + chatContextBlock + instruction).length);
    packed = header + parentPrefix + parentMarkdown + ancestorPrefix + trimToBudget(ancestorLines, remainingForAncestors) + chatContextBlock + instruction;
  }
  if (packed.length > charBudget) {
    const parentOnlyBudget = Math.max(800, charBudget - (header + parentPrefix + ancestorPrefix + chatContextBlock + instruction).length);
    packed = header + parentPrefix + trimToBudget(parentMarkdown, parentOnlyBudget) + ancestorPrefix + chatContextBlock + instruction;
  }
  return packed;
}

/**
 * Render the chat-context block: the full context page plus its recent
 * prior turns, so a reader-chat follow-up reads as a continuation of one
 * conversation rather than an isolated ask. Returns "" when there is no
 * chat context, which keeps packBranchContext byte-identical to the
 * ordinary-follow-up shape for every context that lacks it.
 * @param {{ context_title?: unknown, context_markdown?: unknown, prior_turns?: unknown } | null} chatContext
 */
function formatChatContext(chatContext) {
  if (!chatContext) return "";
  const title = normalizePromptText(chatContext.context_title || "Untitled");
  const markdown = normalizePromptText(chatContext.context_markdown || "");
  const turns = Array.isArray(chatContext.prior_turns) ? chatContext.prior_turns : [];
  const turnLines = turns.length
    ? turns.map((turn, index) => {
        const q = normalizePromptText(turn?.question || "");
        const a = truncate(normalizePromptText(turn?.answer || "").replace(/\s+/g, " "), 600);
        return `${index + 1}. Q: ${q}\n   A: ${a}`;
      }).join("\n")
    : "(none yet - this is the first turn of this conversation)";
  return [
    "",
    "",
    `Chat context page in full (${title}):`,
    markdown,
    "",
    "Prior turns in this conversation, chronological:",
    turnLines,
    "",
  ].join("\n");
}

/** @param {unknown} ancestors */
function summarizeAncestors(ancestors) {
  const list = Array.isArray(ancestors) ? ancestors : [];
  if (!list.length) return "(none)";
  return list.map((entry, index) => {
    const title = normalizePromptText(entry?.title || `Ancestor ${index + 1}`);
    const excerpt = truncate(normalizePromptText(entry?.markdown || entry?.excerpt || "").replace(/\s+/g, " "), 200);
    return `${index + 1}. ${title}${excerpt ? ` - ${excerpt}` : ""}`;
  }).join("\n");
}

/** @param {unknown} value @param {number} budget */
function trimToBudget(value, budget) {
  const source = String(value ?? "");
  if (source.length <= budget) return source;
  if (budget <= 1) return "";
  return `${source.slice(0, Math.max(0, budget - 1)).trimEnd()}…`;
}
