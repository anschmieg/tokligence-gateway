// Model catalog metadata for GET /v1/models.
//
// The envelope stays OpenAI-compatible; the extensions follow the field names
// GitHub Copilot's /v1/models already uses, because that is the dialect clients
// (Claude Code's Agent SDK among them) actually parse:
//
//   model_picker_enabled / model_picker_category  picker visibility and grouping
//   policy.state / policy.terms                  gating plus a human-readable why
//   capabilities.limits                          context, prompt, output budgets
//   capabilities.supports                        tools, streaming, reasoning, vision
//   supported_endpoints                          which routes serve the model
//
// Limits are baked in rather than fetched per request so the gateway does not
// depend on a third-party catalog host being reachable.

// Real per-model limits, from https://models.opencode.ai/api.json (`limit`).
// Only models we have authoritative numbers for are listed; the rest omit
// `limits` rather than publish a guess.
const MODEL_LIMITS = {
  "space-bunny-free": { max_context_window_tokens: 1048576, max_prompt_tokens: 524288, max_output_tokens: 524288 },
  "beam-free": { max_context_window_tokens: 1048576, max_output_tokens: 131072 },
  "deepseek-v4.1-flash-free": { max_context_window_tokens: 200000, max_output_tokens: 32000 },
  "glm-5.3-flash-free": { max_context_window_tokens: 200000, max_output_tokens: 32000 },
  "longcat-2.5-preview-free": { max_context_window_tokens: 1000000, max_output_tokens: 131072 },
  "mimo-v2.6-flash-free": { max_context_window_tokens: 200000, max_output_tokens: 32000 },
  "nemotron-3.5-lightning-free": { max_context_window_tokens: 262144, max_output_tokens: 262144 },
  "nemotron-3.5-super-vl-free": { max_context_window_tokens: 1048576, max_output_tokens: 131072 },
};

const PROTOCOL_ENDPOINTS = {
  chat_completions: "/v1/chat/completions",
  messages: "/v1/messages",
  responses: "/v1/responses",
};

const VISION_MODELS = new Set(["nemotron-3.5-super-vl-free"]);

function capabilitiesFor(model, limits) {
  const supports = {
    tool_calls: true,
    parallel_tool_calls: true,
    streaming: true,
    structured_outputs: false,
    reasoning_effort: ["low", "medium", "high"],
    adaptive_thinking: false,
    min_thinking_budget: 1024,
    max_thinking_budget: 32000,
    vision: VISION_MODELS.has(model.id.toLowerCase()),
  };
  const capabilities = {
    object: "model_capabilities",
    type: "chat",
    family: model.id.split("/").pop().replace(/[-.].*$/, ""),
    supports,
  };
  if (limits) capabilities.limits = limits;
  if (supports.vision) {
    capabilities.limits = {
      ...(capabilities.limits || {}),
      vision: { max_prompt_images: 4, supported_media_types: ["image/png", "image/jpeg", "image/webp"] },
    };
  }
  return capabilities;
}

// Picker policy: hide superseded generations and providers the account no
// longer pays for, but keep them callable and explain why they are hidden.
export function pickerPolicyFor(model, policy = {}) {
  const providers = policy.providers || {};
  const provider = model.provider;
  const reasons = [];

  const providerRule = providers[provider];
  const isFree = /free/.test(model.id.toLowerCase());
  if (providerRule?.enabled === false) {
    reasons.push(providerRule.reason || `${provider} is not available on your plan`);
  } else if (providerRule?.free_only && !isFree) {
    reasons.push(providerRule.reason || `${provider} is only available on the free tier`);
  }

  for (const rule of policy.hide || []) {
    if (rule.pattern && new RegExp(rule.pattern, "i").test(model.id)) {
      reasons.push(rule.reason || "Superseded generation");
      break;
    }
  }

  const enabled = reasons.length === 0;
  return {
    model_picker_enabled: enabled,
    model_picker_category: policy.categories?.[provider] || model.quality_tier || "general",
    preview: Boolean(model.preview),
    policy: enabled
      ? { state: "enabled" }
      : { state: "disabled", terms: reasons.join("; ") },
  };
}

export function decorateModel(model, policy = {}) {
  const limits = MODEL_LIMITS[model.id.toLowerCase()];
  const endpoints = (model.protocols || Object.keys(PROTOCOL_ENDPOINTS)).map((p) => PROTOCOL_ENDPOINTS[p]).filter(Boolean);
  return {
    ...model,
    name: model.display_name || model.id,
    version: model.id,
    vendor: model.vendor || model.provider,
    supported_endpoints: endpoints.length ? endpoints : [PROTOCOL_ENDPOINTS.chat_completions],
    capabilities: capabilitiesFor(model, limits),
    ...pickerPolicyFor(model, policy),
  };
}
