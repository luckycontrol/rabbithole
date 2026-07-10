export const BRAIN_PRESETS = Object.freeze({
  openrouter: Object.freeze({
    id: "openrouter",
    label: "OpenRouter",
    recommended: true,
    model_source: "catalog",
    base_url: "https://openrouter.ai/api/v1",
    kind: "openai-compatible",
    requires_key: true,
    author_model: "anthropic/claude-sonnet-5",
    answer_model: "anthropic/claude-sonnet-5",
  }),
  custom: Object.freeze({
    id: "custom",
    label: "Local",
    model_source: "custom",
    base_url: "http://localhost:11434/v1",
    kind: "openai-compatible",
    requires_key: false,
    author_model: "llama3.2",
    answer_model: "llama3.2",
  }),
});

export function presetFor(id) {
  return BRAIN_PRESETS[id] || BRAIN_PRESETS.openrouter;
}

export function defaultBrainSettings() {
  const preset = BRAIN_PRESETS.openrouter;
  return {
    preset: preset.id,
    base_url: preset.base_url,
    author_model: preset.author_model,
    answer_model: preset.answer_model,
    fetch_proxy_url: "",
    session_only: false,
  };
}

export function settingsForPreset(id, current = {}) {
  const preset = presetFor(id);
  return {
    ...current,
    preset: preset.id,
    base_url: preset.base_url,
    author_model: preset.author_model,
    answer_model: preset.answer_model,
  };
}
