// ===========================================================================
// SELECTION → MARKDOWN REGION
// ===========================================================================
// A selection in a rendered document has to be placed back in the Markdown
// source before the agent can be asked to rewrite it. The two coordinate
// systems do not line up: selection offsets count rendered characters, while
// the source carries syntax (`**`, `[](…)`, fences) the rendered text drops.
//
// The bridge is structural rather than textual. lexBlockRegions gives every
// top-level block its exact source span and the HTML it renders to; counting
// the elements each block produces pairs those spans with the document's own
// top-level elements, position by position. No character measuring, so nothing
// here depends on how the renderer spells a link or how KaTeX expands math.
//
// The unit is therefore a whole block, and deliberately so: Markdown has no
// valid splice point in the middle of `**bold**`, whereas block boundaries are
// always safe. The agent is told which phrase the reader actually highlighted
// and returns the block with only that phrase changed.
//
// Documents that cannot be paired are refused outright — see regionMapFor.

import { lexNodeBlockRegions, renderNodeMarkdownFragment } from "./renderer.js";

var mapCache = new WeakMap();

function parseHtmlNodes(html) {
  var template = document.createElement("template");
  template.innerHTML = String(html || "");
  return template.content.childNodes;
}

// What one block contributes to the document's top-level children. A bare text
// run is the disqualifying case: a raw HTML block renders as escaped text, and
// such a run merges with its neighbours' whitespace once the whole document is
// parsed, so block boundaries stop being recoverable from the DOM.
function summarizeBlockHtml(html) {
  var childNodes = parseHtmlNodes(html);
  var elements = 0;
  for (var i = 0; i < childNodes.length; i++) {
    var child = childNodes[i];
    if (child.nodeType === 1) elements += 1;
    else if (child.nodeType === 3 && child.textContent.trim()) return null;
  }
  return elements;
}

/**
 * Pair every top-level element position in a node's rendered output with the
 * block whose source produced it. Returns null when the document is outside
 * the projection, which callers must treat as "no selection revision here"
 * rather than guessing a span.
 */
export function regionMapFor(node) {
  if (!node) return null;
  var markdown = String(node.md || "");
  var cached = mapCache.get(node);
  if (cached && cached.md === markdown) return cached.map;

  var map = null;
  try {
    var blocks = lexNodeBlockRegions(node);
    var blockForElement = [];
    for (var i = 0; i < blocks.length; i++) {
      var elements = summarizeBlockHtml(blocks[i].html);
      if (elements === null) { blockForElement = null; break; }
      for (var e = 0; e < elements; e++) blockForElement.push(i);
    }
    if (blockForElement) map = { md: markdown, blocks: blocks, blockForElement: blockForElement };
  } catch (error) {
    map = null;
  }
  mapCache.set(node, { md: markdown, map: map });
  return map;
}

// The child of `dc` that contains `container`. A range endpoint can also sit
// directly on `dc` as a child index, which `edge` resolves: -1 for a start
// (the child at that index) and 0 for an end (the child before it).
function topLevelChild(dc, container, offset, edge) {
  if (!container) return null;
  if (container === dc) {
    var index = edge < 0 ? offset : offset - 1;
    return dc.children[Math.max(0, Math.min(dc.children.length - 1, index))] || null;
  }
  var el = container.nodeType === 1 ? container : container.parentElement;
  while (el && el.parentElement && el.parentElement !== dc) el = el.parentElement;
  return el && el.parentElement === dc ? el : null;
}

function childIndex(dc, el) {
  for (var i = 0; i < dc.children.length; i++) if (dc.children[i] === el) return i;
  return -1;
}

/**
 * The smallest run of whole blocks a range touches, as a span of `node.md`.
 * Null when the document is unmappable or the range does not sit inside it.
 *
 * @returns {{ md_start: number, md_end: number, region_markdown: string, block_count: number } | null}
 */
