import assert from "node:assert/strict";
import { normalizeAnchor } from "../../src/core/model.js";
import { enclosedPdfLines, planPdfCrop } from "../../src/core/pdf-shared.js";
import { normalizeRectUnion, pdfSelectionOffsets } from "../../src/ui/pdf-view.js";

const lines = [{ s: 10, e: 20 }, { s: 30, e: 42 }];
const startSpan = { dataset: { line: "0" } }, endSpan = { dataset: { line: "1" } };
const offsets = pdfSelectionOffsets({
  startContainer: { nodeType: 3, parentElement: startSpan }, startOffset: 3,
  endContainer: { nodeType: 3, parentElement: endSpan }, endOffset: 5,
}, lines);
assert.deepEqual(offsets, { start: 13, end: 35 }, "intra-line range offsets map into post-normalization markdown space");

assert.deepEqual(normalizeRectUnion([
  { left: 120, top: 220, right: 180, bottom: 230, width: 60, height: 10 },
  { left: 110, top: 240, right: 210, bottom: 260, width: 100, height: 20 },
], { left: 100, top: 200, width: 200, height: 400 }), { x: .05, y: .05, w: .5, h: .1 });

assert.deepEqual(normalizeAnchor({ offset_start: -5, offset_end: 9, pdf: {
  page: 3.9, rect: { x: -.2, y: .8, w: 4, h: .7 },
} }), { offset_start: 0, offset_end: 9, pdf: { page: 3, rect: { x: 0, y: .8, w: 1, h: 1 - .8 } } });
assert.deepEqual(normalizeAnchor({ offset_start: 2, offset_end: 4, pdf: { page: 0, rect: {} } }), { offset_start: 2, offset_end: 4 });

assert.deepEqual(planPdfCrop({ x: .1, y: .2, w: .5, h: .25 }, 2000, 1000), { sx: 180, sy: 195, sw: 1040, sh: 260, width: 1040, height: 260 });
assert.deepEqual(planPdfCrop({ x: .1, y: .1, w: .8, h: .8 }, 4000, 2000), { sx: 336, sy: 168, sw: 3328, sh: 1664, width: 1568, height: 784 });
assert.deepEqual(planPdfCrop({ x: -.5, y: .98, w: 4, h: 3 }, 100, 100), { sx: 0, sy: 97, sw: 100, sh: 3, width: 100, height: 3 });
assert.equal(planPdfCrop({ x: .2, y: .2, w: 0, h: .2 }, 100, 100), null);

const markdown = "zero\none\ntwo\nthree";
const boxLines = [
  { p: 1, x: .1, y: .1, w: .2, h: .05, s: 0, e: 4 },
  { p: 1, x: .2, y: .2, w: .2, h: .05, s: 5, e: 8 },
  { p: 1, x: .35, y: .35, w: .3, h: .1, s: 9, e: 12 },
];
assert.deepEqual(enclosedPdfLines(boxLines, 1, { x: .08, y: .08, w: .35, h: .2 }, markdown), { text: "zero\none", start: 0, end: 8 });
assert.deepEqual(enclosedPdfLines(boxLines, 1, { x: .9, y: .9, w: .05, h: .05 }, markdown), { text: "", start: 0, end: 0 });

console.log("ok PDF selection: intra-span offsets, normalized rect unions, and anchor.pdf clamps");
