import assert from "node:assert/strict";
import { routeProvider, seedConfiguredOpenRouter } from "../support/provider-mock.mjs";
import { bootWebApp } from "../support/web-app-harness.mjs";

const PROVIDER_URL = "https://openrouter.ai/api/v1/chat/completions";

const app = await bootWebApp();
const { browser, baseUrl } = app;
try {
  const context = await browser.newContext();
  await seedConfiguredOpenRouter(context);
  const page = await context.newPage();
  const requests = [];
  page.on("request", (request) => {
    if (request.url() === PROVIDER_URL && request.method() === "POST") requests.push(request.postDataJSON());
  });
  await routeProvider(page, {
    streams: [
      ["TITLE: First answer\n", "The first answer uses the root page."],
      ["TITLE: Second answer\n", "The second answer remembers the first turn."],
      ["TITLE: Fresh answer\n", "This belongs to a new conversation."],
    ],
  });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.keyboard.press("Escape");
  await createDocument(page, "# Reader chat context\n\nA distinctive root page about orbital gardens.");
  await page.click("#t-reader");

  assert.equal(await page.locator("#reader-chat-panel").isVisible(), false, "chat starts collapsed");
  assert.equal(await page.getAttribute("#reader-chat-fab", "aria-expanded"), "false");
  await page.click("#reader-chat-fab");
  assert.equal(await page.locator("#reader-chat-panel").isVisible(), true, "chat button opens the compact panel");
  assert.equal(await page.getAttribute("#reader-chat-panel", "aria-hidden"), "false");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "composer-text", "opening focuses the question field");

  await page.fill("#composer-text", "What is special here?");
  await page.click("#composer-send");
  await page.locator("#reader-chat-log .reader-chat-turn", { hasText: "The first answer uses the root page." }).waitFor();
  assert.equal(await page.locator("#reader-chat-log .reader-chat-turn").count(), 1);

  await page.fill("#composer-text", "How does that affect maintenance?");
  await page.click("#composer-send");
  await page.locator("#reader-chat-log .reader-chat-turn", { hasText: "The second answer remembers the first turn." }).waitFor();
  assert.equal(await page.locator("#reader-chat-log .reader-chat-turn").count(), 2);
  await waitForRequests(requests, 2);
  const secondPrompt = JSON.stringify(requests[1]);
  assert.match(secondPrompt, /orbital gardens/, "a later turn retains the original page");
  assert.match(secondPrompt, /What is special here\?/, "a later turn retains the earlier question");
  assert.match(secondPrompt, /first answer uses the root page/i, "a later turn retains the earlier answer");

  const storedBeforeNew = await page.evaluate(() => window.__rabbitholeTest.readStoredHole());
  const branchCountBeforeNew = storedBeforeNew.nodes.length;
  await page.fill("#composer-text", "Keep this unsent draft");
  await page.click("#reader-chat-new");
  assert.equal(await page.locator("#reader-chat-log .reader-chat-turn").count(), 0, "new chat clears only the visible conversation");
  assert.equal(await page.inputValue("#composer-text"), "Keep this unsent draft", "new chat preserves the unsent draft");
  assert.equal((await page.evaluate(() => window.__rabbitholeTest.readStoredHole())).nodes.length, branchCountBeforeNew,
    "new chat leaves existing Rabbithole branches intact");

  await page.fill("#composer-text", "Start over from the page");
  await page.click("#composer-send");
  await page.locator("#reader-chat-log .reader-chat-turn", { hasText: "This belongs to a new conversation." }).waitFor();
  await waitForRequests(requests, 3);
  const freshPrompt = JSON.stringify(requests[2]);
  assert.match(freshPrompt, /orbital gardens/);
  assert.doesNotMatch(freshPrompt, /What is special here\?/, "new chat excludes the earlier conversation");

  await page.click("#reader-chat-collapse");
  await page.waitForFunction(() => !document.body.classList.contains("reader-chat-open"));
  assert.equal(await page.getAttribute("#reader-chat-panel", "aria-hidden"), "true");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "reader-chat-fab", "collapse returns focus to the chat button");
  await page.click("#reader-chat-fab");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.body.classList.contains("reader-chat-open"));
  assert.equal(await page.getAttribute("#reader-chat-panel", "aria-hidden"), "true", "Escape collapses the panel");

  const frozenHtml = await page.evaluate(() => window.__rabbitholeTest.exportSnapshot());
  const frozen = await context.newPage();
  await frozen.setContent(frozenHtml, { waitUntil: "load" });
  await frozen.click("#reader-chat-fab");
  assert.equal(await frozen.locator("#reader-chat-panel").isVisible(), true, "snapshot can open the chat panel");
  assert.equal(await frozen.locator("#composer-text").isDisabled(), true, "snapshot chat is read-only");
  await frozen.close();
  await context.close();
  console.log("ok reader chat: two-state panel, multi-turn context, new chat, focus, and frozen behavior");
} finally {
  await app.close();
}

async function createDocument(page, markdown) {
  const previous = await page.evaluate(() => window.__rabbitholeTest?.currentHoleId?.() || "");
  await page.evaluate((value) => window.__rabbitholeTest.createDocument(value), markdown);
  await page.waitForFunction((oldId) => {
    const id = window.__rabbitholeTest?.currentHoleId?.();
    return id && id !== oldId;
  }, previous);
  await page.waitForSelector(".node .doc-content[data-node-id]");
}

async function waitForRequests(requests, count) {
  for (let attempt = 0; attempt < 80 && requests.length < count; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(requests.length, count, `expected ${count} provider requests`);
}
