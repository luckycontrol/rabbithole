# Golden Ask Evals

Run:

```bash
EVAL_BASE_URL=https://openrouter.ai/api/v1 \
EVAL_API_KEY=... \
EVAL_MODEL=anthropic/claude-sonnet-5 \
npm run eval
```

The runner uses the real web Brain answer prompt and OpenAI-compatible streaming
transport. It prints a pass/fail scorecard for the golden asks and exits nonzero
on any hard rubric failure or provider error.

To promote a model in `src/web/brain/tested-models.js`, run the eval with that
exact provider/model string, record the passing date in the registry entry, and
change `status` from `untested` to `passed` in the same commit as the eval note.
Do not mark models as tested from structure-only checks.
