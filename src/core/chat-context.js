/**
 * Reader chat threading.
 *
 * A branch_request MAY carry a chat_context_id/chat_thread_id pair:
 * chat_context_id names the node the human is having a conversation about
 * (the "context page"), and chat_thread_id groups every turn of that
 * conversation together. Turns commonly branch directly off the context page
 * rather than off each other's answers, so the ordinary parent/ancestor
 * chain does not by itself carry prior turns — this module reconstructs them
 * explicitly from the live node tree.
 *
 * Both normalization (format only, no tree access) and resolution
 * (validated against the live node tree) live here so every host applies the
 * same rules: model.js normalizes the pair onto a new node's origin, and
 * each transport resolves it — against the tree it already holds — when it
 * builds the answering prompt or the MCP branch_request event. Invalid or
 * inconsistent metadata resolves to null so callers fall back to an ordinary
 * follow-up instead of throwing.
 */

/** @typedef {Map<string, any> | Record<string, any>} NodeCollection */
/** @typedef {{ chat_context_id: string, chat_thread_id: string }} ChatContextRef */
/** @typedef {{ question: string, answer: string, created_at: string }} ChatTurn */
/** @typedef {{ contextNode: any, priorTurns: ChatTurn[] }} ResolvedChatContext */

const MAX_ID_LENGTH = 128;
const DEFAULT_MAX_PRIOR_TURNS = 12;

function normalizeChatId(value) {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, MAX_ID_LENGTH) : "";
}

/**
 * Format-only normalization of a chat context ref off a raw branch payload
 * (or a stored node's origin, which carries the same field names). Both ids
 * must be present together — either alone is malformed and dropped.
 * @param {{ chat_context_id?: unknown, chat_thread_id?: unknown } | null | undefined} source
 * @returns {ChatContextRef | null}
 */
export function normalizeChatContextRef(source) {
  const contextId = normalizeChatId(source?.chat_context_id);
  const threadId = normalizeChatId(source?.chat_thread_id);
  if (!contextId || !threadId) return null;
  return { chat_context_id: contextId, chat_thread_id: threadId };
}

/**
 * Resolve a chat context ref against the live node tree, from the
 * perspective of `parentId` (the new branch's parent). Falls back to null —
 * an ordinary follow-up, no chat context attached — unless:
 *  - the context node exists,
 *  - it is an ancestor of (or the same node as) the parent, and
 *  - no other node already uses the same thread id under a different
 *    context id (a thread id is scoped to exactly one context page, so a
 *    reused/guessed thread id pointing at the wrong page is rejected).
 * @param {NodeCollection} nodes
 * @param {unknown} parentId
 * @param {ChatContextRef | null} ref
 * @returns {ResolvedChatContext | null}
 */
export function resolveChatContext(nodes, parentId, ref) {
  if (!ref) return null;
  const contextNode = nodeById(nodes, ref.chat_context_id);
  if (!contextNode) return null;
  if (!isAncestorOrSelf(nodes, ref.chat_context_id, parentId)) return null;
  for (const node of allNodes(nodes)) {
    const nodeRef = normalizeChatContextRef(node.origin);
    if (nodeRef && nodeRef.chat_thread_id === ref.chat_thread_id && nodeRef.chat_context_id !== ref.chat_context_id) {
      return null;
    }
  }
  return { contextNode, priorTurns: collectPriorTurns(nodes, ref) };
}

/**
 * Chronological (oldest first) answered question/answer turns already
 * recorded under this chat context + thread, trimmed to the most recent
 * `limit`. A still-pending sibling (the ask currently being answered, or any
 * other in-flight ask) contributes nothing yet.
 * @param {NodeCollection} nodes
 * @param {ChatContextRef | null} ref
 * @param {{ limit?: number }} [options]
 * @returns {ChatTurn[]}
 */
export function collectPriorTurns(nodes, ref, { limit = DEFAULT_MAX_PRIOR_TURNS } = {}) {
  if (!ref) return [];
  const turns = [];
  for (const node of allNodes(nodes)) {
    if (node.status !== "answered") continue;
    const nodeRef = normalizeChatContextRef(node.origin);
    if (!nodeRef || nodeRef.chat_context_id !== ref.chat_context_id || nodeRef.chat_thread_id !== ref.chat_thread_id) continue;
    turns.push({
      question: String(node.origin?.question || ""),
      answer: String(node.markdown || ""),
      created_at: String(node.created_at || ""),
    });
  }
  turns.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return turns.length > limit ? turns.slice(turns.length - limit) : turns;
}

/**
 * Shape a resolved chat context for the wire / prompt layer: the full
 * context-page markdown plus its recent prior turns. Both direct-host.js
 * (LLM prompt context) and session.js (MCP branch_request event) use this so
 * the two transports expose an equivalent chat_context field.
 * @param {ResolvedChatContext} chatContext
 */
export function describeChatContext(chatContext) {
  return {
    context_title: chatContext.contextNode.title || "Untitled",
    context_markdown: chatContext.contextNode.markdown || "",
    prior_turns: chatContext.priorTurns.map((turn) => ({ question: turn.question, answer: turn.answer })),
  };
}

function nodeById(nodes, id) {
  return nodes instanceof Map ? nodes.get(id) : nodes?.[id];
}

function allNodes(nodes) {
  return nodes instanceof Map ? nodes.values() : Object.values(nodes || {});
}

function isAncestorOrSelf(nodes, ancestorId, nodeId) {
  const guard = new Set();
  let current = nodeById(nodes, nodeId);
  while (current && !guard.has(current.id)) {
    if (current.id === ancestorId) return true;
    guard.add(current.id);
    current = current.parent_id ? nodeById(nodes, current.parent_id) : null;
  }
  return false;
}
