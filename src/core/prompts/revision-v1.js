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
