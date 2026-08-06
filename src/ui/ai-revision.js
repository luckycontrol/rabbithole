import {
  buildDocContent,
  childrenOf,
  closed,
  flashHint,
  nodes,
  showHint,
  uuid,
} from "./core.js";
import { isEditableAnswer } from "../core/model.js";
import { buttonMarkup } from "../core/html/button-markup.js";
import { iconSvg } from "../core/html/icons.js";
import { refreshNodeHtml } from "./renderer.js";

function defaultHooks() {
  return {
    post: function(){ return Promise.resolve({ ok: true }); },
    refresh: function(){},
  };
}

var revisionHooks = defaultHooks();

export function registerAiRevisionHooks(hooks) {
  Object.assign(revisionHooks, hooks || {});
}

export function disposeAiRevision() {
  Object.keys(nodes).forEach(function(id){ delete nodes[id]._revision; });
  revisionHooks = defaultHooks();
}

export function canReviseWithAi(node) {
  return !closed && isEditableAnswer(node) && !node.extensions?.pdf;
}

export function updateAiRevisionControl(node) {
  var button = node && node.aiRevisionBtn;
  if (!button) return;
  var available = canReviseWithAi(node) && !node._revision;
  button.hidden = !available;
  button.disabled = !available;
}

export function openAiRevision(node) {
  if (!canReviseWithAi(node)) return false;
  if (!node._revision) {
    node._revision = {
      phase: "prompt",
      instruction: "",
      requestId: null,
      draftTitle: node.title || "Untitled",
      draftMarkdown: "",
      showOriginal: false,
      error: "",
    };
  }
  refresh(node);
  return true;
}

export function buildAiRevisionSurface(node, base) {
  var state = node && node._revision;
  if (!state) return null;
  var section = document.createElement("section");
  section.className = "ai-revision ai-revision-" + state.phase;
  section.setAttribute("aria-label", "Revise card with AI");

  var head = document.createElement("div");
  head.className = "ai-revision-head";
  head.innerHTML = iconSvg("sparkles") + '<span>AI revision</span><span class="ai-revision-state">' + phaseLabel(state.phase) + "</span>";
  section.appendChild(head);

  var showingOriginal = state.phase === "prompt" || state.showOriginal || !state.draftMarkdown;
  var previewNode = showingOriginal ? node : {
    ...node,
    id: node.id + "-revision-preview",
    title: state.draftTitle || node.title,
    md: state.draftMarkdown,
    markdown: state.draftMarkdown,
    html: "",
    _revision: null,
  };
  if (!showingOriginal) refreshNodeHtml(previewNode);
  var preview = buildDocContent(previewNode, base);
  preview.classList.add("ai-revision-preview");
  preview.dataset.nodeId = node.id;
  section.appendChild(preview);

  if (state.phase === "prompt") section.appendChild(buildPrompt(node, state));
  else if (state.phase === "generating") section.appendChild(buildGenerating(node, state));
  else if (state.phase === "ready") section.appendChild(buildReady(node, state));
  else section.appendChild(buildError(node, state));
  return section;
}

function buildPrompt(node, state) {
  var form = document.createElement("form");
  form.className = "ai-revision-composer";
  var childCount = childrenOf(node.id).length;
  var note = document.createElement("p");
  note.className = "ai-revision-note";
  note.textContent = "This replaces the current card instead of creating a branch."
    + (childCount ? " " + childCount + " linked " + (childCount === 1 ? "branch stays" : "branches stay") + " attached." : "");
  var textarea = document.createElement("textarea");
  textarea.rows = 2;
  textarea.placeholder = "How should AI revise this card?";
  textarea.setAttribute("aria-label", "AI revision instruction");
  textarea.value = state.instruction;
  textarea.addEventListener("input", function(){ state.instruction = textarea.value; });

  var suggestions = document.createElement("div");
  suggestions.className = "ai-revision-suggestions";
  ["Make it shorter", "Explain more clearly", "Fix errors", "Add an example"].forEach(function(label){
    var button = document.createElement("button");
    button.type = "button"; button.className = "ai-revision-chip"; button.textContent = label;
    button.addEventListener("click", function(){ state.instruction = label; textarea.value = label; textarea.focus(); });
    suggestions.appendChild(button);
  });
  var actions = document.createElement("div");
  actions.className = "ai-revision-actions";
  actions.innerHTML =
    buttonMarkup({ bare: true, className: "ai-revision-button", label: "Cancel" }) +
    buttonMarkup({ bare: true, className: "ai-revision-button primary", label: "Generate revision", svgIconHtml: iconSvg("sparkles") });
  actions.querySelector("button").addEventListener("click", function(){ closeRevision(node); });
  actions.querySelector(".primary").addEventListener("click", function(){ form.requestSubmit(); });
  form.addEventListener("submit", function(event){ event.preventDefault(); submitRevision(node, state); });
  form.addEventListener("keydown", function(event){
    if (event.key === "Escape") { event.preventDefault(); closeRevision(node); }
    else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); form.requestSubmit(); }
  });
  form.append(note, textarea, suggestions, actions);
  requestAnimationFrame(function(){ if (node._revision === state) textarea.focus({ preventScroll: true }); });
  return form;
}

