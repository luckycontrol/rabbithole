import {
  CANVAS_BASE,
  closed,
  flashHint,
  MAX_FS,
  MIN_FS,
  READER_BASE,
  breadcrumbEl,
  buildDocContent,
  childrenOf,
  currentNodeId,
  fontPx,
  goToNode,
  mode,
  motionSourceFromEvent,
  nodes,
  playLandingCue,
  readerMain,
  refreshCanvasNodeContent,
  setCurrentNodeId,
  setModeValue,
  world,
  sessionPhase
} from "./core.js";
import {
  BRANCH_FOLLOWUP,
  branchTypeOfNode,
  canvasNodeKind,
  lensLabel,
  lineageNodesFromMap,
  truncate
} from "../core/model.js";
import { escapeHtml } from "../core/utils.js";
import { createModuleLifecycle } from "./lifecycle.js";
import { captureContentPosition, restoreContentPosition } from "./scroll-position.js";
import { mountVisuals } from "./visuals.js";
import { applyChildHighlights, transitionMarkGroups } from "./text-marks.js";
import { buildOriginCrop } from "./origin-provenance.js";
import { buttonMarkup } from "../core/html/button-markup.js";
import { iconSvg } from "../core/html/icons.js";
import { refreshNodeHtml } from "./renderer.js";
import { registerLayer } from "./overlay/layer-stack.js";
import { buildAiRevisionSurface, canReviseWithAi, openAiRevision } from "./ai-revision.js";
import { onPointerGesture } from "./gestures.js";

function anchorStart(node) {
  return node.origin?.anchor?.offset_start ?? 1e9;
}

function isFollowup(node) {
  return branchTypeOfNode(node) === BRANCH_FOLLOWUP;
}

function lensBadgeHtml(key) {
  return '<span class="lens-badge">' + escapeHtml(lensLabel(key)) + "</span>";
}

function defaultReaderHooks(){
  return {
    hideAsk: function(){},
    syncReaderChatContext: function(){},
    updateReaderChatState: function(){},
    scheduleViewSave: function(){},
    setMode: function(){},
    post: function(){ return Promise.resolve({ ok: true }); },
    mountDocImages: null,
    persistNode: function(){},
    animateScroll: function(){}
  };
}

var readerLifecycle = createModuleLifecycle({ defaults: defaultReaderHooks });

export function registerReaderHooks(hooks) {
  readerLifecycle.register(hooks);
}

var breadcrumbNodes = {};
var noteNodes = {};
var readerDraft = null;

// The chosen edit-panel width persists for the page session as an inline
// override on the static #reader-rail element (the rail is never recreated, so
// reopening the panel keeps the last value). These bound that value; a
// double-click removes the override and falls back to the default clamp().
var READER_EDIT_MIN_WIDTH = 220;
var READER_EDIT_MAX_WIDTH = 560;
var READER_EDIT_WIDTH_STEP = 24;

function marginNotesLayer(){ return document.getElementById("margin-notes"); }

  // ===========================================================================
  // READER
  // ===========================================================================
export function openNode(id){
    if (!nodes[id]) return false;
    if (readerDraft && readerDraft.nodeId !== id){
      if (!requestCloseReaderAnswerDraft("navigation", function(){ openNode(id); })) return false;
    }
    var transferredPosition = document.body.classList.contains("mode-canvas")
      ? captureContentPosition(nodes[id].bodyEl)
      : null;
    // Snapshot the outgoing document's position (belt & braces alongside the
    // scroll listener) so every window keeps its place when you come back.
    // Only while the reader is actually visible — hidden (canvas mode) it
    // reads 0 and would clobber the position saved on the way out.
    var prev = nodes[currentNodeId];
    if (prev && !document.body.classList.contains("mode-canvas")) prev._scrollTop = readerMain.scrollTop;
    setCurrentNodeId(id);
    readerLifecycle.hooks.syncReaderChatContext(id);
    setModeValue("reader");
    document.body.classList.remove("mode-canvas");
    readerLifecycle.hooks.hideAsk();
    kbdMarkIdx = -1;
    renderBreadcrumb();
    renderReaderBody();
    if (transferredPosition) {
      restoreContentPosition(readerMain, transferredPosition);
      nodes[id]._scrollTop = readerMain.scrollTop;
    }
    renderMarginNotes();
    readerLifecycle.hooks.updateReaderChatState();
    readerLifecycle.hooks.scheduleViewSave();
    return true;
  }

export function renderBreadcrumb(){
    var path = lineageNodesFromMap(nodes, currentNodeId);
    var fragment = document.createDocumentFragment();
    path.forEach(function(n, i){
      var crumb = breadcrumbNodes[n.id];
      if (!crumb){
        crumb = document.createElement("span");
        crumb.className = "crumb";
        crumb.dataset.id = n.id;
        crumb._sep = document.createElement("span");
        crumb._sep.className = "crumb-sep";
        crumb._sep.textContent = "›";
        breadcrumbNodes[n.id] = crumb;
      }
      var cur = i === path.length - 1;
      crumb.classList.toggle("current", cur);
      if (cur){
        crumb.removeAttribute("role");
        crumb.removeAttribute("tabindex");
        crumb.setAttribute("aria-current", "page");
      } else {
        crumb.setAttribute("role", "link");
        crumb.tabIndex = 0;
        crumb.removeAttribute("aria-current");
      }
      crumb.textContent = cur && readerDraft && readerDraft.nodeId === n.id
        ? (readerDraft.title || "Untitled")
        : (n.title || "Untitled");
      if (i > 0) fragment.appendChild(crumb._sep);
      fragment.appendChild(crumb);
    });
    breadcrumbEl.replaceChildren(fragment);
  }
