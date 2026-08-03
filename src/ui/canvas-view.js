import {
  CANVAS_BASE,
  MAX_FS,
  MAX_SCALE,
  MIN_FS,
  MIN_SCALE,
  READER_BASE,
  SVGNS,
  buildDocContent,
  canvasBuilt,
  canvasFramed,
  childrenOf,
  closed,
  currentNodeId,
  edgesSvg,
  fontPx,
  flashHint,
  isVisible,
  mode,
  motionSourceFromEvent,
  nextOrder,
  nodes,
  readerMain,
  registerCoreHooks,
  registerNode,
  rootId,
  setCanvasBuilt,
  setCanvasFramed,
  setModeValue,
  setViewAdjusted,
  shouldReduceMotion,
  sessionPhase,
  uuid,
  view,
  viewport,
  world,
  zoomLabel
} from "./core.js";
import {
  TREE_PARENT_GAP,
  TREE_STACK_GAP,
  boundsOverlap,
  nodeBounds,
  nodeOrder,
  shiftBounds,
  unionBounds
} from "../core/layout.js";
import {
  BRANCH_FOLLOWUP,
  BRANCH_SELECTION,
  branchTypeOfNode,
  CANVAS_NODE_CARD,
  CANVAS_NODE_ORIGIN_VERSION,
  CANVAS_NODE_TEXT,
  canvasNodeKind,
  lensLabel,
  truncate
} from "../core/model.js";
import { openNode } from "./reader.js";
import { applyChildHighlights, transitionMarkGroups } from "./text-marks.js";
import { easeInOutMotion, easeOutMotion } from "./easing.js";
import { buttonMarkup, iconButtonMarkup } from "../core/html/button-markup.js";
import { buildOriginCrop } from "./origin-provenance.js";
import { BUNNY_MARK_SVG, iconSvg } from "../core/html/icons.js";
import { createModuleLifecycle } from "./lifecycle.js";
import { captureContentPosition, restoreContentPosition } from "./scroll-position.js";
import { applyComposerState } from "./composer-state.js";
import { ENTER_SEND_HINT, isSubmitEnter } from "./input-intent.js";
import { openAnchoredSurface } from "./overlay/anchor.js";
import { registerLayer } from "./overlay/layer-stack.js";
import { refreshNodeHtml } from "./renderer.js";
import { teardownNode } from "./node-teardown.js";

function isSelectionBranch(node) {
  return branchTypeOfNode(node) === BRANCH_SELECTION;
}

function isFollowup(node) {
  return branchTypeOfNode(node) === BRANCH_FOLLOWUP;
}

function defaultCanvasHooks(){
  return {
    hideAsk: function(){},
    sendFollowup: function(){ return null; },
    confirmDelete: function(){},
    post: function(){ return Promise.resolve({ ok: true }); },
    persistNode: function(){},
    persistNodesBulk: function(){},
    scheduleViewSave: function(){}
  };
}

var canvasLifecycle = createModuleLifecycle({ defaults: defaultCanvasHooks });
var filmCameraHandle = null;
var cardResizeObserver = null;
var activePointerGestures = new Set();
var canvasInsertToolbar = null;
var canvasDraft = null;

export function registerCanvasHooks(hooks) {
  canvasLifecycle.register(hooks);
}

export function initCanvasView(){
  cleanupCanvasView(false);
  var canvasScope = canvasLifecycle.beginInit();
  if (typeof ResizeObserver === "function") cardResizeObserver = new ResizeObserver(scheduleEdges);
  registerCoreHooks({
    ensureCanvasBuilt: ensureCanvasBuilt,
    diveToNode: diveToNode
  });
  canvasScope.listen(world, "mouseover", onWorldMouseOver);
  canvasScope.listen(world, "mouseout", onWorldMouseOut);
  initViewportPan();
  canvasScope.listen(viewport, "wheel", onViewportWheel, { passive: false });
  canvasScope.listen(viewport, "dblclick", onViewportDblClick);
  canvasScope.listen(document.getElementById("t-reader"), "click", function(){ if (mode !== "canvas") return; openNode(currentNodeId); });
  canvasScope.listen(document.getElementById("t-frame"), "click", function(e){ frameAll(true, motionSourceFromEvent(e)); });
  canvasScope.listen(document.getElementById("t-tidy"), "click", function(e){ tidy(motionSourceFromEvent(e)); });
  canvasScope.listen(document.getElementById("t-zin"), "click", function(){ zoomAt(viewport.clientWidth/2, viewport.clientHeight/2, 1.15); });
  canvasScope.listen(document.getElementById("t-zout"), "click", function(){ zoomAt(viewport.clientWidth/2, viewport.clientHeight/2, 0.87); });
  canvasScope.listen(zoomLabel, "click", function(){ zoomTo(viewport.clientWidth/2, viewport.clientHeight/2, 1); });
  exposeFilmCameraHook();
  return disposeCanvasView;
}

export function disposeCanvasView(){
  cleanupCanvasView(true);
}

function cleanupCanvasView(resetHooks){
  canvasLifecycle.dispose(resetHooks);
  if (cardResizeObserver) cardResizeObserver.disconnect();
  cardResizeObserver = null;
  activePointerGestures.forEach(function(cancel){ cancel(); });
  activePointerGestures.clear();
  closeCanvasInsertToolbar();
  closeCanvasDraft();
  cancelViewAnimation();
  if (edgeRaf){ cancelAnimationFrame(edgeRaf); edgeRaf = 0; }
  if (filmCameraHandle && window.__rhFilmCamera === filmCameraHandle) {
    try { delete window.__rhFilmCamera; } catch(_e){}
  }
  filmCameraHandle = null;
  if (edgesSvg) while (edgesSvg.firstChild) edgesSvg.removeChild(edgesSvg.firstChild);
  edgeEls = {};
  edgeGeometry = {};
  edgeHl = {};
  wheelKind = null;
  wheelCard = null;
  wheelTs = 0;
  viewport?.classList.remove("panning");
  if (resetHooks) {
    registerCoreHooks({
      ensureCanvasBuilt: function(){},
      diveToNode: function(){}
    });
  }
}

  // ===========================================================================
  // CANVAS
  // ===========================================================================
function applyTransform(){
    world.style.transform = "translate(" + view.x + "px," + view.y + "px) scale(" + view.scale + ")";
    zoomLabel.textContent = Math.round(view.scale * 100) + "%";
    canvasLifecycle.hooks.scheduleViewSave();
  }
  function exposeFilmCameraHook(){
    var enabled = false;
    try { enabled = localStorage.getItem("rh-film") === "1"; } catch(e){}
    if (!enabled) return;
    filmCameraHandle = {
      getView: function(){
        return { x: view.x, y: view.y, scale: view.scale };
      },
      setView: function(x, y, scale){
        cancelViewAnimation();
        setViewAdjusted(true);
        view.x = Number(x);
        view.y = Number(y);
        view.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(scale)));
        applyTransform();
        drawEdges();
        return { x: view.x, y: view.y, scale: view.scale };
      }
    };
    Object.defineProperty(window, "__rhFilmCamera", {
      configurable: true,
      value: filmCameraHandle
    });
  }
