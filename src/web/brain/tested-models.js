export const TESTED_MODELS = Object.freeze({
  "anthropic/claude-sonnet-5": Object.freeze({
    model: "anthropic/claude-sonnet-5",
    provider: "openrouter",
    status: "untested",
    note: "Default model; promote only after npm run eval passes with this exact model.",
  }),
});

export function testedModelRecord(model) {
  return TESTED_MODELS[String(model || "").trim()] || null;
}

export function testedModelHint(model) {
  const record = testedModelRecord(model);
  if (!record) return "Untested model.";
  if (record.status === "passed") return "Eval-tested.";
  return "Untested until npm run eval passes.";
}

export function isEvalTestedModel(model) {
  return testedModelRecord(model)?.status === "passed";
}
