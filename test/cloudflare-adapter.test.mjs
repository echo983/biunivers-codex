import test from "node:test";
import assert from "node:assert/strict";
import { adaptRequest, responseEvents } from "../src/cloudflare-adapter.mjs";

test("removes unsupported Codex fields and tools", () => {
  const adapted = adaptRequest({
    model: "test", stream: true, include: ["reasoning.encrypted_content"],
    prompt_cache_key: "x", client_metadata: { origin: "test" }, store: false,
    tools: [{ type: "function", name: "exec" }, { type: "namespace", name: "agents" }, { type: "web_search" }],
  });
  assert.equal(adapted.stream, false);
  assert.deepEqual(adapted.tools, [{ type: "function", name: "exec" }]);
  for (const field of ["include", "prompt_cache_key", "client_metadata", "store"]) assert.equal(field in adapted, false);
});

test("converts a completed response into Codex-compatible SSE events", () => {
  const response = {
    id: "resp_1", status: "completed",
    output: [{ id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hello", annotations: [], logprobs: [] }] }],
  };
  const events = responseEvents(response);
  assert.equal(events.some((event) => event.type === "response.output_text.delta" && event.delta === "hello"), true);
  assert.equal(events.at(-1).type, "response.completed");
  assert.equal(events.at(-1).response, response);
});