function screenToWorld(sx, sy){ return { x: (sx - view.x) / view.scale, y: (sy - view.y) / view.scale }; }

  var CANVAS_TEXT_SIZE = { w: 300, h: 160 };
  var CANVAS_CARD_SIZE = { w: 420, h: 360 };
  var ANSWER_DRAFT_KIND = "answer";

  function closeCanvasInsertToolbar(){
    var active = canvasInsertToolbar;
    canvasInsertToolbar = null;
    if (!active) return;
    if (active.surfaceControl) active.surfaceControl.dispose();
    if (active.el.parentNode) active.el.parentNode.removeChild(active.el);
  }

  function toolbarPointAnchor(point){
    return {
      contextElement: viewport,
      getBoundingClientRect: function(){
        return { x: point.clientX, y: point.clientY, left: point.clientX, top: point.clientY,
          right: point.clientX, bottom: point.clientY, width: 0, height: 0 };
      }
    };
  }

  function focusCanvasInsertButton(button, buttons){
    buttons.forEach(function(candidate){ candidate.tabIndex = candidate === button ? 0 : -1; });
    button.focus({ preventScroll: true });
  }

  function openCanvasInsertToolbar(event){
    closeCanvasInsertToolbar();
    closeCanvasDraft();
    var point = { clientX: event.clientX, clientY: event.clientY };
    var el = document.createElement("div");
    el.className = "canvas-insert-toolbar canvas-insert-ui popover-surface visible";
    el.setAttribute("role", "toolbar");
    el.setAttribute("aria-label", "Add to canvas");
    el.innerHTML =
      iconButtonMarkup({ bare: true, className: "canvas-insert-action", ariaLabel: "Add text", title: "Add text", svgIconHtml: iconSvg("text") }) +
      iconButtonMarkup({ bare: true, className: "canvas-insert-action", ariaLabel: "Add card", title: "Add card", svgIconHtml: iconSvg("card") });
    document.body.appendChild(el);
    var buttons = Array.prototype.slice.call(el.querySelectorAll("button"));
    buttons.forEach(function(button, index){ button.tabIndex = index === 0 ? 0 : -1; });
    el.addEventListener("keydown", function(e){
      var index = buttons.indexOf(document.activeElement), next = null;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next = buttons[(index + 1 + buttons.length) % buttons.length];
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = buttons[(index - 1 + buttons.length) % buttons.length];
      else if (e.key === "Home") next = buttons[0];
      else if (e.key === "End") next = buttons[buttons.length - 1];
      if (!next) return;
      e.preventDefault(); focusCanvasInsertButton(next, buttons);
    });
    buttons[0].addEventListener("click", function(){ closeCanvasInsertToolbar(); openCanvasDraft(CANVAS_NODE_TEXT, draftPosition(point, CANVAS_TEXT_SIZE)); });
    buttons[1].addEventListener("click", function(){ closeCanvasInsertToolbar(); openCanvasDraft(CANVAS_NODE_CARD, draftPosition(point, CANVAS_CARD_SIZE)); });
    var surfaceControl = openAnchoredSurface({
      surface: el,
      anchor: toolbarPointAnchor(point),
      placement: "top-center",
      restoreFocus: false,
      onClose: closeCanvasInsertToolbar
    });
    canvasInsertToolbar = { el: el, surfaceControl: surfaceControl };
    focusCanvasInsertButton(buttons[0], buttons);
  }

  function draftPosition(point, size){
    var margin = 16, topClear = 68;
    var scaledW = size.w * view.scale, scaledH = size.h * view.scale;
    var maxLeft = Math.max(margin, viewport.clientWidth - margin - scaledW);
    var maxTop = Math.max(topClear, viewport.clientHeight - margin - scaledH);
    var left = Math.max(margin, Math.min(maxLeft, point.clientX - scaledW / 2));
    var top = Math.max(topClear, Math.min(maxTop, point.clientY + 12));
    return screenToWorld(left, top);
  }

  function closeCanvasDraft(){
    var active = canvasDraft;
    canvasDraft = null;
    if (!active) return;
    if (active.unregisterLayer) active.unregisterLayer({ restoreFocus: false });
    if (active.el.parentNode) active.el.parentNode.removeChild(active.el);
    if (active.node && active.node.el) active.node.el.classList.remove("canvas-content-editing");
  }

  function openCanvasDraft(kind, position, node){
    if (closed){
      flashHint("Changes can't be saved in this read-only canvas.");
      return;
    }
    closeCanvasInsertToolbar();
    closeCanvasDraft();
    var isAnswerDraft = kind === ANSWER_DRAFT_KIND;
    var size = node ? { w: node.w, h: node.h } : (kind === CANVAS_NODE_TEXT ? CANVAS_TEXT_SIZE : CANVAS_CARD_SIZE);
    var form = document.createElement("form");
    form.className = "node canvas-insert-draft canvas-insert-ui canvas-" + kind + "-draft";
    form.setAttribute("role", "dialog");
    form.setAttribute("aria-label", node ? (isAnswerDraft ? "Edit answer" : "Edit canvas " + kind) : "Add canvas " + kind);
    form.style.left = position.x + "px"; form.style.top = position.y + "px";
    form.style.width = size.w + "px"; form.style.height = size.h + "px";
    var head = document.createElement("div"); head.className = "canvas-draft-head";
    head.textContent = node ? (isAnswerDraft ? "Edit answer" : "Edit " + kind) : (kind === CANVAS_NODE_TEXT ? "Add text" : "Add card");
    var titleInput = null;
    if (kind === CANVAS_NODE_CARD){
      titleInput = document.createElement("input"); titleInput.className = "canvas-draft-title";
      titleInput.type = "text"; titleInput.placeholder = "Card title"; titleInput.setAttribute("aria-label", "Card title");
      titleInput.value = node ? (node.title || "") : "";
    }
    var textarea = document.createElement("textarea"); textarea.className = "canvas-draft-content";
    textarea.placeholder = kind === CANVAS_NODE_TEXT ? "Type text…" : "Write Markdown…";
    textarea.setAttribute("aria-label", kind === CANVAS_NODE_TEXT ? "Text" : (isAnswerDraft ? "Answer content" : "Card content"));
    textarea.value = node ? (node.md || "") : "";
    var actions = document.createElement("div"); actions.className = "canvas-draft-actions";
    var cancel = cardButton(buttonMarkup({ bare: true, className: "canvas-draft-button", label: "Cancel" }));
    var save = cardButton(buttonMarkup({ bare: true, className: "canvas-draft-button primary", label: kind === CANVAS_NODE_TEXT ? "Add text" : (isAnswerDraft ? "Save answer" : "Save card"), svgIconHtml: iconSvg("check") }));
    actions.appendChild(cancel); actions.appendChild(save);
    form.appendChild(head); if (titleInput) form.appendChild(titleInput); form.appendChild(textarea); form.appendChild(actions);
    world.appendChild(form);
    if (node && node.el) node.el.classList.add("canvas-content-editing");
    var unregisterLayer = registerLayer({
      element: form,
      restoreFocus: false,
      preventOutsidePointerDefault: false,
      onClose: closeCanvasDraft
    });
    canvasDraft = { el: form, node: node || null, kind: kind, position: position, size: size,
      titleInput: titleInput, textarea: textarea, unregisterLayer: unregisterLayer };
    cancel.addEventListener("click", function(){ closeCanvasDraft(); });
    save.addEventListener("click", function(){ form.requestSubmit(); });
    form.addEventListener("submit", function(e){ e.preventDefault(); saveCanvasDraft(); });
    form.addEventListener("keydown", function(e){
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)){ e.preventDefault(); form.requestSubmit(); }
    });
    requestAnimationFrame(function(){ (titleInput || textarea).focus({ preventScroll: true }); });
  }

  function textNodeTitle(markdown){
    var first = String(markdown || "").split(/\r?\n/).find(function(line){ return line.trim(); }) || "Text";
    first = first.replace(/^\s*#{1,6}\s*/, "").replace(/[*_`~\[\]]/g, "").trim() || "Text";
    return truncate(first, 48);
  }

  function saveCanvasDraft(){
    var active = canvasDraft;
    if (!active) return;
    var markdown = active.textarea.value.trim();
    var isAnswerDraft = active.kind === ANSWER_DRAFT_KIND;
    var title = active.kind === CANVAS_NODE_TEXT ? textNodeTitle(markdown) : (active.titleInput ? active.titleInput.value.trim() : "");
    if (isAnswerDraft){
      updateAnswerNodeContent(active.node, markdown);
      closeCanvasDraft();
      return;
    }
    if (active.kind === CANVAS_NODE_TEXT && !markdown){ flashHint("Type some text before adding it."); active.textarea.focus(); return; }
    if (active.kind === CANVAS_NODE_CARD && !title && !markdown){ flashHint("Add a title or some card content first."); active.titleInput.focus(); return; }
    if (!title) title = "Untitled card";
    if (active.node){
      updateManualNodeContent(active.node, title, markdown);
      closeCanvasDraft();
      return;
    }
    var payload = {
      type: "canvas_node_create",
      node_id: uuid(),
      kind: active.kind,
      title: title,
      markdown: markdown,
      position: { x: active.position.x, y: active.position.y },
      size: { w: active.size.w, h: active.size.h }
    };
    closeCanvasDraft();
    createManualNode(payload);
  }

  function createManualNode(payload){
    var node = registerNode({
      id: payload.node_id, parent_id: null, title: payload.title, html: "", md: payload.markdown,
      base_url: null, base_url_source: null, read: false,
      origin: { canvas: { version: CANVAS_NODE_ORIGIN_VERSION, kind: payload.kind } },
      x: payload.position.x, y: payload.position.y, w: payload.size.w, h: payload.size.h,
      font_scale: 1, collapsed: false, status: "answered", extensions: {}, _order: nextOrder(), _startTs: 0
    });
    refreshNodeHtml(node);
    createNodeEl(node, true); renderVisibility(); drawEdges();
    Promise.resolve(canvasLifecycle.hooks.post(payload)).then(function(result){
      if (result && result.ok !== false) return;
      if (nodes[node.id] === node){ teardownNode(node.id); renderVisibility(); drawEdges(); }
      flashHint("Couldn't save the new canvas item.");
    }, function(){
      if (nodes[node.id] === node){ teardownNode(node.id); renderVisibility(); drawEdges(); }
      flashHint("Couldn't save the new canvas item.");
    });
  }

  function updateManualNodeContent(node, title, markdown){
    var previous = { title: node.title, markdown: node.md };
    node.title = title; node.md = markdown; refreshNodeHtml(node);
    if (node.titleEl){ node.titleEl.textContent = title; node.titleEl.title = title; }
    fillBody(node); scheduleEdges();
    var payload = { type: "canvas_node_content", node_id: node.id, title: title, markdown: markdown };
    Promise.resolve(canvasLifecycle.hooks.post(payload)).then(function(result){
      if (result && result.ok !== false) return;
      restoreManualNodeContent(node, previous, title, markdown);
    }, function(){ restoreManualNodeContent(node, previous, title, markdown); });
  }

  function updateAnswerNodeContent(node, markdown){
    var previous = node.md;
    node.md = markdown; refreshNodeHtml(node);
    fillBody(node); scheduleEdges();
    var payload = { type: "answer_node_content", node_id: node.id, markdown: markdown };
    Promise.resolve(canvasLifecycle.hooks.post(payload)).then(function(result){
      if (result && result.ok !== false) return;
      restoreAnswerNodeContent(node, previous, markdown);
    }, function(){ restoreAnswerNodeContent(node, previous, markdown); });
  }

  function restoreAnswerNodeContent(node, previous, expectedMarkdown){
    if (nodes[node.id] !== node || node.md !== expectedMarkdown) return;
    node.md = previous; refreshNodeHtml(node);
    fillBody(node); scheduleEdges(); flashHint("Couldn't save the answer.");
  }

  function restoreManualNodeContent(node, previous, expectedTitle, expectedMarkdown){
    if (nodes[node.id] !== node || node.title !== expectedTitle || node.md !== expectedMarkdown) return;
    node.title = previous.title; node.md = previous.markdown; refreshNodeHtml(node);
    if (node.titleEl){ node.titleEl.textContent = node.title; node.titleEl.title = node.title; }
    fillBody(node); scheduleEdges(); flashHint("Couldn't save the canvas item.");
  }

  function zoomAt(sx, sy, factor){
    var next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
    zoomTo(sx, sy, next);
  }
  function zoomTo(sx, sy, next){
    cancelViewAnimation(); // manual zoom cancels any in-flight glide
    next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    if (next === view.scale) return;
    setViewAdjusted(true);
    var w = screenToWorld(sx, sy); view.scale = next; view.x = sx - w.x * view.scale; view.y = sy - w.y * view.scale; applyTransform();
  }
  var NODE_EXPAND_ICON = iconSvg("expand");
  var NODE_COLLAPSE_ICON = iconSvg("collapse");
  var NODE_RESTORE_ICON = iconSvg("restore");

  function syncCollapseButton(node, btn){
    var action = node.collapsed ? "Expand document" : "Collapse document";
    btn.innerHTML = node.collapsed ? NODE_RESTORE_ICON : NODE_COLLAPSE_ICON;
    btn.setAttribute("aria-label", action); btn.title = action;
  }

  function isAnswerNodeEditable(node){
    return !!node && node.id !== rootId && node.parent_id != null
      && !canvasNodeKind(node) && node.status === "answered";
  }

export function updateAnswerEditControl(node){
    var button = node && node.answerEditBtn;
    if (!button) return;
    var editable = isAnswerNodeEditable(node);
    button.hidden = !editable;
    button.disabled = !editable;
  }

export function createNodeEl(node, enter){
    var manualKind = canvasNodeKind(node);
    var el = document.createElement("div");
    el.className = "node" + (node.id === rootId ? " root" : "");
    if (manualKind) el.className += " canvas-manual-node canvas-" + manualKind + "-node";
    if (enter && !document.hidden && !shouldReduceMotion()) el.className += " node-enter";
    el.dataset.id = node.id;

    var head = document.createElement("div");
    head.className = "node-head";
    if (node.id === rootId){
      var badge = document.createElement("span"); badge.className = "node-badge"; badge.innerHTML = BUNNY_MARK_SVG;
      badge.title = "Where this Rabbithole begins";
      head.appendChild(badge);
    }
    var titleEl = document.createElement("span"); titleEl.className = "node-title"; titleEl.textContent = node.title || "…";
    titleEl.title = node.title || "";
    var aDown = cardButton(buttonMarkup({ bare: true, className: "node-btn node-font-btn", label: "A−", ariaLabel: "Smaller text", title: "Smaller text" }));
    var aUp = cardButton(buttonMarkup({ bare: true, className: "node-btn node-font-btn", label: "A+", ariaLabel: "Larger text", title: "Larger text" }));
    var collapseBtn = cardButton(iconButtonMarkup({ bare: true, className: "node-btn", svgIconHtml: NODE_COLLAPSE_ICON, ariaLabel: "Collapse document", title: "Collapse document" }));
    syncCollapseButton(node, collapseBtn);
    var openBtn = cardButton(iconButtonMarkup({ bare: true, className: "node-btn", svgIconHtml: NODE_EXPAND_ICON, ariaLabel: "Expand document", title: "Expand document" }));
    var divider = document.createElement("span"); divider.className = "node-act-divider"; divider.setAttribute("aria-hidden", "true");
    var acts = document.createElement("span"); acts.className = "node-acts";
    if (node.id !== rootId){
      var removeLabel = manualKind ? "Remove canvas " + manualKind : "Remove this branch";
      var delBtn = cardButton(buttonMarkup({ bare: true, className: "node-btn danger", label: "✕", ariaLabel: removeLabel, title: removeLabel }));
      delBtn.addEventListener("click", function(e){ e.stopPropagation(); canvasLifecycle.hooks.confirmDelete(node, delBtn); });
      acts.appendChild(delBtn);
    }
    if (manualKind){
      var editBtn = cardButton(iconButtonMarkup({ bare: true, className: "node-btn canvas-manual-edit", svgIconHtml: iconSvg("edit"), ariaLabel: "Edit canvas " + manualKind, title: "Edit canvas " + manualKind }));
      editBtn.addEventListener("click", function(e){ e.stopPropagation(); openCanvasDraft(manualKind, { x: node.x, y: node.y }, node); });
      acts.appendChild(editBtn);
    }
    var answerEditBtn = null;
    if (!manualKind && node.parent_id != null){
      answerEditBtn = cardButton(iconButtonMarkup({ bare: true, className: "node-btn canvas-answer-edit", svgIconHtml: iconSvg("edit"), ariaLabel: "Edit answer Markdown", title: "Edit answer Markdown" }));
      answerEditBtn.addEventListener("click", function(e){
        e.stopPropagation();
        if (isAnswerNodeEditable(node)) openCanvasDraft(ANSWER_DRAFT_KIND, { x: node.x, y: node.y }, node);
      });
      acts.appendChild(answerEditBtn);
    }
    if (manualKind !== CANVAS_NODE_TEXT){
      acts.appendChild(aDown); acts.appendChild(aUp); acts.appendChild(divider); acts.appendChild(collapseBtn); acts.appendChild(openBtn);
    }
    head.appendChild(titleEl); head.appendChild(acts);

    var body = document.createElement("div"); body.className = "node-body";
    var comp = manualKind === CANVAS_NODE_TEXT ? null : buildCardComposer(node);
    var resize = document.createElement("div"); resize.className = "node-resize";
    el.appendChild(head); el.appendChild(body); if (comp) el.appendChild(comp); el.appendChild(resize);
    world.appendChild(el);

    node.el = el; node.bodyEl = body; node.titleEl = titleEl; node.answerEditBtn = answerEditBtn;
    updateAnswerEditControl(node);
    if (cardResizeObserver) cardResizeObserver.observe(el);
    fillBody(node);
    if (comp) updateCardComposer(node);
    if (node.collapsed) el.classList.add("collapsed");

    enableDrag(node, head);
    enableResize(node, resize);
    head.addEventListener("dblclick", function(e){
      if (onCardControl(e)) return;
      if (manualKind === CANVAS_NODE_TEXT) openCanvasDraft(manualKind, { x: node.x, y: node.y }, node);
      else openNode(node.id);
    });
    if (manualKind || answerEditBtn) body.addEventListener("dblclick", function(e){
      if (e.target.closest("a, button, input, textarea, select, [contenteditable='true']")) return;
      if (manualKind){
        e.preventDefault(); e.stopPropagation(); openCanvasDraft(manualKind, { x: node.x, y: node.y }, node);
      } else if (isAnswerNodeEditable(node)) {
        e.preventDefault(); e.stopPropagation(); openCanvasDraft(ANSWER_DRAFT_KIND, { x: node.x, y: node.y }, node);
      }
    });
    openBtn.addEventListener("click", function(e){ e.stopPropagation(); openNode(node.id); });
    collapseBtn.addEventListener("click", function(e){ e.stopPropagation(); toggleCollapse(node, collapseBtn); });
    aDown.addEventListener("click", function(e){ e.stopPropagation(); setNodeFontScale(node, -0.1); });
    aUp.addEventListener("click", function(e){ e.stopPropagation(); setNodeFontScale(node, 0.1); });
    // Scrolling a card moves the inline marks its children's edges start from.
    body.addEventListener("scroll", scheduleEdges, { passive: true });
    // Hovering a card lights up its edge and the exact text it branched from.
    el.addEventListener("mouseenter", function(){ focusOrigin(node, true); });
    el.addEventListener("mouseleave", function(){
      focusOrigin(node, false);
      if (node.ncComp && !node.ncText.value.trim() && document.activeElement !== node.ncText) closeCardDrawer(node);
    });

    layoutNode(node);
    if (el.classList.contains("node-enter")){
      requestAnimationFrame(function(){
        el.classList.add("entered");
        setTimeout(function(){ el.classList.remove("node-enter"); el.classList.remove("entered"); }, 220);
      });
    }
    return node;
  }

  // Glide the canvas view into a card at reading scale.
function diveToNode(node, source){
    var vw = viewport.clientWidth, vh = viewport.clientHeight;
    var ts = Math.min(1, Math.max(0.75, Math.min((vw - 120) / node.w, (vh - 120) / effH(node))));
    var tx = vw / 2 - (node.x + node.w / 2) * ts;
    var ty = vh / 2 - (node.y + effH(node) / 2) * ts;
    animateView(tx, ty, ts, { source: source, duration: 270, ease: "inOut" });
  }
  function cardButton(markup){
    var template = document.createElement("template");
    template.innerHTML = markup;
    return template.content.firstElementChild;
  }

  // ---------- per-card follow-up composer ----------
  var SEND_ICON = iconSvg("send");
  // The scrollbar only appears once the textarea is actually at its cap —
  // otherwise sub-pixel rounding paints a stray thumb next to the send button.
export function autoGrowEl(ta, max){
    ta.style.height = "auto";
    ta.style.height = Math.min(max, ta.scrollHeight) + "px";
    ta.style.overflowY = ta.scrollHeight > max ? "auto" : "hidden";
  }
  function buildCardComposer(node){
    var comp = document.createElement("div"); comp.className = "node-composer";
    var clip = document.createElement("div"); clip.className = "nc-clip"; clip.id = cardDrawerId(node);
    var inner = document.createElement("div"); inner.className = "nc-inner";
    var ta = document.createElement("textarea"); ta.rows = 1;
    var send = cardButton(iconButtonMarkup({ bare: true, className: "send-btn", ariaLabel: "Send follow-up", title: ENTER_SEND_HINT, svgIconHtml: SEND_ICON }));
    var handle = document.createElement("button"); handle.type = "button"; handle.className = "nc-handle"; handle.title = "Ask a follow-up about this document";
    handle.setAttribute("aria-expanded", "false"); handle.setAttribute("aria-controls", clip.id);
    var plus = document.createElement("span"); plus.className = "nc-plus"; plus.textContent = "+";
    handle.appendChild(plus); handle.appendChild(document.createTextNode(" Follow-up"));
    inner.appendChild(ta); inner.appendChild(send); clip.appendChild(inner);
    comp.appendChild(clip); comp.appendChild(handle);
    node.ncComp = comp; node.ncInner = inner; node.ncText = ta; node.ncSend = send; node.ncHandle = handle;
    handle.addEventListener("click", function(e){ e.stopPropagation(); openCardDrawer(node); });
    ta.addEventListener("input", function(){ autoGrowEl(ta, 90); updateCardComposer(node); });
    ta.addEventListener("keydown", function(e){
      if (isSubmitEnter(e)){ e.preventDefault(); submitCardFollowup(node, "keyboard"); }
      else if (e.key === "Escape"){ e.stopPropagation(); closeCardDrawer(node); handle.focus({ preventScroll: true }); }
    });
    // Click-away with an empty drawer tucks it back in (a draft keeps it out).
    ta.addEventListener("blur", function(){
      if (!ta.value.trim() && !(node.el && node.el.matches(":hover"))) closeCardDrawer(node);
    });
    send.addEventListener("click", function(e){ e.stopPropagation(); submitCardFollowup(node, motionSourceFromEvent(e)); });
    return comp;
  }
  function cardDrawerId(node){
    return "card-followup-" + String(node.id).replace(/[^A-Za-z0-9_-]/g, function(ch){ return "-" + ch.charCodeAt(0).toString(16) + "-"; });
  }
  // preventScroll matters: a plain focus() would yank the overflow-hidden
  // viewport around to reveal the textarea, fighting the canvas transform.
  function openCardDrawer(node){
    // This is a card-embedded disclosure, not a floating surface: its
    // hover/draft lifecycle owns dismissal, so it does not join the layer stack.
    node.ncComp.classList.add("open");
    node.ncHandle.setAttribute("aria-expanded", "true");
    node.ncText.focus({ preventScroll: true });
  }
  function closeCardDrawer(node){
    node.ncComp.classList.remove("open");
    node.ncHandle.setAttribute("aria-expanded", "false");
  }
  // Same honest states as the reader's composer: an away agent doesn't disable
  // asking (questions queue server-side); only a pending doc or a dead session does.
export function updateCardComposer(node){
    if (!node.ncText) return;
    // A draft in progress keeps the drawer out even when the pointer wanders off.
    node.ncComp.classList.toggle("nc-draft", !!node.ncText.value.trim());
    applyComposerState(
      { text: node.ncText, send: node.ncSend, wrap: node.ncInner },
      { phase: sessionPhase(), pending: node.status === "pending" || !!node.extensions?.pdf?.converting },
      { frozen: "Read-only snapshot", closed: "Session ended — saved",
        pending: "Still being written…", away: "Asks are saved for the agent…",
        live: "Ask a follow-up…" }
    );
  }
  function submitCardFollowup(node, source){
    if (closed){ flashHint("Session ended — reopen this Rabbithole from your terminal to continue."); return; }
    if (node.status === "pending" || node.extensions?.pdf?.converting) return;
    var question = node.ncText.value.trim();
    if (!question) return;
    var kid = canvasLifecycle.hooks.sendFollowup(node, question, null);
    node.ncText.value = "";
    autoGrowEl(node.ncText, 90);
    closeCardDrawer(node);
    updateCardComposer(node);
    revealNode(kid, source);
  }
  // Asking from a card spawns the answer card wherever placeChild puts it —
  // possibly off-screen. Pan just enough to bring it into view (user-initiated,
  // so moving the viewport is expected; streaming never does this).
export function revealNode(n, source){
    if (mode !== "canvas" || !n) return;
    var pad = 30, vw = viewport.clientWidth, vh = viewport.clientHeight;
    var x1 = n.x * view.scale + view.x, y1 = n.y * view.scale + view.y;
    var x2 = (n.x + n.w) * view.scale + view.x, y2 = (n.y + effH(n)) * view.scale + view.y;
    var dx = 0, dy = 0;
    if (x2 > vw - pad) dx = vw - pad - x2;
    if (x1 + dx < pad) dx = pad - x1;
    if (y2 > vh - pad) dy = vh - pad - y2;
    if (y1 + dy < pad) dy = pad - y1;
    if (!dx && !dy) return;
    animatePan(view.x + dx, view.y + dy, source, 230, "out");
  }
function animatePan(tx, ty, source, duration, ease){ animateView(tx, ty, view.scale, { source: source, duration: duration, ease: ease }); }
  // One shared view glide (pan + zoom together): frame-all, reveal, and
  // search/activity jumps. A newer glide cancels an in-flight one; hidden windows jump
  // instantly (rAF never fires there).
  var viewAnimId = 0, viewAnimRaf = 0;
  function cancelViewAnimation(){
    viewAnimId++;
    if (viewAnimRaf){ cancelAnimationFrame(viewAnimRaf); viewAnimRaf = 0; }
  }
function animateView(tx, ty, ts, opts){
    opts = opts || {};
    cancelViewAnimation();
    var myId = viewAnimId;
    if (document.hidden || shouldReduceMotion() || opts.source !== "pointer"){
      view.x = tx; view.y = ty; view.scale = ts; applyTransform(); return;
    }
    var sx = view.x, sy = view.y, ss = view.scale, t0 = performance.now(), D = opts.duration || 270;
    var easeFn = opts.ease === "inOut" ? easeInOutMotion : easeOutMotion;
    function step(t){
      viewAnimRaf = 0;
      if (myId !== viewAnimId) return;
      var p = Math.min(1, (t - t0) / D), k = easeFn(p);
      view.x = sx + (tx - sx) * k; view.y = sy + (ty - sy) * k; view.scale = ss + (ts - ss) * k; applyTransform();
      if (p < 1) viewAnimRaf = requestAnimationFrame(step);
    }
    viewAnimRaf = requestAnimationFrame(step);
  }

export function fillBody(node){
    var body = node.bodyEl; if (!body) return;
    var previous = body.querySelector(".doc-content"); if (previous && previous._rhDispose) previous._rhDispose();
    body.classList.remove("pdf-body");
    body.innerHTML = "";
    if (node.origin && node.origin.selected_text){
      var q = document.createElement("div"); q.className = "origin-quote"; q.textContent = "“" + node.origin.selected_text + "”";
      body.appendChild(q);
    } else if (node.origin && (node.origin.question || node.origin.lens)){
      var fq = document.createElement("div"); fq.className = "origin-quote";
      fq.textContent = node.origin.lens ? "Follow-up — " + lensLabel(node.origin.lens) : node.origin.question;
      body.appendChild(fq);
    }
    var crop = buildOriginCrop(node, "card");
    if (crop) body.appendChild(crop);
    var dc = buildDocContent(node, CANVAS_BASE);
    body.appendChild(dc);
    body.classList.toggle("pdf-body", dc.classList.contains("rh-pdf"));
    applyChildHighlights(dc, node);
  }
  function setNodeFontScale(node, delta){
    node.font_scale = Math.min(MAX_FS, Math.max(MIN_FS, (node.font_scale || 1) + delta));
    var dc = node.bodyEl && node.bodyEl.querySelector(".doc-content"); if (dc) dc.style.fontSize = fontPx(node, CANVAS_BASE) + "px";
    if (mode === "reader" && currentNodeId === node.id){ var rdc = readerMain.querySelector(".doc-content"); if (rdc) rdc.style.fontSize = fontPx(node, READER_BASE) + "px"; }
    scheduleEdges();
    canvasLifecycle.hooks.persistNode(node);
  }

function layoutNode(node){
    var el = node.el; el.style.left = node.x + "px"; el.style.top = node.y + "px"; el.style.width = node.w + "px";
    if (!node.collapsed){
      // Branch cards use their saved/default height as a ceiling, not a floor.
      // Short answers therefore hug their content while longer answers retain
      // the existing scrollable viewport. Keep the root's established fixed
      // document window; it is the canvas anchor rather than a branch.
      if (node.id === rootId || canvasNodeKind(node)){
        el.style.height = node.h + "px";
        el.style.maxHeight = "";
      } else {
        el.style.height = "auto";
        el.style.maxHeight = node.h + "px";
      }
    }
  }

  // Shared pointer-gesture wiring: cleans up on pointerup AND pointercancel/
  // lostpointercapture, so an interrupted gesture (touch cancel, window blur)
  // never leaves move listeners or drag state stuck.
  function onPointerGesture(handle, onDown, onMove, onUp, scope){
    function pointerDown(e){
      if (!onDown(e)) return;
      try { handle.setPointerCapture(e.pointerId); } catch(_e){}
      function move(ev){ if (ev.pointerId === e.pointerId) onMove(ev); }
      function finish(commit){
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", done);
        handle.removeEventListener("pointercancel", done);
        handle.removeEventListener("lostpointercapture", done);
        activePointerGestures.delete(cancel);
        try { handle.releasePointerCapture(e.pointerId); } catch(_e){}
        if (commit) onUp();
      }
      function done(ev){ if (ev.pointerId === e.pointerId) finish(true); }
      function cancel(){ finish(false); }
      activePointerGestures.add(cancel);
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", done);
      handle.addEventListener("pointercancel", done);
      handle.addEventListener("lostpointercapture", done);
    }
    if (scope) scope.listen(handle, "pointerdown", pointerDown);
    else handle.addEventListener("pointerdown", pointerDown);
  }
  // The head carries the card's own gestures — drag it, double-click to open — but it also
  // holds the controls, and a pointer that lands on one of those is operating the control,
  // not the card. Every head gesture owes that distinction the same answer.
  function onCardControl(e){ return !!e.target.closest(".node-btn"); }
  function enableDrag(node, handle){
    var sx, sy, ox, oy;
    onPointerGesture(handle,
      function(e){ if (e.button !== 0 || onCardControl(e)) return false; e.preventDefault(); canvasLifecycle.hooks.hideAsk(); sx=e.clientX; sy=e.clientY; ox=node.x; oy=node.y; return true; },
      function(ev){ node.x = ox + (ev.clientX - sx) / view.scale; node.y = oy + (ev.clientY - sy) / view.scale; layoutNode(node); scheduleEdges(); },
      function(){ drawEdges(); canvasLifecycle.hooks.persistNode(node); });
  }
  function enableResize(node, handle){
    var sx, sy, ow, oh;
    onPointerGesture(handle,
      function(e){ if (e.button !== 0) return false; e.preventDefault(); e.stopPropagation(); sx=e.clientX; sy=e.clientY; ow=node.w; oh=node.h; return true; },
      function(ev){ node.w = Math.max(240, ow + (ev.clientX - sx)/view.scale); node.h = Math.max(160, oh + (ev.clientY - sy)/view.scale); layoutNode(node); scheduleEdges(); },
      function(){ drawEdges(); canvasLifecycle.hooks.persistNode(node); });
  }
function toggleCollapse(node, btn){
    node.collapsed = !node.collapsed;
    node.el.classList.toggle("collapsed", node.collapsed);
    syncCollapseButton(node, btn);
    if (!node.collapsed) layoutNode(node);
    renderVisibility(); drawEdges(); canvasLifecycle.hooks.persistNode(node);
  }
export function renderVisibility(){
    var cache = Object.create(null);
    for (var id in nodes){ var n = nodes[id]; if (!n.el) continue; if (n.id === rootId){ n.el.style.display = ""; cache[n.id] = true; continue; } n.el.style.display = isVisible(n, cache) ? "" : "none"; }
  }
var edgeRaf = 0;           // coalesces edge redraws during drag/resize/scroll
export function scheduleEdges(){
    if (edgeRaf) return;
    edgeRaf = requestAnimationFrame(function(){ edgeRaf = 0; drawEdges(); });
  }

  // Effective on-canvas height follows the rendered card: collapsed cards are
  // head-only and short branches may be smaller than their saved height cap.
export function effH(n){ return n.el ? (n.el.offsetHeight || (n.collapsed ? 36 : n.h)) : n.h; }
function clamp(lo, hi, v){ return Math.max(lo, Math.min(hi, v)); }

  // Which side the edge leaves the parent from and enters the child on — chosen
  // by where the child actually sits, so a card dragged left of (or above) its
  // parent gets a sensibly routed arrow instead of one that always exits right.
  function edgeSides(p, n){
    var ph = effH(p), nh = effH(n);
    var dx = (n.x + n.w / 2) - (p.x + p.w / 2);
    var dy = (n.y + nh / 2) - (p.y + ph / 2);
    var fx = dx / ((p.w + n.w) / 2 + 1);
    var fy = dy / ((ph + nh) / 2 + 1);
    if (Math.abs(fx) >= Math.abs(fy)) return dx >= 0 ? ["right", "left"] : ["left", "right"];
    return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
  }

  // Where an edge leaves its parent: at the inline mark of the exact text the
  // branch was asked from (clamped to the card's visible body while scrolled) —
  // the mark's y for side exits, its x for top/bottom exits — at the composer
  // for follow-ups, or at the side's midpoint as a fallback.
  function edgeStart(p, child, side){
    var ph = effH(p), ax = null, ay = null, anchored = false;
    if (!p.collapsed && p.el && p.bodyEl){
      var mark = p.bodyEl.querySelector('mark[data-child="' + child.id + '"]');
      if (mark){
        var mr = mark.getBoundingClientRect();
        if (mr.height > 0){
          var er = p.el.getBoundingClientRect();
          var br = p.bodyEl.getBoundingClientRect();
          ay = p.y + clamp((br.top - er.top) / view.scale + 10, (br.bottom - er.top) / view.scale - 10,
                           (mr.top + mr.height / 2 - er.top) / view.scale);
          ax = p.x + clamp((br.left - er.left) / view.scale + 10, (br.right - er.left) / view.scale - 10,
                           (mr.left + mr.width / 2 - er.left) / view.scale);
          anchored = true;
        }
      } else if (isFollowup(child)){
        ay = p.y + ph - 22;
      }
    }
    if (side === "right")  return { x: p.x + p.w, y: ay != null ? ay : p.y + ph / 2, anchored: anchored };
    if (side === "left")   return { x: p.x,       y: ay != null ? ay : p.y + ph / 2, anchored: anchored };
    if (side === "bottom") return { x: ax != null ? ax : p.x + p.w / 2, y: p.y + ph, anchored: anchored };
    return { x: ax != null ? ax : p.x + p.w / 2, y: p.y, anchored: anchored };
  }
  function edgeEnd(n, side){
    var nh = effH(n);
    if (side === "left")  return { x: n.x,           y: n.y + nh / 2 };
    if (side === "right") return { x: n.x + n.w,     y: n.y + nh / 2 };
    if (side === "top")   return { x: n.x + n.w / 2, y: n.y };
    return { x: n.x + n.w / 2, y: n.y + nh };
  }
  function ctrlPt(pt, side, d){
    if (side === "right")  return (pt.x + d) + " " + pt.y;
    if (side === "left")   return (pt.x - d) + " " + pt.y;
    if (side === "bottom") return pt.x + " " + (pt.y + d);
    return pt.x + " " + (pt.y - d);
  }

  var edgeEls = {};
  var edgeGeometry = {};
  function ensureEdgeEls(childId){
    var els = edgeEls[childId];
    if (els) return els;
    var path = document.createElementNS(SVGNS, "path");
    path.setAttribute("data-child", childId);
    var dot = document.createElementNS(SVGNS, "circle");
    dot.setAttribute("r", "3");
    dot.setAttribute("data-child", childId);
    edgesSvg.appendChild(path);
    edgesSvg.appendChild(dot);
    edgeEls[childId] = [path, dot];
    return edgeEls[childId];
  }
  function removeEdge(childId){
    var els = edgeEls[childId];
    if (els){
      for (var i = 0; i < els.length; i++) if (els[i].parentNode) els[i].parentNode.removeChild(els[i]);
    }
    delete edgeEls[childId];
    delete edgeGeometry[childId];
    delete edgeHl[childId];
  }
  function applyEdgeClasses(childId, path, dot, anchored){
    path.classList.toggle("edge-hl", !!edgeHl[childId]);
    dot.classList.toggle("edge-hl", !!edgeHl[childId]);
    dot.classList.toggle("anchored", !!anchored);
  }
function rebuildEdges(){
    while (edgesSvg.firstChild) edgesSvg.removeChild(edgesSvg.firstChild);
    edgeEls = {};
    edgeGeometry = {};
    drawEdges();
  }
export function drawEdges(){
    var live = {};
    var visCache = Object.create(null);
    function vis(node){ return isVisible(node, visCache); }
    for (var id in nodes){
      var n = nodes[id]; if (!n.parent_id || !n.el) continue; var p = nodes[n.parent_id]; if (!p || !p.el) continue;
      if (!vis(n) || !vis(p)) continue;
      live[n.id] = true;
      var sides = edgeSides(p, n);
      var start = edgeStart(p, n, sides[0]);
      var end = edgeEnd(n, sides[1]);
      var horiz = sides[0] === "left" || sides[0] === "right";
      var reach = Math.max(40, (horiz ? Math.abs(end.x - start.x) : Math.abs(end.y - start.y)) / 2);
      var d = "M " + start.x + " " + start.y + " C " + ctrlPt(start, sides[0], reach) + " " + ctrlPt(end, sides[1], reach) + " " + end.x + " " + end.y;
      var geom = {
        d: d,
        cx: String(start.x),
        cy: String(start.y),
        anchored: !!start.anchored
      };
      var els = ensureEdgeEls(n.id);
      var path = els[0], dot = els[1], prev = edgeGeometry[n.id];
      if (!prev || prev.d !== geom.d) path.setAttribute("d", geom.d);
      if (!prev || prev.cx !== geom.cx) dot.setAttribute("cx", geom.cx);
      if (!prev || prev.cy !== geom.cy) dot.setAttribute("cy", geom.cy);
      if (!prev || prev.anchored !== geom.anchored) applyEdgeClasses(n.id, path, dot, geom.anchored);
      else if (!!edgeHl[n.id] !== path.classList.contains("edge-hl")) applyEdgeClasses(n.id, path, dot, geom.anchored);
      edgeGeometry[n.id] = geom;
    }
    for (var childId in edgeEls){
      if (!live[childId]) removeEdge(childId);
    }
  }
  // Highlight state lives here, not just on the elements — edges can be removed
  // and recreated when visibility changes, so hover state needs a stable source.
  var edgeHl = {};
function setEdgeHighlight(childId, on){
    if (on) edgeHl[childId] = true; else delete edgeHl[childId];
    var els = edgeEls[childId];
    if (!els) return;
    for (var i = 0; i < els.length; i++) els[i].classList.toggle("edge-hl", on);
  }
export function clearEdgeHighlight(childId){
    delete edgeHl[childId];
  }
function focusOrigin(node, on){
    if (mode !== "canvas") return;
    setEdgeHighlight(node.id, on);
    var p = node.parent_id ? nodes[node.parent_id] : null;
    if (p && p.bodyEl){
      var marks = p.bodyEl.querySelectorAll('[data-child="' + node.id + '"]');
      for (var i = 0; i < marks.length; i++) marks[i].classList.toggle("mark-focus", on);
    }
  }
  // Hovering the highlighted text lights up the edge to the branch it spawned.
  function onWorldMouseOver(e){
    transitionMarkGroups(e, true, "mark-hover", setEdgeHighlight);
  }
  function onWorldMouseOut(e){
    transitionMarkGroups(e, false, "mark-hover", setEdgeHighlight);
  }

  function initViewportPan(){
    var sx, sy, ox, oy;
    onPointerGesture(viewport,
      function(e){ if (e.pointerType === "touch" || e.button !== 0 || e.target.closest(".node")) return false; canvasLifecycle.hooks.hideAsk(); cancelViewAnimation(); viewport.classList.add("panning"); sx=e.clientX; sy=e.clientY; ox=view.x; oy=view.y; return true; },
      function(ev){ setViewAdjusted(true); view.x = ox + (ev.clientX - sx); view.y = oy + (ev.clientY - sy); applyTransform(); },
      function(){ viewport.classList.remove("panning"); }, canvasLifecycle.scope);
    initTouchViewportGestures();
  }

  // Touch has an explicit ownership contract:
  // - one finger that starts in a card belongs to the card's native scroller;
  // - one finger that starts on empty canvas pans the world 1:1;
  // - two fingers anywhere own the camera and pinch around their midpoint.
  // Keeping this in one state machine prevents a card drag, browser scroll, and
  // canvas pan from each reacting to a different pointer in the same gesture.
  function initTouchViewportGestures(){
    var touches = new Map();
    var gesture = null;
    var suppressClickUntil = 0;
    var PAN_SLOP = 3;

    function touchPoint(event){
      return { id: event.pointerId, x: event.clientX, y: event.clientY };
    }
    function capture(pointerId){
      try { viewport.setPointerCapture(pointerId); } catch(_e){}
    }
    function release(pointerId){
      try { viewport.releasePointerCapture(pointerId); } catch(_e){}
    }
    function resetTouchGesture(){
      touches.forEach(function(_point, pointerId){ release(pointerId); });
      touches.clear();
      gesture = null;
      viewport.classList.remove("panning", "pinching");
    }
    function beginPan(point, active){
      gesture = { kind: "pan", pointerId: point.id, sx: point.x, sy: point.y,
        ox: view.x, oy: view.y, active: !!active };
      if (active) viewport.classList.add("panning");
    }
    function beginPinch(){
      var pair = Array.from(touches.values()).slice(0, 2);
      if (pair.length < 2) return;
      // A pinch wins over a card-head drag or resize that began with the first
      // finger. Their owned listeners are cancelled before the camera moves.
      activePointerGestures.forEach(function(cancel){ cancel(); });
      canvasLifecycle.hooks.hideAsk();
      cancelViewAnimation();
      capture(pair[0].id); capture(pair[1].id);
      var midX = (pair[0].x + pair[1].x) / 2;
      var midY = (pair[0].y + pair[1].y) / 2;
      var dx = pair[1].x - pair[0].x, dy = pair[1].y - pair[0].y;
      gesture = { kind: "pinch", ids: [pair[0].id, pair[1].id],
        distance: Math.max(1, Math.hypot(dx, dy)), scale: view.scale,
        anchor: screenToWorld(midX, midY) };
      suppressClickUntil = Date.now() + 450;
      viewport.classList.remove("panning");
      viewport.classList.add("pinching");
    }
    function onTouchDown(event){
      if (event.pointerType !== "touch") return;
      // A gesture that begins in a native PDF belongs to that PDF's local
      // zoom/scroll state. The canvas must never join it when finger two lands.
      if (event.target.closest && event.target.closest(".rh-pdf-scroll")) return;
      if (touches.size >= 2){ event.preventDefault(); event.stopPropagation(); return; }
      var point = touchPoint(event);
      touches.set(event.pointerId, point);
      if (touches.size === 2){
        beginPinch();
        event.preventDefault(); event.stopPropagation();
        return;
      }
      if (!(event.target.closest && event.target.closest(".node"))){
        canvasLifecycle.hooks.hideAsk();
        cancelViewAnimation();
        capture(event.pointerId);
        beginPan(point, false);
        event.preventDefault(); event.stopPropagation();
      } else {
        // Do not prevent this pointer: the card body keeps native one-finger
        // scrolling, momentum, text selection, and nested horizontal scrolling.
        gesture = { kind: "content", pointerId: event.pointerId };
      }
    }
    function onTouchMove(event){
      if (event.pointerType !== "touch" || !touches.has(event.pointerId)) return;
      var point = touchPoint(event);
      touches.set(event.pointerId, point);
      if (!gesture) return;
      if (gesture.kind === "pinch"){
        var a = touches.get(gesture.ids[0]), b = touches.get(gesture.ids[1]);
        if (!a || !b) return;
        var dx = b.x - a.x, dy = b.y - a.y;
        var next = Math.min(MAX_SCALE, Math.max(MIN_SCALE,
          gesture.scale * Math.hypot(dx, dy) / gesture.distance));
        var midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
        setViewAdjusted(true);
        view.scale = next;
        view.x = midX - gesture.anchor.x * next;
        view.y = midY - gesture.anchor.y * next;
        applyTransform();
        event.preventDefault(); event.stopPropagation();
        return;
      }
      if (gesture.kind === "pan" && gesture.pointerId === event.pointerId){
        var panX = point.x - gesture.sx, panY = point.y - gesture.sy;
        if (!gesture.active && Math.hypot(panX, panY) < PAN_SLOP) return;
        if (!gesture.active){
          gesture.active = true;
          viewport.classList.add("panning");
          suppressClickUntil = Date.now() + 350;
        }
        setViewAdjusted(true);
        view.x = gesture.ox + panX;
        view.y = gesture.oy + panY;
        applyTransform();
        event.preventDefault(); event.stopPropagation();
      }
    }
    function onTouchEnd(event){
      if (event.pointerType !== "touch" || !touches.has(event.pointerId)) return;
      release(event.pointerId);
      touches.delete(event.pointerId);
      if (gesture && gesture.kind === "pinch" && touches.size === 1){
        // Lifting one finger after a pinch should flow directly into a one-finger
        // camera pan instead of dropping the gesture or jumping the world.
        var remaining = Array.from(touches.values())[0];
        viewport.classList.remove("pinching");
        capture(remaining.id);
        beginPan(remaining, true);
        event.preventDefault(); event.stopPropagation();
        return;
      }
      if (!touches.size || (gesture && gesture.pointerId === event.pointerId)) resetTouchGesture();
    }
    function onTouchCancel(event){
      if (event.pointerType !== "touch") return;
      release(event.pointerId);
      touches.delete(event.pointerId);
      resetTouchGesture();
    }
    function suppressGestureClick(event){
      if (Date.now() >= suppressClickUntil) return;
      event.preventDefault(); event.stopPropagation();
    }

    var scope = canvasLifecycle.scope;
    scope.listen(viewport, "pointerdown", onTouchDown, { capture: true, passive: false });
    scope.listen(viewport, "pointermove", onTouchMove, { capture: true, passive: false });
    scope.listen(viewport, "pointerup", onTouchEnd, { capture: true, passive: false });
    scope.listen(viewport, "pointercancel", onTouchCancel, { capture: true, passive: false });
    scope.listen(viewport, "click", suppressGestureClick, true);
    scope.addCleanup(resetTouchGesture);
  }

  // Can this element still scroll in the direction of the wheel delta?
  function canScroll(el, dx, dy){
    if (dx && el.scrollWidth > el.clientWidth + 1){
      if (dx < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true;
    }
    if (dy && el.scrollHeight > el.clientHeight + 1){
      if (dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
    }
    return false;
  }
  // A trackpad swipe is one gesture and keeps the target it STARTED on: a pan
  // begun on the background stays a pan while the cursor crosses cards, and a
  // scroll begun inside a card keeps scrolling that card — never the canvas —
  // even if the cursor drifts off it. A pause in wheel events ends the gesture.
  var wheelKind = null, wheelCard = null, wheelTs = 0;
  function onViewportWheel(e){
    if (e.ctrlKey){ e.preventDefault(); wheelKind = null; zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01)); return; }
    if (!wheelKind || e.timeStamp - wheelTs > 180){
      wheelCard = (e.target.closest && e.target.closest(".node")) || null;
      wheelKind = wheelCard ? "card" : "pan";
    }
    wheelTs = e.timeStamp;
    if (wheelKind === "pan"){
      e.preventDefault(); cancelViewAnimation(); setViewAdjusted(true); view.x -= e.deltaX; view.y -= e.deltaY; applyTransform();
      return;
    }
    var over = (e.target.closest && e.target.closest(".node")) || null;
    if (over !== wheelCard){
      // Drifted off the origin card mid-scroll: keep moving ITS content by hand.
      e.preventDefault();
      var nb = wheelCard ? wheelCard.querySelector(".node-body") : null;
      if (nb){ nb.scrollLeft += e.deltaX; nb.scrollTop += e.deltaY; }
      return;
    }
    // Still over the origin card: allow the browser to scroll the innermost thing
    // that can still move (body, a code block, a wide table); if nothing can,
    // swallow the event so the canvas doesn't lurch mid-read.
    var el = e.target, consumable = false;
    while (el && el.nodeType === 1){
      if (canScroll(el, e.deltaX, e.deltaY)){ consumable = true; break; }
      if (el === over) break;
      el = el.parentNode;
    }
    if (!consumable) e.preventDefault();
  }

export function frameAll(animate, source){
    var visCache = Object.create(null);
    var ids = Object.keys(nodes).filter(function(id){ return isVisible(nodes[id], visCache); });
    if (!ids.length) return;
    var minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    ids.forEach(function(id){ var n=nodes[id]; minX=Math.min(minX,n.x); minY=Math.min(minY,n.y); maxX=Math.max(maxX,n.x+n.w); maxY=Math.max(maxY,n.y+effH(n)); });
    var fullW=viewport.clientWidth||window.innerWidth, fullH=viewport.clientHeight||window.innerHeight, pad=100;
    var rail=document.getElementById("web-rail"), taskbar=document.getElementById("taskbar");
    var insetX=(rail && rail.classList.contains("open")) ? rail.getBoundingClientRect().width : 0;
    var insetY=taskbar ? taskbar.getBoundingClientRect().height : 0;
    var vw=fullW-insetX, vh=fullH-insetY;
    var ts = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.min((vw-pad)/(maxX-minX), (vh-pad)/(maxY-minY), 1.2)));
    var tx = insetX+vw/2 - (minX+(maxX-minX)/2)*ts, ty = insetY+vh/2 - (minY+(maxY-minY)/2)*ts;
    if (source) setViewAdjusted(true);
    if (animate){ animateView(tx, ty, ts, { source: source, duration: 270, ease: "inOut" }); return; }
    view.scale = ts; view.x = tx; view.y = ty; applyTransform();
  }
  // Double-clicking empty canvas opens the insertion tools. Read-only canvases
  // retain the historical frame-all gesture because they cannot add content.
  function onViewportDblClick(e){
    if (e.target.closest && e.target.closest(".node")) return;
    if (closed){ frameAll(true, motionSourceFromEvent(e)); return; }
    e.preventDefault();
    openCanvasInsertToolbar(e);
  }

