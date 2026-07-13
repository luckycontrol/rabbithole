# Method History

## Current Baseline
- Latest iteration: 002
- Baseline status: progress
- Baseline evidence: The card drawer now opens through the established keyboard disclosure path, so the test passes the card composing-Enter no-node/no-request assertions and observes exactly one new node after completed `테스트` submission. It now fails only because the test expects `.node-title` to remain `테스트`, while the immediate mock response replaces the optimistic question title with `Card IME` before that assertion.

## Attempt Ledger

| Iteration | Method | Why Chosen | Target Symptom | Outcome | Proof Summary |
| --- | --- | --- | --- | --- | --- |
| 001 | Guard both follow-up Enter handlers with `!event.isComposing` | The premature request is emitted by the IME confirmation keydown itself, and the event already exposes composition state | Korean `테스트` can create an intermediate `트` follow-up branch | better | RED: reader branch count was 1 vs expected 0. After edit/build, reader no-request and full-text assertions passed; card verification was not reached due test pointer interception. `check:dist` and all unit tests passed. |
| 002 | Open the card composer through focus + keyboard Enter and register the regression in `test:e2e` | Pointer clicking the transformed card handle was intercepted by `#viewport`; the established suite uses the keyboard disclosure path | Card IME assertions were unreachable because test setup timed out | better | The drawer setup and both card composing-Enter no-op assertions passed; completed submission added exactly one node. The next assertion races the immediate mock answer title and fails with `0 !== 1`. |

## Notes
- Do not repeat the event-level guard unless a card assertion proves it insufficient.
- Do not retry pointer interaction for the card drawer; focus + keyboard Enter is now proven to reach the card behavior.
- The next iteration should make the full-question assertion stable against the expected answer-title update, for example by asserting the new card's `.origin-quote` and the second captured request body after waiting for request count. Then rerun the narrow test before considering production changes.
