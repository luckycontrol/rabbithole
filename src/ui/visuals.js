  // ===========================================================================
// VISUAL FENCES
// ===========================================================================
import { getBlockType } from "../core/blocks.js";

export var visualSurfaceCaches = {};
var blockMounts = {};
var visualHooksReady = false;
var VISUAL_ALLOWED_URI = /^(?:(?:https?:)?\/\/|https?:|\/|\.\/|\.\.\/|#|data:image\/(?:png|jpe?g|gif|webp);base64,|[^:]*$)/i;
export var VISUAL_SANITIZE_CONFIG = {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
    ADD_TAGS: ["style"],
    ADD_ATTR: ["style"],
    FORCE_BODY: true,
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form"],
    FORBID_ATTR: ["srcdoc"],
    ALLOWED_URI_REGEXP: VISUAL_ALLOWED_URI
  };
  var VISUAL_BASE_CSS =
    ":host{display:block;width:100%;max-width:100%;margin:0.55em 0 1em;contain:content;color:var(--fg);background:transparent;font:inherit;}" +
    ".rh-viz-frame{box-sizing:border-box;width:100%;max-width:100%;overflow-x:auto;overflow-y:visible;overscroll-behavior-x:contain;border:1px solid var(--border);border-radius:8px;padding:0.85em 1em;background:var(--node-bg);color:var(--fg);font:inherit;}" +
    ".rh-viz-content{box-sizing:border-box;min-width:100%;width:auto;color:inherit;font:inherit;}" +
    ".rh-viz-content *,.rh-viz-content *::before,.rh-viz-content *::after{box-sizing:border-box;}" +
    ".rh-viz-content svg{max-width:none;height:auto;}" +
    ".rh-viz-content img{max-width:100%;height:auto;}" +
    ".rh-viz-content a{color:var(--accent);text-decoration-color:color-mix(in srgb,var(--accent) 42%,transparent);}" +
    ".rh-viz-content code,.rh-viz-content pre{font-family:var(--font-mono);}";
export function registerBlockMount(type, mountSpec){
    var key = String(type || "").toLowerCase();
    var descriptor = getBlockType(key);
    if (!descriptor) throw new Error('Cannot register mount for unknown block type "' + key + '"');
    if (!mountSpec || typeof mountSpec !== "object") throw new TypeError('Block mount for "' + key + '" must be an object');
    if (descriptor.security === "sanitize-html" && typeof mountSpec.renderHtml !== "function") {
      throw new TypeError('Block mount for "' + key + '" must provide renderHtml(model)');
    }
    if (mountSpec.wire !== undefined && typeof mountSpec.wire !== "function") {
      throw new TypeError('Block mount wire for "' + key + '" must be a function');
    }
    blockMounts[key] = mountSpec;
  }
  function ensureVisualSanitizer(){
    var purifier = window.DOMPurify;
    if (!purifier || typeof purifier.sanitize !== "function") throw new Error("DOMPurify is unavailable");
    if (!visualHooksReady && typeof purifier.addHook === "function"){
      purifier.addHook("uponSanitizeAttribute", function(node, data){
        if (data && data.attrName && /^on/i.test(data.attrName)) data.keepAttr = false;
      });
      visualHooksReady = true;
    }
    return purifier;
  }
export function sanitizeVisualSource(source){
    return ensureVisualSanitizer().sanitize(source, VISUAL_SANITIZE_CONFIG);
  }
export function decodeVisualSource(encoded){
    var bin = atob(String(encoded || ""));
    if (typeof TextDecoder === "function"){
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder("utf-8").decode(bytes);
    }
    try {
      return decodeURIComponent(escape(bin));
    } catch(e) {
      return bin;
    }
  }
  function visualCacheKey(type, encoded){
    return String(type || "") + "\n" + String(encoded || "");
  }
export function visualFallback(source, message){
    var wrap = document.createElement("div");
    wrap.className = "viz-fallback";
    var note = document.createElement("div");
    note.className = "viz-fallback-note";
    note.textContent = message || "Unable to render visual. Showing source.";
    var pre = document.createElement("pre");
    var code = document.createElement("code");
    code.textContent = String(source || "");
    pre.appendChild(code);
    wrap.appendChild(note);
    wrap.appendChild(pre);
    return wrap;
  }
export function buildShowVisual(model){
    return String(model == null ? "" : model);
  }
  function buildMountedVisual(descriptor, mountSpec, model){
      var host = document.createElement("div");
      host.className = "viz-mounted viz-" + descriptor.type;
      host.setAttribute("data-viz-mounted", descriptor.type);
      host.style.contain = "content";
      var shadow = host.attachShadow({ mode: "open" });
      var style = document.createElement("style");
      style.textContent = VISUAL_BASE_CSS;
      var frame = document.createElement("div");
      frame.className = "rh-viz-frame";
      var content = document.createElement("div");
      content.className = "rh-viz-content";
      if (descriptor.security === "sanitize-html") {
        content.innerHTML = sanitizeVisualSource(mountSpec.renderHtml(model));
      } else {
        content.textContent = descriptor.toPlainText(model);
      }
      frame.appendChild(content);
      shadow.appendChild(style);
      shadow.appendChild(frame);
      if (mountSpec.wire) mountSpec.wire(content, model);
      return host;
  }
  function getSurfaceCache(surfaceKey){
    var key = String(surfaceKey || "default");
    if (!visualSurfaceCaches[key]) visualSurfaceCaches[key] = {};
    return visualSurfaceCaches[key];
  }
export function mountVisuals(containerEl, surfaceKey){
    if (!containerEl || !containerEl.querySelectorAll) return;
    var placeholders = containerEl.querySelectorAll(".viz");
    if (!placeholders.length) {
      if (surfaceKey && visualSurfaceCaches[surfaceKey]) visualSurfaceCaches[surfaceKey] = {};
      return;
    }
    var cache = getSurfaceCache(surfaceKey);
    var present = {};
    var idCounts = {};
    var used = {};
    var mountable = [];
    for (var i = 0; i < placeholders.length; i++){
      var ph = placeholders[i];
      if (ph.classList && ph.classList.contains("viz-pending")) continue;
      var type = String(ph.getAttribute("data-viz") || "").toLowerCase();
      var encoded = ph.getAttribute("data-src") || "";
      if (!type || !encoded) continue;
      var blockId = ph.getAttribute("data-block-id") || "";
      var key = blockId ? "id\n" + blockId : visualCacheKey(type, encoded);
      if (blockId) idCounts[blockId] = (idCounts[blockId] || 0) + 1;
      present[key] = (present[key] || 0) + 1;
      mountable.push({ el: ph, type: type, encoded: encoded, key: key, blockId: blockId });
    }
    for (var d = 0; d < mountable.length; d++){
      var candidate = mountable[d];
      if (candidate.blockId && idCounts[candidate.blockId] > 1){
        present[candidate.key] -= 1;
        candidate.key = visualCacheKey(candidate.type, candidate.encoded);
        present[candidate.key] = (present[candidate.key] || 0) + 1;
        candidate.blockId = "";
      }
    }
    for (var m = 0; m < mountable.length; m++){
      var item = mountable[m];
      var idx = used[item.key] || 0;
      used[item.key] = idx + 1;
      if (!cache[item.key]) cache[item.key] = [];
      var mounted = cache[item.key][idx];
      if (!mounted){
        var descriptor = getBlockType(item.type);
        var mountSpec = blockMounts[item.type];
        var source;
        try {
          source = decodeVisualSource(item.encoded);
        } catch(e) {
          mounted = visualFallback("", "Unable to decode visual source.");
        }
        if (!mounted) try {
          mounted = descriptor && mountSpec
            ? buildMountedVisual(descriptor, mountSpec, descriptor.parse(source))
            : visualFallback(source, "Unsupported visual type. Showing source.");
        } catch(e) {
          mounted = visualFallback(source, "Unable to render visual. Showing source.");
        }
        cache[item.key][idx] = mounted;
      }
      if (item.el.parentNode) item.el.parentNode.replaceChild(mounted, item.el);
    }
    for (var ckey in cache){
      if (!Object.prototype.hasOwnProperty.call(cache, ckey)) continue;
      if (!present[ckey]) delete cache[ckey];
      else cache[ckey].length = present[ckey];
    }
  }

registerBlockMount("show", { renderHtml: buildShowVisual });
