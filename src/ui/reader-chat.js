import {
  READER_BASE,
  buildDocContent,
  closed,
  composerInner,
  composerSend,
  composerText,
  currentNodeId,
  flashHint,
  frozen,
  nodes,
  sessionPhase,
  uuid
} from "./core.js";
import { autoGrowEl } from "./canvas-view.js";
import { applyComposerState } from "./composer-state.js";
import { ENTER_SEND_HINT, isSubmitEnter } from "./input-intent.js";
import { createModuleLifecycle } from "./lifecycle.js";
import { sendFollowup } from "./ask-followups.js";

function defaultReaderChatHooks(){
  return {};
}

var chatLifecycle = createModuleLifecycle({ defaults: defaultReaderChatHooks });
var fab = null;
var panel = null;
var titleEl = null;
var logEl = null;
var newButton = null;
var collapseButton = null;
var contextNodeId = null;
var threadId = null;
var lastAnswerId = null;
var turns = [];
var open = false;

export function initReaderChat(){
  disposeReaderChatResources(false);
  var scope = chatLifecycle.beginInit();
  fab = document.getElementById("reader-chat-fab");
  panel = document.getElementById("reader-chat-panel");
  titleEl = document.getElementById("reader-chat-title");
  logEl = document.getElementById("reader-chat-log");
  newButton = document.getElementById("reader-chat-new");
  collapseButton = document.getElementById("reader-chat-collapse");
  composerSend.title = ENTER_SEND_HINT;
  scope.listen(fab, "click", openChat);
  scope.listen(collapseButton, "click", function(){ collapseChat(true); });
  scope.listen(newButton, "click", startNewConversation);
  scope.listen(composerText, "input", function(){ autoGrowComposer(); updateReaderChatState(); });
  scope.listen(composerText, "keydown", function(event){
    if (!isSubmitEnter(event)) return;
    event.preventDefault();
    submitQuestion();
  });
  scope.listen(composerSend, "click", submitQuestion);
  scope.listen(document, "keydown", function(event){
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    collapseChat(true);
  });
  syncReaderChatContext(currentNodeId);
  renderEmptyState();
  updateReaderChatState();
  return disposeReaderChat;
}

export function disposeReaderChat(){
  disposeReaderChatResources(true);
}

function disposeReaderChatResources(resetHooks){
  turns.forEach(disposeTurn);
  chatLifecycle.dispose(resetHooks);
  document.body.classList.remove("reader-chat-open");
  if (fab){
    fab.setAttribute("aria-expanded", "false");
  }
  if (panel) panel.setAttribute("aria-hidden", "true");
  fab = panel = titleEl = logEl = newButton = collapseButton = null;
  contextNodeId = threadId = lastAnswerId = null;
  turns = [];
  open = false;
}

function openChat(){
  if (open) return;
  open = true;
  document.body.classList.add("reader-chat-open");
  fab.setAttribute("aria-expanded", "true");
  panel.setAttribute("aria-hidden", "false");
  autoGrowComposer();
  composerText.focus({ preventScroll: true });
}

function collapseChat(restoreFocus){
  if (!open) return;
  open = false;
  document.body.classList.remove("reader-chat-open");
  fab.setAttribute("aria-expanded", "false");
  panel.setAttribute("aria-hidden", "true");
  if (restoreFocus) fab.focus({ preventScroll: true });
}

export function syncReaderChatContext(nodeId){
  var nextId = nodeId && nodes[nodeId] ? nodeId : null;
  if (nextId !== contextNodeId){
    contextNodeId = nextId;
    resetConversation(false);
  }
  if (titleEl){
    var node = nextId && nodes[nextId];
    titleEl.textContent = node?.title || "Untitled";
    titleEl.title = node?.title || "Untitled";
  }
  updateReaderChatState();
}

function startNewConversation(){
  resetConversation(true);
  updateReaderChatState();
  composerText.focus({ preventScroll: true });
}

function resetConversation(preserveDraft){
  var draft = preserveDraft && composerText ? composerText.value : "";
  turns.forEach(disposeTurn);
  turns = [];
  lastAnswerId = null;
  threadId = uuid();
  if (logEl) renderEmptyState();
  if (composerText){
    composerText.value = draft;
    autoGrowComposer();
  }
}

function renderEmptyState(){
  if (!logEl) return;
  var empty = document.createElement("p");
  empty.className = "reader-chat-empty";
  empty.textContent = "Ask a question about this document. Follow-ups remember this page and the conversation.";
  logEl.replaceChildren(empty);
}

