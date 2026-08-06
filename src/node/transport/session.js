import http from "node:http";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { openBrowser } from "./browser.js";
import { log, error as logError } from "../logger.js";
import { addAssetsToHole, defaultFsStore, resolveAsset } from "../fs-store.js";
import { maybeUpgradeBaseUrlFromFrontmatter, normalizeBaseUrl } from "../../core/base-url.js";
import { extractNodeAssetRefs } from "../../core/assets.js";
import { createHoleState, holeStateToHole, holeStateToHydrationNodes, reduceHoleEvent } from "../../core/reducer.js";
import { toPersistedHole } from "../../core/schema.js";
import { canvasNodeKind, lineageTitlesFromMap, normalizePdfAnchor } from "../../core/model.js";
import { describeChatContext, normalizeChatContextRef, resolveChatContext } from "../../core/chat-context.js";
import { buildJsonError, closeServerGracefully, CLOSE_TIMEOUT_MS } from "./http.js";
import { writeSseEvent } from "./sse.js";
import { handleSessionRequest } from "./session-router.js";
import { GenerationIngress } from "./generation-ingress.js";
import { applyPersistedBrowserEvent, assetsOrphanedByDeletion, buildNodeAnsweredEvent, createSaveChain, dispatchBrowserEvent } from "../../core/hole-host.js";
import { MAX_PDF_FIGURE_ASSET_BYTES, normalizePdfExtension, parseFigureRefs, rewriteFigureRefs } from "../../core/pdf-shared.js";
import { TRANSCRIBE_V1_RULES } from "../../core/prompts/transcribe-v1.js";
import { normalizeRevisionFragment, readSelectionRegion, SELECTION_RESPONSE_CONTRACT, selectionRegionMatches } from "../../core/selection-revision.js";
import { cropPdfFigureToAsset, cropPdfRegionToFile, renderPdfPageToFile, sweepPdfRegionFiles } from "../pdf-crop.js";

const SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
const SAVE_DEBOUNCE_MS = 400;
// Once the browser has connected at least once, treat a sustained loss of every
// SSE client as the human having closed the tab — close after a grace window.
// Kept generous so a reload, a network blip, or a laptop sleep/wake (all of
// which EventSource recovers from automatically) never kills a live session the
// human is still reading; the only cost of waiting is that the already-blocking
// agent call releases a little later after a genuine tab close.
const DISCONNECT_GRACE_MS = 60 * 1000;
const DEFAULT_MAX_BLOCK_MS = 240 * 1000;
const REARM_GRACE_MS = 20 * 1000;
// Cap on retained SSE events for reconnect replay, so a long-lived session
// doesn't grow this array without bound.
const MAX_REPLAY_EVENTS = 500;
// After a branch_request is handed to the agent, expect answer_branch within
// this window. If nothing comes back the agent likely died mid-generation
// (cancelled without an MCP request in flight) — tell the browser so pending
// asks don't shimmer forever. Self-heals: any later agent call re-attaches.
const ANSWER_WATCHDOG_MS = 4 * 60 * 1000;