export function initReader(){
    disposeReaderResources(false);
    var readerScope = readerLifecycle.beginInit();
    try {
    readerScope.listen(breadcrumbEl, "click", function(e){
      var c = e.target.closest(".crumb");
      if (!c || c.classList.contains("current")) return;
      openNode(c.dataset.id);
    });
    readerScope.listen(breadcrumbEl, "keydown", function(e){
      if (e.key !== "Enter") return;
      var c = e.target.closest && e.target.closest('.crumb[role="link"]');
      if (!c) return;
      e.preventDefault();
      openNode(c.dataset.id);
    });
    readerScope.listen(readerMain, "scroll", onReaderScroll, { passive: true });
    readerScope.listen(readerMain, "click", onMarkClick);
    readerScope.listen(readerMain, "keydown", onMarkKeydown);
    readerScope.listen(readerMain, "dblclick", onReaderDoubleClick);
    readerScope.listen(readerMain, "mouseover", function(e){ transitionMarkGroups(e, true, "mark-hover"); });
    readerScope.listen(readerMain, "mouseout", function(e){ transitionMarkGroups(e, false, "mark-hover"); });
    readerScope.listen(readerMain, "focusin", function(e){ transitionMarkGroups(e, true, "mark-dom-focus"); });
    readerScope.listen(readerMain, "focusout", function(e){ transitionMarkGroups(e, false, "mark-dom-focus"); });
    // Canvas marks dive to the answer card in place — never yank into the reader.
    readerScope.listen(world, "click", onCanvasMarkClick);
    readerScope.listen(world, "keydown", onCanvasMarkKeydown);
    var notes = marginNotesLayer();
    readerScope.listen(notes, "click", onNoteClick);
    readerScope.listen(notes, "keydown", onNoteKeydown);
    // Hovering a margin note lights its highlight so the pair reads as one.
    readerScope.listen(notes, "mouseover", function(e){ syncNoteHover(e, true); });
    readerScope.listen(notes, "mouseout", function(e){ syncNoteHover(e, false); });
    readerScope.listen(document.getElementById("reader-rail-toggle"), "click", function(){ setReaderRailCollapsed(true); });
    readerScope.listen(document.getElementById("reader-rail-strip"), "click", function(){ setReaderRailCollapsed(false); });
    applyReaderRailCollapse();
    readerScope.listen(document.getElementById("r-textdown"), "click", function(){ setReaderFontScale(-0.1); });
    readerScope.listen(document.getElementById("r-textup"), "click", function(){ setReaderFontScale(0.1); });
    readerScope.listen(document.getElementById("t-canvas"), "click", function(){
      if (mode === "canvas") return;
      requestCloseReaderAnswerDraft("mode", function(){ readerLifecycle.hooks.setMode("canvas"); });
    });
    return disposeReader;
    } catch (error) {
      disposeReader();
      throw error;
    }
  }

export function disposeReader(){
    disposeReaderResources(true);
  }

function disposeReaderResources(resetHooks){
    if (readerDraft && readerDraft.unregisterLayer) readerDraft.unregisterLayer({ restoreFocus: false });
    readerLifecycle.dispose(resetHooks);
    breadcrumbNodes = {};
    noteNodes = {};
    document.body.classList.remove("reader-editing", "reader-editing-compact");
    readerDraft = null;
    kbdMarkIdx = -1;
  }

export function renderReaderBody(){
    var node = nodes[currentNodeId];
    var previous = readerMain.querySelector(".doc-content"); if (previous && previous._rhDispose) previous._rhDispose();
    readerMain.innerHTML = "";
    var col = document.createElement("div");
    col.className = "reader-col";
    // The lineage trail leads the document column and scrolls with it — the
    // floating taskbar above carries no per-document state.
    if (breadcrumbEl) col.appendChild(breadcrumbEl);
    if (node.origin && (node.origin.selected_text || node.origin.question)){
      var ctx = document.createElement("div");
      ctx.className = "reader-context";
      if (node.origin.selected_text){
        var tail = node.origin.lens ? " — " + lensBadgeHtml(node.origin.lens)
          : (node.origin.question ? " — " + escapeHtml(node.origin.question) : "");
        ctx.innerHTML = '<span class="rc-label">From</span>“' + escapeHtml(truncate(node.origin.selected_text, 200)) + '”' + tail + '<span class="rc-go">→</span>';
      } else {
        ctx.innerHTML = '<span class="rc-label">Follow-up</span>' +
          (node.origin.lens ? lensBadgeHtml(node.origin.lens) : escapeHtml(node.origin.question || ""));
      }
      // The strip is a live link: click it to land on the exact spot in the
      // parent this branch grew from (flashed so the eye finds it).
      if (node.parent_id && nodes[node.parent_id]){
        ctx.classList.add("linked");
        ctx.title = "See this in its original context";
        ctx.setAttribute("role", "link");
        ctx.tabIndex = 0;
        ctx.setAttribute("aria-label", "See this in its original context");
        ctx.addEventListener("click", function(e){ jumpToOrigin(node, motionSourceFromEvent(e)); });
        ctx.addEventListener("keydown", function(e){
          if (e.key !== "Enter") return;
          e.preventDefault();
          jumpToOrigin(node, "keyboard");
        });
      }
      col.appendChild(ctx);
    }
    var crop = buildOriginCrop(node, "reader");
    if (crop) col.appendChild(crop);
    var editing = readerDraft && readerDraft.nodeId === node.id && !isCompactReader();
    var revising = !!node._revision;
    if (!editing && !revising && isAnswerNodeEditable(node)) col.appendChild(buildReaderAnswerActions(node));
    var dc = editing ? buildReaderAnswerPreview(node) : (revising ? buildAiRevisionSurface(node, READER_BASE) : buildDocContent(node, READER_BASE));
    col.appendChild(dc);
    if (!revising) applyChildHighlights(dc, node);
    var isPdfReader = dc.classList.contains("rh-pdf");
    var isPdfViewport = isPdfReader && !node.parent_id && !crop;
    readerMain.classList.toggle("pdf-reader", isPdfReader);
    readerMain.classList.toggle("pdf-reader-viewport", isPdfViewport);
    col.classList.toggle("pdf-reader-col", isPdfReader);
    col.classList.toggle("pdf-reader-viewport", isPdfViewport);
    readerMain.appendChild(col);
    // Each document remembers where you were; a first open starts at the top.
    readerMain.scrollTop = editing ? (readerDraft.scrollTop || 0) : (node._scrollTop || 0);
    if (editing && readerDraft.contentPosition) restoreContentPosition(readerMain, readerDraft.contentPosition);
  }