function submitQuestion(){
  if (closed || frozen){
    flashHint(frozen ? "This is a read-only snapshot." : "Session ended — reopen this Rabbithole from your terminal to continue.");
    return;
  }
  var context = contextNodeId && nodes[contextNodeId];
  var previous = lastAnswerId && nodes[lastAnswerId];
  var parent = previous || context;
  var question = composerText.value.trim();
  if (!question || !parent || parent.status === "pending" || parent.extensions?.pdf?.converting) return;
  if (!threadId) threadId = uuid();
  var activeThreadId = threadId;
  var node = sendFollowup(parent, question, null, {
    chat_context_id: contextNodeId,
    chat_thread_id: activeThreadId,
    onRollback: function(rolledBack){ removeRolledBackTurn(rolledBack.id, activeThreadId); }
  });
  if (!node) return;
  addTurn(node, question);
  lastAnswerId = node.id;
  composerText.value = "";
  autoGrowComposer();
  updateReaderChatState();
  scrollLogToEnd();
}

function addTurn(node, question){
  var empty = logEl.querySelector(".reader-chat-empty");
  if (empty) empty.remove();
  var turn = document.createElement("article");
  turn.className = "reader-chat-turn";
  turn.dataset.nodeId = node.id;
  var questionEl = document.createElement("div");
  questionEl.className = "reader-chat-question";
  questionEl.textContent = question;
  var answerEl = document.createElement("div");
  answerEl.className = "reader-chat-answer";
  turn.appendChild(questionEl);
  turn.appendChild(answerEl);
  logEl.appendChild(turn);
  var entry = { nodeId: node.id, element: turn, answerElement: answerEl };
  turns.push(entry);
  renderTurnAnswer(entry, node);
}

function renderTurnAnswer(entry, node){
  var previous = entry.answerElement.querySelector(".doc-content");
  if (previous && previous._rhDispose) previous._rhDispose();
  entry.answerElement.replaceChildren(buildDocContent(node, READER_BASE, "reader-chat:" + node.id));
}

function disposeTurn(entry){
  var content = entry?.answerElement?.querySelector(".doc-content");
  if (content && content._rhDispose) content._rhDispose();
  if (entry?.element?.parentNode) entry.element.remove();
}

function removeRolledBackTurn(nodeId, expectedThreadId){
  if (threadId !== expectedThreadId) return;
  var index = turns.findIndex(function(turn){ return turn.nodeId === nodeId; });
  if (index < 0) return;
  removeTurnsFrom(index);
}

function removeTurnsFrom(index){
  turns.slice(index).forEach(disposeTurn);
  turns = turns.slice(0, index);
  lastAnswerId = turns.length ? turns[turns.length - 1].nodeId : null;
  if (!turns.length) renderEmptyState();
  updateReaderChatState();
}

export function hasReaderChatNode(nodeOrId){
  var id = typeof nodeOrId === "string" ? nodeOrId : nodeOrId?.id;
  return turns.some(function(turn){ return turn.nodeId === id; });
}

export function syncReaderChatNode(node){
  if (!node) return;
  var entry = turns.find(function(turn){ return turn.nodeId === node.id; });
  if (!entry) return;
  renderTurnAnswer(entry, node);
  updateReaderChatState();
  scrollLogToEnd();
}

export function syncReaderChatDeleted(nodeIds){
  var ids = new Set(nodeIds || []);
  var index = turns.findIndex(function(turn){ return ids.has(turn.nodeId) || !nodes[turn.nodeId]; });
  if (index >= 0) removeTurnsFrom(index);
}

export function updateReaderChatState(){
  if (!composerText || !composerSend || !composerInner) return;
  var context = contextNodeId && nodes[contextNodeId];
  var last = lastAnswerId && nodes[lastAnswerId];
  var pending = !context || context.status === "pending" || !!context.extensions?.pdf?.converting
    || !!(last && last.status === "pending");
  applyComposerState(
    { text: composerText, send: composerSend, wrap: composerInner },
    { phase: sessionPhase(), pending: pending },
    { frozen: "Read-only snapshot — open the live Rabbithole to keep asking",
      closed: "Session ended — reopen this Rabbithole from your terminal; saved questions are answered there",
      pending: "This answer is still being written…",
      away: "The agent is away — questions are saved and answered when it returns…",
      live: "Ask about this document…" }
  );
}

function autoGrowComposer(){
  if (composerText) autoGrowEl(composerText, 120);
}

function scrollLogToEnd(){
  if (!logEl) return;
  logEl.scrollTop = logEl.scrollHeight;
}
