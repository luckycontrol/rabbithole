function assertEvent(event) {
  if (!event || typeof event.status !== "string") {
    throw new Error(`Rabbithole returned an invalid event: ${JSON.stringify(event)}`);
  }
  return event;
}

/**
 * Deterministic re-arm loop. The driver performs I/O; this state machine makes
 * sure keep-alives never depend on an LLM choosing to invoke a tool.
 */
export async function runWatchLoop({ holeId, driver, signal, onStatus = () => {} }) {
  if (!holeId) throw new Error("holeId is required");
  let event = assertEvent(await driver.open(holeId, { signal }));

  while (true) {
    onStatus(event);
    switch (event.status) {
      case "keep_listening":
      case "cancelled":
        event = assertEvent(await driver.open(holeId, { signal }));
        break;
      case "branch_request": {
        const answer = await driver.generateBranch(event, { signal });
        event = assertEvent(await driver.answer(event, answer, { signal }));
        break;
      }
      case "convert_request":
        event = assertEvent(await driver.convert(event, { signal }));
        break;
      case "session_closed":
        return event;
      default:
        throw new Error(`Unsupported Rabbithole status: ${event.status}`);
    }
  }
}

/** Split prose for live rendering while keeping fenced blocks intact. */
export function splitMarkdownChunks(markdown, targetSize = 1_600) {
  const source = String(markdown || "");
  if (!source) return [""];
  const lines = source.split(/(?<=\n)/);
  const chunks = [];
  let chunk = "";
  let inFence = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    chunk += line;
    if (!inFence && chunk.length >= targetSize && /\n\s*\n$/.test(chunk)) {
      chunks.push(chunk);
      chunk = "";
    }
  }
  if (chunk || chunks.length === 0) chunks.push(chunk);
  return chunks;
}