function maxBlockMs() {
  const value = Number(process.env.RABBITHOLE_MAX_BLOCK_MS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_BLOCK_MS;
}

function answerWatchdogTimeoutMs() {
  const value = Number(process.env.RABBITHOLE_ANSWER_WATCHDOG_MS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : ANSWER_WATCHDOG_MS;
}

/**
 * One live Rabbithole: the node tree, the browser transport, and the
 * agent-facing event queue. The agent blocks on waitForEvent(); the browser
 * drives the canvas and posts branch requests / node updates.
 */
export class RabbitHoleSession {
  constructor({ holeId, title, rootId, createdAt, nodes, assetNames, viewState, isResume, renderPage, onClose, mintGenerationRunId = randomUUID, recoverStalledBranch = null, answerWatchdogMs = answerWatchdogTimeoutMs() }) {
    this.id = randomUUID();
    this.holeId = holeId || randomUUID();
    this.title = title || "Untitled";
    this.rootId = rootId || null;
    this.createdAt = createdAt || new Date().toISOString();
    this.assetNames = new Set(assetNames || []);
    this.renderPage = renderPage;
    this.onClose = onClose;
    this.mintGenerationRunId = mintGenerationRunId;
    this.recoverStalledBranch = typeof recoverStalledBranch === "function" ? recoverStalledBranch : null;
    this.answerWatchdogMs = Number.isFinite(Number(answerWatchdogMs)) && Number(answerWatchdogMs) > 0
      ? Math.floor(Number(answerWatchdogMs))
      : ANSWER_WATCHDOG_MS;

    this.state = createHoleState({
      hole_id: this.holeId,
      title: this.title,
      root_id: this.rootId,
      created_at: this.createdAt,
      view_state: viewState ?? null,
      nodes,
    });
    this.nodes = this.state.nodes;
    this.viewState = this.state.view_state;

    this.pendingByRequest = new Map(); // request_id -> node_id
    this.generationByRequest = new Map(); // request_id -> active MCP generation ingress
    this.revisionRequests = new Map(); // request_id -> transient in-place revision preview
    // Requests whose node was deleted mid-answer: a late answer_branch for one
    // of these is absorbed gracefully instead of erroring at the agent.
    this.cancelledRequests = new Set();
    this.needsRehydration = !!isResume;

    this.server = null;
    this.url = null;
    this.closed = false;
    this.closePromise = null;

    this.queue = []; // agent-facing events awaiting consumption
    this.waiters = []; // FIFO of {resolve, cleanup} for blocked waitForEvent() calls
    this.agentAttached = true; // false once the agent cancels/stalls; browser is told
    this.agentReason = null;
    this.watchdogTimer = null;
    this.rearmDetachTimer = null;
    this.inFlightBranchRequests = new Map(); // request_id -> last delivered branch_request not yet answered
    this.recoveryControllers = new Map(); // request_id -> AbortController for a sampling fallback
    this.recoveryChain = Promise.resolve();
    this.recoveryEpoch = 0;
    this.autoRecoveryMode = false; // enabled after the first successful sampled recovery
    this.convertRequests = new Map();
    // Legacy/failure-fallback transient region JPEGs (request_id -> path).
    // Successful region asks use branch-owned crop-* assets instead.
    this.regionFiles = new Map();
    this.regionSweep = isResume ? sweepPdfRegionFiles(this.holeId).catch(() => {}) : Promise.resolve();

    this.sseClients = new Set();
    this.everConnected = false;
    this.disconnectTimer = null;
    this.outboundEvents = [];
    this.lastOutboundEventId = 0;

    this.timeoutHandle = null;
    this.saveChain = createSaveChain({
      debounceMs: SAVE_DEBOUNCE_MS,
      save: () => {
        const snapshot = this.toHole();
        return () => defaultFsStore.saveHole(snapshot).catch((err) => logError(`Save failed: ${err.message}`));
      },
    });
    this.shutdownScheduled = false;

    // Saved asks: questions the human asked while no agent was listening are
    // persisted as pending nodes; a resume re-queues each one (oldest first,
    // under a fresh request_id) so the agent answers them right away.
    if (isResume) { this.requeueSavedAsks(); this.requeueSavedConversions(); }

    this.handleRequest = this.handleRequest.bind(this);
  }

  // ---- lifecycle ----------------------------------------------------------

  async start() {
    if (this.server) return this.url;

    const server = http.createServer(this.handleRequest);
    this.server = server;
    server.on("error", (err) => {
      logError(`Session ${this.id} server error: ${err.message}`);
      this.close("server_error");
    });

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Failed to determine session address"));
          return;
        }
        this.url = `http://127.0.0.1:${address.port}`;
        log(`Rabbithole "${this.title}" listening at ${this.url}`);
        resolve();
      });
    });

    this.touch();
    // Persist right away so the hole is resumable even if the process dies
    // before the first answer (durable asks depend on the file existing).
    this.scheduleSave();
    openBrowser(this.url);
    return this.url;
  }

  isClosed() {
    return this.closed;
  }

  touch() {
    if (this.closed) return;
    if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
    this.timeoutHandle = setTimeout(() => {
      log(`Session ${this.id} timed out`);
      this.close("timeout");
    }, SESSION_TIMEOUT_MS);
  }

  // Close the session a short while after the browser disconnects (tab closed),
  // unless it reconnects (reload) within the grace window.
  scheduleDisconnectClose() {
    if (this.closed || this.disconnectTimer) return;
    this.disconnectTimer = setTimeout(() => {
      this.disconnectTimer = null;
      if (!this.closed && this.sseClients.size === 0) {
        log(`Session ${this.id} closing — browser disconnected`);
        this.close("disconnected");
      }
    }, DISCONNECT_GRACE_MS);
  }

  clearDisconnectClose() {
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
  }

  close(reason = "session_closed") {
    if (this.closed) return this.closePromise;
    for (const request of this.convertRequests.values()) if (request.markdown) this.restoreNodeConversion(request.node_id);
    // Only this session's own crops — a successor session for the same hole may
    // already be writing fresh ones under different request ids.
    for (const filePath of this.regionFiles.values()) fs.unlink(filePath).catch(() => {});
    this.regionFiles.clear();
    this.closed = true;
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    this.clearAnswerWatchdog();
    this.clearRearmDetach();
    this.clearDisconnectClose();
    this.stopAutomaticRecovery();
    this.closePromise = this.flushSave();

    this.broadcast({ type: "session_closed", reason });

    // Drop any queued (now unanswerable) branch requests and release every
    // blocked agent call with session_closed.
    this.queue.length = 0;
    this.inFlightBranchRequests.clear();
    this.generationByRequest.clear();
    this.revisionRequests.clear();
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      waiter.cleanup?.();
      waiter.resolve({ status: "session_closed", session_id: this.id });
    }

    if (this.shutdownScheduled) return this.closePromise;
    this.shutdownScheduled = true;
    setTimeout(() => {
      for (const client of this.sseClients) {
        try {
          client.end();
        } catch {}
      }
      this.sseClients.clear();
      if (!this.server) {
        this.onClose?.(this);
        return;
      }
      const server = this.server;
      this.server = null;
      closeServerGracefully(server, {
        timeoutMs: CLOSE_TIMEOUT_MS,
        onClosed: () => {
          this.onClose?.(this);
          log(`Session ${this.id} closed (${reason})`);
        },
      });
    }, 0);
    return this.closePromise;
  }

  // ---- agent-facing event queue ------------------------------------------

  /**
   * Block until the next browser event. `signal` (the MCP request's
   * AbortSignal) fires when the human cancels the tool call in the terminal —
   * the waiter is removed and the browser is told the agent detached, so
   * pending asks stop pretending an answer is coming.
   */
  waitForEvent(signal) {
    if (this.closed) return Promise.resolve({ status: "session_closed", session_id: this.id });
    // A new MCP tool call takes precedence over a sampling fallback. Its
    // existing in-flight request remains claimable and is delivered below.
    this.stopAutomaticRecovery();
    this.touch();
    this.markAgentAttached();
    if (this.queue.length > 0) return Promise.resolve(this.deliverToAgent(this.queue.shift()));
    const inFlight = this.nextInFlightBranchRequest();
    if (inFlight) return Promise.resolve(this.deliverToAgent(inFlight));
    // FIFO of waiters so concurrent waitForEvent() calls never orphan each other.
    return new Promise((resolve) => {
      let done = false;
      let budgetTimer = null;
      let waiter = null;
      const finish = (event, { deliver = true } = {}) => {
        if (done) return;
        done = true;
        const idx = this.waiters.indexOf(waiter);
        if (idx !== -1) this.waiters.splice(idx, 1);
        waiter?.cleanup?.();
        resolve(deliver ? this.deliverToAgent(event) : event);
      };
      const onAbort = () => {
        this.clearAnswerWatchdog();
        this.setAgentAttached(false, "cancelled");
        finish({ status: "cancelled", session_id: this.id }, { deliver: false });
      };
      const cleanup = () => {
        if (budgetTimer) {
          clearTimeout(budgetTimer);
          budgetTimer = null;
        }
        if (signal) signal.removeEventListener("abort", onAbort);
      };
      waiter = { resolve: (event) => finish(event), cleanup };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      budgetTimer = setTimeout(() => {
        this.scheduleRearmDetach();
        finish(this.keepListeningResult(), { deliver: false });
      }, maxBlockMs());
      budgetTimer.unref?.();
      this.waiters.push(waiter);
    });
  }

  pushEvent(event) {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.cleanup?.();
      waiter.resolve(event);
      return true;
    }
    this.queue.push(event);
    this.scheduleAutomaticRecovery(event);
    return false;
  }

  // Every branch_request handed to the agent arms the watchdog; any subsequent
  // agent activity (answer_branch, another waitForEvent) clears or re-arms it.
  deliverToAgent(event) {
    if (event && (event.status === "branch_request" || event.status === "revision_request" || event.status === "convert_request")) {
      this.inFlightBranchRequests.set(event.request_id, event);
      this.startAnswerWatchdog();
    }
    return event;
  }

  nextInFlightBranchRequest() {
    for (const [requestId, event] of this.inFlightBranchRequests) {
      // A conversion has no pending node — it stays redeliverable for as long
      // as its run is live, so a keep_listening re-arm can't drop it.
      if (event.status === "convert_request") {
        if (this.convertRequests.has(requestId)) return event;
        this.inFlightBranchRequests.delete(requestId);
        continue;
      }
      if (event.status === "revision_request") {
        if (this.revisionRequests.has(requestId)) return event;
        this.inFlightBranchRequests.delete(requestId);
        continue;
      }
      const nodeId = this.pendingByRequest.get(requestId);
      const node = nodeId ? this.nodes.get(nodeId) : null;
      if (node && node.status === "pending") return event;
      this.inFlightBranchRequests.delete(requestId);
    }
    return null;
  }

  keepListeningResult() {
    return {
      status: "keep_listening",
      session_id: this.id,
      hole_id: this.holeId,
      instruction:
        `Immediately call open_rabbithole with {"hole_id":"${this.holeId}"} to keep listening. ` +
        "Do not re-send content; pending asks are saved and will be delivered on re-attach.",
    };
  }

  startAnswerWatchdog() {
    this.clearAnswerWatchdog();
    const event = this.nextInFlightBranchRequest();
    const requestId = event?.request_id || null;
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null;
      if (this.closed) return;
      const current = requestId ? this.inFlightBranchRequests.get(requestId) : null;
      if (current && this.canRecoverStalledEvent(current)) {
        this.enqueueStalledRecovery(current, { automatic: false });
      } else {
        this.setAgentAttached(false, "stalled");
      }
    }, this.answerWatchdogMs);
  }

  clearAnswerWatchdog() {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  canRecoverStalledEvent(event) {
    if (!this.recoverStalledBranch || event?.status !== "branch_request" || event.region) return false;
    const nodeId = this.pendingByRequest.get(event.request_id);
    const node = nodeId ? this.nodes.get(nodeId) : null;
    return !!(node && node.status === "pending");
  }

  // Once a compatible MCP client has recovered one stalled answer, later asks
  // can be handled without making the human re-open the same hole by hand.
  // The microtask gives an arriving normal MCP waiter first claim on the event.
  scheduleAutomaticRecovery(event) {
    if (!this.autoRecoveryMode || !this.canRecoverStalledEvent(event)) return;
    queueMicrotask(() => {
      if (this.closed || !this.autoRecoveryMode || !this.canRecoverStalledEvent(event)) return;
      const index = this.queue.indexOf(event);
      if (index === -1) return;
      this.queue.splice(index, 1);
      this.inFlightBranchRequests.set(event.request_id, event);
      this.enqueueStalledRecovery(event, { automatic: true });
    });
  }

  enqueueStalledRecovery(event, { automatic }) {
    const recoveryEpoch = this.recoveryEpoch;
    this.recoveryChain = this.recoveryChain
      .catch(() => {})
      .then(() => this.runStalledRecovery(event, { automatic, recoveryEpoch }));
    return this.recoveryChain;
  }

  async runStalledRecovery(event, { automatic, recoveryEpoch }) {
    if (this.closed || recoveryEpoch !== this.recoveryEpoch || (automatic && !this.autoRecoveryMode) || !this.canRecoverStalledEvent(event)) {
      return;
    }
    if (this.recoveryControllers.has(event.request_id)) return;

    const nodeId = this.pendingByRequest.get(event.request_id);
    const node = nodeId ? this.nodes.get(nodeId) : null;
    const parent = this.nodes.get(event.parent_node_id);
    if (!node || node.status !== "pending") return;

    const controller = new AbortController();
    this.recoveryControllers.set(event.request_id, controller);
    this.setAgentAttached(false, "recovering");
    try {
      const recovered = await this.recoverStalledBranch({ event, parent, node, signal: controller.signal });
      if (!recovered?.content) throw new Error("Stalled-branch recovery returned no answer");
      if (this.closed || controller.signal.aborted || this.pendingByRequest.get(event.request_id) !== nodeId) return;

      this.clearAnswerWatchdog();
      this.inFlightBranchRequests.delete(event.request_id);
      this.discardRegionFile(event.request_id);
      await this.finalizeBranchAnswer({
        requestId: event.request_id,
        title: recovered.title || node.title || "Follow-up",
        content: recovered.content,
        baseUrl: null,
        assets: [],
      });
      if (this.closed || controller.signal.aborted) return;
      this.autoRecoveryMode = true;
      this.setAgentAttached(true);
      log(`Session ${this.id} recovered stalled branch ${event.request_id} through MCP sampling`);
    } catch (error) {
      if (!this.closed && !controller.signal.aborted) {
        this.autoRecoveryMode = false;
        logError(`Session ${this.id} stalled-branch recovery failed: ${error.message}`);
        this.setAgentAttached(false, "stalled");
      }
    } finally {
      if (this.recoveryControllers.get(event.request_id) === controller) {
        this.recoveryControllers.delete(event.request_id);
      }
    }
  }

  stopAutomaticRecovery() {
    this.recoveryEpoch += 1;
    this.autoRecoveryMode = false;
    for (const requestId of [...this.recoveryControllers.keys()]) this.cancelStalledRecovery(requestId);
  }

  cancelStalledRecovery(requestId) {
    const controller = this.recoveryControllers.get(requestId);
    if (!controller) return;
    this.recoveryControllers.delete(requestId);
    controller.abort();
  }

  scheduleRearmDetach() {
    this.clearRearmDetach();
    this.rearmDetachTimer = setTimeout(() => {
      this.rearmDetachTimer = null;
      if (!this.closed) this.setAgentAttached(false, "cancelled");
    }, REARM_GRACE_MS);
    this.rearmDetachTimer.unref?.();
  }

  clearRearmDetach() {
    if (this.rearmDetachTimer) {
      clearTimeout(this.rearmDetachTimer);
      this.rearmDetachTimer = null;
    }
  }

  markAgentAttached() {
    this.clearRearmDetach();
    this.setAgentAttached(true);
  }

  setAgentAttached(attached, reason = null) {
    if (this.closed || (this.agentAttached === attached && this.agentReason === reason)) return;
    const becameDetached = this.agentAttached && !attached;
    this.agentAttached = attached;
    this.agentReason = reason;
    if (becameDetached) for (const request of this.convertRequests.values()) if (request.markdown) this.restoreNodeConversion(request.node_id);
    this.broadcast({ type: "agent_status", attached, reason });
  }

  // ---- SSE (server -> browser) -------------------------------------------

  broadcast(data) {
    // A streaming answer emits many node_progress events, but each one carries
    // the full accumulated content — only the latest matters for replay. Drop
    // the superseded one so chunks never crowd real events out of the buffer.
    if (data.type === "node_progress") {
      const stale = this.outboundEvents.findIndex(
        (e) => e.data.type === "node_progress" && e.data.node_id === data.node_id
      );
      if (stale !== -1) this.outboundEvents.splice(stale, 1);
    }
    const event = { id: ++this.lastOutboundEventId, data };
    this.outboundEvents.push(event);
    if (this.outboundEvents.length > MAX_REPLAY_EVENTS) {
      this.outboundEvents.splice(0, this.outboundEvents.length - MAX_REPLAY_EVENTS);
    }
    for (const client of this.sseClients) writeSseEvent(client, event);
  }

  // ---- node tree ----------------------------------------------------------

  dispatchHoleEvent(event, options = {}) {
    const reduced = reduceHoleEvent(this.state, event, { ...options, mutate: true });
    this.state = reduced.state;
    this.nodes = this.state.nodes;
    this.viewState = this.state.view_state;
    return reduced.effects || {};
  }

  lineageTitles(nodeId) {
    return lineageTitlesFromMap(this.nodes, nodeId);
  }

  buildHydration() {
    return {
      session_id: this.id,
      hole_id: this.holeId,
      title: this.title,
      root_id: this.rootId,
      // The highest event id reflected in this snapshot — the client passes it
      // back on its first /sse connect so any event broadcast in the gap between
      // serving this page and the EventSource connecting gets replayed.
      last_event_id: this.lastOutboundEventId,
      agent_attached: this.agentAttached,
      agent_reason: this.agentReason,
      view_state: this.viewState,
      nodes: holeStateToHydrationNodes(this.state),
    };
  }

  toHole() {
    // Answered nodes persist in full. Pending nodes persist as durable asks —
    // the question and its anchor survive, but any half-streamed markdown is
    // dropped: on resume the question is re-asked and answered fresh.
    const hole = holeStateToHole(this.state);
    return {
      ...hole,
      nodes: hole.nodes
        .filter((n) => (n.status ?? "answered") === "answered" || n.status === "pending")
        .map((n) => (n.status === "pending" ? { ...n, markdown: "" } : n)),
    };
  }

  scheduleSave() {
    this.saveChain.schedule();
  }

  flushSave() {
    return this.saveChain.flush();
  }

  // ---- the answer path (agent -> server -> browser) -----------------------

  createGenerationIngress(node) {
    return new GenerationIngress({
      id: this.mintGenerationRunId(),
      nodeId: node.id,
      fallbackTitle: node.title || "Untitled",
    });
  }

  async answerBranch({ requestId, title, content, partial, baseUrl, assets, signal }) {
    this.touch();
    if (this.closed) throw new Error("Rabbithole session is already closed");
    this.clearAnswerWatchdog();
    this.stopAutomaticRecovery();
    this.markAgentAttached();
    const inFlightEvent = this.inFlightBranchRequests.get(requestId);
    this.inFlightBranchRequests.delete(requestId);
    if (!partial) this.discardRegionFile(requestId);
    if (this.convertRequests.has(requestId)) return this.answerConversion({ requestId, content, partial, signal });

    // The human deleted this branch while the agent was writing it — absorb the
    // answer quietly: partials ack, the final call just blocks for the next event.
    if (this.cancelledRequests.has(requestId)) {
      if (partial) return { ok: true, node_id: null, request_id: requestId, partial: true, cancelled: true };
      this.cancelledRequests.delete(requestId);
      return this.waitForEvent(signal);
    }

    if (this.revisionRequests.has(requestId)) {
      return this.answerRevision({ requestId, title, content, partial, assets, signal, inFlightEvent });
    }

    // A partial call streams a chunk into the pending node and returns right
    // away — the request stays claimable, the watchdog stays armed (a death
    // mid-stream should still surface as stalled), and nothing persists yet.
    if (partial) {
      const nodeId = this.pendingByRequest.get(requestId);
      if (!nodeId) throw buildJsonError(`No pending branch request ${requestId}`, 404);
      const node = this.nodes.get(nodeId);
      if (!node) throw buildJsonError(`Node ${nodeId} not found`, 404);
      let ingress = this.generationByRequest.get(requestId);
      if (!ingress) {
        ingress = this.createGenerationIngress(node);
        this.generationByRequest.set(requestId, ingress);
      }

      const addedAssets = await addAssetsToHole(this.holeId, assets);
      for (const asset of addedAssets) this.assetNames.add(asset.name);

      const explicitBaseUrl = normalizeBaseUrl(baseUrl);
      const baseUrlFields = explicitBaseUrl
        ? { base_url: explicitBaseUrl, base_url_source: "explicit" }
        : { base_url: node.base_url, base_url_source: node.base_url_source };
      const progress = ingress.acceptChunk(content, { progressFields: baseUrlFields });
      this.dispatchHoleEvent(progress);
      const updated = this.nodes.get(node.id);
      // Keep the original event claimable. If a stream dies, sampling can
      // continue from updated.markdown rather than abandoning the branch.
      if (inFlightEvent) this.inFlightBranchRequests.set(requestId, inFlightEvent);
      this.startAnswerWatchdog();
      // Deliberately untagged outbound projection: `progress` already passed
      // through the reducer with its GenerationRun tag; the SSE payload mirrors
      // canonical node state and is never reducer input.
      this.broadcast({
        type: "node_progress",
        node_id: updated.id,
        markdown: updated.markdown,
        base_url: updated.base_url,
        base_url_source: updated.base_url_source,
      });
      return { ok: true, node_id: updated.id, request_id: requestId, partial: true };
    }

    await this.finalizeBranchAnswer({ requestId, title, content, baseUrl, assets });
    return this.waitForEvent(signal);
  }

  async answerRevision({ requestId, title, content, partial, assets, signal, inFlightEvent }) {
    const request = this.revisionRequests.get(requestId);
    if (!request) throw buildJsonError(`No pending revision request ${requestId}`, 404);
    const node = this.nodes.get(request.node_id);
    if (!isRevisableAnswer(node)) {
      this.revisionRequests.delete(requestId);
      throw buildJsonError("The answer being revised is no longer available", 409);
    }
    if (request.region) {
      return this.answerSelectionRevision({ request, requestId, node, content, partial, assets, signal, inFlightEvent });
    }
    let ingress = request.ingress;
    if (!ingress) {
      ingress = this.createGenerationIngress(node);
      request.ingress = ingress;
    }
    const addedAssets = await addAssetsToHole(this.holeId, assets);
    for (const asset of addedAssets) this.assetNames.add(asset.name);
    const result = ingress.acceptChunk(content, { final: !partial, title });
    if (partial) {
      if (inFlightEvent) this.inFlightBranchRequests.set(requestId, inFlightEvent);
      this.startAnswerWatchdog();
      this.broadcast({ type: "revision_progress", request_id: requestId, node_id: node.id,
        title: ingress.run.snapshot().title, markdown: result.markdown });
      return { ok: true, node_id: node.id, request_id: requestId, partial: true, revision: true };
    }
    this.revisionRequests.delete(requestId);
    this.broadcast({ type: "revision_ready", request_id: requestId, node_id: node.id,
      title: result.title, markdown: result.markdown });
    return this.waitForEvent(signal);
  }

  // A selection revision streams a fragment, not a card. It deliberately skips
  // the generation ingress: that accumulator builds a whole document and mints
  // block ids for it, both wrong for a span that will be spliced between two
  // offsets of an existing one.
  async answerSelectionRevision({ request, requestId, node, content, partial, assets, signal, inFlightEvent }) {
    const addedAssets = await addAssetsToHole(this.holeId, assets);
    for (const asset of addedAssets) this.assetNames.add(asset.name);
    request.fragment += String(content ?? "");
    if (partial) {
      if (inFlightEvent) this.inFlightBranchRequests.set(requestId, inFlightEvent);
      this.startAnswerWatchdog();
      this.broadcast({ type: "revision_progress", request_id: requestId, node_id: node.id,
        scope: "selection", selection: request.region, fragment: request.fragment });
      return { ok: true, node_id: node.id, request_id: requestId, partial: true, revision: true };
    }
    this.revisionRequests.delete(requestId);
    // Re-checked at the end as well as at the start: the card can be edited
    // from another surface while the agent writes, and a span that moved in the
    // meantime would splice this fragment over the wrong words.
    this.broadcast({ type: "revision_ready", request_id: requestId, node_id: node.id,
      scope: "selection", selection: request.region,
      fragment: normalizeRevisionFragment(request.fragment, request.region.region_markdown),
      stale: !selectionRegionMatches(node.markdown, request.region) });
    return this.waitForEvent(signal);
  }

  async finalizeBranchAnswer({ requestId, title, content, baseUrl, assets }) {
    const nodeId = this.pendingByRequest.get(requestId);
    if (!nodeId) throw buildJsonError(`No pending branch request ${requestId}`, 404);
    const node = this.nodes.get(nodeId);
    if (!node) throw buildJsonError(`Node ${nodeId} not found`, 404);
    let ingress = this.generationByRequest.get(requestId);
    if (!ingress) {
      ingress = this.createGenerationIngress(node);
      this.generationByRequest.set(requestId, ingress);
    }

    const addedAssets = await addAssetsToHole(this.holeId, assets);
    for (const asset of addedAssets) this.assetNames.add(asset.name);

    const explicitBaseUrl = normalizeBaseUrl(baseUrl);
    const baseUrlFields = explicitBaseUrl
      ? { base_url: explicitBaseUrl, base_url_source: "explicit" }
      : { base_url: node.base_url, base_url_source: node.base_url_source };

    // Asset ingress succeeded, so this response now owns the pending request.
    this.pendingByRequest.delete(requestId);
    this.generationByRequest.delete(requestId);

    // GenerationIngress accepts both final tails and repeated full answers;
    // the session remains responsible only for node metadata and lifecycle.
    const answeredFields = {
      parent_id: node.parent_id,
      ...baseUrlFields,
      origin: node.origin,
      position: node.position,
      size: node.size,
      font_scale: node.font_scale,
      // Fresh answers land unread; the client flips this the moment the human
      // actually opens them (and immediately if they're watching it stream).
      read: false,
    };
    const answered = ingress.acceptChunk(content, { final: true, title, answeredFields });
    if (!explicitBaseUrl) maybeUpgradeBaseUrlFromFrontmatter(answered);
    this.dispatchHoleEvent(answered);
    const finalNode = this.nodes.get(nodeId);

    this.broadcast(buildNodeAnsweredEvent(finalNode));
    await this.flushSave();
    return finalNode;
  }

  async answerConversion({ requestId, content, partial, signal }) {
    const request = this.convertRequests.get(requestId), node = this.nodes.get(request.node_id);
    if (!node) throw buildJsonError("Conversion node not found", 404);
    request.markdown += String(content || "");
    // request.pdf was validated at convert start against the original body —
    // the live body is the stream itself, so re-normalizing here would fail.
    const pdf = request.pdf;
    this.dispatchHoleEvent({ type: "node_progress", node_id: node.id, markdown: request.markdown });
    this.broadcast({ type: "pdf_convert_progress", node_id: node.id, markdown: request.markdown, page_done: pdf.pages.at(-1)?.n || 0, page_total: pdf.pages.length });
    if (partial) { this.startAnswerWatchdog(); this.scheduleSave(); return { ok: true, node_id: node.id, request_id: requestId, partial: true }; }
    const materialized = await this.materializeNodeFigures(request.markdown, pdf);
    this.dispatchHoleEvent({ ...buildNodeAnsweredEvent(this.nodes.get(node.id)), markdown: materialized });
    this.patchNodePdf(node.id, { ...pdf, converting: false, converted: true, convert_request: false });
    this.convertRequests.delete(requestId); await this.flushSave(); this.broadcast(buildNodeAnsweredEvent(this.nodes.get(node.id)));
    return this.waitForEvent(signal);
  }

  discardRegionFile(requestId) {
    const filePath = this.regionFiles.get(requestId);
    if (!filePath) return;
    this.regionFiles.delete(requestId);
    fs.unlink(filePath).catch(() => {});
  }

  async materializeNodeFigures(markdown, pdf, figureBudget = { bytes: 0 }) {
    const replacements = []; let ordinal = 0;
    for (const ref of parseFigureRefs(markdown)) {
      let replacement = `*${ref.caption || "Figure"}*`; const page = pdf.pages.find((entry) => entry.n === ref.page);
      // Figures share the export headroom — past the byte budget or asset cap
      // they degrade to caption text, never fail the conversion.
      if (page && ref.rect && this.assetNames.size < 200 && figureBudget.bytes < MAX_PDF_FIGURE_ASSET_BYTES) try {
        const name = `fig-p${String(ref.page).padStart(3, "0")}-${++ordinal}.png`;
        const { bytes } = await cropPdfFigureToAsset({ holeId: this.holeId, asset: pdf.source.asset, pageNumber: page.n, rect: ref.rect, name });
        if (figureBudget.bytes + bytes > MAX_PDF_FIGURE_ASSET_BYTES) { await defaultFsStore.deleteAsset(this.holeId, name).catch(() => {}); throw new Error("figure budget"); }
        figureBudget.bytes += bytes; this.assetNames.add(name); replacement = `![${ref.caption}](asset:${name})`;
      } catch {}
      replacements.push({ ref, markdown: replacement });
    }
    return rewriteFigureRefs(markdown, replacements);
  }

  patchNodePdf(nodeId, value) { this.dispatchHoleEvent({ type: "node_extensions_patch", node_id: nodeId, namespace: "pdf", value }); this.broadcast({ type: "node_extensions_patch", node_id: nodeId, namespace: "pdf", value }); this.scheduleSave(); }

  // Restore reads the RAW extension: mid-run the node body is the streamed
  // output, so normalizePdfExtension (which validates offsets against the live
  // body) would reject exactly the state this method exists to repair.
  restoreNodeConversion(nodeId) {
    const raw = this.nodes.get(nodeId)?.extensions?.pdf;
    if (!raw || raw.version !== 2) return;
    this.dispatchHoleEvent({ type: "node_progress", node_id: nodeId, markdown: String(raw.original_markdown ?? this.nodes.get(nodeId).markdown ?? "") });
    this.patchNodePdf(nodeId, { ...raw, converting: false, converted: false, convert_request: false });
    for (const [id, request] of this.convertRequests) if (request.node_id === nodeId) this.convertRequests.delete(id);
  }

  async handleConvertPdf(payload, { saved = false } = {}) {
    const nodeId = String(payload.node_id || ""), node = this.nodes.get(nodeId), pdf = normalizePdfExtension(node);
    if (!pdf) throw buildJsonError("This node is not a native PDF", 400);
    if ([...this.nodes.values()].some((candidate) => candidate.parent_id === nodeId)) throw buildJsonError("Create a text version before asking follow-ups", 409);
    if (pdf.converting && !saved) throw buildJsonError("Conversion is already running", 409);
    const requestId = randomUUID();
    if (!pdf.converting) this.patchNodePdf(nodeId, { ...pdf, converting: true, converted: false, original_markdown: node.markdown, convert_request: true });
    const activePdf = normalizePdfExtension({ markdown: node.markdown, extensions: { pdf: this.nodes.get(nodeId).extensions?.pdf } });
    this.convertRequests.set(requestId, { node_id: nodeId, markdown: "", pdf: activePdf });
    const pages = await Promise.all(activePdf.pages.map(async (page) => {
      const key = `convert-${requestId}-${page.n}`;
      const imagePath = await renderPdfPageToFile({ holeId: this.holeId, asset: activePdf.source.asset, pageNumber: page.n, requestId: key });
      this.regionFiles.set(key, imagePath);
      return { n: page.n, image_path: imagePath };
    }));
    const event = { status: "convert_request", session_id: this.id, request_id: requestId, node_id: nodeId, page_count: activePdf.pages.length,
      pages, rules: TRANSCRIBE_V1_RULES, ...(saved ? { saved: true } : {}) };
    this.pushEvent(event); await this.flushSave(); return { ok: true, node_id: nodeId, request_id: requestId };
  }

  requeueSavedConversions() {
    for (const node of this.nodes.values()) {
      const raw = node?.extensions?.pdf;
      if (!raw || raw.version !== 2 || !raw.converting) continue;
      // Mid-run saves persist the streamed body — put the original back before
      // deciding anything else, then re-issue the request as a saved convert.
      this.restoreNodeConversion(node.id);
      if (raw.convert_request) queueMicrotask(() => this.handleConvertPdf({ node_id: node.id }, { saved: true }).catch((error) => logError(error.message)));
    }
  }

  buildRehydrationPayload() {
    const saved = [...this.nodes.values()].filter((n) => n.status === "pending" && n.origin);
    return {
      title: this.title,
      nodes: [...this.nodes.values()]
        .filter((n) => n.status === "answered")
        .map((n) => ({ id: n.id, parent_id: n.parent_id, title: n.title, markdown: n.markdown })),
      ...(saved.length
        ? {
            saved_asks: saved.map((n) => ({
              node_id: n.id,
              question: n.origin.question || "",
              selected_text: n.origin.selected_text || "",
            })),
          }
        : {}),
    };
  }

  // Re-queue every persisted pending ask for the agent, oldest first. Runs at
  // construction on resume, before the agent's first waitForEvent, so saved
  // questions are answered before anything new.
  requeueSavedAsks() {
    let enqueue = Promise.resolve();
    const saved = [...this.nodes.values()]
      .filter((n) => n.status === "pending" && n.origin)
      .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
    for (const node of saved) {
      const requestId = randomUUID();
      this.pendingByRequest.set(requestId, node.id);
      const parent = this.nodes.get(node.parent_id);
      const chatContext = resolveChatContext(this.nodes, node.parent_id, normalizeChatContextRef(node.origin));
      const event = {
        status: "branch_request",
        session_id: this.id,
        request_id: requestId,
        node_id: node.id,
        parent_node_id: node.parent_id,
        parent_node_title: parent?.title || "Untitled",
        selected_text: node.origin.selected_text || "",
        question: node.origin.question || "",
        lens: node.origin.lens || null,
        lineage: this.lineageTitles(node.parent_id),
        saved: true, // asked while the agent was away; answer it like any other
        ...(chatContext ? { chat_context: describeChatContext(chatContext) } : {}),
      };
      if (this.needsRehydration) {
        this.needsRehydration = false;
        event.rehydration = this.buildRehydrationPayload();
      }
      enqueue = enqueue.then(() => this.queueBranchEvent(event, node, parent));
    }
    enqueue.catch((error) => logError(`Saved branch requeue failed: ${error.message}`));
  }

  // ---- browser events (browser -> server) ---------------------------------

  handleBranchRequest(payload, preparedCrop = null) {
    const parentId = String(payload.parent_id || "");
    const parent = this.nodes.get(parentId);
    if (!parent) throw buildJsonError(`Parent node ${parentId} not found`, 404);
    // Raw flag, not normalizePdfExtension: mid-run the body is the stream and
    // normalization rejects it — which would drop the lock exactly when it matters.
    if (parent.extensions?.pdf?.converting) throw buildJsonError("This PDF is being converted", 409);

    const requestId = String(payload.request_id || randomUUID());
    const nodeId = String(payload.node_id || randomUUID());
    const effects = this.dispatchHoleEvent(
      { ...payload, type: "branch_request", request_id: requestId, node_id: nodeId, parent_id: parentId },
      { now: new Date().toISOString() }
    );
    const node = effects.createdNode;
    this.pendingByRequest.set(requestId, nodeId);
    const chatContext = resolveChatContext(this.nodes, parentId, normalizeChatContextRef(node.origin));

    const event = {
      status: "branch_request",
      session_id: this.id,
      request_id: requestId,
      node_id: nodeId,
      parent_node_id: parentId,
      parent_node_title: parent.title || "Untitled",
      selected_text: node.origin.selected_text,
      question: node.origin.question,
      lens: node.origin.lens,
      lineage: this.lineageTitles(parentId),
      ...(chatContext ? { chat_context: describeChatContext(chatContext) } : {}),
    };

    if (this.needsRehydration) {
      this.needsRehydration = false;
      event.rehydration = this.buildRehydrationPayload();
    }

    // Persist the ask immediately (not just on answer/close) so a crash or
    // SIGKILL between ask and answer can't lose the question.
    this.scheduleSave();

    this.queueBranchEvent(event, node, parent, preparedCrop).catch((error) => {
      logError(`PDF region attachment failed: ${error.message}`);
      this.pushEvent(event);
    });
    return { ok: true, node_id: nodeId, request_id: requestId };
  }

  handleRevisionRequest(payload) {
    const node = this.nodes.get(String(payload.node_id || ""));
    if (!isRevisableAnswer(node)) throw buildJsonError("Only completed answer cards can be revised with AI", 409);
    const instruction = String(payload.instruction || "").trim();
    if (!instruction) throw buildJsonError("Tell AI how to revise this card", 400);
    const region = readSelectionRegion(payload.selection);
    if (region && !selectionRegionMatches(node.markdown, region)) {
      throw buildJsonError("This card changed since that passage was selected — select it again", 409);
    }
    const requestId = String(payload.request_id || randomUUID());
    for (const [id, request] of this.revisionRequests) {
      if (request.node_id !== node.id) continue;
      this.revisionRequests.delete(id);
      this.inFlightBranchRequests.delete(id);
      this.queue = this.queue.filter((event) => event.request_id !== id);
      this.cancelledRequests.add(id);
    }
    this.revisionRequests.set(requestId, { node_id: node.id, instruction, ingress: null, region, fragment: "" });
    const event = {
      status: "revision_request",
      session_id: this.id,
      request_id: requestId,
      node_id: node.id,
      current_title: node.title || "Untitled",
      current_markdown: node.markdown || "",
      instruction,
      lineage: this.lineageTitles(node.id),
      response_contract: region
        ? SELECTION_RESPONSE_CONTRACT
        : "Return the complete replacement Markdown. Stream with answer_branch partial=true, then finish with the revised card title.",
    };
    if (region) event.selection = region;
    if (this.needsRehydration) {
      this.needsRehydration = false;
      event.rehydration = this.buildRehydrationPayload();
    }
    this.pushEvent(event);
    return { ok: true, node_id: node.id, request_id: requestId };
  }

  handleRevisionCancel(payload) {
    const requestId = String(payload.request_id || "");
    if (this.revisionRequests.delete(requestId)) this.cancelledRequests.add(requestId);
    this.inFlightBranchRequests.delete(requestId);
    this.queue = this.queue.filter((event) => event.request_id !== requestId);
    return { ok: true, request_id: requestId };
  }

  async handleRevisionSaveAsBranch(payload) {
    const parent = this.nodes.get(String(payload.node_id || ""));
    if (!isRevisableAnswer(parent)) throw buildJsonError("The source answer is no longer available", 409);
    const nodeId = String(payload.child_id || randomUUID());
    const position = payload.position || {
      x: Number(parent.position?.x || 0) + Number(parent.size?.w || 420) + 80,
      y: Number(parent.position?.y || 0),
    };
    const event = {
      type: "node_answered", node_id: nodeId, parent_id: parent.id,
      title: String(payload.title || parent.title || "Revision").trim() || "Revision",
      markdown: String(payload.markdown || ""),
      base_url: parent.base_url || null,
      base_url_source: parent.base_url ? "inherited" : null,
      origin: { selected_text: "", question: String(payload.instruction || "AI revision"), lens: null,
        anchor: null, branch_type: "followup", revision_of: parent.id },
      position, size: payload.size || { w: 420, h: 360 }, font_scale: 1, collapsed: false, read: false,
    };
    this.dispatchHoleEvent(event, { now: new Date().toISOString() });
    const child = this.nodes.get(nodeId);
    this.broadcast(buildNodeAnsweredEvent(child));
    await this.flushSave();
    return { ok: true, node_id: nodeId };
  }

  async preparePdfCrop(payload) {
    const parent = this.nodes.get(String(payload.parent_id || ""));
    const anchor = normalizePdfAnchor(payload.anchor?.pdf);
    const pdf = normalizePdfExtension(parent);
    const pageNumber = anchor?.fragments?.[0]?.page;
    if (!pdf || !pageNumber || !pdf.pages.some((entry) => entry.n === pageNumber)) return null;
    await this.regionSweep;
    const imagePath = await cropPdfRegionToFile({ holeId: this.holeId, asset: pdf.source.asset, anchor, pageNumber, requestId: payload.request_id });
    this.regionFiles.set(String(payload.request_id), imagePath);
    return { imagePath, page: pageNumber };
  }

  async queueBranchEvent(event, node, parent, preparedCrop = null) {
    if (preparedCrop?.imagePath) {
      event.region = { page: preparedCrop.page, image_path: preparedCrop.imagePath };
      this.pushEvent(event);
      return;
    }

    const anchor = node?.origin?.anchor?.pdf || parent?.origin?.anchor?.pdf;
    let sourceNode = parent;
    while (sourceNode && !normalizePdfExtension(sourceNode)) sourceNode = this.nodes.get(sourceNode.parent_id);
    const pdf = anchor ? normalizePdfExtension(sourceNode) : null;
    const pageNumber = anchor?.fragments?.[0]?.page;
    if (pdf && pageNumber && pdf.pages.some((entry) => entry.n === pageNumber)) try {
      await this.regionSweep;
      const imagePath = await cropPdfRegionToFile({ holeId: this.holeId, asset: pdf.source.asset, anchor, pageNumber, requestId: event.request_id });
      event.region = { page: pageNumber, image_path: imagePath };
      this.regionFiles.set(event.request_id, imagePath);
    } catch (error) {
      logError(`PDF region crop failed: ${error.message}`);
    }
    this.pushEvent(event);
  }

  // Remove a branch and its whole subtree. Any in-flight ask targeting a doomed
  // node is cancelled (a late answer is absorbed, not errored), queued requests
  // the agent never saw are dropped, and the SSE replay buffer is scrubbed so a
  // reconnect can't resurrect a deleted node via node_answered self-healing.
  async handleDeleteNode(payload) {
    const targetId = String(payload.node_id || "");
    if (!targetId || targetId === this.rootId) throw buildJsonError("The starting document can't be removed", 400);
    if (!this.nodes.has(targetId)) return { ok: true, deleted: [] };

    const effects = this.dispatchHoleEvent({ type: "delete_node", node_id: targetId });
    const doomed = new Set(effects.deletedNodeIds || []);
    for (const [reqId, nodeId] of [...this.pendingByRequest]) {
      if (doomed.has(nodeId)) {
        this.pendingByRequest.delete(reqId);
        this.generationByRequest.delete(reqId);
        this.cancelStalledRecovery(reqId);
        this.cancelledRequests.add(reqId);
        this.inFlightBranchRequests.delete(reqId);
        this.discardRegionFile(reqId);
      }
    }
    for (const [reqId, request] of [...this.revisionRequests]) {
      if (!doomed.has(request.node_id)) continue;
      this.revisionRequests.delete(reqId);
      this.inFlightBranchRequests.delete(reqId);
      this.cancelledRequests.add(reqId);
    }
    this.queue = this.queue.filter((ev) => !(ev.node_id && doomed.has(ev.node_id)));
    this.outboundEvents = this.outboundEvents.filter((e) => !(e.data.node_id && doomed.has(e.data.node_id)));
    await this.gcAssetsForDeletedNodes(effects.deletedNodes || []);
    this.broadcast({ type: "node_deleted", node_ids: [...doomed] });
    this.scheduleSave();
    return { ok: true, deleted: [...doomed] };
  }

  async gcAssetsForDeletedNodes(deletedNodes) {
    const orphaned = assetsOrphanedByDeletion({ deletedNodes, remainingNodes: this.nodes.values(), extractRefs: extractNodeAssetRefs });
    for (const name of orphaned) {
      try {
        await defaultFsStore.deleteAsset(this.holeId, name);
        this.assetNames.delete(name);
      } catch (err) {
        logError(`Asset GC failed for ${name}: ${err.message}`);
      }
    }
  }

  handleNodeUpdate(payload) {
    if (!this.nodes.has(String(payload.node_id || ""))) return { ok: true }; // tolerate updates for transient nodes
    return this.applyPersistedBrowserEvent(payload);
  }

  // Batched layout update (e.g. Tidy) — one request, one debounced save.
  handleNodesUpdate(payload) {
    return this.applyPersistedBrowserEvent(payload);
  }

  applyPersistedBrowserEvent(payload) {
    return applyPersistedBrowserEvent(payload, {
      dispatch: (event) => this.dispatchHoleEvent(event),
      scheduleSave: () => this.scheduleSave(),
    });
  }

  async handleBrowserEvent(payload) {
    return dispatchBrowserEvent(payload, {
      handlers: {
        branch_request: async (event) => {
          let preparedCrop = null;
          try { preparedCrop = await this.preparePdfCrop(event); }
          catch (error) { logError(`PDF crop persistence failed: ${error.message}`); }
          const result = this.handleBranchRequest(event, preparedCrop);
          await this.flushSave();
          return result;
        },
        revision_request: (event) => this.handleRevisionRequest(event),
        revision_cancel: (event) => this.handleRevisionCancel(event),
        revision_save_as_branch: (event) => this.handleRevisionSaveAsBranch(event),
        canvas_node_create: async (event) => {
          const result = this.applyPersistedBrowserEvent(event);
          await this.flushSave();
          return { ...result, node_id: String(event.node_id || "") };
        },
        canvas_node_content: (event) => this.applyPersistedBrowserEvent(event),
        answer_node_content: (event) => this.applyPersistedBrowserEvent(event),
        // Anchors move when the text they point at is rewritten, so the
        // surface that rewrites it also reports where they landed.
        node_origin: (event) => this.applyPersistedBrowserEvent(event),
        node_update: (event) => this.handleNodeUpdate(event),
        nodes_update: (event) => this.handleNodesUpdate(event),
        block_state: (event) => this.applyPersistedBrowserEvent(event),
        node_extensions_patch: (event) => {
          const result = this.applyPersistedBrowserEvent(event);
          this.broadcast({ type: "node_extensions_patch", node_id: event.node_id, namespace: event.namespace, value: event.value });
          return result;
        },
        convert_pdf: (event) => this.handleConvertPdf(event),
        convert_cancel: (event) => { this.restoreNodeConversion(String(event.node_id || "")); return { ok: true }; },
        delete_node: (event) => this.handleDeleteNode(event),
        view_state: (event) => this.applyPersistedBrowserEvent(event),
        done: () => { this.close("done"); return { ok: true }; },
      },
      unsupported: (type) => { throw buildJsonError(`Unsupported browser event: ${type}`, 400); },
    });
  }

  // ---- HTTP routing -------------------------------------------------------

  async handleRequest(req, res) {
    return handleSessionRequest(this, req, res);
  }
}

function isRevisableAnswer(node) {
  return !!node && node.parent_id != null && node.status === "answered"
    && !canvasNodeKind(node) && !normalizePdfExtension(node);
}
