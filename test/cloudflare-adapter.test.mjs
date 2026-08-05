import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  appendAssistantMessage,
  buildChatRequest,
  chatResponseToResponses,
  CloudflareResponsesAdapter,
  responseEvents,
  responsesInputToChat,
  responsesToolsToChat,
} from "../src/cloudflare-adapter.mjs";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}/v1`;
}

function completedResponseId(sse) {
  const data = sse.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
  return data.find((event) => event.type === "response.completed")?.response?.id;
}

test("translates Responses messages and tool results to Chat Completions", () => {
  assert.deepEqual(responsesInputToChat([
    { role: "user", content: [{ type: "input_text", text: "read it" }] },
    { type: "function_call_output", call_id: "call_1", output: "done" },
  ]), [
    { role: "user", content: "read it" },
    { role: "tool", tool_call_id: "call_1", content: "done" },
  ]);
});

test("translates Responses function declarations", () => {
  assert.deepEqual(responsesToolsToChat([
    { type: "function", name: "exec", description: "Run", parameters: { type: "object" }, strict: false },
    { type: "web_search" },
  ]), [{
    type: "function",
    function: { name: "exec", description: "Run", parameters: { type: "object" }, strict: false },
  }]);
});

test("builds a bounded-provider request without Responses-only fields", () => {
  const body = buildChatRequest({
    model: "test", instructions: "Be useful", input: "hello", max_output_tokens: 100,
    tools: [{ type: "function", name: "exec", parameters: { type: "object" } }],
    store: false, include: ["reasoning.encrypted_content"], stream: true,
  });
  assert.deepEqual(body.messages, [
    { role: "system", content: "Be useful" },
    { role: "user", content: "hello" },
  ]);
  assert.equal(body.stream, false);
  assert.equal(body.max_completion_tokens, 100);
  assert.equal("input" in body, false);
  assert.equal("store" in body, false);
});

test("preserves multi-turn text and tool-call linkage", () => {
  const first = buildChatRequest({ model: "test", input: "remember 1729" });
  const chat = {
    choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "exec", arguments: "{}" } }] } }],
  };
  const saved = appendAssistantMessage(first.messages, chat);
  const second = buildChatRequest({
    model: "test", input: [{ type: "function_call_output", call_id: "call_1", output: "ok" }],
  }, saved);
  assert.deepEqual(second.messages.at(-2).tool_calls[0].id, "call_1");
  assert.deepEqual(second.messages.at(-1), { role: "tool", tool_call_id: "call_1", content: "ok" });
});

test("converts Chat Completions text and calls into Responses output", () => {
  const converted = chatResponseToResponses({
    id: "chat_1", model: "test", created: 1,
    choices: [{ message: { role: "assistant", content: "hello", tool_calls: [{ id: "call_1", type: "function", function: { name: "exec", arguments: "{\"x\":1}" } }] } }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  }, "resp_old");
  assert.equal(converted.previous_response_id, "resp_old");
  assert.equal(converted.output[0].content[0].text, "hello");
  assert.deepEqual(converted.output[1], {
    id: converted.output[1].id, type: "function_call", call_id: "call_1", name: "exec", arguments: "{\"x\":1}", status: "completed",
  });
  assert.equal(converted.usage.total_tokens, 5);
});

test("converts a completed response into Codex-compatible SSE events", () => {
  const response = chatResponseToResponses({
    model: "test", choices: [{ message: { role: "assistant", content: "hello" } }],
  });
  const events = responseEvents(response);
  assert.equal(events.some((event) => event.type === "response.output_text.delta" && event.delta === "hello"), true);
  assert.equal(events.at(-1).type, "response.completed");
  assert.equal(events.at(-1).response, response);
});

test("keeps a multi-turn transcript while proxying Responses to Chat Completions", async (t) => {
  const requests = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      model: "test",
      choices: [{ message: { role: "assistant", content: requests.length === 1 ? "remembered" : "1729" } }],
    }));
  });
  const upstreamBaseUrl = await listen(upstream);
  const adapter = new CloudflareResponsesAdapter({ upstreamBaseUrl, apiKey: "test-key" });
  const adapterBaseUrl = await adapter.listen();
  t.after(async () => { await adapter.close(); await new Promise((resolve) => upstream.close(resolve)); });

  const first = await fetch(`${adapterBaseUrl}/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "test", input: "remember 1729", stream: true }),
  });
  const firstId = completedResponseId(await first.text());
  const second = await fetch(`${adapterBaseUrl}/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "test", previous_response_id: firstId, input: "what number?", stream: true }),
  });
  assert.equal(second.status, 200);
  assert.deepEqual(requests.map((request) => request.url), ["/v1/chat/completions", "/v1/chat/completions"]);
  assert.deepEqual(requests[1].body.messages, [
    { role: "user", content: "remember 1729" },
    { role: "assistant", content: "remembered" },
    { role: "user", content: "what number?" },
  ]);
});