export function resolveSelectionRegion(dc, node, range) {
  if (!dc || !node || !range) return null;
  if (dc.classList && dc.classList.contains("rh-pdf")) return null;
  if (!dc.contains(range.startContainer) || !dc.contains(range.endContainer)) return null;

  var map = regionMapFor(node);
  if (!map) return null;
  // Mounting wraps elements (a `pre` gains a `.code-block` parent) but never
  // changes how many top-level elements there are, so a disagreement here means
  // the document on screen is not the one these blocks describe.
  if (dc.children.length !== map.blockForElement.length) return null;

  var startEl = topLevelChild(dc, range.startContainer, range.startOffset, -1);
  var endEl = topLevelChild(dc, range.endContainer, range.endOffset, 0);
  if (!startEl || !endEl) return null;

  var first = childIndex(dc, startEl);
  var last = childIndex(dc, endEl);
  if (first < 0 || last < 0) return null;
  if (last < first) { var swap = first; first = last; last = swap; }

  var firstBlock = map.blockForElement[first];
  var lastBlock = map.blockForElement[last];
  if (firstBlock == null || lastBlock == null) return null;

  var mdStart = map.blocks[firstBlock].start;
  var mdEnd = map.blocks[lastBlock].end;
  if (!(mdEnd > mdStart)) return null;

  return {
    md_start: mdStart,
    md_end: mdEnd,
    region_markdown: map.md.slice(mdStart, mdEnd),
    block_count: lastBlock - firstBlock + 1,
  };
}

/**
 * The document's own top-level elements covering a region — the inverse of
 * resolveSelectionRegion, used to mark the region on screen and to swap a
 * preview in for it. Empty when the document no longer matches the region.
 *
 * @returns {Element[]}
 */
export function regionElements(dc, node, region) {
  var map = dc && node && region ? regionMapFor(node) : null;
  if (!map || dc.children.length !== map.blockForElement.length) return [];
  var found = [];
  for (var i = 0; i < map.blockForElement.length; i++) {
    var block = map.blocks[map.blockForElement[i]];
    if (block.start >= region.md_start && block.end <= region.md_end) found.push(dc.children[i]);
  }
  return found;
}

/**
 * Where a region sits in the rendered text of its document — the coordinate
 * system child anchors are measured in, so this is what decides which branches
 * a rewrite moves and which it detaches. Null when the region is not on screen.
 *
 * @returns {{ start: number, end: number } | null}
 */
export function regionRenderedRange(dc, node, region) {
  var elements = regionElements(dc, node, region);
  if (!elements.length) return null;
  var start = 0;
  var index = 0;
  for (; index < dc.children.length; index++) {
    if (dc.children[index] === elements[0]) break;
    start += dc.children[index].textContent.length;
  }
  if (index === dc.children.length) return null;
  var length = elements.reduce(function(total, el){ return total + el.textContent.length; }, 0);
  return { start: start, end: start + length };
}

export function spliceRegion(markdown, region, replacement) {
  var source = String(markdown || "");
  return source.slice(0, region.md_start) + String(replacement == null ? "" : replacement) + source.slice(region.md_end);
}

/**
 * How much the rendered text of a region grows or shrinks when its source is
 * replaced — the amount every anchor after it has to move.
 *
 * Both sides are measured from a detached render so that whatever mounting
 * adds to the live document (a visual's own labels, say) is absent from both
 * and cancels. The residue is a visual *inside* the edited region whose
 * mounted text differs from its placeholder; that skews the delta and leaves a
 * later highlight a few characters off, which is a cosmetic miss rather than
 * lost content.
 */
export function renderedLengthDelta(node, previousRegionMarkdown, nextRegionMarkdown) {
  return renderedTextLength(node, nextRegionMarkdown) - renderedTextLength(node, previousRegionMarkdown);
}

function renderedTextLength(node, markdown) {
  var template = document.createElement("template");
  template.innerHTML = renderNodeMarkdownFragment(node, markdown);
  return template.content.textContent.length;
}
