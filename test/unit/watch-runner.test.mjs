import assert from "node:assert/strict";
import { buildCodexAppServerArgs } from "../../src/node/watch/driver.js";
import { runWatchLoop, splitMarkdownChunks } from "../../src/node/watch/runner.js";

{
  const calls = [];
  let openCount = 0;
  const driver = {
    async open(holeId) {
      calls.push(["open", holeId]);
      openCount += 1;
      if (openCount === 1) return { status: "keep_listening", hole_id: holeId };
      return { status: "branch_request", session_id: "session", request_id: "request", question: "Why?" };
    },
    async generateBranch(event) {
      calls.push(["generate", event.request_id]);
      return { title: "Because", content: "An answer." };
    },
    async answer(event, answer) {
      calls.push(["answer", event.request_id, answer.title]);
      return { status: "session_closed", reason: "done" };
    },
  };

  const statuses = [];
  const result = await runWatchLoop({ holeId: "steady-rabbit", driver, onStatus: (event) => statuses.push(event.status) });
  assert.equal(result.status, "session_closed");
  assert.deepEqual(calls, [
    ["open", "steady-rabbit"],
    ["open", "steady-rabbit"],
    ["generate", "request"],
    ["answer", "request", "Because"],
  ]);
  assert.deepEqual(statuses, ["keep_listening", "branch_request", "session_closed"]);
}

{
  let opens = 0;
  const result = await runWatchLoop({
    holeId: "recover-rabbit",
    driver: {
      async open() {
        opens += 1;
        return opens === 1 ? { status: "cancelled" } : { status: "session_closed" };
      },
    },
  });
  assert.equal(result.status, "session_closed");
  assert.equal(opens, 2, "cancelled waits must resume the same hole");
}

{
  const fenced = `${"Paragraph. ".repeat(220)}\n\n\`\`\`show\n<div>${"x".repeat(2_000)}</div>\n\`\`\`\n\nTail.`;
  const chunks = splitMarkdownChunks(fenced, 800);
  assert.equal(chunks.join(""), fenced);
  assert.equal(chunks.filter((chunk) => chunk.includes("```show")).length, 1);
  assert.match(chunks.find((chunk) => chunk.includes("```show")), /```show[\s\S]*```/);
}

{
  assert.deepEqual(buildCodexAppServerArgs(), ["app-server", "--stdio"]);
}

console.log("ok watch runner: deterministic re-arm, cancellation recovery, chunks, and Codex launch");
