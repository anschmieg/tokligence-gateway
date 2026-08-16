export function protocolForPath(pathname) {
  if (pathname.includes("/chat/completions")) return "chat_completions";
  if (pathname.includes("/responses")) return "responses";
  if (pathname.includes("/messages")) return "messages";
  return null;
}

export function inspectRequestFeatures(protocol, request) {
  const input = request || {};
  const content = JSON.stringify(input.messages || input.input || "");
  return {
    protocol,
    streaming: input.stream === true,
    tools: Array.isArray(input.tools) && input.tools.length > 0,
    parallel_tools: input.parallel_tool_calls === true,
    structured_output: Boolean(input.response_format || input.text?.format || input.output_config?.format),
    reasoning: Boolean(input.reasoning || input.thinking || input.output_config?.effort),
    vision: /"(image|input_image|image_url)"/.test(content),
  };
}

export function supportsFeatures(capabilities, required) {
  if (!capabilities.protocols.includes(required.protocol)) return false;
  return ["streaming", "tools", "parallel_tools", "structured_output", "reasoning", "vision"].every((feature) => !required[feature] || capabilities[feature] === true);
}