function buildGenerating(node, state) {
  var footer = document.createElement("div");
  footer.className = "ai-revision-footer";
  var status = document.createElement("span");
  status.className = "ai-revision-progress";
  status.setAttribute("role", "status");
  status.textContent = state.draftMarkdown ? "Writing a complete replacement…" : "Revising this card…";
  var cancel = htmlButton("Cancel", "ai-revision-button");
  cancel.addEventListener("click", function(){ closeRevision(node); });
  footer.append(status, cancel);
  return footer;
}

function buildReady(node, state) {
  var footer = document.createElement("div");
  footer.className = "ai-revision-footer ready";
  var toggle = htmlButton(state.showOriginal ? "Show revision" : "Show original", "ai-revision-button");
  toggle.addEventListener("click", function(){ state.showOriginal = !state.showOriginal; refresh(node); });
  var retry = htmlButton("Try again", "ai-revision-button");
  retry.addEventListener("click", function(){ submitRevision(node, state); });
  var cancel = htmlButton("Cancel", "ai-revision-button");
  cancel.addEventListener("click", function(){ closeRevision(node); });
  var branch = htmlButton("Keep as branch", "ai-revision-button");
  branch.addEventListener("click", function(){ keepAsBranch(node, state); });
  var apply = htmlButton("Apply revision", "ai-revision-button primary", iconSvg("check"));
  apply.addEventListener("click", function(){ applyRevision(node, state); });
  footer.append(toggle, retry, cancel, branch, apply);
  return footer;
}

function buildError(node, state) {
  var footer = document.createElement("div");
  footer.className = "ai-revision-footer error";
  var message = document.createElement("span");
  message.className = "ai-revision-error";
  message.setAttribute("role", "alert");
  message.textContent = state.error || "AI couldn't revise this card.";
  var cancel = htmlButton("Cancel", "ai-revision-button");
  cancel.addEventListener("click", function(){ closeRevision(node); });
  var retry = htmlButton("Try again", "ai-revision-button primary", iconSvg("sparkles"));
  retry.addEventListener("click", function(){ submitRevision(node, state); });
  footer.append(message, cancel, retry);
  return footer;
}

function submitRevision(node, state) {
  if (node._revision !== state) return;
  var instruction = String(state.instruction || "").trim();
  if (!instruction) { flashHint("Tell AI how to revise this card."); return; }
  if (state.requestId) revisionHooks.post({ type: "revision_cancel", request_id: state.requestId, node_id: node.id });
  state.phase = "generating";
  state.requestId = uuid();
  state.draftTitle = node.title || "Untitled";
  state.draftMarkdown = "";
  state.showOriginal = false;
  state.error = "";
  var requestId = state.requestId;
  refresh(node);
  Promise.resolve(revisionHooks.post({ type: "revision_request", request_id: requestId, node_id: node.id, instruction: instruction }))
    .then(function(result){
      if (node._revision !== state || state.requestId !== requestId) return;
      if (result && result.ok !== false) return;
      state.phase = "error"; state.error = result?.error || "AI couldn't start this revision."; refresh(node);
    }, function(error){
      if (node._revision !== state || state.requestId !== requestId) return;
      state.phase = "error"; state.error = error?.message || "AI couldn't start this revision."; refresh(node);
    });
}

export function handleRevisionProgress(message) {
  var node = nodes[message.node_id];
  var state = node && node._revision;
  if (!state || state.requestId !== message.request_id) return false;
  state.phase = "generating";
  state.draftTitle = message.title || state.draftTitle || node.title;
  state.draftMarkdown = String(message.markdown || "");
  refresh(node);
  return true;
}

