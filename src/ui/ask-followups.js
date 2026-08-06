import {
  ask,
  askGo,
  askText,
  canvasBuilt,
  childrenOf,
  closed,
  currentNodeId,
  flashHint,
  frozen,
  mode,
  motionSourceFromEvent,
  nextOrder,
  nodes,
  readerMain,
  registerNode,
  shouldReduceMotion,
  uuid
} from "./core.js";
import {
  DEFAULT_CHILD,
  nodeOrder,
  placeChild as sharedPlaceChild,
  subtreeBounds as sharedSubtreeBounds
} from "../core/layout.js";
import {
  BRANCH_FOLLOWUP,
  BRANCH_SELECTION,
  LENSES,
  lensLabel,
  truncate
} from "../core/model.js";
import {
  autoGrowEl,
  createNodeEl,
  drawEdges,
  effH,
  revealNode,
  renderVisibility,
  scheduleEdges
} from "./canvas-view.js";
import { renderMarginNotes } from "./reader.js";
import { charOffset, mountPdfRectMark, wrapInContainer } from "./text-marks.js";
import { easeOutMotion } from "./easing.js";
import { openAnchoredSurface } from "./overlay/anchor.js";
import { cancelFrame, createModuleLifecycle, nextFrame } from "./lifecycle.js";
import { teardownNode } from "./node-teardown.js";
import { ENTER_SEND_HINT, isComposingText, isSubmitEnter } from "./input-intent.js";
import { canReviseWithAi } from "./ai-revision.js";
import { regionRenderedRange, resolveSelectionRegion } from "./selection-region.js";
import {
  branchesInsideRegion,
  cancelSelectionRevision,
  isSelectionRevisionActive,
  startSelectionRevision
} from "./revise-selection.js";

function defaultAskHooks(){
  return {
    post: function(){ return Promise.resolve({ ok: true }); },
  };
}

var askLifecycle = createModuleLifecycle({ defaults: defaultAskHooks });

export function registerAskHooks(hooks) {
  askLifecycle.register(hooks);
}

  // ===========================================================================
  // ASK (shared by both views)
  // ===========================================================================
export function initAskFollowups(){
  disposeAskFollowupResources(false);
  var askScope = askLifecycle.beginInit();
  askGo.title = ENTER_SEND_HINT;
  askScope.listen(document, "mouseup", function(e){
    if (inAsk(e)) return;
    if (usesMobileAskSurface()) queueMobileAsk(80);
    else askScope.timeout(maybeShowAsk, 0);
  });
  askScope.listen(document, "selectionchange", function(){
    if (usesMobileAskSurface()) queueMobileAsk(140);
  });
  askScope.listen(document, "touchend", function(e){
    if (!inAsk(e) && usesMobileAskSurface()) queueMobileAsk(80);
  }, { passive: true });
  askScope.listen(askGo, "click", function(e){ submitAsk(null, motionSourceFromEvent(e)); });
  askScope.listen(document.getElementById("ask-lenses"), "click", function(e){
    var b = e.target.closest ? e.target.closest(".lens") : null;
    if (b) submitAsk(b.getAttribute("data-lens"), motionSourceFromEvent(e));
  });
  askScope.listen(document.getElementById("ask-modes"), "click", function(e){
    var tab = e.target.closest ? e.target.closest(".ask-mode") : null;
    if (tab) setAskMode(tab.getAttribute("data-mode"));
  });
  askScope.listen(document.getElementById("ask-modes"), "keydown", function(e){
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    setAskMode(askMode === "ask" ? "revise" : "ask");
  });
  askScope.listen(document.getElementById("ask-revise-chips"), "click", function(e){
    var chip = e.target.closest ? e.target.closest(".ask-chip") : null;
    if (!chip) return;
    askText.value = chip.getAttribute("data-instruction") || "";
    askText.focus();
    submitRevise();
  });
  askScope.listen(askText, "input", function(){ autoGrowEl(askText, 110); });
  askScope.listen(askText, "keydown", onAskTextKeydown);
  askScope.listen(ask, "transitionend", function(e){ if (e.target === ask && askPosition) askPosition.update(); });
  askScope.listen(readerMain, "wheel", interruptScrollAnimation, { passive: true });
  askScope.listen(readerMain, "touchstart", interruptScrollAnimation, { passive: true });
  askScope.listen(readerMain, "pointerdown", interruptScrollAnimation, { passive: true });
  askScope.listen(readerMain, "scroll", function(){ if (performance.now() > scrollAnimIgnoreUntil) cancelScrollAnimation(); }, { passive: true });
  askScope.listen(document, "keydown", interruptScrollAnimation);
  return disposeAskFollowups;
}

