import { CANVAS_SHELL } from "../core/html/shell.js";
import { extractAssetRefsFromMarkdown } from "../core/assets.js";
import { binaryToBase64 } from "../core/portable-projection.js";
import { createSnapshotProjection } from "../core/snapshot-projection.js";
import { serializeForInlineScript } from "../core/utils.js";
import {
  currentNodeId,
  mode,
  nodes,
  readerMain,
  view
} from "./core.js";

var snapshotHooks = {
  fetchAssetBinary: null,
  getSnapshotHole: null,
  getFrozenClientSource: null,
  getDompurifySource: null,
  getStylesheetText: null
};

export function setSnapshotHooks(hooks) {
  snapshotHooks = Object.assign({}, snapshotHooks, hooks || {});
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function snapshotViewState() {
  var cur = nodes[currentNodeId];
  var scroll = mode === "reader" ? readerMain.scrollTop : ((cur && cur._scrollTop) || 0);
  return {
    mode: mode,
    node_id: currentNodeId,
    scroll: scroll,
    view: { x: view.x, y: view.y, scale: view.scale }
  };
}

function collectAssetNames(snapshotNodes) {
  var names = {};
  snapshotNodes.forEach(function(node){
    extractAssetRefsFromMarkdown(node.markdown).forEach(function(name){ names[name] = true; });
  });
  return Object.keys(names).sort();
}

async function fetchAssetBinary(name) {
  if (typeof snapshotHooks.fetchAssetBinary === "function") {
    try {
      var hooked = await snapshotHooks.fetchAssetBinary(name);
      if (hooked) return hooked;
    } catch(e) {}
  }
  try {
    var slash = String.fromCharCode(47);
    var res = await fetch(slash + "assets" + slash + name, { cache: "no-store" });
    if (!res.ok) return new Uint8Array();
    return await res.blob();
  } catch(e) {
    return new Uint8Array();
  }
}

async function buildAssetData(snapshotNodes) {
  var out = {};
  var names = collectAssetNames(snapshotNodes);
  for (var i = 0; i < names.length; i++) out[names[i]] = await binaryToBase64(await fetchAssetBinary(names[i]));
  return out;
}

function extractDompurifySource() {
  if (typeof snapshotHooks.getDompurifySource === "function") {
    return snapshotHooks.getDompurifySource() || "";
  }
  var script = document.scripts && document.scripts[0] ? document.scripts[0].textContent || "" : "";
  var marker = "\n(function(){";
  var idx = script.indexOf(marker);
  return idx === -1 ? "" : script.slice(0, idx);
}

export async function buildSnapshotProjection() {
  var viewState = snapshotViewState();
  if (typeof snapshotHooks.getSnapshotHole !== "function") throw new Error("Snapshot document is unavailable");
  var hole = await snapshotHooks.getSnapshotHole();
  return createSnapshotProjection(hole, viewState, await buildAssetData(hole.nodes));
}

export function buildSnapshotHtml(snapshotProjection) {
  var title = (snapshotProjection && snapshotProjection.hole && snapshotProjection.hole.title) || "Rabbithole";
  var styleText = typeof snapshotHooks.getStylesheetText === "function"
    ? snapshotHooks.getStylesheetText()
    : "";
  if (!styleText) throw new Error("Frozen stylesheet is unavailable");
  var dompurifySource = extractDompurifySource();
  var frozenClient = typeof snapshotHooks.getFrozenClientSource === "function"
    ? snapshotHooks.getFrozenClientSource()
    : window.__RABBITHOLE_FROZEN_CLIENT__;
  if (!frozenClient) throw new Error("Frozen client bundle is unavailable");
  var lt = String.fromCharCode(60);
  var gt = String.fromCharCode(62);
  var scriptOpen = lt + "script" + gt;
  var scriptClose = lt + String.fromCharCode(47) + "script" + gt;
  var payloadOpen = lt + 'script type="application/vnd.rabbithole+json" id="rabbithole-portable"' + gt;
  return "<!DOCTYPE html>\n" +
    '<html lang="en" data-theme="light">\n' +
    "<head>\n" +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    "<title>" + escapeHtml(title) + "</title>\n" +
    "<style>\n" + styleText + "\n</style>\n" +
    "</head>\n" +
    "<body>\n" +
    CANVAS_SHELL +
    "\n" + payloadOpen + serializeForInlineScript(snapshotProjection) + scriptClose +
    "\n" + scriptOpen + "\n" +
    dompurifySource +
    "\n(function(){\n" +
    '  "use strict";\n' +
    frozenClient +
    "\n  var payload = document.getElementById(\"rabbithole-portable\");\n" +
    "  RabbitholeFrozenClient.startPortableSnapshot(JSON.parse(payload.textContent));\n" +
    "})();\n" +
    scriptClose + "\n" +
    "</body>\n" +
    "</html>";
}

function exportFilename(title) {
  var slug = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return "rabbithole-" + (slug || "export") + ".html";
}

export async function downloadSnapshot() {
  var snapshotProjection = await buildSnapshotProjection();
  var html = buildSnapshotHtml(snapshotProjection);
  var blob = new Blob([html], { type: "text/html;charset=utf-8" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = exportFilename(snapshotProjection.hole.title);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function(){ URL.revokeObjectURL(url); }, 30000);
  return html;
}
