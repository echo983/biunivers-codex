import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, prepareCodexHome } from "../src/config.mjs";

test("requires endpoint and model", () => {
  assert.throws(() => loadConfig({}), /BASE_URL/);
  assert.throws(() => loadConfig({ CODEX_MODEL_BASE_URL: "https://example.test/v1" }), /MODEL_NAME/);
});

test("generates an internal provider config without persisting the secret", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "biunivers-codex-"));
  const config = loadConfig({
    BIUNIVERS_WORKSPACE: workspace,
    CODEX_MODEL_BASE_URL: "https://example.test/v1/",
    CODEX_MODEL_NAME: "open-model",
    CODEX_MODEL_API_KEY: "must-not-be-written",
  });
  assert.equal(config.codexHome, "/tmp/biunivers-codex-home");
  assert.equal(config.codexHome.startsWith(`${workspace}${path.sep}`), false);
  await prepareCodexHome(config, "http://127.0.0.1:3210/v1");
  const content = await readFile(path.join(config.codexHome, "config.toml"), "utf8");
  assert.match(content, /wire_api = "responses"/);
  assert.match(content, /base_url = "http:\/\/127\.0\.0\.1:3210\/v1"/);
  assert.doesNotMatch(content, /env_key/);
  assert.match(content, /CODEX_MODEL_API_KEY = "exclude"/);
  assert.doesNotMatch(content, /must-not-be-written/);
});
