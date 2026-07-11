import assert from "node:assert/strict";
import { buildAnswerMessages } from "../../src/core/prompts/answering-v1.js";

const context = { root_title: "Root", parent_title: "Parent", parent_markdown: "Body", ancestors: [], selected_text: "x", question: "Why?", lens: null };
const without = buildAnswerMessages(context);
const baseline = JSON.stringify(without);
assert.equal(typeof without[1].content, "string");
assert.equal(JSON.stringify(buildAnswerMessages({ ...context })), baseline, "no-attachment messages must remain byte-identical");

const dataUrl = "data:image/jpeg;base64,/9j/2Q==";
const withImage = buildAnswerMessages({ ...context, attachment: { kind: "image", data_url: dataUrl, page: 7 } });
assert.deepEqual(withImage[1].content.map((part) => part.type), ["text", "image_url"]);
assert.equal(withImage[1].content[1].image_url.url, dataUrl);
assert(withImage[1].content[0].text.startsWith("Selection region image: attached (page 7). Trust the image over extracted text for math, tables, and figures.\n"));
assert.equal(JSON.stringify(buildAnswerMessages(context)), baseline, "attachment assembly must not mutate its source context");

console.log("ok prompts: PDF attachment parts and byte-identical text-only messages");
