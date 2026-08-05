import { randomUUID } from "node:crypto";
import http from "node:http";

const MAX_CONVERSATIONS = 64;
export const MAX_TOOL_CALLS_PER_TURN = 8;
const PROVIDER_FAILURE_MESSAGE = "模型服务暂时无法生成有效回答，本轮任务已停止，请稍后重试。";
const TOOL_BUDGET_MESSAGE = `本轮已达到 ${MAX_TOOL_CALLS_PER_TURN} 次工具调用上限。请根据已有结果回答；如果信息仍不足，应明确说明并请用户发起新的指令。`;

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => ["input_text", "output_text", "text"].includes(part?.type) && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function normalizedChatMessage(message) {
  const normalized = structuredClone(message);
  normalized.content = textContent(normalized.content);
  if (normalized.role === "assistant" && normalized.tool_calls?.length && !normalized.content) {
    normalized.content = "";
  }
  return normalized;
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
    if (["function_call", "custom_tool_call"].includes(item.type) && item.call_id && item.name) {
      const argumentsText = item.type === "custom_tool_call"
        ? JSON.stringify({ input: String(item.input ?? "") })
        : item.arguments || "{}";
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: item.call_id,
          type: "function",
          function: { name: item.name, arguments: argumentsText },
        }],
      });
      continue;
    }
    if (["function_call_output", "custom_tool_call_output"].includes(item.type) && item.call_id) {
      messages.push({ role: "tool", tool_call_id: item.call_id, content: textContent(item.output) || String(item.output ?? "") });
    }
  }
  return messages;
}

export function responsesToolsToChat(tools = []) {
  return tools.filter((tool) => ["function", "custom"].includes(tool?.type) && tool.name).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.type === "custom"
        ? { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false }
        : tool.parameters || { type: "object", properties: {} },
      ...(tool.type === "function" && typeof tool.strict === "boolean" ? { strict: tool.strict } : {}),
    },
  }));
}

export function buildChatRequest(incoming, priorMessages = []) {
  const messages = priorMessages.map(normalizedChatMessage);
  if (!messages.length && incoming.instructions) messages.push({ role: "system", content: String(incoming.instructions) });
  messages.push(...responsesInputToChat(incoming.input).map(normalizedChatMessage));
  const body = { model: incoming.model, messages, stream: false };
  const tools = responsesToolsToChat(incoming.tools);
  if (tools.length) body.tools = tools;
  if (incoming.tool_choice !== undefined) body.tool_choice = incoming.tool_choice;
  if (incoming.parallel_tool_calls !== undefined) body.parallel_tool_calls = incoming.parallel_tool_calls;
  if (incoming.max_output_tokens !== undefined) body.max_completion_tokens = incoming.max_output_tokens;
  return body;
}

export function enforceToolBudget(body, usedToolCalls) {
  if (usedToolCalls < MAX_TOOL_CALLS_PER_TURN) return false;
  body.tool_choice = "none";
  body.messages.push({ role: "system", content: TOOL_BUDGET_MESSAGE });
  return true;
}

export function limitToolCalls(chat, remaining) {
  const message = chat.choices?.[0]?.message;
  if (!Array.isArray(message?.tool_calls) || message.tool_calls.length <= remaining) return chat;
  const limited = structuredClone(chat);
  limited.choices[0].message.tool_calls = limited.choices[0].message.tool_calls.slice(0, Math.max(0, remaining));
  return limited;
}

export function terminalChatResponse(model, content) {
  return {
    model,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
  };
}

function isToolContinuation(input) {
  const items = Array.isArray(input) ? input : [input];
  return items.some((item) => ["function_call_output", "custom_tool_call_output"].includes(item?.type));
}

export function chatResponseToResponses(chat, previousResponseId = null, customToolNames = new Set()) {
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
    if (customToolNames.has(call.function.name)) {
      let input = call.function.arguments || "";
      try { input = JSON.parse(input).input ?? input; } catch { /* Preserve malformed input for Codex to report. */ }
      output.push({
        id: `ctc_${randomUUID().replaceAll("-", "")}`,
        type: "custom_tool_call",
        call_id: call.id,
        name: call.function.name,
        input: String(input),
        status: "completed",
      });
      continue;
    }
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
  const saved = { role: "assistant", content: textContent(message.content) };
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) saved.tool_calls = structuredClone(message.tool_calls);
  return [...messages, saved];
}

export function hasUsableChatOutput(chat) {
  const message = chat.choices?.[0]?.message;
  return Boolean(
    (typeof message?.content === "string" && message.content.length)
    || (Array.isArray(message?.tool_calls) && message.tool_calls.length),
  );
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
      const priorConversation = previousId ? this.#conversations.get(previousId) : undefined;
      if (previousId && !priorConversation) {
        response.writeHead(404, { "content-type": "application/json" });
        return response.end('{"error":{"message":"Previous model response is no longer available."}}');
      }
      const continuingToolRound = isToolContinuation(incoming.input);
      const usedToolCalls = continuingToolRound ? priorConversation?.toolCalls || 0 : 0;
      const body = buildChatRequest(incoming, priorConversation?.messages);
      const toolBudgetExhausted = enforceToolBudget(body, usedToolCalls);
      let result;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const upstream = await fetch(`${this.upstreamBaseUrl}/chat/completions`, {
            method: "POST",
            signal: AbortSignal.timeout(90_000),
            headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          result = await upstream.json();
          console.log(`Model request completed with HTTP ${upstream.status} in ${Date.now() - startedAt} ms.`);
          if (upstream.ok && hasUsableChatOutput(result)) break;
          console.warn(`Model request produced no usable result${attempt === 1 ? "; retrying once." : "."}`);
        } catch {
          console.warn(`Model request failed${attempt === 1 ? "; retrying once." : "."}`);
        }
      }
      if (!hasUsableChatOutput(result)) {
        result = terminalChatResponse(incoming.model, PROVIDER_FAILURE_MESSAGE);
      }
      if (toolBudgetExhausted && result.choices?.[0]?.message?.tool_calls?.length) {
        result = terminalChatResponse(incoming.model, TOOL_BUDGET_MESSAGE);
      }
      result = limitToolCalls(result, MAX_TOOL_CALLS_PER_TURN - usedToolCalls);
      const upstreamMessage = result.choices?.[0]?.message || {};
      console.log(JSON.stringify({
        event: "model_response_shape",
        finishReason: result.choices?.[0]?.finish_reason ?? null,
        textLength: typeof upstreamMessage.content === "string" ? upstreamMessage.content.length : 0,
        reasoningLength: typeof upstreamMessage.reasoning_content === "string" ? upstreamMessage.reasoning_content.length : 0,
        toolNames: (upstreamMessage.tool_calls || []).map((call) => call?.function?.name).filter(Boolean),
      }));
      const customToolNames = new Set((incoming.tools || []).filter((tool) => tool?.type === "custom").map((tool) => tool.name));
      const converted = chatResponseToResponses(result, previousId, customToolNames);
      const emittedToolCalls = result.choices?.[0]?.message?.tool_calls?.length || 0;
      this.#conversations.set(converted.id, {
        messages: appendAssistantMessage(body.messages, result),
        toolCalls: usedToolCalls + emittedToolCalls,
      });
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