function isAnswerNodeEditable(node){
  return !!node && !closed && node.parent_id != null
    && node.status === "answered" && !canvasNodeKind(node);
}

function buildReaderAnswerActions(node){
  var actions = document.createElement("div");
  actions.className = "reader-answer-actions";
  actions.innerHTML = buttonMarkup({
    bare: true,
    className: "reader-answer-edit",
    label: "Edit",
    ariaLabel: "Edit answer Markdown",
    title: "Edit answer Markdown",
    svgIconHtml: iconSvg("edit")
  }) + buttonMarkup({
    bare: true,
    className: "reader-ai-revise",
    label: "Revise with AI",
    ariaLabel: "Revise this card with AI",
    title: "Revise this card with AI",
    svgIconHtml: iconSvg("sparkles")
  });
  actions.querySelector(".reader-answer-edit").addEventListener("click", function(){ openReaderAnswerDraft(node); });
  var revise = actions.querySelector(".reader-ai-revise");
  revise.hidden = !canReviseWithAi(node);
  revise.addEventListener("click", function(){ openAiRevision(node); });
  return actions;
}

function onReaderDoubleClick(e){
  var node = nodes[currentNodeId];
  if (!isAnswerNodeEditable(node) || readerDraft) return;
  if (e.target.closest("a, button, input, textarea, select, [contenteditable='true']")) return;
  if (!e.target.closest(".doc-content, .crumb.current")) return;
  e.preventDefault();
  openReaderAnswerDraft(node);
}

function openReaderAnswerDraft(node){
  if (!isAnswerNodeEditable(node) || readerDraft) return;
  node._scrollTop = readerMain.scrollTop;
  readerDraft = {
    nodeId: node.id,
    scrollTop: node._scrollTop,
    contentPosition: captureContentPosition(readerMain),
    title: node.title || "",
    markdown: node.md || "",
    trigger: readerMain.querySelector(".reader-answer-edit"),
    form: null,
    titleInput: null,
    textarea: null,
    saveButton: null,
    cancelButton: null,
    retryButton: null,
    status: null,
    compactPreview: null,
    mobileMode: "write",
    error: "",
    saving: false,
    pendingClose: null,
    unregisterLayer: null,
  };
  document.body.classList.add("reader-editing");
  if (isCompactReader()) document.body.classList.add("reader-editing-compact");
  renderBreadcrumb();
  renderReaderBody();
  renderReaderEditPanel();
}

function isCompactReader(){
  return !!(window.matchMedia && window.matchMedia("(max-width: 760px), (pointer: coarse)").matches);
}

// ---------------------------------------------------------------------------
// Branch-rail width grip. A vertical handle on the rail's left edge, always
// visible on desktop (hidden on compact). It moves that left boundary: dragging
// it left (away from the rail) widens the rail, dragging it right narrows it,
// and the arrow keys follow the same sense. Dragging overrides
// --reader-branch-rail on the rail element (which is what both #reader-rail and
// the full-width edit panel measure against), so one inline property resizes
// the surface in branch browsing and while editing. The element is created once
// and stays in the static rail; the compact query hides it.
// ---------------------------------------------------------------------------

function currentReaderEditPanelWidth(){
  var rail = document.getElementById("reader-rail");
  var computed = rail && parseFloat(getComputedStyle(rail).width);
  return (computed && isFinite(computed)) ? Math.round(computed) : READER_EDIT_MIN_WIDTH;
}

function setReaderEditPanelWidth(width){
  var rail = document.getElementById("reader-rail");
  if (!rail) return;
  width = Math.max(READER_EDIT_MIN_WIDTH, Math.min(READER_EDIT_MAX_WIDTH, Math.round(width)));
  rail.style.setProperty("--reader-branch-rail", width + "px");
  syncReaderEditGripAria();
}

function resetReaderEditPanelWidth(){
  var rail = document.getElementById("reader-rail");
  if (!rail) return;
  rail.style.removeProperty("--reader-branch-rail");
  syncReaderEditGripAria();
}

function syncReaderEditGripAria(){
  var grip = document.querySelector(".reader-edit-grip");
  if (grip) grip.setAttribute("aria-valuenow", String(currentReaderEditPanelWidth()));
}

