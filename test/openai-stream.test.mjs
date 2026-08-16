import assert from "node:assert/strict";
import test from "node:test";

import { sendChatCompletionResult } from "../openai-stream.mjs";

function fakeResponse() {
  return {
    status: null,
    headers: null,
    chunks: [],
    ended: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    write(chunk) {
      this.chunks.push(String(chunk));
    },
    end(chunk = "") {
      if (chunk) this.chunks.push(String(chunk));
      this.ended = true;
    },
  };
}

test("streaming chat clients receive valid SSE for buffered upstream results", () => {
  const res = fakeResponse();
  sendChatCompletionResult(res, {
    id: "chatcmpl_test",
    object: "chat.completion",
    created: 123,
    model: "deepseek-v4-flash-free",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: "OK",
        reasoning_content: "done",
      },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  }, "opencode-zen/deepseek-v4-flash-free", true);

  const body = res.chunks.join("");
  assert.equal(res.status, 200);
  assert.equal(res.headers["Content-Type"], "text/event-stream");
  assert.match(body, /"object":"chat.completion.chunk"/);
  assert.match(body, /"content":"OK"/);
  assert.match(body, /"reasoning_content":"done"/);
  assert.match(body, /"finish_reason":"stop"/);
  assert.match(body, /data: \[DONE\]/);
  assert.equal(res.ended, true);
});

test("non-streaming chat clients retain the original JSON response", () => {
  const res = fakeResponse();
  const data = {
    id: "chatcmpl_test",
    choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
  };
  sendChatCompletionResult(res, data, "model", false);

  assert.equal(res.status, 200);
  assert.equal(res.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(res.chunks.join("")), data);
  assert.equal(res.ended, true);
});