export function tidy(source){
    var visited={};
    function moveSubtree(node, dx, dy){
      node.x += dx; node.y += dy;
      childrenOf(node.id).filter(function(k){ return visited[k.id]; }).sort(nodeOrder).forEach(function(k){ moveSubtree(k, dx, dy); });
    }
    function place(node, x, y){
      visited[node.id] = true;
      node.x = x; node.y = y;
      var bounds = nodeBounds(node, { effH: effH });
      if (node.collapsed) return bounds;

      var kids = childrenOf(node.id).sort(nodeOrder);
      var selectionKids = kids.filter(isSelectionBranch);
      var followupKids = kids.filter(isFollowup);
      var sideBounds = null;
      var sideX = node.x + node.w + TREE_PARENT_GAP;
      var sideY = node.y;
      selectionKids.forEach(function(k){
        var kb = place(k, sideX, sideY);
        sideBounds = unionBounds(sideBounds, kb);
        bounds = unionBounds(bounds, kb);
        sideY = kb.maxY + TREE_STACK_GAP;
      });

      var belowY = node.y + effH(node) + TREE_PARENT_GAP;
      followupKids.forEach(function(k){
        var kb = place(k, node.x, belowY);
        if (boundsOverlap(kb, sideBounds)){
          var dy = sideBounds.maxY + TREE_STACK_GAP - kb.minY;
          moveSubtree(k, 0, dy);
          kb = shiftBounds(kb, 0, dy);
        }
        bounds = unionBounds(bounds, kb);
        belowY = kb.maxY + TREE_STACK_GAP;
      });
      return bounds;
    }
    var root = nodes[rootId]; if (!root) return; place(root, 0, 0);
    // Only nodes actually visited (the visible tree) are laid out — hidden
    // descendants of a collapsed node keep their positions instead of being
    // yanked around by a stale traversal.
    var ids = Object.keys(visited);
    var moved = [];
    ids.forEach(function(id){ var nn=nodes[id]; layoutNode(nn); moved.push(nn); });
    canvasLifecycle.hooks.persistNodesBulk(moved);
    rebuildEdges(); frameAll(true, source);
  }

  // Canvas cards (DOM + rendered markdown for every node) are only built the first
  // time the user actually opens the canvas — Reader is the default, so a large
  // hole pays no canvas cost until/unless it's wanted.
