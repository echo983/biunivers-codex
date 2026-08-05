import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export function sessionSummaryPrompt() {
  return `请总结当前会话。不要调用任何工具，不要读取或修改文件，只输出 Markdown 摘要正文。
使用以下小节：会话目标、关键决策、已完成工作、涉及文件、遗留问题、建议下一步。
内容应简洁、忠于实际，不包含凭据、secret、完整内部提示或隐藏推理；没有内容的小节写“无”。`;
}

export async function saveSessionSummary(workspace, markdown, now = new Date()) {
  const directoryName = "Biunivers Codex Sessions";
  const directory = path.join(workspace, directoryName);
  await mkdir(directory, { recursive: true });
  const stem = `${now.toISOString().replace(/[:.]/g, "-")}-session-summary`;
  for (let sequence = 0; sequence < 1000; sequence++) {
    const fileName = `${stem}${sequence ? `-${sequence}` : ""}.md`;
    try {
      await writeFile(path.join(directory, fileName), `${markdown.trim()}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      return `${directoryName}/${fileName}`;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("Could not allocate a unique session-summary filename.");
}
