// Selection revision only earns its keep if the passage the human dragged is
// the passage that changes. Everything else in the card must survive, and so
// must the branch marks pointing at text the rewrite did not touch — a mark is
// a rendered character offset, so a splice earlier in the document is exactly
// what would silently drag it onto the wrong words.
//
// This drives the whole path in a real browser: drag, switch to Revise, send an
// instruction, watch the fragment stream into a diff preview, apply it.

import assert from "node:assert/strict";
import { routeProvider, seedConfiguredOpenRouter } from "../support/provider-mock.mjs";
import { bootWebApp } from "../support/web-app-harness.mjs";

const CARD = [
  "TITLE: Layers\n",
  "The transport layer moves bytes between the two hosts.\n\n",
  "The session layer keeps the conversation alive across those bytes.\n\n",
  "The presentation layer decides how the conversation looks.\n",
];

const app = await bootWebApp();
const { browser, baseUrl } = app;
try {
  const context = await browser.newContext();
  await seedConfiguredOpenRouter(context);
  const page = await context.newPage();
  await routeProvider(page, {
    streams: [
      CARD,
      ["TITLE: Presentation\n", "A branch about the presentation layer."],
      // A selection revision returns only the replacement, with no title line.
      ["Bytes cross the wire here.\n\n"],
    ],
  });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.__rabbitholeTest);
  await page.keyboard.press("Escape");
  await createDocument(page, "# Networking\n\nA root document to branch from.");

  // Revise is offered on answer cards, not on the root, so the card under test
  // is one the model wrote. Create it from the canvas composer so it remains a
  // regular branch in the reader rail rather than a reader-chat turn.
  await page.locator(".node.root .nc-handle").focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.matches(".node.root .nc-inner textarea"));
  await page.keyboard.type("Explain the layers");
  await page.keyboard.press("Enter");
  await page.click("#t-reader");
  await page.locator("#margin-notes .side-item", { hasText: "Layers" }).waitFor();
  await page.click("#margin-notes .side-item");
  await page.waitForFunction(() => document.querySelector("#reader-main .doc-content")?.textContent.includes("presentation layer"));

  // A branch anchored in the last paragraph — the one the rewrite leaves alone.
  await selectInReader(page, "presentation layer decides");
  await page.waitForSelector("#ask.visible");
  await page.fill("#ask-text", "Why?");
  await page.press("#ask-text", "Enter");
  const mark = page.locator("#reader-main mark[data-child]");
  await mark.waitFor();
  assert.equal(await mark.innerText(), "presentation layer decides",
    "the branch mark should start on the words it was dragged from");

  // Now rewrite the first paragraph, well ahead of that mark.
  await selectInReader(page, "transport layer moves bytes");
  await page.waitForSelector("#ask.visible");
  await page.waitForSelector("#ask-modes:not([hidden])");
  assert.equal(await page.locator('#ask-modes .ask-mode[data-mode="revise"]').count(), 1,
    "a mappable passage in an answer card should offer Revise beside Ask");

  await page.click('#ask-modes .ask-mode[data-mode="revise"]');
  await page.waitForSelector("#ask-revise-note:not([hidden])");
  assert.match(await page.locator("#ask-revise-note").innerText(), /rewrites this passage in place/,
    "the note should say the passage is replaced rather than branched");

  await page.fill("#ask-text", "Say it in one short sentence");
  await page.press("#ask-text", "Enter");

  await page.waitForSelector("#reader-main .rh-revise-after");
  assert.match(await page.locator("#ask-revision .ask-revision-status").innerText(),
    /Changed words are marked/, "the ready panel should explain the diff it is showing");
  assert.equal(await page.locator("#reader-main .rh-revise-before").count(), 1,
    "the original stays on screen beside the replacement");
  assert(await page.locator("#reader-main .rh-revise-del").count() > 0,
    "removed words should be marked in the original");
  assert(await page.locator("#reader-main .rh-revise-ins").count() > 0,
    "added words should be marked in the replacement");
  assert.equal(await page.locator("#reader-main .doc-content").innerText().then((t) => t.includes("Bytes cross the wire here")), true);

  const before = await readerText(page);
  assert(before.includes("The transport layer moves bytes"),
    "the preview must not replace the card before it is applied");

  await page.locator("#ask-revision .ask-revision-button.primary", { hasText: "Apply" }).click();
  await page.waitForSelector("#reader-main .rh-revise-after", { state: "detached" });

  const after = await readerText(page);
  assert(after.includes("Bytes cross the wire here."), "the replacement should land in the card");
  assert(!after.includes("The transport layer moves bytes"), "the rewritten passage should be gone");
  assert(after.includes("The session layer keeps the conversation alive"),
    "a paragraph outside the region must be untouched");
  assert(after.includes("The presentation layer decides how the conversation looks"),
    "the paragraph after the region must be untouched");

  const movedMark = page.locator("#reader-main mark[data-child]");
  await movedMark.waitFor();
  assert.equal(await movedMark.innerText(), "presentation layer decides",
    "a branch after the rewrite must still point at its own words, not at shifted ones");

  await context.close();
  console.log("ok selection revision: a dragged passage is rewritten in place and later branch marks stay on their words");
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

async function readerText(page) {
  return page.locator("#reader-main .doc-content").first().innerText();
}

async function selectInReader(page, needle) {
  const picked = await page.evaluate((text) => {
    const root = document.querySelector("#reader-main .doc-content");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const index = node.data.indexOf(text);
      if (index === -1) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + text.length);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const chosen = selection.toString();
      root.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 200, clientY: 200 }));
      return chosen;
    }
    return "";
  }, needle);
  assert.equal(picked, needle, `reader selection mismatch for ${JSON.stringify(needle)}`);
}