function ensureReaderEditResizeGrip(){
  var rail = document.getElementById("reader-rail");
  if (!rail || rail.querySelector(".reader-edit-grip")) return;
  var grip = document.createElement("div");
  grip.className = "reader-edit-grip";
  grip.setAttribute("role", "separator");
  grip.setAttribute("aria-orientation", "vertical");
  grip.setAttribute("aria-label", "Resize branch panel width");
  grip.setAttribute("aria-valuemin", String(READER_EDIT_MIN_WIDTH));
  grip.setAttribute("aria-valuemax", String(READER_EDIT_MAX_WIDTH));
  grip.tabIndex = 0;
  rail.appendChild(grip);
  syncReaderEditGripAria();

  onPointerGesture(grip,
    function(e){
      if (e.button !== 0) return false;
      e.preventDefault();
      document.body.classList.add("reader-resizing");
      grip._rhStartX = e.clientX;
      grip._rhStartW = currentReaderEditPanelWidth();
      return true;
    },
    function(ev){
      setReaderEditPanelWidth(grip._rhStartW - (ev.clientX - grip._rhStartX));
    },
    function(){
      document.body.classList.remove("reader-resizing");
      delete grip._rhStartX;
      delete grip._rhStartW;
    });

  grip.addEventListener("dblclick", function(){ resetReaderEditPanelWidth(); });
  grip.addEventListener("keydown", function(e){
    var width = currentReaderEditPanelWidth();
    if (e.key === "ArrowLeft"){ setReaderEditPanelWidth(width + READER_EDIT_WIDTH_STEP); e.preventDefault(); }
    else if (e.key === "ArrowRight"){ setReaderEditPanelWidth(width - READER_EDIT_WIDTH_STEP); e.preventDefault(); }
    else if (e.key === "Home"){ setReaderEditPanelWidth(READER_EDIT_MIN_WIDTH); e.preventDefault(); }
    else if (e.key === "End"){ setReaderEditPanelWidth(READER_EDIT_MAX_WIDTH); e.preventDefault(); }
  });
}

// ---------------------------------------------------------------------------
// Branch-rail collapse. The head chevron puts the rail away; a narrow strip
// takes its place and brings it back. The strip keeps the branch count on
// screen, so an answer that lands while the rail is collapsed is still
// announced. Collapsing never touches the inline --reader-branch-rail override
// the grip writes, so expanding returns to the width the reader chose.
//
// The edit panel lives inside the rail, so it cannot be shown collapsed: the
// applied state is the stored preference AND no edit open. Keeping the
// preference separate from the applied state is what lets closing an edit
// restore the collapse rather than recompute it.
// ---------------------------------------------------------------------------

var READER_RAIL_STORAGE_KEY = "rh-reader-rail";
var readerRailCollapsePref = readStoredReaderRailCollapse();

function readStoredReaderRailCollapse(){
  try { return localStorage.getItem(READER_RAIL_STORAGE_KEY) === "collapsed"; } catch(e){ return false; }
}

function storeReaderRailCollapse(collapsed){
  try { localStorage.setItem(READER_RAIL_STORAGE_KEY, collapsed ? "collapsed" : "open"); } catch(e){}
}

function applyReaderRailCollapse(){
  var rail = document.getElementById("reader-rail");
  if (!rail) return;
  // An open edit panel wins over the preference — it has nowhere else to render.
  var collapsed = readerRailCollapsePref && !rail.classList.contains("reader-edit-panel-active");
  rail.classList.toggle("reader-rail-collapsed", collapsed);
  var toggle = document.getElementById("reader-rail-toggle");
  if (toggle) toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  var strip = document.getElementById("reader-rail-strip");
  if (strip) strip.setAttribute("aria-expanded", collapsed ? "false" : "true");
}

function setReaderRailCollapsed(collapsed){
  readerRailCollapsePref = !!collapsed;
  storeReaderRailCollapse(readerRailCollapsePref);
  applyReaderRailCollapse();
  // Collapsing hides the control that was just pressed, so hand focus to the
  // control that replaces it rather than dropping it on a hidden element.
  var next = document.getElementById(collapsed ? "reader-rail-strip" : "reader-rail-toggle");
  if (next) next.focus({ preventScroll: true });
}

// The strip carries the count itself, so the number stays readable while the
// list is hidden.
function syncReaderRailCount(total){
  var count = document.getElementById("reader-rail-count");
  if (count) count.textContent = String(total);
  var stripCount = document.getElementById("reader-rail-strip-count");
  if (stripCount) stripCount.textContent = String(total);
  var strip = document.getElementById("reader-rail-strip");
  if (strip){
    var label = "Show branches, " + total;
    strip.setAttribute("aria-label", label);
    strip.title = label;
  }
}

function buildReaderAnswerPreview(node){
  var draft = readerDraft;
  var previewNode = Object.assign({}, node, {
    md: String(draft?.markdown ?? node.md ?? ""),
    html: "",
    _htmlFor: null,
    _contentDisposers: null,
  });
  var dc = buildDocContent(previewNode, READER_BASE);
  dc.classList.add("reader-draft-preview");
  return dc;
}

function replaceReaderDraftPreview(){
  var draft = readerDraft;
  var node = draft && nodes[draft.nodeId];
  if (!draft || !node || mode !== "reader" || currentNodeId !== node.id) return;
  var current = readerMain.querySelector(".reader-draft-preview");
  if (!current){ renderReaderBody(); return; }
  var position = captureContentPosition(readerMain);
  var next = buildReaderAnswerPreview(node);
  if (current._rhDispose) current._rhDispose();
  current.replaceWith(next);
  applyChildHighlights(next, node);
  restoreContentPosition(readerMain, position);
  draft.scrollTop = readerMain.scrollTop;
  draft.contentPosition = captureContentPosition(readerMain);
}

