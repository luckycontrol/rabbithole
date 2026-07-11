/** @typedef {"sanitize-html" | "inert"} BlockSecurity */
/** @typedef {{ type: string, version: number, parse: (source: string) => unknown, toPlainText: (model: any) => string, security: BlockSecurity }} BlockTypeDescriptor */

/** @type {Map<string, BlockTypeDescriptor>} */
const blockTypes = new Map();

/** @param {unknown} value */
function normalizedType(value) {
  return String(value || "").toLowerCase();
}

/** @param {BlockTypeDescriptor} descriptor */
export function registerBlockType(descriptor) {
  if (!descriptor || typeof descriptor !== "object") throw new TypeError("Block type descriptor must be an object");
  const type = normalizedType(descriptor.type);
  if (!type || !/^[a-z][a-z0-9_-]*$/.test(type)) throw new TypeError("Block type descriptor.type must be a fence-safe name");
  if (!Number.isInteger(descriptor.version) || descriptor.version < 1) throw new TypeError(`Block type "${type}" must have a positive integer version`);
  if (typeof descriptor.parse !== "function") throw new TypeError(`Block type "${type}" must provide parse(source)`);
  if (typeof descriptor.toPlainText !== "function") throw new TypeError(`Block type "${type}" must provide toPlainText(model)`);
  if (descriptor.security !== "sanitize-html" && descriptor.security !== "inert") {
    throw new TypeError(`Block type "${type}" security must be "sanitize-html" or "inert"`);
  }
  if (blockTypes.has(type)) throw new Error(`Block type "${type}" is already registered`);
  const registered = Object.freeze({ ...descriptor, type });
  blockTypes.set(type, registered);
  return registered;
}

/** @param {unknown} type */
export function getBlockType(type) {
  return blockTypes.get(normalizedType(type));
}

export function listBlockTypes() {
  return [...blockTypes.values()];
}

registerBlockType({
  type: "show",
  version: 1,
  parse(source) { return String(source ?? ""); },
  toPlainText() { return ""; },
  security: "sanitize-html",
});
