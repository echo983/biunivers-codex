import { randomUUID } from "node:crypto";
import http from "node:http";

const MAX_CONVERSATIONS = 64;

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => ["input_text", "output_text", "text"].includes(part?.type) && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

export function responsesInputToChat(input) {
  const items = Array.isArray(input) ? input : typeof input === "string"
    ? [{ role: "user", content: input }]
    : [input];
  const messages = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (["system", "developer", "user", "assistant"].includes(item.role)) {
      const content = textContent(item.content);
      if (content) messages.push({ role: item.role === "developer" ? "system" : item.role, content });
      continue;
    }
    if (item.type === "function_call" && item.call_id && item.name) {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: item.call_id,
          type: "function",
          function: { name: item.name, arguments: item.arguments || "{}" },
        }],
      });
      continue;
    }
    if (item.type === "function_call_output" && item.call_id) {
      messages.push({ role: "tool", tool_call_id: item.call_id, content: textContent(item.output) || String(item.output ?? "") });
    }
  }
  return messages;
}

export function responsesToolsToChat(tools = []) {
  return tools.filter((tool) => tool?.type === "function" && tool.name).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.parameters || { type: "object", properties: {} },
      ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {}),
    },
  }));
}

export function buildChatRequest(incoming, priorMessages = []) {
  const messages = structuredClone(priorMessages);
  if (!messages.length && incoming.instructions) messages.push({ role: "system", content: String(incoming.instructions) });
  messages.push(...responsesInputToChat(incoming.input));
  const body = { model: incoming.model, messages, stream: false };
  const tools = responsesToolsToChat(incoming.tools);
  if (tools.length) body.tools = tools;
  if (incoming.tool_choice !== undefined) body.tool_choice = incoming.tool_choice;
  if (incoming.parallel_tool_calls !== undefined) body.parallel_tool_calls = incoming.parallel_tool_calls;
  if (incoming.max_output_tokens !== undefined) body.max_completion_tokens = incoming.max_output_tokens;
  return body;
}

export function chatResponseToResponses(chat, previousResponseId = null) {
  const choice = chat.choices?.[0] || {};
  const message = choice.message || {};
  const output = [];
  if (typeof message.content === "string" && message.content) {
    output.push({
      id: `msg_${randomUUID().replaceAll("-", "")}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: message.content, annotations: [], logprobs: [] }],
    });
  }
  for (const call of message.tool_calls || []) {
    if (call?.type !== "function" || !call.function?.name) continue;
    output.push({
      id: `fc_${randomUUID().replaceAll("-", "")}`,
      type: "function_call",
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments || "{}",
      status: "completed",
    });
  }
  return {
    id: `resp_${randomUUID().replaceAll("-", "")}`,
    object: "response",
    created_at: chat.created || Math.floor(Date.now() / 1000),
    status: "completed",
    error: null,
    incomplete_details: null,
    model: chat.model,
    previous_response_id: previousResponseId,
    output,
    usage: chat.usage ? {
      input_tokens: chat.usage.prompt_tokens || 0,
      output_tokens: chat.usage.completion_tokens || 0,
      total_tokens: chat.usage.total_tokens || 0,
    } : undefined,
  };
}

export function appendAssistantMessage(messages, chat) {
  const message = chat.choices?.[0]?.message;
  if (!message) return messages;
  const saved = { role: "assistant", content: typeof message.content === "string" ? message.content : null };
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) saved.tool_calls = structuredClone(message.tool_calls);
  return [...messages, saved];
}

export function responseEvents(response) {
  let sequence = 0;
  const events = [];
  const push = (type, fields) => events.push({ type, sequence_number: sequence++, ...fields });
  for (const [outputIndex, item] of response.output.entries()) {
    push("response.output_item.added", {
      output_index: outputIndex,
      item: { ...item, status: "in_progress" },
    });
    for (const [contentIndex, part] of (item.content || []).entries()) {
      push("response.content_part.added", {
        item_id: item.id, output_index: outputIndex, content_index: contentIndex,
        part: { ...part, text: "" },
      });
      if (part.type === "output_text") {
        push("response.output_text.delta", {
          item_id: item.id, output_index: outputIndex, content_index: contentIndex,
          delta: part.text, logprobs: [],
        });
        push("response.output_text.done", {
          item_id: item.id, output_index: outputIndex, content_index: contentIndex,
          text: part.text, logprobs: [],
        });
      }
      push("response.content_part.done", {
        item_id: item.id, output_index: outputIndex, content_index: contentIndex, part,
      });
    }
    push("response.output_item.done", { output_index: outputIndex, item });
  }
  push("response.completed", { response });
  return events;
}

export class CloudflareResponsesAdapter {
  #server;
  #conversations = new Map();

  constructor({ upstreamBaseUrl, apiKey }) {
    this.upstreamBaseUrl = upstreamBaseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.#server = http.createServer((request, response) => this.#handle(request, response));
  }

  async listen() {
    await new Promise((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(0, "127.0.0.1", resolve);
    });
    return `http://127.0.0.1:${this.#server.address().port}/v1`;
  }

  close() { return new Promise((resolve) => this.#server.close(resolve)); }

  async #handle(request, response) {
    const startedAt = Date.now();
    try {
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404, { "content-type": "application/json" });
        return response.end('{"error":{"message":"Not found."}}');
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const incoming = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const previousId = typeof incoming.previous_response_id === "string" ? incoming.previous_response_id : null;
      const priorMessages = previousId ? this.#conversations.get(previousId) : undefined;
      if (previousId && !priorMessages) {
        response.writeHead(404, { "content-type": "application/json" });
        return response.end('{"error":{"message":"Previous model response is no longer available."}}');
      }
      const body = buildChatRequest(incoming, priorMessages);
      const upstream = await fetch(`${this.upstreamBaseUrl}/chat/completions`, {
        method: "POST",
        signal: AbortSignal.timeout(90_000),
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await upstream.json();
      console.log(`Model request completed with HTTP ${upstream.status} in ${Date.now() - startedAt} ms.`);
      if (!upstream.ok) {
        response.writeHead(upstream.status, { "content-type": "application/json" });
        return response.end(JSON.stringify(result));
      }
      const converted = chatResponseToResponses(result, previousId);
      this.#conversations.set(converted.id, appendAssistantMessage(body.messages, result));
      if (this.#conversations.size > MAX_CONVERSATIONS) this.#conversations.delete(this.#conversations.keys().next().value);
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      for (const event of responseEvents(converted)) {
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      response.end();
    } catch (error) {
      const timedOut = error?.name === "TimeoutError";
      console.error(`Model request ${timedOut ? "timed out" : "failed"} after ${Date.now() - startedAt} ms.`);
      response.writeHead(timedOut ? 504 : 502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: timedOut ? "Model request timed out." : "Model adapter failed." } }));
    }
  }
}
