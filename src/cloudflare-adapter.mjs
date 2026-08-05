import http from "node:http";

const STRIPPED_FIELDS = ["include", "prompt_cache_key", "client_metadata", "store"];

export function adaptRequest(input) {
  const body = structuredClone(input);
  body.tools = (body.tools || []).filter((tool) => tool.type === "function");
  for (const field of STRIPPED_FIELDS) delete body[field];
  body.stream = false;
  return body;
}

export function responseEvents(response) {
  let sequence = 0;
  const events = [];
  const push = (type, fields) => events.push({ type, sequence_number: sequence++, ...fields });
  for (const [outputIndex, item] of (response.output || []).entries()) {
    push("response.output_item.added", {
      output_index: outputIndex,
      item: { ...item, status: item.status === "completed" ? "in_progress" : item.status },
    });
    for (const [contentIndex, part] of (item.content || []).entries()) {
      push("response.content_part.added", {
        item_id: item.id, output_index: outputIndex, content_index: contentIndex,
        part: { ...part, text: part.text === undefined ? undefined : "" },
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

export function conversationMessages(...groups) {
  return groups.flatMap((group) => (Array.isArray(group) ? group : [group])).flatMap((item) => {
    if (!item || typeof item !== "object" || !["user", "assistant"].includes(item.role)) return [];
    const parts = typeof item.content === "string" ? [item.content] : (item.content || [])
      .filter((part) => ["input_text", "output_text"].includes(part?.type) && typeof part.text === "string")
      .map((part) => part.text);
    const content = parts.join("");
    return content ? [{ role: item.role, content }] : [];
  });
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
      const previousId = incoming.previous_response_id;
      const priorMessages = typeof previousId === "string" ? this.#conversations.get(previousId) : undefined;
      const body = adaptRequest(incoming);
      delete body.previous_response_id;
      if (priorMessages) body.input = [...priorMessages, ...conversationMessages(body.input)];
      const upstream = await fetch(`${this.upstreamBaseUrl}/responses`, {
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
      if (typeof result.id === "string") {
        const transcript = conversationMessages(priorMessages || [], body.input, result.output || []);
        this.#conversations.set(result.id, transcript);
        if (this.#conversations.size > 64) this.#conversations.delete(this.#conversations.keys().next().value);
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      for (const event of responseEvents(result)) {
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