function inAsk(e){ return e.target && e.target.closest && e.target.closest("#ask"); }

  var askPosition = null, askTabOwner = null, askOwnerCleanup = null;
  var mobileSelectionTimer = 0, ignoreMobileSelectionUntil = 0;

  function usesMobileAskSurface(){
    return !!(window.matchMedia && (window.matchMedia("(pointer: coarse)").matches || window.matchMedia("(max-width: 760px)").matches));
  }
  function queueMobileAsk(delay){
    if (Date.now() < ignoreMobileSelectionUntil || !askLifecycle.scope) return;
    if (mobileSelectionTimer) clearTimeout(mobileSelectionTimer);
    mobileSelectionTimer = askLifecycle.scope.timeout(function(){ mobileSelectionTimer = 0; maybeShowAsk(); }, delay);
  }

  function selectionOwner(dc){
    return (dc && dc.closest && dc.closest(".node")) || readerMain;
  }
  function onAskOwnerKeydown(e){
    if (e.key !== "Tab" || e.shiftKey || !ask.classList.contains("visible")) return;
    var active = document.activeElement;
    if (active !== document.body && active !== askTabOwner && !askTabOwner.contains(active)) return;
    e.preventDefault(); askText.focus();
  }
  function focusAskOwner(owner){
    if (!owner || !owner.isConnected) return;
    if (!owner.hasAttribute("tabindex")) owner.setAttribute("tabindex", "-1");
    try { owner.focus({ preventScroll: true }); } catch(e){ owner.focus(); }
  }

  function maybeShowAsk(){
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
    var anchor = sel.anchorNode && sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentNode : sel.anchorNode;
    var dc = anchor && anchor.closest ? anchor.closest(".doc-content") : null;
    if (!dc) return;
    if (dc.classList.contains("rh-pdf")) return;
    var parentId = dc.dataset.nodeId;
    if (!parentId || !nodes[parentId] || nodes[parentId].status === "pending") return;
    // Asks stay open while the agent is merely away (they queue server-side and
    // are answered when it returns) — only a fully closed session can't take them.
    if (closed){
      flashHint(frozen ? "This is a read-only snapshot — asking needs the live Rabbithole."
        : "Session ended — reopen this Rabbithole from your terminal to keep asking.");
      return;
    }
    var range = sel.getRangeAt(0);
    // Both endpoints must live inside this same document — a selection dragged
    // out into the sidebar/another card would otherwise yield offsets past the
    // doc's text (no inline mark, a bad persisted anchor).
    if (!dc.contains(range.startContainer) || !dc.contains(range.endContainer)) return;
    var startOff = charOffset(dc, range.startContainer, range.startOffset);
    var endOff = charOffset(dc, range.endContainer, range.endOffset);
    if (endOff <= startOff) return;
    if (ask.classList.contains("visible")) hideAsk();
    pendingAsk = { parentId: parentId, container: dc, selectedText: sel.toString().trim(),
                   startOff: startOff, endOff: endOff, range: range.cloneRange() };
    prepareRevise(dc, nodes[parentId], range);
    paintAskHighlight(pendingAsk.range);
    askText.value = "";
    askText.placeholder = "Ask about this…";
    ask.classList.add("visible");
    var owner = selectionOwner(dc);
    var virtualAnchor = { getBoundingClientRect: function(){ return pendingAsk.range.getBoundingClientRect(); }, contextElement: dc };
    askTabOwner = owner;
    askOwnerCleanup = askLifecycle.scope
      ? askLifecycle.scope.listen(document, "keydown", onAskOwnerKeydown)
      : function(){ document.removeEventListener("keydown", onAskOwnerKeydown); };
    // The box takes focus on open so the question can be typed immediately —
    // focusing collapses the native selection, so the cloned Range plus the
    // painted highlight carry it, and Escape puts the selection back.
    openAskSurface(virtualAnchor, owner);
  }
  var pendingAsk = null;