function renderReaderEditPanel(){
  var draft = readerDraft;
  var node = draft && nodes[draft.nodeId];
  var rail = document.getElementById("reader-rail");
  if (!draft || !node || !rail) return;
  if (draft.form && draft.form.isConnected) return;

  rail.classList.add("reader-edit-panel-active");
  rail.setAttribute("aria-labelledby", "reader-edit-title");
  // The panel renders inside the rail, so an edit forces it open for its
  // duration; the stored preference is untouched and applies again on close.
  applyReaderRailCollapse();
  ensureReaderEditResizeGrip();
  var oldPanel = rail.querySelector(".reader-edit-panel");
  if (oldPanel) oldPanel.remove();

  var form = document.createElement("form");
  form.className = "reader-edit-panel";
  form.setAttribute("aria-label", "Edit answer");

  var head = document.createElement("div");
  head.className = "reader-edit-panel-head";
  var heading = document.createElement("h2");
  heading.id = "reader-edit-title";
  heading.textContent = "Edit answer";
  var helper = document.createElement("p");
  helper.textContent = "Changes stay in this draft until you save.";
  head.append(heading, helper);

  var body = document.createElement("div");
  body.className = "reader-edit-panel-body";

  var titleField = document.createElement("label");
  titleField.className = "reader-edit-field reader-edit-title-field";
  var titleLabel = document.createElement("span");
  titleLabel.textContent = "Title";
  var titleInput = document.createElement("input");
  titleInput.id = "reader-answer-title";
  titleInput.type = "text";
  titleInput.className = "reader-edit-title-input";
  titleInput.setAttribute("aria-label", "Answer title");
  titleInput.autocomplete = "off";
  titleInput.value = draft.title;
  titleField.append(titleLabel, titleInput);

  var modeSwitch = document.createElement("div");
  modeSwitch.className = "reader-edit-mode-switch";
  modeSwitch.setAttribute("role", "tablist");
  modeSwitch.setAttribute("aria-label", "Editor mode");
  var writeTab = document.createElement("button");
  writeTab.type = "button";
  writeTab.className = "reader-edit-mode-tab";
  writeTab.dataset.mode = "write";
  writeTab.setAttribute("role", "tab");
  writeTab.setAttribute("aria-controls", "reader-edit-write");
  writeTab.textContent = "Write";
  var previewTab = document.createElement("button");
  previewTab.type = "button";
  previewTab.className = "reader-edit-mode-tab";
  previewTab.dataset.mode = "preview";
  previewTab.setAttribute("role", "tab");
  previewTab.setAttribute("aria-controls", "reader-edit-preview");
  previewTab.textContent = "Preview";
  modeSwitch.append(writeTab, previewTab);

  var writeSurface = document.createElement("div");
  writeSurface.id = "reader-edit-write";
  writeSurface.className = "reader-edit-write";
  writeSurface.setAttribute("role", "tabpanel");
  var markdownField = document.createElement("label");
  markdownField.className = "reader-edit-field reader-edit-markdown-field";
  var markdownLabel = document.createElement("span");
  markdownLabel.textContent = "Markdown";
  var textarea = document.createElement("textarea");
  textarea.id = "reader-answer-markdown";
  textarea.className = "reader-edit-markdown-input";
  textarea.setAttribute("aria-label", "Answer content");
  textarea.placeholder = "Write Markdown…";
  textarea.spellcheck = false;
  textarea.value = draft.markdown;
  markdownField.append(markdownLabel, textarea);
  writeSurface.appendChild(markdownField);

  var previewSurface = document.createElement("div");
  previewSurface.id = "reader-edit-preview";
  previewSurface.className = "reader-edit-compact-preview";
  previewSurface.setAttribute("role", "tabpanel");
  previewSurface.hidden = true;

  var status = document.createElement("div");
  status.className = "reader-edit-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  body.append(titleField, modeSwitch, writeSurface, previewSurface, status);

  var actions = document.createElement("div");
  actions.className = "reader-edit-actions";
  actions.innerHTML =
    buttonMarkup({ bare: true, className: "reader-edit-button", label: "Cancel" }) +
    buttonMarkup({ bare: true, className: "reader-edit-button primary", label: "Save answer", svgIconHtml: iconSvg("check") });
  var cancel = actions.querySelector("button");
  var save = actions.querySelector(".primary");
  var retry = document.createElement("button");
  retry.type = "button";
  retry.className = "reader-edit-retry";
  retry.textContent = "Retry save";
  retry.hidden = true;
  actions.appendChild(retry);

  var discard = document.createElement("div");
  discard.className = "reader-edit-discard-confirm";
  discard.hidden = true;
  discard.setAttribute("role", "alertdialog");
  discard.setAttribute("aria-label", "Discard unsaved draft");
  var discardMessage = document.createElement("p");
  discardMessage.textContent = "Discard this unsaved draft?";
  var discardActions = document.createElement("div");
  discardActions.className = "reader-edit-discard-actions";
  discardActions.innerHTML =
    buttonMarkup({ bare: true, className: "reader-edit-button", label: "Keep editing" }) +
    buttonMarkup({ bare: true, className: "reader-edit-button danger", label: "Discard draft" });
  var keepEditing = discardActions.querySelector("button");
  var discardDraft = discardActions.querySelector(".danger");
  discard.append(discardMessage, discardActions);

  form.append(head, body, actions, discard);
  rail.appendChild(form);

  draft.form = form;
  draft.titleInput = titleInput;
  draft.textarea = textarea;
  draft.saveButton = save;
  draft.cancelButton = cancel;
  draft.retryButton = retry;
  draft.status = status;
  draft.compactPreview = previewSurface;

  titleInput.addEventListener("input", function(){
    if (readerDraft !== draft) return;
    draft.title = titleInput.value;
    draft.error = "";
    renderBreadcrumb();
    syncReaderEditPanel(draft);
  });
  textarea.addEventListener("input", function(){
    if (readerDraft !== draft) return;
    draft.markdown = textarea.value;
    draft.error = "";
    if (!isCompactReader()) replaceReaderDraftPreview();
    if (draft.mobileMode === "preview") renderCompactDraftPreview(draft);
    syncReaderEditPanel(draft);
  });
  cancel.addEventListener("click", function(){ requestCloseReaderAnswerDraft("cancel"); });
  save.addEventListener("click", function(){ form.requestSubmit(); });
  retry.addEventListener("click", function(){ form.requestSubmit(); });
  form.addEventListener("submit", function(e){ e.preventDefault(); saveReaderAnswerDraft(); });
  form.addEventListener("keydown", function(e){
    if (e.key === "Escape") {
      e.preventDefault();
      requestCloseReaderAnswerDraft("escape");
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  writeTab.addEventListener("click", function(){ setReaderEditMode("write"); });
  previewTab.addEventListener("click", function(){ setReaderEditMode("preview"); });
  keepEditing.addEventListener("click", function(){ hideReaderDiscardConfirmation(); });
  discardDraft.addEventListener("click", function(){ discardReaderAnswerDraft(); });

  draft.writeTab = writeTab;
  draft.previewTab = previewTab;
  draft.discard = discard;
  draft.keepEditing = keepEditing;
  syncReaderEditPanel(draft);
  setReaderEditMode(draft.mobileMode);
  draft.unregisterLayer = registerLayer({
    element: form,
    trigger: draft.trigger,
    closeOnOutsidePointer: true,
    preventOutsidePointerDefault: true,
    restoreFocus: false,
    // The width grip lives beside the form (outside its subtree), so a pointer
    // that lands on it is operating the edit surface, not dismissing it.
    ignoreOutsidePointer: function(e){ return !!(e.target && e.target.closest && e.target.closest(".reader-edit-grip")); },
    onClose: function(reason){
      if (reason === "escape") closeReaderAnswerDraft(true);
      else requestCloseReaderAnswerDraft(reason || "outside");
    }
  });
  requestAnimationFrame(function(){
    if (readerDraft !== draft) return;
    // A late frame must not yank focus out of a field the human already reached:
    // under load this lands mid-keystroke and the rest of the body lands in the title.
    if (form.contains(document.activeElement)) return;
    var target = isCompactReader() ? textarea : titleInput;
    if (target && target.isConnected) target.focus({ preventScroll: true });
  });
}

function syncReaderEditPanel(draft){
  if (!draft || !draft.form) return;
  var dirty = isReaderAnswerDraftDirty(draft);
  draft.form.classList.toggle("has-error", !!draft.error);
  draft.saveButton.disabled = draft.saving;
  draft.cancelButton.disabled = false;
  draft.retryButton.hidden = !draft.error || draft.saving;
  draft.saveButton.setAttribute("aria-busy", draft.saving ? "true" : "false");
  draft.status.classList.toggle("error", !!draft.error);
  draft.status.textContent = draft.saving
    ? "Saving answer…"
    : draft.error
      ? "Couldn't save the answer. Your draft is still here. Check the connection and try again."
      : (dirty ? "Unsaved draft" : "Draft changes stay local until you save.");
}

function setReaderEditMode(nextMode){
  var draft = readerDraft;
  if (!draft || !draft.form) return;
  draft.mobileMode = nextMode === "preview" ? "preview" : "write";
  var preview = draft.mobileMode === "preview";
  draft.writeTab.setAttribute("aria-selected", preview ? "false" : "true");
  draft.previewTab.setAttribute("aria-selected", preview ? "true" : "false");
  draft.writeTab.classList.toggle("active", !preview);
  draft.previewTab.classList.toggle("active", preview);
  draft.form.classList.toggle("preview-mode", preview);
  draft.form.querySelector(".reader-edit-write").hidden = preview;
  draft.compactPreview.hidden = !preview;
  if (preview) renderCompactDraftPreview(draft);
}

function renderCompactDraftPreview(draft){
  if (!draft || !draft.compactPreview || draft.mobileMode !== "preview") return;
  var node = nodes[draft.nodeId];
  if (!node) return;
  var previous = draft.compactPreview.querySelector(".doc-content");
  if (previous && previous._rhDispose) previous._rhDispose();
  var preview = buildReaderAnswerPreview(node);
  applyChildHighlights(preview, node);
  draft.compactPreview.replaceChildren(preview);
}

function isReaderAnswerDraftDirty(draft){
  var node = draft && nodes[draft.nodeId];
  if (!draft || !node) return false;
  return String(draft.title ?? "") !== String(node.title || "")
    || String(draft.markdown ?? "") !== String(node.md || "");
}

function hideReaderDiscardConfirmation(){
  if (!readerDraft || !readerDraft.discard) return;
  readerDraft.pendingClose = null;
  readerDraft.discard.hidden = true;
  if (readerDraft.titleInput && readerDraft.titleInput.isConnected) readerDraft.titleInput.focus({ preventScroll: true });
}

function discardReaderAnswerDraft(){
  var draft = readerDraft;
  if (!draft) return;
  var continuation = draft.pendingClose;
  draft.pendingClose = null;
  closeReaderAnswerDraft(!continuation);
  if (typeof continuation === "function") continuation();
}

function requestCloseReaderAnswerDraft(reason, continuation){
  var draft = readerDraft;
  if (!draft){ if (typeof continuation === "function") continuation(); return true; }
  if (draft.saving){
    flashHint("Wait for the answer to finish saving.");
    return false;
  }
  if (!isReaderAnswerDraftDirty(draft)){
    closeReaderAnswerDraft(!continuation);
    if (typeof continuation === "function") continuation();
    return true;
  }
  draft.pendingClose = typeof continuation === "function" ? continuation : null;
  if (draft.discard){
    draft.discard.hidden = false;
    draft.keepEditing?.focus({ preventScroll: true });
  }
  return false;
}

function closeReaderAnswerDraft(restoreFocus){
  var draft = readerDraft;
  readerDraft = null;
  if (!draft) return;
  if (draft.unregisterLayer) draft.unregisterLayer({ restoreFocus: false });
  document.body.classList.remove("reader-editing", "reader-editing-compact");
  var node = nodes[draft.nodeId];
  if (!node || mode !== "reader" || currentNodeId !== node.id) return;
  node._scrollTop = draft.scrollTop;
  renderBreadcrumb();
  renderReaderBody();
  renderMarginNotes();
  if (restoreFocus) requestAnimationFrame(function(){
    readerMain.querySelector(".reader-answer-edit")?.focus({ preventScroll: true });
  });
}

function saveReaderAnswerDraft(){
  var draft = readerDraft;
  var node = draft && nodes[draft.nodeId];
  if (!draft || !node || draft.saving) return;
  if (!isAnswerNodeEditable(node)) { closeReaderAnswerDraft(true); return; }
  var title = String(draft.title ?? node.title ?? "").trim() || "Untitled";
  var markdown = String(draft.markdown ?? draft.textarea?.value ?? "").trim();
  if (!isReaderAnswerDraftDirty(draft)) { closeReaderAnswerDraft(true); return; }
  draft.title = title;
  draft.markdown = markdown;
  draft.error = "";
  draft.saving = true;
  syncReaderEditPanel(draft);
  var payload = { type: "answer_node_content", node_id: node.id, title: title, markdown: markdown };
  Promise.resolve(readerLifecycle.hooks.post(payload)).then(function(result){
    if (!result || result.ok === false) throw new Error(result?.error || "The answer could not be saved.");
    if (readerDraft !== draft || nodes[node.id] !== node) return;
    node.title = title;
    node.md = markdown;
    refreshNodeHtml(node);
    refreshCanvasNodeContent(node);
    if (node.titleEl){ node.titleEl.textContent = title; node.titleEl.title = title; }
    node._scrollTop = draft.scrollTop;
    closeReaderAnswerDraft(true);
  }).catch(function(error){
    if (readerDraft !== draft) return;
    draft.saving = false;
    draft.error = error?.message || "The answer could not be saved.";
    syncReaderEditPanel(draft);
    flashHint("Couldn't save the answer. Your draft is still here.");
  });
}
  // Open the parent and land on the exact origin when this branch is anchored.
export function jumpToOrigin(node, source){
    var parent = nodes[node.parent_id];
    if (!parent) return;
    if (!openNode(parent.id)) return;
    var target = readerMain.querySelector('[data-child="' + node.id + '"].rh-pdf-mark, mark[data-child="' + node.id + '"]');
    if (!target) return;
    scrollMarkIntoView(target, 0.38, source);
    var marks = readerMain.querySelectorAll('[data-child="' + node.id + '"].rh-pdf-mark, mark[data-child="' + node.id + '"]');
    for (var i = 0; i < marks.length; i++) playLandingCue(marks[i], "mark-flash");
  }

function scrollMarkIntoView(mark, viewportRatio, source){
    var scroller = mark.closest && mark.closest(".rh-pdf-scroll");
    if (!scroller) scroller = readerMain;
    var top = mark.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    readerLifecycle.hooks.animateScroll(scroller, Math.max(0, top - scroller.clientHeight * viewportRatio), source);
  }
  function onReaderScroll(){
    var n = nodes[currentNodeId];
    if (n) n._scrollTop = readerMain.scrollTop;
    if (readerDraft && readerDraft.nodeId === currentNodeId){
      readerDraft.scrollTop = readerMain.scrollTop;
      readerDraft.contentPosition = captureContentPosition(readerMain);
    }
    readerLifecycle.hooks.scheduleViewSave();
  }

  function onMarkClick(e){
    var m = e.target.closest("[data-child].rh-pdf-mark, mark[data-child]");
    if (!m) return;
    if (!window.getSelection().isCollapsed) return; // user was selecting, not clicking
    var k = nodes[m.dataset.child];
    // Pending branches open too — the reader shows the answer streaming in live.
    if (k) openNode(k.id);
  }
  function onMarkKeydown(e){
    if (e.key !== "Enter") return;
    var m = e.target.closest && e.target.closest("[data-child].rh-pdf-mark, mark[data-child]");
    if (!m) return;
    var k = nodes[m.dataset.child];
    if (!k) return;
    e.preventDefault();
    openNode(k.id);
  }
  function onCanvasMarkClick(e){
    var m = e.target.closest && e.target.closest("mark[data-child]");
    if (!m) return;
    if (!window.getSelection().isCollapsed) return; // the human was selecting, not clicking
    var k = nodes[m.dataset.child];
    if (k) goToNode(k, motionSourceFromEvent(e));
  }
  function onCanvasMarkKeydown(e){
    if (e.key !== "Enter") return;
    var m = e.target.closest && e.target.closest("mark[data-child]");
    if (!m) return;
    var k = nodes[m.dataset.child];
    if (!k) return;
    e.preventDefault();
    goToNode(k, motionSourceFromEvent(e));
  }
  // Every direct branch has one stable card in the Reader rail. Anchored
  // comments lead, in document order; general follow-ups follow in creation
  // order. Keeping one surface for both is especially important for PDFs,
  // whose own scroller cannot share an old absolute text margin.
export function renderMarginNotes(){
    if (readerDraft && readerDraft.nodeId === currentNodeId){
      if (!readerDraft.form || !readerDraft.form.isConnected) renderReaderEditPanel();
      return;
    }
    var rail = document.getElementById("reader-rail");
    if (rail){
      // The width grip serves branch browsing too, so make sure it exists even
      // when no edit is open (idempotent).
      ensureReaderEditResizeGrip();
      rail.classList.remove("reader-edit-panel-active");
      rail.setAttribute("aria-labelledby", "reader-rail-title");
      var editor = rail.querySelector(".reader-edit-panel");
      if (editor) editor.remove();
      // The edit panel no longer holds the rail open, so a stored collapse
      // takes effect again.
      applyReaderRailCollapse();
    }
    var layer = marginNotesLayer();
    if (!layer) return;
    var kids = childrenOf(currentNodeId).sort(function(a,b){
      var aAnchored = !!(a.origin && a.origin.anchor), bAnchored = !!(b.origin && b.origin.anchor);
      if (aAnchored !== bAnchored) return aAnchored ? -1 : 1;
      return (aAnchored ? anchorStart(a) - anchorStart(b) : 0) || ((a._order||0) - (b._order||0));
    });
    var fragment = document.createDocumentFragment();
    var newLivePanes = [];
    kids.forEach(function(k){
      var pending = k.status !== "answered";
      var qHtml = (k.origin && k.origin.lens) ? lensBadgeHtml(k.origin.lens)
        : escapeHtml((k.origin && k.origin.question) ? k.origin.question : (k.title || "Untitled"));
      var quote = (k.origin && k.origin.selected_text) ? k.origin.selected_text : "";
      var status = pending ? pendingStatusHtml(k) : 'open →';
      var tile = noteNodes[k.id];
      if (!tile){
        tile = document.createElement("div");
        tile.className = "side-item";
        tile.dataset.child = k.id;
        tile.setAttribute("role", "link");
        tile.tabIndex = 0;
        tile._question = document.createElement("div"); tile._question.className = "si-q";
        tile._quote = document.createElement("div"); tile._quote.className = "si-quote";
        tile._status = document.createElement("div"); tile._status.className = "si-status";
        tile.append(tile._question, tile._quote, tile._status);
        noteNodes[k.id] = tile;
      }
      tile.classList.toggle("pending", pending);
      tile.classList.toggle("followup", isFollowup(k));
      tile._question.innerHTML = qHtml;
      tile._quote.textContent = quote ? "“" + truncate(quote, 80) + "”" : "";
      tile._quote.hidden = !quote;
      tile._status.innerHTML = status;
      var name = (k.origin && k.origin.question) || k.title || "Untitled";
      tile.setAttribute("aria-label", "Open branch: " + name + (pending ? ", pending" : ""));
      // A streaming answer is watchable right here: its last lines render live
      // inside the note (and the whole note opens the full streaming view).
      if (pending && k.html){
        if (!tile._live){
          tile._live = document.createElement("div"); tile._live.className = "si-live";
          tile._livePane = document.createElement("div"); tile._livePane.className = "md";
          tile._live.appendChild(tile._livePane);
          tile.appendChild(tile._live);
          newLivePanes.push({ pane: tile._livePane, node: k });
        }
        tile._livePane.innerHTML = k.html;
      } else if (tile._live){
        tile._live.remove();
        tile._live = null;
        tile._livePane = null;
      }
      fragment.appendChild(tile);
    });
    if (!kids.length){
      var empty = document.createElement("div");
      empty.className = "reader-rail-empty";
      empty.textContent = "No branches yet";
      fragment.appendChild(empty);
    }
    layer.replaceChildren(fragment);
    syncReaderRailCount(kids.length);
    var rail = document.getElementById("reader-rail");
    if (rail) rail.classList.toggle("empty", !kids.length);
    mountNoteVisuals(newLivePanes);
  }
function onNoteClick(e){
    var it = e.target.closest && e.target.closest("#margin-notes .side-item");
    if (!it) return;
    openNode(it.dataset.child); // pending notes open too — the answer streams there
  }
function onNoteKeydown(e){
    if (e.key !== "Enter") return;
    var it = e.target.closest && e.target.closest('#margin-notes .side-item[role="link"]');
    if (!it) return;
    e.preventDefault();
    openNode(it.dataset.child);
  }
function syncNoteHover(e, on){
    var tile = e.target.closest && e.target.closest("#margin-notes .side-item");
    if (!tile) return;
    var related = e.relatedTarget;
    if (related && tile.contains(related)) return;
    var marks = readerMain.querySelectorAll('[data-child="' + tile.dataset.child + '"].rh-pdf-mark, mark[data-child="' + tile.dataset.child + '"]');
    for (var i = 0; i < marks.length; i++) marks[i].classList.toggle("mark-focus", on);
  }
function mountNoteVisuals(panes){
    for (var i = 0; i < panes.length; i++){
      var key = "margin-notes:" + panes[i].node.id;
      mountVisuals(panes[i].pane, key);
      if (typeof readerLifecycle.hooks.mountDocImages === "function") readerLifecycle.hooks.mountDocImages(panes[i].pane, key);
    }
  }
function pendingStatusHtml(k){
    var copy = {
      frozen: '<span class="si-muted">unanswered in this snapshot</span>',
      closed: '<span class="si-muted">saved — answered when you reopen</span>',
      away: '<span class="si-muted">saved — waiting for the agent</span>',
      live: k && k.html ? '<span class="shimmer-text">Writing…</span>' : '<span class="shimmer-text">Thinking…</span>'
    };
    return copy[sessionPhase()];
  }
function setReaderFontScale(delta){
    var node = nodes[currentNodeId];
    node.font_scale = Math.min(MAX_FS, Math.max(MIN_FS, (node.font_scale || 1) + delta));
    var dcs = readerMain.querySelectorAll(".doc-content");
    for (var i = 0; i < dcs.length; i++) dcs[i].style.fontSize = fontPx(node, READER_BASE) + "px";
    if (node.bodyEl){ var cdc = node.bodyEl.querySelector(".doc-content"); if (cdc) cdc.style.fontSize = fontPx(node, CANVAS_BASE) + "px"; }
    readerLifecycle.hooks.persistNode(node);
  }

  // j/k focus ring over the current document's anchored branches.
  var kbdMarkIdx = -1;
function allMarks(){ return readerMain.querySelectorAll("[data-child].rh-pdf-mark, mark[data-child]"); }
export function focusedMark(){
    var marks = allMarks();
    return (kbdMarkIdx >= 0 && kbdMarkIdx < marks.length) ? marks[kbdMarkIdx] : null;
  }
export function stepMark(delta){
    var marks = allMarks();
    if (!marks.length) return;
    var prev = focusedMark();
    if (prev) prev.classList.remove("mark-focus");
    kbdMarkIdx = kbdMarkIdx < 0 ? (delta > 0 ? 0 : marks.length - 1)
      : Math.max(0, Math.min(marks.length - 1, kbdMarkIdx + delta));
    var m = marks[kbdMarkIdx];
    m.classList.add("mark-focus");
    scrollMarkIntoView(m, 0.42, "keyboard");
  }
