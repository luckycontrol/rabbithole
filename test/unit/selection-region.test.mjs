// Selection revision rests on one claim: a rendered selection can be placed
// back in the Markdown source. lexBlockRegions is what makes that claim, so
// these fixtures check the two properties the splice depends on across the
// constructs Rabbithole documents actually contain — spans that are exact and
// ordered, and per-block HTML that reassembles into whole-document output.
//
// The helpers that guard the wire are checked here too: a span that no longer
// matches its card must be refused rather than spliced, and a reply the model
// wrapped in a fence must not land in the document as a code block.

import assert from "node:assert/strict";
import { createMarkdownRenderer } from "../../src/core/markdown-renderer.js";
import {
  normalizeRevisionFragment,
  readSelectionRegion,
  selectionRegionMatches,
} from "../../src/core/selection-revision.js";

const renderer = createMarkdownRenderer({
  encodeBase64: (source) => Buffer.from(source, "utf8").toString("base64"),
  resolveAssetUrl: (name) => `/assets/${name}`,
});

const DOCUMENTS = {
  "prose with a reference definition": [
    "First paragraph with **bold** and _em_ and `code`.",
    "",
    "Second paragraph with a [link](https://example.com) and a [ref][r].",
    "",
    "[r]: https://example.com/ref",
    "",
  ].join("\n"),
  "headings and a rule": "# Title\n\nIntro.\n\n## Section\n\n---\n\nBody.\n",
  "tight list": "Steps:\n\n- one\n- two\n- three\n\nDone.\n",
  "loose nested list": "- outer\n\n  continued\n\n  - inner a\n  - inner b\n\n- second\n",
  "fenced code": "Before.\n\n```js\nconst x = 1;\n```\n\nAfter.\n",
  "table": "| a | b |\n| - | - |\n| 1 | 2 |\n\nTail.\n",
  "blockquote": "> quoted\n> lines\n\nOut.\n",
  "block and inline math": "Intro.\n\n$$\nE = mc^2\n$$\n\nOutro with $a+b$.\n",
  "backslash math": "Text.\n\n\\[\nx = y\n\\]\n\nMore.\n",
  "image with an asset": "![alt](asset:diagram-1.png)\n\nCaption.\n",
  "mermaid fence": "```mermaid\ngraph TD\nA-->B\n```\n\nAfter.\n",
  "korean prose": "무한 캔버스 위에서 문서를 읽어요.\n\n**가지**는 여기서 뻗어 나가요.\n",
  "setext heading": "Title here\n==========\n\nBody.\n",
  "indented code": "Para.\n\n    indented\n    code\n\nTail.\n",
  "no trailing newline": "Only a paragraph",
  "empty": "",
};

const VOID_TAGS = new Set(["img", "br", "hr", "input", "meta", "link", "source", "col"]);

// Top-level nodes a generated HTML string yields once blank separators are
// dropped: elements, plus bare text runs counted separately because those are
// what make a document unmappable.
function topLevelNodes(html) {
  let index = 0;
  let depth = 0;
  let elements = 0;
  let text = 0;
  let run = "";
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open === -1) {
      if (depth === 0) run += html.slice(index);
      break;
    }
    if (depth === 0) run += html.slice(index, open);
    const close = html.indexOf(">", open);
    if (close === -1) break;
    const tag = html.slice(open + 1, close);
    const closing = tag.startsWith("/");
    const name = tag.replace(/^\//, "").split(/[\s/>]/)[0].toLowerCase();
    const selfClosing = tag.endsWith("/") || VOID_TAGS.has(name);
    if (depth === 0) {
      if (run.trim()) text += 1;
      run = "";
    }
    if (closing) depth -= 1;
    else if (!selfClosing) {
      if (depth === 0) elements += 1;
      depth += 1;
    } else if (depth === 0) elements += 1;
    index = close + 1;
  }
  if (run.trim()) text += 1;
  return { elements, text };
}

function tighten(html) {
  return html.replace(/>\n+</g, "><").replace(/\n<\/code>/g, "</code>");
}