export function showAskFromSelection(options){
    var parentId = options && options.parentId;
    var parent = parentId && nodes[parentId];
    if (!parent || parent.status === "pending" || parent.extensions?.pdf?.converting) return false;
    if (closed){
      flashHint(frozen ? "This is a read-only snapshot — asking needs the live Rabbithole."
        : "Session ended — reopen this Rabbithole from your terminal to keep asking.");
      return false;
    }
    var anchorEl = options.anchorRectEl;
    // Virtual anchors (a selection range) carry their element as contextElement.
    var anchorNode = anchorEl && anchorEl.closest ? anchorEl : anchorEl && anchorEl.contextElement ? anchorEl.contextElement : null;
    pendingAsk = { parentId: parentId, container: anchorNode && anchorNode.closest ? anchorNode.closest(".doc-content") : null,
      selectedText: String(options.selectedText || "").trim(), startOff: options.mdStart,
      endOff: options.mdEnd, pdfAnchor: options.pdfAnchor || null, range: options.range || null };
    prepareRevise(pendingAsk.container, parent, pendingAsk.range);
    if (pendingAsk.range) paintAskHighlight(pendingAsk.range);
    askText.value = "";
    askText.placeholder = "Ask about this…";
    ask.classList.add("visible");
    var owner = selectionOwner(pendingAsk.container);
    askTabOwner = owner;
    askOwnerCleanup = askLifecycle.scope
      ? askLifecycle.scope.listen(document, "keydown", onAskOwnerKeydown)
      : function(){ document.removeEventListener("keydown", onAskOwnerKeydown); };
    openAskSurface(anchorEl, owner);
    return true;
  }
  function openAskSurface(anchor, owner){
    var mobile = usesMobileAskSurface();
    ask.classList.toggle("mobile-sheet", mobile);
    askText.placeholder = "Ask about this…";
    var surfaceAnchor = mobile ? mobileViewportAnchor(owner) : anchor;
    askPosition = openAnchoredSurface({ surface: ask, anchor: surfaceAnchor,
      placement: mobile ? "top-center" : "bottom-start", restoreFocus: false, preventOutsidePointerDefault: false,
      ignoreOutsidePointer: function(event){ return !!(event.target?.closest?.(".rh-pdf-zoom-control")); },
      onClose: function(reason){
        var escapeOwner = reason === "escape" ? owner : null;
        var keepRange = reason === "escape" && pendingAsk ? pendingAsk.range : null;
        hideAsk();
        if (escapeOwner) focusAskOwner(escapeOwner);
        restoreSelectionRange(keepRange);
      } });
    autoGrowEl(askText, 110); // Must run after the surface leaves display:none.
    if (!mobile) askText.focus({ preventScroll: true });
  }
  function mobileViewportAnchor(owner){
    return { contextElement: owner, getBoundingClientRect: function(){
      var viewport = window.visualViewport;
      var left = viewport ? viewport.offsetLeft : 0;
      var top = viewport ? viewport.offsetTop : 0;
      var width = viewport ? viewport.width : window.innerWidth;
      var height = viewport ? viewport.height : window.innerHeight;
      var bottom = top + height;
      return { left: left, right: left + width, top: bottom, bottom: bottom,
        width: width, height: 0, x: left, y: bottom };
    } };
  }
  function restoreSelectionRange(range){
    if (!range) return;
    ignoreMobileSelectionUntil = Date.now() + 300;
    try { var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range); } catch(e){}
  }
