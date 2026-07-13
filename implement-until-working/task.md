# Follow-up IME submission

## Request
Entering Korean text such as `테스트` in a follow-up composer and pressing Enter must create one follow-up branch, not an intermediate extra branch such as `트`.

## Acceptance criteria
- A composing Enter keydown makes no follow-up branch request.
- After composition completes, a normal Enter makes exactly one request containing the full current text.
- The behavior is consistent in the main reader composer and each canvas card composer.
- Shift+Enter remains a newline path.

## Touchpoints and constraints
- Main composer: `src/ui/ask-followups.js`
- Card composer: `src/ui/canvas-view.js`
- Browser regression coverage: `test/e2e/`
- UI changes require `npm run build` because committed bundles are shipped.
- Keep the fix scoped to follow-up composers and add no dependencies.

## Canonical verification
```bash
node test/e2e/followup-ime.test.mjs
npm run build
npm test
```
