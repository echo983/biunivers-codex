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

export class CloudflareResponsesAdapter {
  #server;
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
    try {
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404, { "content-type": "application/json" });
        return response.end('{"error":{"message":"Not found."}}');
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = adaptRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const upstream = await fetch(`${this.upstreamBaseUrl}/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await upstream.json();
      if (!upstream.ok) {
        response.writeHead(upstream.status, { "content-type": "application/json" });
        return response.end(JSON.stringify(result));
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      for (const event of responseEvents(result)) {
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      response.end();
    } catch (error) {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: error.message || "Model adapter failed." } }));
    }
  }
}