export function hideAsk(){
    if (askPosition){ askPosition.dispose(); askPosition = null; }
    if (askOwnerCleanup){ var cleanup = askOwnerCleanup; askOwnerCleanup = null; cleanup(); }
    askTabOwner = null;
    ask.classList.remove("visible"); pendingAsk = null; clearAskHighlight();
    resetReviseSurface();
  }

  // Closing the surface abandons a revision in flight: its preview lives in the
  // document, and leaving that behind with nothing to accept it would strand
  // the reader in a diff they cannot dismiss.
  function resetReviseSurface(){
    if (isSelectionRevisionActive()) cancelSelectionRevision({ silent: true });
    pendingRegion = null;
    askMode = "ask";
    ask.classList.remove("mode-revise", "revision-running");
    var modes = document.getElementById("ask-modes");
    if (modes) modes.hidden = true;
    var input = document.querySelector(".ask-input");
    if (input) input.hidden = false;
    var lenses = document.getElementById("ask-lenses");
    if (lenses) lenses.hidden = false;
    var chips = document.getElementById("ask-revise-chips");
    if (chips) chips.hidden = true;
    var note = document.getElementById("ask-revise-note");
    if (note) note.hidden = true;
    var panel = document.getElementById("ask-revision");
    if (panel){ panel.hidden = true; panel.replaceChildren(); }
    askText.placeholder = "Ask about this…";
  }

