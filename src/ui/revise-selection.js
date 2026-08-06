// ===========================================================================
// SELECTION REVISION — reader-side flow
// ===========================================================================
// Drag a passage, say how it should change, and the agent rewrites that
// passage with the rest of the document as context. The instruction is typed
// in the selection popover that already exists for asking, and the result is
// previewed in the document itself before anything is saved.
//
// The phases mirror the card-level revision in ai-revision.js — prompt,
// generating, ready, error — deliberately, so the two read as one feature. The
// difference is what comes back: a fragment for one region rather than a whole
// card, spliced between the two source offsets selection-region.js resolved.
//
// This module owns everything after the instruction is submitted: the request,
// the preview swapped into the document, the splice, the anchors that have to
// move with it, and the undo.

import { buildDocContent, childrenOf, closed, flashHint, nodes, READER_BASE, showHint, uuid } from "./core.js";
import { refreshNodeHtml } from "./renderer.js";
import { buttonMarkup } from "../core/html/button-markup.js";
import { iconSvg } from "../core/html/icons.js";
import { diffWordRanges } from "./region-diff.js";
import { rangeFromOffsets } from "./text-marks.js";
import { regionElements, regionRenderedRange, renderedLengthDelta, spliceRegion } from "./selection-region.js";

function defaultHooks() {
  return {
    post: function(){ return Promise.resolve({ ok: true }); },
    refresh: function(){},
    persistOrigin: function(){ return Promise.resolve({ ok: true }); },
  };
}

var hooks = defaultHooks();
var active = null;

export function registerReviseSelectionHooks(next) {
  Object.assign(hooks, next || {});
}

export function disposeReviseSelection() {
  if (active) teardownPreview(active);
  active = null;
  hooks = defaultHooks();
}

export function isSelectionRevisionActive() {
  return !!active;
}

/**
 * Branches anchored inside a region lose their inline mark when it is
 * rewritten. The count is surfaced before the request goes out, because a
 * reader deciding whether to reword a sentence should know it carries their
 * questions.
 */