export function handleRevisionReady(message) {
  var node = nodes[message.node_id];
  var state = node && node._revision;
  if (!state || state.requestId !== message.request_id) return false;
  state.phase = "ready";
  state.draftTitle = String(message.title || node.title || "Untitled").trim() || "Untitled";
  state.draftMarkdown = String(message.markdown || "");
  state.showOriginal = false;
  refresh(node);
  return true;
}

export function handleRevisionError(message) {
  var node = nodes[message.node_id];
  var state = node && node._revision;
  if (!state || state.requestId !== message.request_id) return false;
  state.phase = "error";
  state.error = message.message || "AI couldn't revise this card.";
  refresh(node);
  return true;
}

function applyRevision(node, state) {
  if (node._revision !== state || state.phase !== "ready") return;
  var previous = { title: node.title, markdown: node.md };
  var next = { title: state.draftTitle || node.title || "Untitled", markdown: state.draftMarkdown };
  delete node._revision;
  setNodeContent(node, next);
  Promise.resolve(revisionHooks.post({ type: "answer_node_content", node_id: node.id, title: next.title, markdown: next.markdown }))
    .then(function(result){
      if (result && result.ok !== false) {
        showHint({ message: "Card revised.", actionLabel: "Undo", duration: 8000,
          onAction: function(){ return undoRevision(node, previous, next); } });
        return;
      }
      restoreIfCurrent(node, previous, next, "Couldn't apply the revision.");
    }, function(){ restoreIfCurrent(node, previous, next, "Couldn't apply the revision."); });
}

function undoRevision(node, previous, expected) {
  if (node.title !== expected.title || node.md !== expected.markdown) return Promise.resolve();
  setNodeContent(node, previous);
  return Promise.resolve(revisionHooks.post({ type: "answer_node_content", node_id: node.id,
    title: previous.title, markdown: previous.markdown })).then(function(result){
      if (result && result.ok !== false) return;
      restoreIfCurrent(node, expected, previous, "Couldn't undo the revision.");
    }, function(){ restoreIfCurrent(node, expected, previous, "Couldn't undo the revision."); });
}

function keepAsBranch(node, state) {
  if (node._revision !== state || state.phase !== "ready") return;
  var childId = uuid();
  Promise.resolve(revisionHooks.post({
    type: "revision_save_as_branch", request_id: state.requestId, node_id: node.id, child_id: childId,
    title: state.draftTitle, markdown: state.draftMarkdown, instruction: state.instruction,
    position: { x: Number(node.x || 0) + Number(node.w || 420) + 80, y: Number(node.y || 0) },
    size: { w: 420, h: 360 },
  })).then(function(result){
    if (node._revision !== state) return;
    if (!result || result.ok === false) {
      state.phase = "error"; state.error = result?.error || "Couldn't keep this revision as a branch."; refresh(node); return;
    }
    delete node._revision; refresh(node); flashHint("Revision kept as a new branch.");
  }, function(error){
    if (node._revision !== state) return;
    state.phase = "error"; state.error = error?.message || "Couldn't keep this revision as a branch."; refresh(node);
  });
}

function closeRevision(node) {
  var state = node && node._revision;
  if (!state) return;
  if (state.requestId && state.phase === "generating") {
    revisionHooks.post({ type: "revision_cancel", request_id: state.requestId, node_id: node.id });
  }
  delete node._revision;
  refresh(node);
}

function setNodeContent(node, content) {
  node.title = String(content.title || "Untitled").trim() || "Untitled";
  node.md = String(content.markdown || "");
  refreshNodeHtml(node);
  if (node.titleEl) { node.titleEl.textContent = node.title; node.titleEl.title = node.title; }
  refresh(node);
}

function restoreIfCurrent(node, replacement, expected, message) {
  if (node.title !== expected.title || node.md !== expected.markdown) return;
  setNodeContent(node, replacement);
  flashHint(message);
}

function refresh(node) {
  updateAiRevisionControl(node);
  revisionHooks.refresh(node);
}

function phaseLabel(phase) {
  return phase === "prompt" ? "Instructions" : phase === "generating" ? "Drafting…" : phase === "ready" ? "Preview" : "Needs attention";
}

function htmlButton(label, className, icon) {
  var template = document.createElement("template");
  template.innerHTML = buttonMarkup({ bare: true, className: className, label: label, svgIconHtml: icon || "" });
  return template.content.firstElementChild;
}