export function disposeAskFollowups(){
    disposeAskFollowupResources(true);
  }

  function disposeAskFollowupResources(resetHooks){
    hideAsk();
    cancelScrollAnimation();
    askLifecycle.dispose(resetHooks);
    pendingAsk = null;
    askTabOwner = null;
    askOwnerCleanup = null;
    if (mobileSelectionTimer) clearTimeout(mobileSelectionTimer);
    mobileSelectionTimer = 0;
    ignoreMobileSelectionUntil = 0;
    scrollAnimId = 0;
    scrollAnimIgnoreUntil = 0;
    askText.value = "";
  }
  // Custom Highlight API — keeps the selected text visibly marked while the popup
  // has focus. Best-effort: browsers without it just fall back to today's look.
  function paintAskHighlight(range){
    try { if (window.Highlight && window.CSS && CSS.highlights) CSS.highlights.set("rh-ask", new Highlight(range)); } catch(e){}
  }
  function clearAskHighlight(){
    try { if (window.CSS && CSS.highlights) CSS.highlights.delete("rh-ask"); } catch(e){}
  }

  var LENS_KEYS = { "1": "explain", "2": "eli5", "3": "example", "4": "deeper" };
  function onAskTextKeydown(e){
    if (isSubmitEnter(e)){
      e.preventDefault();
      if (askMode === "revise") submitRevise();
      else submitAsk(null, "keyboard");
      return;
    }
    if (isComposingText(e) || askText.value !== "" || e.metaKey || e.ctrlKey || e.altKey) return;
    // Single letters and digits are shortcuts only while the box is empty —
    // once the human starts typing, they are just characters.
    if (askMode === "ask" && LENS_KEYS[e.key]){
      e.preventDefault();
      submitAsk(LENS_KEYS[e.key], "keyboard");
    } else if (e.key === "e" && pendingRegion){
      e.preventDefault();
      setAskMode(askMode === "revise" ? "ask" : "revise");
    }
  }

  // ---------------------------------------------------------------------------
  // Ask / Revise
  // ---------------------------------------------------------------------------
  // The same drag opens both: a question that branches, or an instruction that
  // rewrites the passage in place. Revise is offered only when the passage can
  // actually be placed back in the card's Markdown source — see
  // resolveSelectionRegion — so the tab is absent rather than failing on use.

  var askMode = "ask", pendingRegion = null;

  // Revise is offered only for a passage this card can actually splice: an
  // editable answer, in the reader, whose selection maps back to whole blocks
  // of its Markdown source. Everything else keeps the ask-only surface.
  function prepareRevise(dc, node, range){
    pendingRegion = null;
    askMode = "ask";
    if (canReviseWithAi(node) && mode === "reader" && dc && dc.closest("#reader-main")){
      pendingRegion = resolveSelectionRegion(dc, node, range);
    }
    if (pendingRegion && pendingAsk){
      var rendered = regionRenderedRange(dc, node, pendingRegion);
      pendingAsk.renderedStart = rendered ? rendered.start : null;
      pendingAsk.renderedEnd = rendered ? rendered.end : null;
    }
    refreshAskModes();
  }

  function refreshAskModes(){
    var modes = document.getElementById("ask-modes");
    if (!modes) return;
    modes.hidden = !pendingRegion;
    var tabs = modes.querySelectorAll(".ask-mode");
    for (var i = 0; i < tabs.length; i++){
      var selected = tabs[i].getAttribute("data-mode") === askMode;
      tabs[i].classList.toggle("active", selected);
      tabs[i].setAttribute("aria-selected", selected ? "true" : "false");
      tabs[i].tabIndex = selected ? 0 : -1;
    }
    var revising = askMode === "revise";
    ask.classList.toggle("mode-revise", revising);
    askText.placeholder = revising ? "How should AI change this?" : "Ask about this…";
    document.getElementById("ask-lenses").hidden = revising;
    document.getElementById("ask-revise-chips").hidden = !revising;
    var note = document.getElementById("ask-revise-note");
    note.hidden = !revising;
    if (revising) note.textContent = reviseNoteText();
  }

  function reviseNoteText(){
    var parent = pendingAsk && nodes[pendingAsk.parentId];
    var detached = parent && pendingAsk.renderedStart != null
      ? branchesInsideRegion(parent, pendingAsk.renderedStart, pendingAsk.renderedEnd).length
      : 0;
    var base = "AI rewrites this passage in place. You review it before it is saved.";
    if (!detached) return base;
    return base + " " + detached + (detached === 1 ? " branch here loses" : " branches here lose")
      + " its link to the text.";
  }

  function setAskMode(next){
    var wanted = next === "revise" && pendingRegion ? "revise" : "ask";
    if (wanted === askMode) return;
    askMode = wanted;
    refreshAskModes();
    askText.focus({ preventScroll: true });
    if (askPosition) askPosition.update();
  }

  function submitRevise(){
    if (!pendingAsk || !pendingRegion || closed) return;
    var parent = nodes[pendingAsk.parentId];
    var instruction = askText.value.trim();
    if (!parent){ hideAsk(); return; }
    if (!instruction){ flashHint("Tell AI how to change this passage."); return; }
    var panel = document.getElementById("ask-revision");
    var started = startSelectionRevision({
      node: parent,
      region: pendingRegion,
      instruction: instruction,
      selectedText: pendingAsk.selectedText,
      panel: panel,
      onPhase: function(phase){
        if (phase === "closed" || phase === "applied") hideAsk();
        else if (askPosition) askPosition.update();
      },
    });
    if (!started) return;
    var sel = window.getSelection(); if (sel) sel.removeAllRanges();
    // The surface stays open on the phases the panel drives, but the composer
    // above it has done its job.
    askText.value = "";
    ask.classList.add("revision-running");
    document.getElementById("ask-modes").hidden = true;
    document.querySelector(".ask-input").hidden = true;
    document.getElementById("ask-revise-chips").hidden = true;
    document.getElementById("ask-revise-note").hidden = true;
    if (askPosition) askPosition.update();
  }

  function retirePdfConversionAction(parent){
    parent?.bodyEl?.querySelector(".rh-pdf-convert")?.remove();
    if (mode === "reader") readerMain.querySelector('.doc-content[data-node-id="' + parent.id + '"] .rh-pdf-convert')?.remove();
    // Reader stays mounted while Canvas is visible, so retire its docked action
    // too; otherwise switching modes would resurrect an invalid conversion.
    document.querySelector('#tb-document .rh-pdf-reader-toolbar[data-pdf-node-id="' + parent.id + '"] .rh-pdf-convert')?.remove();
  }

  function submitAsk(lensKey, source){
    if (!pendingAsk || closed) return;
    var parent = nodes[pendingAsk.parentId];
    if (!parent){ hideAsk(); return; }
    var lens = (lensKey && LENSES[lensKey]) ? lensKey : null;
    var question = lens ? LENSES[lens].q : askText.value.trim();
    var requestId = uuid(), childId = uuid();
    var pos = placeChild(parent, BRANCH_SELECTION);
    var anchor = { offset_start: pendingAsk.startOff, offset_end: pendingAsk.endOff };
    if (pendingAsk.pdfAnchor) anchor.pdf = pendingAsk.pdfAnchor;
    var node = {
	      id: childId, parent_id: parent.id,
	      title: lens ? lensLabel(lens) : (question ? truncate(question, 48) : "…"),
	      html: "", md: "",
	      base_url: parent.base_url || null,
	      base_url_source: parent.base_url ? "inherited" : null,
	      read: false,
      origin: { selected_text: pendingAsk.selectedText, question: question, lens: lens, anchor: anchor, branch_type: BRANCH_SELECTION },
      x: pos.x, y: pos.y, w: DEFAULT_CHILD.w, h: DEFAULT_CHILD.h, font_scale: 1, collapsed: false,
      status: "pending", _order: nextOrder(), _startTs: Date.now()
    };
    registerNode(node);
    retirePdfConversionAction(parent);
    var isPdfRegion = !!pendingAsk.pdfAnchor;
    function revealCreatedBranch(response){
      if (response && response.crop_asset) node.origin.crop_asset = response.crop_asset;
      if (canvasBuilt && !node.el){ createNodeEl(node, true); renderVisibility(); drawEdges(); }

      // Mark inline in whichever views currently render the parent doc. Wrap via
      // offsets (always text-node endpoints) — a live Range can end on an element
      // boundary, which the text-walker can't terminate on.
      if (isPdfRegion) {
        if (mode === "reader") mountPdfRectMark(readerMain.querySelector('.doc-content[data-node-id="' + parent.id + '"]'), anchor, childId, "rh-pdf-mark mark-pending");
        if (parent.bodyEl) mountPdfRectMark(parent.bodyEl.querySelector(".doc-content"), anchor, childId, "rh-pdf-mark mark-pending");
        scheduleEdges();
        if (mode === "reader" && currentNodeId === parent.id) renderMarginNotes();
      } else if (mode === "reader"){
        var rdc = readerMain.querySelector('.doc-content[data-node-id="' + parent.id + '"]');
        wrapInContainer(rdc, anchor, childId, "hl mark-pending");
        if (currentNodeId === parent.id) renderMarginNotes();
      }
      if (parent.bodyEl && !isPdfRegion){ wrapInContainer(parent.bodyEl.querySelector(".doc-content"), anchor, childId, "hl mark-pending"); scheduleEdges(); }
      revealNode(node, source);
    }

    var sel = window.getSelection(); if (sel) sel.removeAllRanges();
    hideAsk();
    var request = askLifecycle.hooks.post({ type: "branch_request", request_id: requestId, node_id: childId, parent_id: parent.id,
           selected_text: node.origin.selected_text, question: question, lens: lens, anchor: anchor,
           branch_type: BRANCH_SELECTION,
           position: { x: node.x, y: node.y }, size: { w: node.w, h: node.h } });
    if (isPdfRegion) {
      // The host prepares and persists the crop before acknowledging this ask.
      // Keep the node registered for streamed events, but do not paint an empty
      // card: its first visible frame already contains the durable clip.
      request.then(function(res){ if (!res || !res.ok) rollbackBranch(node); else revealCreatedBranch(res); });
    } else {
      revealCreatedBranch(null);
      request.then(function(res){ if (!res || !res.ok) rollbackBranch(node); });
    }
  }

  // Shared follow-up submission: from the reader chat or a card's docked
  // composer. Every direct child uses the same Reader branch rail.
