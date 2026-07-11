/**
 * Shared utility functions.
 */

// U+2028 / U+2029 are valid in JSON strings but illegal in JS source — they
// break inline <script> embedding. Built from char codes to keep this file
// itself free of those characters.
const LINE_SEP = new RegExp(String.fromCharCode(0x2028), "g");
const PARA_SEP = new RegExp(String.fromCharCode(0x2029), "g");

/**
 * Escapes a value for safe embedding in HTML text/attribute context.
 * @param {unknown} str
 */
export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Serializes a value for safe embedding inside an inline `<script>`.
 * @param {unknown} value
 */
export function serializeForInlineScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(LINE_SEP, "\\u2028")
    .replace(PARA_SEP, "\\u2029");
}
