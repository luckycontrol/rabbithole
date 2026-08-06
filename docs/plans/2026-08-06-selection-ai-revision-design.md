# Selection-scoped AI revision design

## Context and decision

Reader mode has two ways to change a card, and neither starts from a selection.
`openReaderAnswerDraft` (`src/ui/reader.js`) opens a Markdown editor for the
whole card in the branch rail, and `openAiRevision` (`src/ui/ai-revision.js`)
asks the agent to rewrite the whole card from an instruction. Dragging text
offers only one thing: `maybeShowAsk` (`src/ui/ask-followups.js`) opens the
anchored `#ask` surface, which creates a branch.

This adds the missing third thing: drag a passage, say how it should change, and
have the agent rewrite **that passage** with the rest of the document as
context. The whole-card revision stays as it is.

The surface is the existing `#ask` popover, extended with a two-way switch at
its head and the same four phases the card-level revision already uses —
`prompt`, `generating`, `ready`, `error`. Keeping it anchored to the selection
means the passage being changed and the instruction changing it stay in one
place. A rail panel was considered and rejected for the common case: a one- or
two-sentence fix does not warrant crossing the page. Long selections are the
exception and are handled below.

The agent returns **only the replacement**, not the whole card. That keeps the
round trip proportional to the edit rather than to the document, and it makes
"nothing outside the selection changed" a property of the protocol instead of
something the client has to verify after the fact.

## Locating the selection in the Markdown source

Returning a fragment requires knowing which bytes of `node.md` it replaces, and
that is not directly available: `charOffset` (`src/ui/text-marks.js`) measures
**rendered** text, while `node.md` is Markdown source with syntax characters the
rendered text does not contain.

`lexBlockRegions`, added to the shared renderer
(`src/core/markdown-renderer.js`), closes the gap at block granularity. It lexes
with the same Marked configuration the renderer uses and returns, for every
top-level block, the exact source span it came from plus the HTML it renders to.
Two properties make it usable, both verified across twenty representative
documents (prose, tight and loose lists, tables, fenced code, block and inline
math, images, reference links, setext headings, indented code, raw HTML):

- `md.slice(start, end) === source` for every block, and blocks are ordered and
  non-overlapping.
- Concatenating every block's HTML and tightening it reproduces
  `renderMarkdownToHtml(md)` byte for byte.

Spans are **located** with `indexOf` from a running cursor rather than
accumulated from `raw` lengths. A link reference definition (`[r]: https://…`)
is consumed into the lexer's link table without emitting a token, so summing
lengths silently shifts every span after it. Located spans tile the source in
order without being required to cover it.

Pairing a DOM selection to a block therefore works structurally, with no text
measurement: walk `.doc-content`'s child nodes and each block's rendered nodes
in order, skipping whitespace-only text, and pair them off.

**The revised region is the smallest run of whole blocks the selection touches**
— usually one paragraph. This is deliberate, not a limitation worked around:
Markdown cannot be spliced at arbitrary character boundaries. A selection
starting inside `**bold**` has no valid fragment boundary, while block
boundaries always do. The agent is told the exact phrase the reader highlighted
and instructed to change only that; the surrounding block comes back verbatim
and the preview shows what actually moved.

### When the document is unmappable

One construct breaks the pairing: a raw HTML block, which the renderer escapes
to bare text (`html({ text }) { return escapeHtml(text); }`). It produces a
top-level text node that merges with its neighbours' whitespace, so block
boundaries stop being recoverable from the DOM.

The guard is conservative and per-document: if any block contributes a bare
top-level text node, or the paired counts disagree, the document is unmappable.
The revise switch is then hidden, `#ask` behaves exactly as it does today, and
the card-level AI revision remains available. A wrong splice is never preferable
to an unavailable button.

## Contract

`revision_request` gains an optional `selection`. Its absence is today's
whole-card revision, unchanged.

```js
{ type: "revision_request", request_id, node_id, instruction,
  selection: { md_start, md_end, region_markdown, selected_text } }
```

The host rejects the request with 409 when
`node.markdown.slice(md_start, md_end) !== region_markdown` — the card changed
under the reader, and a stale span must not be spliced.

The event handed to the agent keeps `current_markdown` (the whole card, as
context) and adds the same `selection`, with a response contract naming the
fragment as the expected reply. `answer_branch` is unchanged: the agent streams
a shorter body and nothing about the tool moves.

Streaming stays on `revision_progress` / `revision_ready`, which gain
`scope: "selection"` and `fragment`. A selection revision does not go through
`createGenerationIngress` — that accumulator builds a whole card and would
assign block ids to a fragment; the pending fragment is accumulated on the
request instead.

Persistence does not change. On apply the client splices
`md.slice(0, md_start) + fragment + md.slice(md_end)` and posts the existing
`answer_node_content` with the complete Markdown.