export function sendFollowup(parent, question, lens, options){
    if (parent?.extensions?.pdf?.converting) return null;
    options = options || {};
    var chatContextId = String(options.chat_context_id || "").trim();
    var chatThreadId = String(options.chat_thread_id || "").trim();
    var chatRef = chatContextId && chatThreadId
      ? { chat_context_id: chatContextId, chat_thread_id: chatThreadId }
      : null;
    var requestId = uuid(), childId = uuid();
    var pos = placeChild(parent, BRANCH_FOLLOWUP);
    var node = {
	      id: childId, parent_id: parent.id,
	      title: lens ? lensLabel(lens) : truncate(question, 48),
	      html: "", md: "",
	      base_url: parent.base_url || null,
	      base_url_source: parent.base_url ? "inherited" : null,
	      read: false,
      origin: {
        selected_text: "", question: question, lens: lens, anchor: null, branch_type: BRANCH_FOLLOWUP,
        ...(chatRef || {})
      },
      x: pos.x, y: pos.y, w: DEFAULT_CHILD.w, h: DEFAULT_CHILD.h, font_scale: 1, collapsed: false,
      status: "pending", _order: nextOrder(), _startTs: Date.now()
    };
    registerNode(node);
    retirePdfConversionAction(parent);
    if (canvasBuilt){ createNodeEl(node, true); renderVisibility(); drawEdges(); }
    if (currentNodeId === parent.id && mode === "reader") renderMarginNotes();
    var payload = { type: "branch_request", request_id: requestId, node_id: childId, parent_id: parent.id,
           selected_text: "", question: question, lens: lens, anchor: null,
           branch_type: BRANCH_FOLLOWUP,
           ...(chatRef || {}),
           position: { x: node.x, y: node.y }, size: { w: node.w, h: node.h } };
    askLifecycle.hooks.post(payload).then(function(res){
      if (!res || !res.ok) rollbackBranch(node, options.onRollback);
    });
    return node;
  }

  // scrollTo({behavior:"smooth"}) proved unreliable here, so the one deliberate
  // scroll in the app (submit → your new question) is driven by hand. rAF never
  // fires in a hidden window — jump instantly there instead of never arriving.
  var scrollAnimId = 0, scrollAnimIgnoreUntil = 0, scrollFrameCleanup = null;
