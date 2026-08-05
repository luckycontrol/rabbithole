# Reader edit-panel width resize design

## Context and decision

In reader mode, editing an answer opens a panel inside the right branch rail
(`#reader-rail`). The rail's width — and therefore the panel's — is fixed by the
CSS variable `--reader-branch-rail: clamp(252px, 24vw, 320px)` in
`src/core/html/tokens.js`, used by `#reader-rail` in `src/core/html/styles.js`
(width and flex-basis). Because `.reader-edit-panel` fills the rail at
`width: 100%`, resizing the rail resizes the panel with no extra layout work.

The chosen approach is a drag handle: a vertical grip on the rail's left edge
(between the document and the rail) that appears only while an edit is open.
Dragging it overrides the rail width via an inline style on the same variable;
double-clicking resets to the default `clamp()` value. The width persists for
the page session (open, close, reopen keeps the last value) but is not saved to
preferences — the double-click reset makes persistence unnecessary for now, and
adding a storage key now would be premature.

The alternative of header preset/stepper buttons was considered but rejected:
it is touch-friendly and accessible but cannot offer fine control and adds
another control to an already dense panel head. The full "persist to
preferences-store" variant of the handle was also considered and deferred; the
session-scoped handle plus reset covers the core need.

The shared pointer-gesture helper `onPointerGesture` in `src/ui/canvas-view.js`
(drag lifecycle, pointer capture, cleanup on pointerup/pointercancel/
lostpointercapture) is module-internal. It will be moved to a shared module so
reader.js can reuse the same tested gesture path instead of wiring its own.

## Behavior

- The grip is present only while `#reader-rail` has the
  `reader-edit-panel-active` class (i.e. an edit is open), and only in the
  non-compact layout. On compact/mobile (`isCompactReader()`) the panel is
  full-screen, so the grip is hidden.
- Pointer drag on the grip changes the rail width, clamped to
  `min 220px` / `max 560px`.
- Double-click on the grip resets the width to the default
  (`--reader-branch-rail` clamp value).
- The chosen width lives for the rest of the page session: closing and
  reopening the edit panel keeps it, but a page reload restores the default.
- Text selection near the boundary must not be hijacked: the grip sets
  `user-select: none` for the duration of a drag and restores it on end.

## Accessibility

The grip is a resizable separator: `role="separator"`,
`aria-orientation="vertical"`, `tabindex="0"`, and `aria-valuenow` reporting the
current width. Left/Right arrow keys adjust the width by a step, and
`Home`/`End` jump to min/max.

## Edge cases

- **Live preview**: the preview re-renders on every textarea input
  (`replaceReaderDraftPreview`), so a width change reflows it automatically; no
  extra handling.
- **PDF reader**: the PDF viewport path still renders the rail, so the grip
  works there through the same code path; covered by an e2e assertion.
- **Compact layout**: grip hidden; behavior unchanged.

## Behavior and verification

A real Chromium e2e test in `test/e2e/web-app-setup.test.mjs`, next to the
existing edit-panel tests, will: open an edit, assert the grip is visible and
interactive; drag it and assert the rail width increased; double-click and
assert the width returned to the default; close the edit and assert the grip is
gone. The test must fail against the current implementation before production
code changes. After the change, committed bundles will be rebuilt, the narrow
test will pass, and the broader deterministic suite will be run if feasible.
