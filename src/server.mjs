import http from "node:http";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexClient } from "./codex-client.mjs";
import { loadConfig, prepareCodexHome } from "./config.mjs";
import { CloudflareResponsesAdapter } from "./cloudflare-adapter.mjs";
import { loadSessionSummariesPrompt, saveSessionSummary, sessionSummaryPrompt } from "./session-summary.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const assets = new Map([
  ["/", ["public/index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["public/app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["public/styles.css", "text/css; charset=utf-8"]],
]);
const config = loadConfig();
let modelApiKey = process.env.CODEX_MODEL_API_KEY;
const modelKeyFile = process.env.CODEX_MODEL_KEY_FILE;
if (!modelApiKey && modelKeyFile) {
  try {
    modelApiKey = (await readFile(modelKeyFile, "utf8")).trim();
  } finally {
    await unlink(modelKeyFile).catch(() => {});
    delete process.env.CODEX_MODEL_KEY_FILE;
  }
}
if (!modelApiKey) throw new Error("CODEX_MODEL_API_KEY is required.");
const adapter = new CloudflareResponsesAdapter({
  upstreamBaseUrl: config.baseUrl,
  apiKey: modelApiKey,
});
const providerBaseUrl = await adapter.listen();
await prepareCodexHome(config, providerBaseUrl);
const codex = new CodexClient({ cwd: config.workspace, codexHome: config.codexHome });
await codex.initialize();

let threadId = null;
let activeTurnId = null;
let sessionSummaryState = null;
const clients = new Set();
const publish = (event) => {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const response of clients) response.write(data);
};
codex.on("notification", (message) => {
  if (message.method === "turn/started") activeTurnId = message.params?.turn?.id ?? activeTurnId;
  if (message.method === "turn/started" && sessionSummaryState && !sessionSummaryState.turnId) {
    sessionSummaryState.turnId = message.params?.turn?.id ?? null;
  }
  if (message.method === "item/agentMessage/delta" && sessionSummaryState) {
    sessionSummaryState.markdown += message.params?.delta || "";
  }
  if (message.method === "turn/completed") activeTurnId = null;
  publish(message);
  if (message.method === "turn/completed" && sessionSummaryState
    && (!sessionSummaryState.turnId || sessionSummaryState.turnId === message.params?.turn?.id)) {
    const completed = sessionSummaryState;
    sessionSummaryState = null;
    const markdown = completed.markdown.trim();
    if (message.params?.turn?.status === "completed" && markdown) {
      saveSessionSummary(config.workspace, markdown, completed.createdAt)
        .then((relativePath) => publish({ method: "app/session-summary-saved", params: { relativePath } }))
        .catch(() => publish({ method: "app/session-summary-failed", params: { message: "会话摘要无法写入 Workspace。" } }));
    } else {
      publish({ method: "app/session-summary-failed", params: { message: "会话摘要未生成，Workspace 没有被修改。" } });
    }
  }
});
codex.on("diagnostic", (message) => console.error(`Codex: ${safeDiagnostic(message)}`));
codex.on("exit", (error) => publish({ method: "app/error", params: { message: error.message } }));

function safeDiagnostic(value) {
  return String(value)
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
    .slice(-4096);
}

async function json(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.reduce((n, chunk) => n + chunk.length, 0) > 1024 * 1024) throw new Error("Request is too large.");
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
const reply = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
};

async function startTurn(text) {
  if (!threadId) {
    const result = await codex.request("thread/start", { model: config.model, cwd: config.workspace });
    threadId = result.thread.id;
  }
  const result = await codex.request("turn/start", { threadId, input: [{ type: "text", text }] });
  activeTurnId = result.turn?.id ?? activeTurnId;
  return { threadId, turnId: activeTurnId };
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname === "/health") return reply(response, 200, { status: "ok" });
    if (request.method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      response.write(`data: ${JSON.stringify({ method: "app/ready", params: { threadId, active: Boolean(activeTurnId), model: config.model } })}\n\n`);
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/messages") {
      const body = await json(request);
      const text = String(body.text || "").trim();
      if (!text) return reply(response, 400, { error: "Message is required." });
      if (activeTurnId) return reply(response, 409, { error: "A task is already running." });
      return reply(response, 202, await startTurn(text));
    }
    if (request.method === "POST" && url.pathname === "/api/session-summary") {
      if (activeTurnId) return reply(response, 409, { error: "A task is already running." });
      if (!threadId) return reply(response, 409, { error: "当前还没有可总结的会话。" });
      const summary = { turnId: null, markdown: "", createdAt: new Date() };
      sessionSummaryState = summary;
      try {
        const result = await startTurn(sessionSummaryPrompt());
        if (sessionSummaryState === summary) summary.turnId ||= result.turnId;
        return reply(response, 202, result);
      } catch (error) {
        if (sessionSummaryState === summary) sessionSummaryState = null;
        throw error;
      }
    }
    if (request.method === "POST" && url.pathname === "/api/session-summary/load") {
      if (activeTurnId) return reply(response, 409, { error: "A task is already running." });
      return reply(response, 202, await startTurn(loadSessionSummariesPrompt()));
    }
    if (request.method === "POST" && url.pathname === "/api/cancel") {
      if (threadId && activeTurnId) await codex.request("turn/interrupt", { threadId, turnId: activeTurnId });
      return reply(response, 200, { interrupted: Boolean(activeTurnId) });
    }
    if (request.method === "POST" && url.pathname === "/api/new-thread") {
      if (activeTurnId) return reply(response, 409, { error: "Stop the active task first." });
      threadId = null;
      return reply(response, 200, { ok: true });
    }
    const asset = assets.get(url.pathname);
    if (request.method === "GET" && asset) {
      const data = await readFile(path.join(root, asset[0]));
      response.writeHead(200, { "content-type": asset[1], "cache-control": "no-store" });
      return response.end(data);
    }
    reply(response, 404, { error: "Not found." });
  } catch (error) { reply(response, 500, { error: error.message || "Internal error." }); }
});

server.listen(config.port, "0.0.0.0", () => console.log(`Biunivers Codex listening on 0.0.0.0:${config.port}`));
const shutdown = () => server.close(async () => { codex.stop(); await adapter.close(); process.exit(0); });
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