function ensureCanvasBuilt(){
    if (canvasBuilt) return;
    setCanvasBuilt(true);
    Object.keys(nodes).forEach(function(id){ if (!nodes[id].el) createNodeEl(nodes[id]); });
    renderVisibility();
    applyTransform();
  }
export function setMode(m){
    closeCanvasInsertToolbar();
    closeCanvasDraft();
    var transferredPosition = null;
    if (m === "canvas" && mode === "reader"){
      // display:none resets the reader's scrollTop — remember it first so
      // toggling out to the canvas and back lands exactly where you were.
      var cur = nodes[currentNodeId];
      if (cur) {
        cur._scrollTop = readerMain.scrollTop;
        transferredPosition = captureContentPosition(readerMain);
      }
    }
    setModeValue(m);
    if (m === "canvas"){
      ensureCanvasBuilt();
      document.body.classList.add("mode-canvas");
      requestAnimationFrame(function(){
        var active = nodes[currentNodeId];
        if (transferredPosition && active?.bodyEl) restoreContentPosition(active.bodyEl, transferredPosition);
        rebuildEdges();
        // Frame everything only the first time; afterwards the canvas keeps the
        // pan/zoom you left it at.
        if (!canvasFramed){ setCanvasFramed(true); frameAll(); }
      });
      canvasLifecycle.hooks.scheduleViewSave();
    }
    else { openNode(currentNodeId); }
  }
