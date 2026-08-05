const messages = document.querySelector("#messages");
const form = document.querySelector("#composer");
const prompt = document.querySelector("#prompt");
const send = document.querySelector("#send");
const cancel = document.querySelector("#cancel");
const status = document.querySelector("#status");
const taskState = document.querySelector("#taskState");
const taskStateText = document.querySelector("#taskStateText");
const newThread = document.querySelector("#newThread");
const saveSummary = document.querySelector("#saveSummary");
let agentMessage = null;
let readyLabel = "正在连接…";
let activityRecords = new Map();
let hasConversation = false;

const activityLabels = {
  commandExecution: ["正在执行命令…", "执行了命令"],
  fileChange: ["正在修改文件…", "修改了文件"],
  mcpToolCall: ["正在调用工具…", "调用了工具"],
  webSearch: ["正在检索…", "进行了检索"],
};

function addMessage(kind, text) {
  document.querySelector(".welcome")?.remove();
  const node = document.createElement("div");
  node.className = `message ${kind}`;
  node.textContent = text;
  messages.append(node);
  messages.scrollTop = messages.scrollHeight;
  return node;
}

function setTaskState(text = "") {
  taskState.hidden = !text;
  taskStateText.textContent = text;
}

function busy(value, stateText = "正在等待模型响应…") {
  send.disabled = value;
  cancel.disabled = !value;
  newThread.disabled = value;
  saveSummary.disabled = value || !hasConversation;
  prompt.disabled = value;
  status.textContent = readyLabel;
  setTaskState(value ? stateText : "");
}

function activity(text) {
  const node = document.createElement("div");
  node.className = "activity";
  node.textContent = text;
  messages.append(node);
  messages.scrollTop = messages.scrollHeight;
  return node;
}

function recordActivity(type) {
  const [activeLabel, completedLabel] = activityLabels[type] || ["正在使用工具…", "使用了工具"];
  setTaskState(activeLabel);
  const record = activityRecords.get(type) || { count: 0, node: activity(completedLabel), completedLabel };
  record.count++;
  record.node.textContent = `${record.completedLabel}${record.count > 1 ? `（${record.count} 次）` : ""}`;
  activityRecords.set(type, record);
}

async function post(url, body) {
  try {
    const response = await fetch(url, {
      method: "POST",
      ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "请求失败。");
    return result;
  } catch (error) {
    activity(error.message || "请求失败。");
    busy(false);
    return null;
  }
}

const events = new EventSource("/api/events");
events.onmessage = ({ data }) => {
  const event = JSON.parse(data);
  if (event.method === "app/ready") {
    readyLabel = `已就绪 · ${event.params.model}`;
    hasConversation = Boolean(event.params.threadId);
    busy(event.params.active);
  }
  if (event.method === "turn/started") {
    hasConversation = true;
    agentMessage = null;
    activityRecords = new Map();
    busy(true, "正在思考…");
  }
  if (event.method === "item/agentMessage/delta") {
    agentMessage ||= addMessage("agent", "");
    agentMessage.textContent += event.params?.delta || "";
    setTaskState("正在整理结果…");
    messages.scrollTop = messages.scrollHeight;
  }
  if (event.method === "item/started" && !["agentMessage", "userMessage", "reasoning"].includes(event.params?.item?.type)) {
    recordActivity(event.params?.item?.type || "tool");
  }
  if (event.method === "item/started" && event.params?.item?.type === "reasoning") setTaskState("正在思考…");
  if (event.method === "turn/completed") {
    const turn = event.params?.turn;
    if (turn?.status === "failed") activity(`任务失败：${turn.error?.message || "模型调用失败。"}`);
    busy(false);
  }
  if (event.method === "app/error") {
    activity(event.params.message);
    busy(false);
  }
  if (event.method === "app/session-summary-saved") {
    activity(`会话摘要已保存：${event.params.relativePath}`);
  }
  if (event.method === "app/session-summary-failed") {
    activity(event.params.message || "会话摘要保存失败。");
  }
};
events.onerror = () => {
  readyLabel = "连接中断，正在重连…";
  status.textContent = readyLabel;
};

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = prompt.value.trim();
  if (!text) return;
  addMessage("user", text);
  prompt.value = "";
  busy(true);
  await post("/api/messages", { text });
});

cancel.addEventListener("click", () => post("/api/cancel"));

saveSummary.addEventListener("click", async () => {
  addMessage("user", "保存当前会话摘要");
  busy(true, "正在准备会话摘要…");
  await post("/api/session-summary");
});

newThread.addEventListener("click", async () => {
  const confirmed = window.confirm("开始新会话后，当前聊天记录将不可恢复。Workspace 文件和未提交改动不受影响。是否继续？");
  if (!confirmed) return;
  const result = await post("/api/new-thread");
  if (result) {
    hasConversation = false;
    messages.replaceChildren();
    addMessage("agent", "已开始新会话。Workspace 内容保持不变。");
    activityRecords = new Map();
    agentMessage = null;
    busy(false);
  }
});
