import assert from "node:assert/strict";
import { CodexAppServerClient } from "../../src/node/watch/app-server.js";

const mockServer = String.raw`
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: message.id, result: { serverInfo: { name: "mock" } } }) + "\n");
  } else if (message.method === "echo") {
    process.stdout.write(JSON.stringify({ id: message.id, result: message.params }) + "\n");
    process.stdout.write(JSON.stringify({ method: "event/done", params: { token: message.params.token } }) + "\n");
  }
});
`;

const client = new CodexAppServerClient({ command: process.execPath, args: ["-e", mockServer] });
try {
  await client.start();
  const notification = client.waitForNotification("event/done", (params) => params.token === "rabbit");
  const response = await client.request("echo", { token: "rabbit" });
  assert.deepEqual(response, { token: "rabbit" });
  assert.deepEqual(await notification, { token: "rabbit" });
} finally {
  await client.close();
}

console.log("ok watch app-server: JSONL requests and notifications");
