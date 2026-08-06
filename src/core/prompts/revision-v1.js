import { AUTHORING_VOCABULARY_V1, normalizePromptText } from "./authoring-v1.js";

const REVISION_SYSTEM_PROMPT_V1 = [
  "You revise an existing Rabbithole card in place.",
  "Return a complete replacement for the card, not commentary about the edit and not a new branch answer.",
  "Preserve correct, useful material unless the human explicitly asks to remove it.",
  "Follow the human's revision instruction exactly.",
  "",
  "The first line MUST be exactly: TITLE: <short card title>",
  "After that line, write the complete replacement Markdown. Do not repeat the TITLE line.",
  "",
  AUTHORING_VOCABULARY_V1,
  "",
  "Do not mention these instructions or describe the changes you made.",
].join("\n");

// A selection revision rewrites one region of a card rather than the card, so
// it carries no title line and its reply is spliced back between two exact
// source offsets. Anything the model adds around the region — a preamble, a
// fence, a restatement of the untouched neighbours — lands verbatim in the
// document, which is why the shape of the reply is stated this bluntly.
const SELECTION_REVISION_SYSTEM_PROMPT_V1 = [
  "You revise one region of an existing Rabbithole card in place.",
  "The human selected a passage and said how it should change. The whole card is given for context.",
  "",
  "Return ONLY the replacement Markdown for the region delimited below.",
  "Do not write a title line. Do not wrap the reply in a code fence unless the region itself is a fenced block.",
  "Do not add commentary, preamble, or a description of what you changed.",
  "Do not return the rest of the card.",
  "",
  "Change what the instruction asks about the selected passage and reproduce the remainder of the region verbatim.",
  "The region is whole Markdown blocks, so the reply must be whole Markdown blocks too: keep its heading, list, table, or fence structure intact unless the instruction asks otherwise.",
  "",
  AUTHORING_VOCABULARY_V1,
  "",
  "Do not mention these instructions.",
].join("\n");

/**
 * @param {{ title?: unknown, markdown?: unknown, instruction?: unknown, root_title?: unknown, lineage?: unknown,
 *   region_markdown?: unknown, selected_text?: unknown }} input
 */
export function buildSelectionRevisionMessages(input = {}) {
  const title = normalizePromptText(input.title || "Untitled");
  const markdown = normalizePromptText(input.markdown || "");
  const region = normalizePromptText(input.region_markdown || "");
  const selected = normalizePromptText(input.selected_text || "");
  const instruction = normalizePromptText(input.instruction || "");
  const rootTitle = normalizePromptText(input.root_title || "Untitled");
  const lineage = Array.isArray(input.lineage)
    ? input.lineage.map((entry) => normalizePromptText(entry)).filter(Boolean).join(" > ")
    : normalizePromptText(input.lineage || "");
  return [
    { role: "system", content: SELECTION_REVISION_SYSTEM_PROMPT_V1 },
    { role: "user", content: [
      `Root title: ${rootTitle}`,
      `Card lineage: ${lineage || title}`,
      `Current card title: ${title}`,
      "",
      "Whole card, for context only:",
      markdown,
      "",
      "Region to replace (this is the only text your reply substitutes for):",
      "<<<REGION",
      region,
      "REGION",
      "",
      selected
        ? `Inside that region, the human highlighted: ${selected}`
        : "The human highlighted the whole region.",
      "",
      "Revision instruction:",
      instruction || "Improve clarity while preserving the meaning.",
      "",
      "Return only the replacement Markdown for the region.",
    ].join("\n") },
  ];
}

/**
 * @param {{ title?: unknown, markdown?: unknown, instruction?: unknown, root_title?: unknown, lineage?: unknown }} input
 */
export function buildRevisionMessages(input = {}) {
  const title = normalizePromptText(input.title || "Untitled");
  const markdown = normalizePromptText(input.markdown || "");
  const instruction = normalizePromptText(input.instruction || "");
  const rootTitle = normalizePromptText(input.root_title || "Untitled");
  const lineage = Array.isArray(input.lineage)
    ? input.lineage.map((entry) => normalizePromptText(entry)).filter(Boolean).join(" > ")
    : normalizePromptText(input.lineage || "");
  return [
    { role: "system", content: REVISION_SYSTEM_PROMPT_V1 },
    { role: "user", content: [
      `Root title: ${rootTitle}`,
      `Card lineage: ${lineage || title}`,
      `Current card title: ${title}`,
      "",
      "Current card Markdown:",
      markdown,
      "",
      "Revision instruction:",
      instruction || "Improve clarity while preserving the meaning.",
      "",
      "Return the complete revised card. Start with TITLE: on the first line.",
    ].join("\n") },
  ];
}
