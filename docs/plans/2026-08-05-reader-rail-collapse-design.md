# Reader branch-rail collapse design

## Context and decision

In reader mode the right-hand surface is the branch rail (`#reader-rail`,
`src/core/html/shell.js`). It is always open on desktop at
`--reader-branch-rail: clamp(252px, 24vw, 320px)` and can already be resized by
the left-edge grip (`.reader-edit-grip`). What is missing is a way to get the
width back: a reader who wants the document at full width has no control that
puts the rail away.

The chosen approach is a **header toggle plus a collapsed strip**. A chevron
button sits in the rail head next to the branch count; pressing it collapses the
rail to a narrow vertical strip that keeps the "Branches" label and the count
badge visible. Pressing the strip — anywhere along it — restores the rail to its
previous width.

The strip is the load-bearing part of the decision. A rail that collapses to
nothing also removes the only signal that branches exist, so a reader would have
no way to notice that an answer arrived while the rail was away. Keeping a
32px strip with a live count costs almost no document width and keeps that
signal.

Three alternatives were considered and rejected:

- **Collapse by dragging the grip past its minimum.** Cheapest to build (the
  gesture path already exists), but there is nothing on screen that suggests it,
  and the grip is hidden on touch, so the feature would be undiscoverable.
  Rejected as a primary control; it stays available as a later addition.
- **A toolbar button in `#tb-document`.** Consistent with the canvas rail
  toggle (`#t-rail`), but far from the surface it controls, and on its own it
  still leaves the collapsed rail with no branch count. Rejected as primary;
  a keyboard shortcut can be added later against the same state functions.
- **Automatic collapse (empty rail collapses, hover peeks it open).** Removes
  the reader's control over the layout and has no touch equivalent. Rejected.

## Behavior

- The rail head gains a chevron toggle (`#reader-rail-toggle`). Pressing it
  collapses the rail; the head and `#margin-notes` are hidden and
  `.reader-rail-strip` takes their place.
- The strip is a full-height button showing a vertically-set "Branches" label
  and the current branch count. Pressing it expands the rail again.
- Collapsing does not discard a width chosen through the grip. The collapsed
  width comes from a separate token, and the inline `--reader-branch-rail`
  override is left untouched, so expanding returns to the width the reader had
  set.
- The resize grip is hidden while collapsed — there is no width to adjust.
- The state persists across reloads in `localStorage` under `rh-reader-rail`,
  following the `rh-theme` precedent in `src/ui/core.js`. Collapsing is a
  deliberate choice about layout, unlike the session-scoped width, so it should
  survive a reload.

### Interaction with the edit panel

The answer edit panel is rendered *inside* the rail. Opening an edit while the
rail is collapsed therefore forces the rail open, and closing the edit returns
it to collapsed. The reader's stored preference is not overwritten by this: the
applied state is `preference AND NOT edit-open`, so the preference is restored
rather than recomputed.

### Compact layout

Below 880px the rail is already hidden by media queries, and the edit panel
takes over the screen. Both the toggle and the strip live inside `#reader-rail`,
so they inherit that `display: none` and need no separate handling. The collapse
state is not applied while the edit panel is active, so it cannot interfere with
the full-screen compact panel.

## Accessibility

Both controls are disclosure buttons for the branch list: `aria-controls`
points at `#margin-notes` (the content that is actually hidden) and
`aria-expanded` reflects the state. Because collapsing removes the head toggle
from view, focus moves to the strip when collapsing and back to the head toggle
when expanding, so keyboard focus is never dropped on a hidden element. The
strip carries an `aria-label` that names the action and the count
("Show branches, 3").

## Verification

A real Chromium e2e assertion in `test/e2e/web-app-setup.test.mjs`, next to the
existing grip test, will: collapse the rail from the head toggle and assert the
rail narrows and the strip is visible with the right count; assert `#margin-notes`
is hidden and `aria-expanded` is `false`; expand from the strip and assert the
width returns; assert a grip-chosen width survives a collapse/expand round trip;
assert opening an edit while collapsed forces the rail open and closing it
re-collapses; and assert the state is written to `localStorage`. The test must
fail against the current implementation before production code changes.