function cancelScrollAnimation(){ scrollAnimId++; clearScrollFrame(); }
  function clearScrollFrame(){
    if (!scrollFrameCleanup) return;
    var cleanup = scrollFrameCleanup;
    scrollFrameCleanup = null;
    cleanup();
  }
  function scheduleScrollFrame(callback){
    clearScrollFrame();
    var id = nextFrame(run);
    var cancel = function(){ cancelFrame(id); };
    scrollFrameCleanup = askLifecycle.scope ? askLifecycle.scope.addCleanup(cancel) : cancel;
    function run(timestamp){
      var cleanup = scrollFrameCleanup;
      scrollFrameCleanup = null;
      if (cleanup) cleanup();
      callback(timestamp);
    }
  }
  function setAnimatedScrollTop(el, value){
    scrollAnimIgnoreUntil = performance.now() + 80;
    el.scrollTop = value;
  }
export function animateScroll(el, target, source){
    var myId = ++scrollAnimId;
    if (document.hidden || shouldReduceMotion() || source !== "pointer"){ el.scrollTop = target; return; }
    var s = el.scrollTop, t0 = performance.now(), D = 240;
    function step(t){
      if (myId !== scrollAnimId) return;
      var p = Math.min(1, (t - t0) / D), k = easeOutMotion(p);
      setAnimatedScrollTop(el, s + (target - s) * k);
      if (p < 1) scheduleScrollFrame(step);
    }
    scheduleScrollFrame(step);
  }
  function interruptScrollAnimation(){ cancelScrollAnimation(); }
  // Undo an optimistic branch whose request the server rejected/never received.
  // No-op if the node is already gone, or if an answer raced in ahead of the
  // failed-POST callback (don't delete a node the agent actually answered).
function rollbackBranch(node, onRollback){
    var live = nodes[node.id];
    if (!live || live.status === "answered") return;
    teardownNode(node.id);
    if (typeof onRollback === "function") onRollback(node);
    if (canvasBuilt) drawEdges();
    if (mode === "reader" && currentNodeId === node.parent_id) renderMarginNotes();
    flashHint("Couldn't reach the agent — that ask was undone.");
  }

function subtreeBounds(node){
    return sharedSubtreeBounds(node, { childrenOf: childrenOf, effH: effH, sort: nodeOrder });
  }
function placeChild(parent, branchType){
    return sharedPlaceChild(parent, branchType, {
      childrenOf: childrenOf,
      effH: effH,
      sort: nodeOrder,
      childSize: DEFAULT_CHILD
    });
  }
