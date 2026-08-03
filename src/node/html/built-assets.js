import fs from "node:fs";
import { CANVAS_STYLES } from "../../core/html/styles.js";

const CLIENT_PATH = new URL("../../../dist/client.js", import.meta.url);
const FROZEN_CLIENT_PATH = new URL("../../../dist/frozen-client.js", import.meta.url);
const KATEX_CSS_PATH = new URL("../../../dist/katex.css", import.meta.url);
const DOMPURIFY_SCRIPT_PATH = new URL("../../../dist/dompurify.js", import.meta.url);
const MERMAID_SCRIPT_PATH = new URL("../../../dist/mermaid.js", import.meta.url);
const PDF_WORKER_PATH = new URL("../../../dist/pdf.worker.mjs", import.meta.url);
const PDFJS_PATH = new URL("../../../dist/pdf.mjs", import.meta.url);

const UI_ASSETS = Object.freeze({
  stylesheetText: `${CANVAS_STYLES}\n${fs.readFileSync(KATEX_CSS_PATH, "utf8")}`,
  clientSource: fs.readFileSync(CLIENT_PATH, "utf8"),
  frozenClientSource: fs.readFileSync(FROZEN_CLIENT_PATH, "utf8"),
});

function memoizeFile(path) {
  let cached = null;
  return function getFile() {
    if (cached) return cached;
    cached = fs.readFileSync(path, "utf8");
    return cached;
  };
}

export function getUiAssets() {
  return UI_ASSETS;
}

export const getDompurifyScript = memoizeFile(DOMPURIFY_SCRIPT_PATH);
export const getMermaidScript = memoizeFile(MERMAID_SCRIPT_PATH);
export const getPdfWorkerScript = memoizeFile(PDF_WORKER_PATH);
export const getPdfJsScript = memoizeFile(PDFJS_PATH);
