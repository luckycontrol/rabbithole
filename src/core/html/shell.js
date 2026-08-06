import { buttonMarkup, iconButtonMarkup } from "./button-markup.js";
import { iconSvg } from "./icons.js";

/*
 * Extracted from the former canvas.js monolith. Keep this string as the exact
 * self-contained browser payload; behavior is verified by the inline-script
 * node --check gate.
 */
export const CANVAS_SHELL = `
<div id="taskbar">
  <div class="tb-pill" id="tb-tools">
    ${iconButtonMarkup({ id: "t-rail", title: "Rabbitholes · S", ariaLabel: "Toggle rabbitholes", ariaExpanded: "false", ariaControls: "web-rail", svgIconHtml: iconSvg("rail") })}
    ${iconButtonMarkup({ id: "t-new", title: "New Rabbithole · N", ariaLabel: "New Rabbithole", svgIconHtml: iconSvg("new") })}
    <span class="sep" id="app-sep"></span>
    <span class="tb-group" data-mode="reader">
      ${buttonMarkup({ id: "t-canvas", title: "Open the spatial canvas", label: "Canvas" })}
      <span class="sep"></span>
      ${buttonMarkup({ id: "r-textdown", title: "Smaller text", label: "A−" })}
      ${buttonMarkup({ id: "r-textup", title: "Larger text", label: "A+" })}
    </span>
    <span class="tb-group" data-mode="canvas">
      ${buttonMarkup({ id: "t-reader", title: "Read this document", label: "Reader" })}
      <span class="sep"></span>
      <span class="zoom-controls">
        ${iconButtonMarkup({ id: "t-zout", title: "Zoom out", ariaLabel: "Zoom out", svgIconHtml: iconSvg("zoom-out") })}
        ${buttonMarkup({ id: "zoom-label", title: "Zoom to 100%", ariaLabel: "Zoom to 100%", label: "100%" })}
        ${iconButtonMarkup({ id: "t-zin", title: "Zoom in", ariaLabel: "Zoom in", svgIconHtml: iconSvg("zoom-in") })}
      </span>
      ${iconButtonMarkup({ id: "t-frame", title: "Frame everything · F", ariaLabel: "Frame everything · F", svgIconHtml: iconSvg("frame") })}
      ${iconButtonMarkup({ id: "t-tidy", title: "Tidy up layout · T", ariaLabel: "Tidy up layout · T", svgIconHtml: iconSvg("tidy") })}
    </span>
  </div>
  <div id="tb-document" aria-label="Document controls"></div>
  <div id="tb-session">
    <div class="tb-pill">
    ${iconButtonMarkup({ id: "t-share", title: "Share and export", ariaLabel: "Share and export", ariaHaspopup: "menu", ariaControls: "sharemenu", ariaExpanded: "false", svgIconHtml: iconSvg("share") })}
    ${iconButtonMarkup({ id: "t-theme", title: "Toggle theme", ariaLabel: "Toggle theme", svgIconHtml: iconSvg("theme") })}
    ${iconButtonMarkup({ id: "t-settings", title: "Model settings", ariaLabel: "Model settings", ariaExpanded: "false", svgIconHtml: iconSvg("settings") })}
    </div>
    <div class="tb-pill" id="tb-done-pill">
      ${buttonMarkup({ id: "tb-done", title: "End the session (the hole stays saved)", label: "Done" })}
    </div>
  </div>
</div>

<div id="reader">
  <div id="reader-workspace">
    <div id="reader-document">
      <div id="reader-main"></div>
      ${iconButtonMarkup({ bare: true, className: "reader-chat-fab", id: "reader-chat-fab", title: "Ask about this document", ariaLabel: "Open document chat", ariaExpanded: "false", ariaControls: "reader-chat-panel", svgIconHtml: iconSvg("chat") })}
      <section id="reader-chat-panel" aria-labelledby="reader-chat-title" aria-hidden="true">
        <header class="reader-chat-head">
          <div class="reader-chat-heading">
            <span class="reader-chat-eyebrow">Ask this document</span>
            <h2 id="reader-chat-title">Untitled</h2>
          </div>
          <div class="reader-chat-actions">
            ${buttonMarkup({ bare: true, className: "reader-chat-new", id: "reader-chat-new", title: "Start a new conversation", ariaLabel: "Start a new conversation", label: "New chat", svgIconHtml: iconSvg("plus") })}
            ${iconButtonMarkup({ bare: true, className: "reader-chat-collapse", id: "reader-chat-collapse", title: "Collapse chat", ariaLabel: "Collapse chat", svgIconHtml: iconSvg("collapse") })}
          </div>
        </header>
        <div id="reader-chat-log" role="log" aria-live="polite" aria-relevant="additions text">
          <p class="reader-chat-empty">Ask a question about this document. Follow-ups remember this page and the conversation.</p>
        </div>
        <div id="composer">
          <div class="composer-inner" id="composer-inner">
            <textarea id="composer-text" rows="1" placeholder="Ask about this document…" aria-label="Ask about this document"></textarea>
            <button id="composer-send" class="send-btn" title="Send (Enter) · New line (Shift+Enter)" aria-label="Send follow-up" disabled>${iconSvg("send")}</button>
          </div>
        </div>
      </section>
    </div>
    <aside id="reader-rail" aria-labelledby="reader-rail-title">
      <div class="reader-rail-head">
        <span id="reader-rail-title">Branches</span>
        <span class="reader-rail-head-end">
          <span id="reader-rail-count">0</span>
          ${iconButtonMarkup({ bare: true, className: "reader-rail-toggle", id: "reader-rail-toggle", title: "Hide branches", ariaLabel: "Hide branches", ariaExpanded: "true", ariaControls: "margin-notes", svgIconHtml: iconSvg("chevron") })}
        </span>
      </div>
      <div id="margin-notes"></div>
      <button type="button" class="reader-rail-strip" id="reader-rail-strip" title="Show branches" aria-label="Show branches" aria-expanded="false" aria-controls="margin-notes"><span class="reader-rail-strip-count" id="reader-rail-strip-count">0</span><span class="reader-rail-strip-label">Branches</span></button>
    </aside>
  </div>
</div>

<div id="viewport"><div id="canvas-gesture-plane" aria-hidden="true"></div><div id="world"><svg id="edges"></svg></div></div>

<div id="ask">
  <div class="ask-modes" id="ask-modes" role="tablist" aria-label="What to do with this passage" hidden>
    ${buttonMarkup({ bare: true, className: "ask-mode active", id: "ask-mode-ask", role: "tab", dataAttrs: { mode: "ask" }, label: "Ask" })}
    ${buttonMarkup({ bare: true, className: "ask-mode", id: "ask-mode-revise", role: "tab", dataAttrs: { mode: "revise" }, label: "Revise", kbdHint: "e" })}
  </div>
  <div class="ask-input">
    <textarea id="ask-text" rows="1" placeholder="Ask about this…"></textarea>
    ${iconButtonMarkup({ bare: true, className: "send-btn", id: "ask-go", title: "Send (Enter) · New line (Shift+Enter)", ariaLabel: "Ask", svgIconHtml: iconSvg("send") })}
  </div>
  <div class="ask-lenses" id="ask-lenses">
    ${buttonMarkup({ bare: true, className: "lens", dataAttrs: { lens: "explain" }, label: "Explain ", kbdHint: "1" })}
    ${buttonMarkup({ bare: true, className: "lens", dataAttrs: { lens: "eli5" }, label: "ELI5 ", kbdHint: "2" })}
    ${buttonMarkup({ bare: true, className: "lens", dataAttrs: { lens: "example" }, label: "Example ", kbdHint: "3" })}
    ${buttonMarkup({ bare: true, className: "lens", dataAttrs: { lens: "deeper" }, label: "Go Deeper ", kbdHint: "4" })}
  </div>
  <div class="ask-revise-chips" id="ask-revise-chips" hidden>
    ${buttonMarkup({ bare: true, className: "ask-chip", dataAttrs: { instruction: "Make it shorter" }, label: "Shorter" })}
    ${buttonMarkup({ bare: true, className: "ask-chip", dataAttrs: { instruction: "Explain this more clearly" }, label: "Clearer" })}
    ${buttonMarkup({ bare: true, className: "ask-chip", dataAttrs: { instruction: "Fix any errors here" }, label: "Fix errors" })}
    ${buttonMarkup({ bare: true, className: "ask-chip", dataAttrs: { instruction: "Add a concrete example" }, label: "Add example" })}
  </div>
  <p class="ask-revise-note" id="ask-revise-note" hidden></p>
  <div class="ask-revision" id="ask-revision" hidden></div>
</div>

<div id="palette" hidden><div id="palette-panel">
  <div class="pal-input">
    ${iconSvg("search")}
    <input id="pal-text" placeholder="Search this Rabbithole…" aria-label="Search this Rabbithole" aria-controls="pal-results" aria-autocomplete="list" autocomplete="off" spellcheck="false">
    <kbd>esc</kbd>
  </div>
  <div id="pal-results" role="listbox" aria-label="Search results"></div>
</div></div>

<div id="sharemenu" role="menu" aria-label="Share and export">
  ${buttonMarkup({ bare: true, className: "sm-item", id: "sm-trail", role: "menuitem", tabIndex: -1, label: "Copy trail as Markdown", svgIconHtml: '<span class="sm-ic">⤷</span>' })}
  ${buttonMarkup({ bare: true, className: "sm-item", id: "sm-doc", role: "menuitem", tabIndex: -1, label: "Copy document as Markdown", svgIconHtml: '<span class="sm-ic">⧉</span>' })}
  <div class="sm-sep"></div>
  ${buttonMarkup({ bare: true, className: "sm-item", id: "sm-export", role: "menuitem", tabIndex: -1, label: "Download snapshot (.html)", svgIconHtml: '<span class="sm-ic">⇩</span>' })}
  ${buttonMarkup({ bare: true, className: "sm-item", id: "sm-portable", role: "menuitem", tabIndex: -1, label: "Export Rabbithole (.rabbithole)", svgIconHtml: '<span class="sm-ic">⇣</span>' })}
</div>

<div id="confirm">
  <div class="cf-msg" id="cf-msg"></div>
  <div class="cf-row">${buttonMarkup({ bare: true, id: "cf-keep", label: "Keep" })}${buttonMarkup({ bare: true, className: "cf-remove", id: "cf-remove", label: "Remove" })}</div>
</div>

<div id="banner"><div class="banner-body"><span class="banner-title" id="banner-title" data-notice-title></span><span id="banner-msg" data-notice-message></span></div>${iconButtonMarkup({ bare: true, id: "banner-x", title: "Dismiss", ariaLabel: "Dismiss banner", icon: "×", dataAttrs: { noticeDismiss: "" } })}</div>
<div id="hint"><span data-notice-message></span><button type="button" data-notice-action hidden></button></div>
`;
