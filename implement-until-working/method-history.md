# Method History

## Current Baseline
- Latest iteration: 003
- Baseline status: complete
- Baseline evidence: The browser regression now uses the newly appended card's stable `.origin-quote` to prove the full `테스트` question was retained, and waits for the second provider body to prove that request also contains `테스트`. The narrow test, dist/type/purity checks, and full `npm test` all pass.

## Attempt Ledger

| Iteration | Method | Why Chosen | Target Symptom | Outcome | Proof Summary |
| --- | --- | --- | --- | --- | --- |
| 001 | Guard both follow-up Enter handlers with `!event.isComposing` | The premature request is emitted by the IME confirmation keydown itself, and the event already exposes composition state | Korean `테스트` can create an intermediate `트` follow-up branch | better | RED: reader branch count was 1 vs expected 0. After edit/build, reader no-request and full-text assertions passed; card verification was not reached due test pointer interception. `check:dist` and all unit tests passed. |
| 002 | Open the card composer through focus + keyboard Enter and register the regression in `test:e2e` | Pointer clicking the transformed card handle was intercepted by `#viewport`; the established suite uses the keyboard disclosure path | Card IME assertions were unreachable because test setup timed out | better | The drawer setup and both card composing-Enter no-op assertions passed; completed submission added exactly one node. The next assertion races the immediate mock answer title and fails with `0 !== 1`. |
| 003 | Assert the appended card's stable question origin instead of its answer title | The immediate mock answer intentionally replaces the optimistic question title, but the card origin remains the submitted question | Final E2E failure was a transient `.node-title` assertion racing `TITLE: Card IME` | complete | `followup-ime.test.mjs`, `check:dist`, `check:types`, `check:purity`, and the full `npm test` suite all exited 0. |

## Notes
- Do not repeat the event-level guard unless a card assertion proves it insufficient.
- Do not retry pointer interaction for the card drawer; focus + keyboard Enter is now proven to reach the card behavior.
- The requested behavior is verified complete; no further iteration is needed unless new evidence reveals a distinct failure mode.