## Surface behavior

- **Head switch.** `#ask` gains "Ask" / "Revise" tabs. Ask is the default and
  keeps today's placeholder, lens row, and digit shortcuts. Revise swaps the
  placeholder to an instruction prompt and the lens row to the four suggestion
  chips the card-level revision already offers, so the two revisions read as one
  feature. `e` on an empty ask box switches to Revise; digits stay lenses.
- **Prompt.** Empty instruction refuses to submit, matching `submitRevision`.
  When branches are anchored inside the region, the prompt states how many will
  be detached before anything is sent.
- **Generating.** The region carries a pending treatment in the document; the
  fragment fills the popover as it streams. The document text is not replaced
  during streaming — the popover is anchored to a Range over that text, and
  rewriting it underneath would move the surface while it is being read.
- **Ready.** The document shows the change in place. Because the region is a
  whole block while the intended change is usually one phrase inside it,
  striking the whole region through would bury the edit in unchanged text. The
  preview instead diffs the region against the replacement word by word and
  marks only the runs that actually differ, leaving the rest as ordinary text.
  The popover footer offers Show original, Try again, Cancel, and Apply
  (⌘/Ctrl+Enter).
- **Long selections.** When the region spans more than two blocks the preview
  outgrows an anchored popover, so the ready phase renders in the branch rail
  instead, with the region highlighted in the document. Prompt and generating
  stay in the popover.
- **Error.** Message plus Try again and Cancel, matching the card-level phase.

## Anchors on apply

Child branches anchor to the parent's **rendered** offsets
(`origin.anchor.offset_start/end`), so a splice moves them.

- Branches whose anchor ends at or before the region start are untouched.
- Branches whose anchor starts at or after the region end shift by the region's
  rendered-length delta, computed by re-rendering the card once and taking the
  difference in total rendered text length. Only the region changed, so the
  delta applies exactly.
- Branches overlapping the region keep their node and lose their anchor
  (`origin.anchor = null`). `applyChildHighlights` already skips anchorless
  children, so the branch stays in the rail and on the canvas with its question
  intact and simply no longer paints a mark. Deleting a question the reader
  asked because its sentence was reworded would destroy their work.

Anchor changes persist with `node_origin`, which replaces a node's origin
wholesale.

Applying shows the existing eight-second undo hint. Undo restores the previous
Markdown and the previous anchors together.

## Scope

Selection revision requires an editable answer card: `isRevisableAnswer` on the
host, `canReviseWithAi` in the client. The root document, canvas notes, and PDF
cards are excluded, matching the card-level revision. Widening to the root
document would be additive and is deliberately not part of this change.

## Accessibility

The head switch is a `tablist` with `Ask` and `Revise` tabs, arrow-key
navigation between them, and `aria-controls` pointing at the shared body. Phase
transitions announce through a `role="status"` live region, as the card-level
revision does. The ready phase marks the removed region with `<del>` and the
replacement with `<ins>` so the change is conveyed structurally and not by
colour alone. Escape backs out one level: from a phase to the prompt, from the
prompt to a restored selection.

## Edge cases

- **Card edited elsewhere mid-flight** — the 409 span check fails, the phase
  moves to error and says the card changed.
- **Session away or closed** — Revise is unavailable exactly where asking is,
  reusing the existing gates. Unlike a branch, a revision cannot queue for an
  absent agent because its span may not survive the wait.
- **Selection inside a fenced or math block** — the enclosing block is the whole
  fence, which is a valid region; the agent gets the full fence as the region.
- **Empty fragment returned** — treated as a deletion of the region and
  previewed as such; apply is allowed but the preview shows the region entirely
  struck through.
- **Region unchanged by the agent** — apply is disabled with the status reading
  that nothing changed.
- **Compact layout** — the mobile sheet variant of `#ask` already exists; the
  ready phase uses the rail-style full-width panel there.

## Verification

- A core suite over `lexBlockRegions` asserting, across the twenty documents
  used to validate the projection, that spans are exact and ordered and that
  concatenated block HTML reproduces whole-document output.
- A resolver suite asserting selection-to-region pairing, including the raw-HTML
  document resolving as unmappable.
- A contract suite over the host: selection request validation, the 409 on a
  stale span, fragment streaming through `revision_progress` / `revision_ready`,
  and parity between the node session transport and the web direct host.
- An apply suite over the splice and anchor fixups: shift after, detach
  overlapping, leave before untouched, and undo restoring both.
- A Chromium end-to-end test driving drag → Revise → instruction → streamed
  fragment → apply, asserting the document text changed and an untouched
  neighbouring branch mark still points at its original words.
- Committed bundles regenerated, then the deterministic default suite.
