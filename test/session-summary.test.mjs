import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadSessionSummariesPrompt, saveSessionSummary, sessionSummaryPrompt } from "../src/session-summary.mjs";

test("requests Markdown without asking the model to touch files", () => {
  const prompt = sessionSummaryPrompt();
  assert.match(prompt, /不要调用任何工具/);
  assert.match(prompt, /只输出 Markdown 摘要正文/);
  assert.match(prompt, /会话目标/);
  assert.match(prompt, /不包含凭据/);
});

test("loads summaries only from the durable Workspace summary directory", () => {
  const prompt = loadSessionSummariesPrompt();
  assert.match(prompt, /\/workspace\/Biunivers Codex Sessions\//);
  assert.match(prompt, /不得搜索或读取任何其他目录/);
  assert.match(prompt, /最近 10 份/);
  assert.match(prompt, /不是权威事实来源/);
});

test("writes summaries under Workspace without overwriting", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "biunivers-summary-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const now = new Date("2026-08-05T12:34:56.789Z");
  const first = await saveSessionSummary(workspace, "# First", now);
  const second = await saveSessionSummary(workspace, "# Second", now);
  assert.equal(first, "Biunivers Codex Sessions/2026-08-05T12-34-56-789Z-session-summary.md");
  assert.equal(second, "Biunivers Codex Sessions/2026-08-05T12-34-56-789Z-session-summary-1.md");
  assert.equal(await readFile(path.join(workspace, first), "utf8"), "# First\n");
  assert.equal(await readFile(path.join(workspace, second), "utf8"), "# Second\n");
});
