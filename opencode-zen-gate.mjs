// What OpenCode Zen checks before it serves a free-tier request.
//
// Empirically the gate rejects a request unless all of the following hold:
//   * the credential is the OAuth access token from a Console sign-in
//     (a Console API key always fails with FreeTierError);
//   * the user-agent identifies OpenCode 1.18.0 or newer - older and non-
//     OpenCode agents get FreeTierError or 426;
//   * x-opencode-session names a session a real client created;
//   * the request streams;
//   * the request declares tools, including OpenCode's own built-in tool names.
// The built-ins are re-declared here with empty schemas so the model can see
// them but will not select them in favour of the caller's tools.

export const GATE_TOOL_NAMES = ["edit", "glob", "grep", "question", "read", "shell", "skill", "subagent", "webfetch", "write", "execute"];

export const GATE_TOOLS = GATE_TOOL_NAMES.map((name) => ({
  type: "function",
  function: {
    name,
    description: "Disabled in this session. Do not call this tool.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
}));

export function requestId() {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let id = "";
  for (let i = 0; i < 26; i += 1) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `msg_${id}`;
}

export function zenHeaders({
  session,
  client = "cli",
  project = "global",
  clientVersion = "1.18.32",
  channel = "latest",
  orgId = "",
  authorization,
}) {
  // v2 reports itself as opencode/<channel>/<version>/cli; v1 had no channel.
  const versioned = String(clientVersion).startsWith("2.")
    ? `${channel}/${clientVersion}`
    : clientVersion;
  const headers = {
    authorization,
    "user-agent": `opencode/${versioned}/cli`,
    "x-opencode-client": client,
    "x-opencode-project": project,
    "x-opencode-session": session,
    "x-session-id": session,
    "x-session-affinity": session,
  };
  if (orgId) headers["x-opencode-org-id"] = orgId;
  return headers;
}

// Merges the gate tools with the caller's tools and forces streaming.
export function shapeZenRequest(body, { gateTools = GATE_TOOLS } = {}) {
  const shaped = { ...body, stream: true };
  if (!shaped.stream_options) shaped.stream_options = { include_usage: true };
  const declared = Array.isArray(shaped.tools) ? shaped.tools : [];
  const declaredNames = new Set(declared.map((tool) => tool?.function?.name || tool?.name));
  const missing = gateTools.filter((tool) => !declaredNames.has(tool.function.name));
  shaped.tools = missing.length ? [...declared, ...missing] : declared;
  if (!shaped.tools.length) throw new Error("OpenCode Zen requires at least one tool on a free-tier request");
  return shaped;
}