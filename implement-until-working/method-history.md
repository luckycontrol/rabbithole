# Method History

## Current Baseline
- Latest iteration: 001
- Baseline status: progress
- Baseline evidence: The new browser test originally failed because reader composing Enter created 1 branch instead of 0. After the `isComposing` guard and rebuild, the reader assertions passed; the test then reached the card setup but timed out because a pointer click on the card handle was intercepted by `#viewport` before card IME assertions ran.

## Attempt Ledger

| Iteration | Method | Why Chosen | Target Symptom | Outcome | Proof Summary |
| --- | --- | --- | --- | --- | --- |
| 001 | Guard both follow-up Enter handlers with `!event.isComposing` | The premature request is emitted by the IME confirmation keydown itself, and the event already exposes composition state | Korean `테스트` can create an intermediate `트` follow-up branch | better | RED: reader branch count was 1 vs expected 0. After edit/build, reader no-request and full-text assertions passed; card verification was not reached due test pointer interception. `check:dist` and all unit tests passed. |

## Notes
- Do not repeat the event-level guard unless a card assertion proves it insufficient.
- The next iteration should first change the card test setup from pointer `click` to the repository's established `focus()` + keyboard Enter drawer-opening flow, then rerun the same test.
