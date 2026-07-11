/**
 * Generation adapter vocabulary for Phase 6.
 *
 * Runtime authority for the browser brain surfaces and their current raw-text
 * streams: {@link ../../web/brain/openai-compatible.js},
 * {@link ../../web/brain/anthropic-messages.js}, and
 * {@link ../../web/brain/index.js}. Current consumers and title extraction are
 * {@link ../../web/transport/direct-host.js},
 * {@link ../../web/brain/title-sentinel.js}, and {@link ../../web/app.js}.
 * The passive MCP ingress is {@link ../../node/transport/session.js}
 * (`answerBranch`); it has no browser-style `Brain` and receives partial/final
 * tool calls carrying `content`, `partial`, and `title` instead.
 *
 * This declaration is Phase 6 vocabulary, not a claim that producers already
 * emit it uniformly. Browser brains currently yield raw string chunks and the
 * host derives titles; Phase 6 normalizes those producers to `GenerationEvent`.
 * The MCP host remains a separate ingress with its own persistence policy.
 * Transport-level run tagging uses `ProgressRun` from {@link ./engine.js} and
 * begins in Phase 6; it is intentionally not redeclared here.
 */

export interface TextGenerationEvent {
  type: "text";
  delta: string;
}

export interface TitleGenerationEvent {
  type: "title";
  title: string;
}

export type GenerationEvent = TextGenerationEvent | TitleGenerationEvent;

/**
 * Browser generation surface shared by today's OpenAI-compatible and
 * Anthropic brains. Inputs remain opaque here because prompt builders own their
 * shapes; the stable adapter boundary is the three method names, abort signal,
 * and generated event stream.
 */
export interface Brain {
  answerBranch(context: unknown, signal: AbortSignal): AsyncIterable<GenerationEvent>;
  authorExplainer(context: unknown, signal: AbortSignal): AsyncIterable<GenerationEvent>;
  authorDocument(source: unknown, signal: AbortSignal): AsyncIterable<GenerationEvent>;
}
