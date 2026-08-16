function writeData(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function sendChatCompletionResult(res, data, requestedModel, stream = false) {
  if (!stream) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
    return;
  }

  const choice = data?.choices?.[0] || {};
  const message = choice.message || {};
  const id = data?.id || `chatcmpl_${Date.now()}`;
  const created = data?.created || Math.floor(Date.now() / 1000);
  const model = data?.model || requestedModel;
  const delta = { role: message.role || "assistant" };
  if (message.content !== undefined) delta.content = message.content;
  if (message.reasoning_content !== undefined) {
    delta.reasoning_content = message.reasoning_content;
  }
  if (message.tool_calls !== undefined) delta.tool_calls = message.tool_calls;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  writeData(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: choice.index || 0, delta, finish_reason: null }],
  });
  writeData(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{
      index: choice.index || 0,
      delta: {},
      finish_reason: choice.finish_reason || "stop",
    }],
    ...(data?.usage ? { usage: data.usage } : {}),
  });
  res.write("data: [DONE]\n\n");
  res.end();
}
