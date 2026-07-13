# Follow-up IME submission design

## Context and decision

The reader follow-up textarea and the per-card follow-up textarea both submit on an unshifted Enter keydown. During Korean IME composition, browsers can emit that Enter keydown to confirm the current syllable before the textarea contains the final composed value. Treating that event as form submission creates a premature branch; the later ordinary Enter can then create the intended full-text branch.

Three implementation shapes were considered. First, each composer can guard its existing Enter condition with `KeyboardEvent.isComposing`. Second, the UI can maintain composition state from `compositionstart` and `compositionend` listeners. Third, a document-level key filter can suppress composing Enter globally. The first approach is preferred: the browser event already carries the relevant state, no lifecycle state can become stale, and the change stays local to the two follow-up submission boundaries. A shared helper would add indirection for only two simple predicates, so both handlers will use the same explicit condition.

The selection-based ask popup also handles Enter, but it creates a different selection branch and is outside the reported follow-up flow. It will remain unchanged to avoid widening behavior without a matching requirement.

## Behavior and verification

For each follow-up composer, an Enter keydown submits only when Shift is not held and `isComposing` is false. A composing Enter is left to the browser/IME and does not clear text, create an optimistic node, or send a request. Once composition has ended, the next normal Enter reads the textarea's complete trimmed value and follows the existing single submission path. Shift+Enter behavior is unchanged.

A real Chromium regression test will create a document through the browser host and exercise both surfaces. It will set an intermediate Korean value, dispatch a composing Enter, and assert that no provider request or follow-up child appears. It will then finish the value as `테스트`, dispatch composition end followed by a normal Enter, and assert exactly one request and one child whose question/title is the full text. The same sequence will run for the reader composer and card composer. The test must fail against the current implementation before production code changes. After the minimal guards are added, committed bundles will be rebuilt, the narrow test will pass, and the broader deterministic suite will be run if feasible.