function runProjectionFixtures() {
  for (const [name, markdown] of Object.entries(DOCUMENTS)) {
    const blocks = renderer.lexBlockRegions(markdown);
    const whole = renderer.renderMarkdownToHtml(markdown);

    let cursor = 0;
    for (const block of blocks) {
      assert.equal(markdown.slice(block.start, block.end), block.source,
        `${name}: block span must quote its own source`);
      assert(block.start >= cursor, `${name}: blocks must not overlap or reorder`);
      cursor = block.end;
    }

    assert.equal(tighten(blocks.map((block) => block.html).join("")), whole,
      `${name}: concatenated block HTML must reproduce whole-document output`);

    const perBlock = blocks.map((block) => topLevelNodes(block.html));
    const summed = perBlock.reduce((total, entry) => total + entry.elements, 0);
    assert.equal(summed, topLevelNodes(whole).elements,
      `${name}: per-block element counts must pair with the document's own`);

    console.log(`ok selection region projection: ${name}`);
  }
}

// A link reference definition is consumed into the lexer's link table without
// producing a token. Accumulating raw lengths would put every later block one
// definition too early, which is why spans are located instead.
function runReferenceDefinitionGap() {
  const markdown = "One.\n\n[r]: https://example.com/ref\n\nTwo with a [ref][r].\n";
  const blocks = renderer.lexBlockRegions(markdown);
  const last = blocks[blocks.length - 1];
  assert.equal(markdown.slice(last.start, last.end), last.source,
    "a block after a reference definition must still quote its own source");
  assert(last.source.includes("Two with"), "the final block should be the second paragraph");
  assert(renderer.renderMarkdownToHtml(markdown).includes('href="https://example.com/ref"'),
    "the definition must still resolve for a block that references it");
  console.log("ok selection region projection: spans survive a reference definition");
}

// A raw HTML block renders as escaped text, so it contributes a bare text node
// that merges with its neighbours. That is the one shape callers must refuse.
function runUnmappableDocument() {
  const markdown = "Before.\n\n<div class=\"x\">raw</div>\n\nAfter.\n";
  const blocks = renderer.lexBlockRegions(markdown);
  const bare = blocks.some((block) => topLevelNodes(block.html).text > 0);
  assert(bare, "a raw HTML block must surface as a bare top-level text run");
  console.log("ok selection region projection: raw HTML marks a document unmappable");
}

function runRegionGuards() {
  const markdown = "One.\n\nTwo.\n";
  const region = readSelectionRegion({ md_start: 6, md_end: 11, region_markdown: "Two.\n", selected_text: "Two." });
  assert(region, "a well-formed selection should be read");
  assert(selectionRegionMatches(markdown, region), "a region quoting its source must match");
  assert(!selectionRegionMatches("One.\n\nEdited elsewhere.\n", region),
    "a region must not match a card that changed under it");
  assert(!selectionRegionMatches("One.\n", region), "a region past the end must not match");

  assert.equal(readSelectionRegion(null), null, "a whole-card revision carries no region");
  assert.equal(readSelectionRegion({ md_start: 5, md_end: 5, region_markdown: "" }), null,
    "an empty span is not a region");
  assert.equal(readSelectionRegion({ md_start: -1, md_end: 4, region_markdown: "x" }), null,
    "a negative span is not a region");
  console.log("ok selection revision: region guards refuse stale and malformed spans");
}

function runFragmentNormalization() {
  assert.equal(normalizeRevisionFragment("```\nrewritten prose\n```", "original prose\n"),
    "rewritten prose", "a fence wrapped around prose is packaging and comes off");
  assert.equal(normalizeRevisionFragment("```markdown\nrewritten\n```", "original\n"),
    "rewritten", "an info string on the wrapping fence does not save it");
  assert.equal(normalizeRevisionFragment("```js\nconst x = 2;\n```", "```js\nconst x = 1;\n```"),
    "```js\nconst x = 2;\n```", "a fenced region keeps the fence it was asked to rewrite");
  assert.equal(normalizeRevisionFragment("plain replacement", "original"),
    "plain replacement", "an unwrapped reply is left alone");
  assert.equal(normalizeRevisionFragment("Text with ```inline``` marks", "original"),
    "Text with ```inline``` marks", "a fence that does not open the reply is content");
  console.log("ok selection revision: fragment normalization strips only packaging");
}

runProjectionFixtures();
runReferenceDefinitionGap();
runUnmappableDocument();
runRegionGuards();
runFragmentNormalization();
console.log("selection region verification passed");