export function branchesInsideRegion(node, renderedStart, renderedEnd) {
  return childrenOf(node.id).filter(function(child){
    var anchor = child.origin && child.origin.anchor;
    if (!anchor || anchor.pdf) return false;
    return anchor.offset_end > renderedStart && anchor.offset_start < renderedEnd;
  });
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export function startSelectionRevision(options) {
  var node = options.node;
  var region = options.region;
  var instruction = String(options.instruction || "").trim();
  if (!node || !region || !instruction || closed) return false;

  cancelSelectionRevision({ silent: true });

  active = {
    nodeId: node.id,
    region: region,
    instruction: instruction,
    selectedText: String(options.selectedText || ""),
    requestId: uuid(),
    phase: "generating",
    fragment: "",
    error: "",
    showOriginal: false,
    panel: options.panel || null,
    onPhase: options.onPhase || function(){},
    marked: [],
    preview: null,
    hiddenOriginals: [],
  };
  markRegionPending();
  renderPanel();
  var requestId = active.requestId;
  Promise.resolve(hooks.post({
    type: "revision_request",
    request_id: requestId,
    node_id: node.id,
    instruction: instruction,
    selection: {
      md_start: region.md_start,
      md_end: region.md_end,
      region_markdown: region.region_markdown,
      selected_text: active.selectedText,
    },
  })).then(function(result){
    if (!active || active.requestId !== requestId) return;
    if (result && result.ok !== false) return;
    fail(result && result.error);
  }, function(error){
    if (!active || active.requestId !== requestId) return;
    fail(error && error.message);
  });
  return true;
}

export function cancelSelectionRevision(options) {
  var state = active;
  if (!state) return;
  active = null;
  if (state.phase === "generating") {
    hooks.post({ type: "revision_cancel", request_id: state.requestId, node_id: state.nodeId });
  }
  teardownPreview(state);
  if (!options || !options.silent) state.onPhase("closed");
}

function fail(message) {
  if (!active) return;
  active.phase = "error";
  active.error = message || "AI couldn't revise this passage.";
  teardownPreviewNodes(active);
  renderPanel();
}

// ---------------------------------------------------------------------------
// Streamed result
// ---------------------------------------------------------------------------

export function handleSelectionRevisionProgress(message) {
  if (!matches(message)) return false;
  active.phase = "generating";
  active.fragment = String(message.fragment || "");
  renderPanel();
  return true;
}

export function handleSelectionRevisionReady(message) {
  if (!matches(message)) return false;
  if (message.stale) {
    fail("This card changed while AI was writing — select the passage again.");
    return true;
  }
  active.phase = "ready";
  active.fragment = String(message.fragment || "");
  showPreview();
  renderPanel();
  return true;
}

export function handleSelectionRevisionError(message) {
  if (!matches(message)) return false;
  fail(message.message);
  return true;
}

function matches(message) {
  return !!active
    && message
    && message.scope === "selection"
    && message.request_id === active.requestId
    && message.node_id === active.nodeId;
}

// ---------------------------------------------------------------------------
// In-document preview
// ---------------------------------------------------------------------------

function currentDoc() {
  var state = active;
  if (!state) return null;
  return document.querySelector('#reader-main .doc-content[data-node-id="' + state.nodeId + '"]');
}

function markRegionPending() {
  var state = active;
  var node = state && nodes[state.nodeId];
  var dc = currentDoc();
  if (!node || !dc) return;
  state.marked = regionElements(dc, node, state.region);
  state.marked.forEach(function(el){ el.classList.add("rh-revise-pending"); });
}

// Both sides stay on screen: the region as it stands, then the replacement
// under it, each with the words that differ marked. A merged single view would
// be denser, but it cannot show a rewrite that moves words between sentences
// without inventing an ordering the reader never wrote.
function showPreview() {
  var state = active;
  var node = state && nodes[state.nodeId];
  var dc = currentDoc();
  if (!node || !dc || !state.marked.length) return;

  var previewNode = Object.assign({}, node, {
    id: node.id + "-revise-preview",
    md: state.fragment,
    html: "",
    _htmlFor: null,
    _contentDisposers: null,
  });
  var rendered = buildDocContent(previewNode, READER_BASE);

  var after = document.createElement("div");
  after.className = "rh-revise-after";
  after.setAttribute("aria-label", "Replacement");
  while (rendered.firstChild) after.appendChild(rendered.firstChild);

  var before = document.createElement("div");
  before.className = "rh-revise-before";
  before.setAttribute("aria-label", "Current text");
  state.marked[0].parentNode.insertBefore(before, state.marked[0]);
  state.marked.forEach(function(el){
    el.classList.remove("rh-revise-pending");
    before.appendChild(el);
  });
  before.parentNode.insertBefore(after, before.nextSibling);

  paintWordDiff(before, after);
  state.preview = { before: before, after: after };
}

function paintWordDiff(before, after) {
  var ranges = diffWordRanges(before.textContent, after.textContent);
  if (!ranges) return;
  wrapRanges(before, ranges.removed, "del", "rh-revise-del");
  wrapRanges(after, ranges.added, "ins", "rh-revise-ins");
}

// Later ranges first so wrapping one does not shift the offsets of the next.
function wrapRanges(root, spans, tagName, className) {
  for (var i = spans.length - 1; i >= 0; i--) {
    var range = rangeFromOffsets(root, spans[i][0], spans[i][1]);
    if (!range) continue;
    var wrapper = document.createElement(tagName);
    wrapper.className = className;
    try { range.surroundContents(wrapper); }
    catch (error) { /* the span straddles an element boundary — leave it plain */ }
  }
}

function teardownPreviewNodes(state) {
  var preview = state && state.preview;
  if (!preview) return;
  state.preview = null;
  unwrapMarks(preview.before);
  var parent = preview.before.parentNode;
  if (parent) {
    while (preview.before.firstChild) parent.insertBefore(preview.before.firstChild, preview.before);
    parent.removeChild(preview.before);
  }
  if (preview.after.parentNode) preview.after.parentNode.removeChild(preview.after);
}

function unwrapMarks(root) {
  var marks = root.querySelectorAll("del.rh-revise-del, ins.rh-revise-ins");
  for (var i = 0; i < marks.length; i++) {
    var mark = marks[i];
    var parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }
}

function teardownPreview(state) {
  teardownPreviewNodes(state);
  (state.marked || []).forEach(function(el){ el.classList.remove("rh-revise-pending"); });
  state.marked = [];
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

function applySelectionRevision() {
  var state = active;
  var node = state && nodes[state.nodeId];
  if (!state || !node || state.phase !== "ready") return;

  var previousMarkdown = String(node.md || "");
  if (previousMarkdown.slice(state.region.md_start, state.region.md_end) !== state.region.region_markdown) {
    fail("This card changed since that passage was selected — select it again.");
    return;
  }
  var nextMarkdown = spliceRegion(previousMarkdown, state.region, state.fragment);
  if (nextMarkdown === previousMarkdown) {
    flashHint("AI returned the passage unchanged.");
    cancelSelectionRevision();
    return;
  }

  // Measured only after the preview is torn down: while it is up the region's
  // elements sit inside the before/after wrappers, so the document no longer
  // has the shape regionElements pairs against.
  teardownPreview(state);
  var previousAnchors = captureAnchors(node);
  var rendered = regionRenderedRange(currentDoc(), node, state.region);
  var delta = renderedLengthDelta(node, state.region.region_markdown, state.fragment);
  active = null;

  shiftAnchors(node, rendered, delta);
  node.md = nextMarkdown;
  refreshNodeHtml(node);
  hooks.refresh(node);
  state.onPhase("applied");

  var nextAnchors = captureAnchors(node);
  persist(node, nextMarkdown, nextAnchors).then(function(ok){
    if (!ok) {
      restore(node, previousMarkdown, previousAnchors, "Couldn't save the revised passage.");
      return;
    }
    showHint({
      message: "Passage revised.", actionLabel: "Undo", duration: 8000,
      onAction: function(){
        if (String(node.md || "") !== nextMarkdown) return Promise.resolve();
        return persist(node, previousMarkdown, previousAnchors).then(function(undone){
          if (!undone) { flashHint("Couldn't undo the revision."); return; }
          applyLocally(node, previousMarkdown, previousAnchors);
        });
      },
    });
  });
}

function captureAnchors(node) {
  return childrenOf(node.id).map(function(child){
    return { id: child.id, origin: child.origin ? JSON.parse(JSON.stringify(child.origin)) : null };
  });
}

// Anchors before the region keep their offsets; those after it move by the
// region's rendered-length change; those overlapping it lose their anchor but
// keep their node. Deleting a question because its sentence was reworded would
// throw away work the reader did, so the branch stays and simply stops
// painting a mark — applyChildHighlights already skips anchorless children.
function shiftAnchors(node, rendered, delta) {
  if (!rendered) return;
  childrenOf(node.id).forEach(function(child){
    var anchor = child.origin && child.origin.anchor;
    if (!anchor || anchor.pdf) return;
    if (anchor.offset_end <= rendered.start) return;
    if (anchor.offset_start >= rendered.end) {
      anchor.offset_start += delta;
      anchor.offset_end += delta;
      return;
    }
    child.origin.anchor = null;
  });
}

function applyLocally(node, markdown, anchors) {
  node.md = markdown;
  anchors.forEach(function(entry){
    var child = nodes[entry.id];
    if (child) child.origin = entry.origin;
  });
  refreshNodeHtml(node);
  hooks.refresh(node);
}

function persist(node, markdown, anchors) {
  return Promise.resolve(hooks.post({ type: "answer_node_content", node_id: node.id, markdown: markdown }))
    .then(function(result){
      if (!result || result.ok === false) return false;
      return Promise.all(anchors.map(function(entry){
        return hooks.post({ type: "node_origin", node_id: entry.id, origin: entry.origin });
      })).then(function(){ return true; });
    }, function(){ return false; });
}

function restore(node, markdown, anchors, message) {
  applyLocally(node, markdown, anchors);
  flashHint(message);
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

function renderPanel() {
  var state = active;
  var panel = state && state.panel;
  if (!panel) return;
  panel.hidden = false;
  panel.replaceChildren(buildStatus(state), buildActions(state));
  state.onPhase(state.phase);
}

function buildStatus(state) {
  var status = document.createElement("div");
  status.className = "ask-revision-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  if (state.phase === "generating") {
    status.textContent = state.fragment ? "Rewriting the passage…" : "Reading the document…";
  } else if (state.phase === "ready") {
    status.textContent = "Replacement below the current text. Changed words are marked.";
  } else {
    status.classList.add("error");
    status.textContent = state.error;
  }
  return status;
}

function buildActions(state) {
  var actions = document.createElement("div");
  actions.className = "ask-revision-actions";
  if (state.phase === "generating") {
    actions.appendChild(button("Cancel", "ask-revision-button", function(){ cancelSelectionRevision(); }));
    return actions;
  }
  if (state.phase === "error") {
    actions.appendChild(button("Cancel", "ask-revision-button", function(){ cancelSelectionRevision(); }));
    actions.appendChild(button("Try again", "ask-revision-button primary", function(){ retry(); }, iconSvg("sparkles")));
    return actions;
  }
  actions.appendChild(button(state.showOriginal ? "Show replacement" : "Show original", "ask-revision-button", function(){
    state.showOriginal = !state.showOriginal;
    var preview = state.preview;
    if (preview) preview.after.hidden = state.showOriginal;
    renderPanel();
  }));
  actions.appendChild(button("Try again", "ask-revision-button", function(){ retry(); }));
  actions.appendChild(button("Cancel", "ask-revision-button", function(){ cancelSelectionRevision(); }));
  actions.appendChild(button("Apply", "ask-revision-button primary", function(){ applySelectionRevision(); }, iconSvg("check")));
  return actions;
}

function retry() {
  var state = active;
  if (!state) return;
  var node = nodes[state.nodeId];
  var options = {
    node: node,
    region: state.region,
    instruction: state.instruction,
    selectedText: state.selectedText,
    panel: state.panel,
    onPhase: state.onPhase,
  };
  cancelSelectionRevision({ silent: true });
  startSelectionRevision(options);
}

function button(label, className, onClick, icon) {
  var template = document.createElement("template");
  template.innerHTML = buttonMarkup({ bare: true, className: className, label: label, svgIconHtml: icon || "" });
  var el = template.content.firstElementChild;
  el.addEventListener("click", onClick);
  return el;
}
