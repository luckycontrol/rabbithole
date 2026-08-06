// ===========================================================================
// SELECTION REVISION — shared contract helpers
// ===========================================================================
// A selection revision replaces an exact span of a card's Markdown with what
// the agent returns. Because the reply is spliced rather than parsed, every
// host validates the span the same way and cleans the reply the same way;
// those two rules live here so the MCP session, the BYOK direct host, and the
// headless watch driver cannot drift apart on them.

/**
 * Normalize the `selection` a client attached to a revision request. Returns
 * null for a whole-card revision, which is the shape without one.
 *
 * @param {unknown} value
 * @returns {{ md_start: number, md_end: number, region_markdown: string, selected_text: string } | null}
 */
export function readSelectionRegion(value) {
  if (!value || typeof value !== "object") return null;
  const raw = /** @type {Record<string, unknown>} */ (value);
  const start = Number(raw.md_start);
  const end = Number(raw.md_end);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end <= start) return null;
  return {
    md_start: start,
    md_end: end,
    region_markdown: String(raw.region_markdown ?? ""),
    selected_text: String(raw.selected_text ?? ""),
  };
}

/**
 * Whether a region still describes the card it was taken from. A card edited
 * from another surface while the instruction was being typed leaves the span
 * pointing at different words, and splicing over it would corrupt the
 * document rather than revise it.
 *
 * @param {unknown} markdown
 * @param {{ md_start: number, md_end: number, region_markdown: string }} region
 */
export function selectionRegionMatches(markdown, region) {
  const source = String(markdown ?? "");
  if (region.md_end > source.length) return false;
  return source.slice(region.md_start, region.md_end) === region.region_markdown;
}

const FENCE_OPEN = /^\s*(`{3,}|~{3,})[^\n]*\n/;

/**
 * Clean a returned fragment enough to splice. Models asked for bare Markdown
 * still sometimes wrap the reply in a fence, and a fence that was never in the
 * region would render as a literal code block in the middle of prose.
 *
 * Unwrapping is refused when the region is itself fenced — there the fence is
 * the answer, not packaging around it.
 *
 * @param {unknown} fragment
 * @param {unknown} regionMarkdown
 */
export function normalizeRevisionFragment(fragment, regionMarkdown) {
  const text = String(fragment ?? "");
  const region = String(regionMarkdown ?? "");
  if (FENCE_OPEN.test(region)) return text;

  const open = FENCE_OPEN.exec(text);
  if (!open) return text;
  const marker = open[1];
  const body = text.slice(open[0].length);
  const close = new RegExp(`\\n[ \\t]*${marker[0]}{${marker.length},}[ \\t]*\\s*$`);
  const match = close.exec(body);
  if (!match) return text;
  // Only packaging: a fence that closes at the very end and opens at the very
  // start wraps the whole reply, so nothing outside it would survive anyway.
  return body.slice(0, match.index);
}

/**
 * The instruction handed to an agent alongside a selection revision. Stated as
 * one line because it travels in the event payload, where the agent reads it
 * before the region itself.
 */
export const SELECTION_RESPONSE_CONTRACT =
  "Return ONLY the replacement Markdown for selection.region_markdown — no title line, no code fence around it, "
  + "no commentary, and none of the surrounding card. Change what the instruction asks about selection.selected_text "
  + "and reproduce the rest of the region verbatim. Stream with answer_branch partial=true, then finish with a normal call.";
