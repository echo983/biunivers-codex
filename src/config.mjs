import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const quote = (value) => JSON.stringify(String(value));

export function loadConfig(env = process.env) {
  const workspace = path.resolve(env.BIUNIVERS_WORKSPACE || "/workspace");
  const baseUrl = env.CODEX_MODEL_BASE_URL?.replace(/\/+$/, "");
  const model = env.CODEX_MODEL_NAME;
  if (!baseUrl) throw new Error("CODEX_MODEL_BASE_URL is required.");
  if (!model) throw new Error("CODEX_MODEL_NAME is required.");
  let endpoint;
  try { endpoint = new URL(baseUrl); } catch { throw new Error("CODEX_MODEL_BASE_URL is invalid."); }
  if (endpoint.protocol !== "https:" && endpoint.hostname !== "127.0.0.1") {
    throw new Error("CODEX_MODEL_BASE_URL must use HTTPS.");
  }
  return {
    workspace,
    port: Number(env.BIUNIVERS_HTTP_PORT || 8080),
    baseUrl,
    model,
    apiKeyPresent: Boolean(env.CODEX_MODEL_API_KEY),
    codexHome: "/tmp/biunivers-codex-home",
  };
}

export async function prepareCodexHome(config, providerBaseUrl = config.baseUrl) {
  await mkdir(config.codexHome, { recursive: true, mode: 0o700 });
  const preset = await readFile(new URL("../preset/AGENTS.md", import.meta.url), "utf8");
  const toml = `model = ${quote(config.model)}
model_provider = "biunivers_cloudflare"
approval_policy = "never"
sandbox_mode = "danger-full-access"
web_search = "disabled"
developer_instructions = ${quote(preset)}

[model_providers.biunivers_cloudflare]
name = "Cloudflare Workers AI"
base_url = ${quote(providerBaseUrl)}
wire_api = "responses"
requires_openai_auth = false

[features]
multi_agent = false

[tools]
view_image = false

[shell_environment_policy]
inherit = "core"
ignore_default_excludes = false

[shell_environment_policy.filters]
CODEX_MODEL_API_KEY = "exclude"
CLOUDFLARE_API_KEY = "exclude"
CLOUDFLARE_API_TOKEN = "exclude"
`;
  await writeFile(path.join(config.codexHome, "config.toml"), toml, { mode: 0o600 });
}
