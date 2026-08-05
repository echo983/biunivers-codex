const messages = document.querySelector("#messages");
const form = document.querySelector("#composer");
const prompt = document.querySelector("#prompt");
const send = document.querySelector("#send");
const cancel = document.querySelector("#cancel");
const status = document.querySelector("#status");
let agentMessage = null;

function addMessage(kind, text) {
  document.querySelector(".welcome")?.remove();
  const node = document.createElement("div");
  node.className = `message ${kind}`;
  node.textContent = text;
  messages.append(node);
  messages.scrollTop = messages.scrollHeight;
  return node;
}
function busy(value) { send.disabled = value; cancel.disabled = !value; status.textContent = value ? "正在处理…" : "已就绪"; }
function activity(text) { const node=document.createElement("div");node.className="activity";node.textContent=text;messages.append(node);messages.scrollTop=messages.scrollHeight; }

const events = new EventSource("/api/events");
events.onmessage = ({ data }) => {
  const event = JSON.parse(data);
  if (event.method === "app/ready") { status.textContent = `已就绪 · ${event.params.model}`; busy(event.params.active); }
  if (event.method === "turn/started") { agentMessage = null; busy(true); }
  if (event.method === "item/agentMessage/delta") {
    agentMessage ||= addMessage("agent", "");
    agentMessage.textContent += event.params?.delta || "";
    messages.scrollTop = messages.scrollHeight;
  }
  if (event.method === "item/started" && !["agentMessage", "userMessage"].includes(event.params?.item?.type)) activity(`正在执行：${event.params?.item?.type || "任务"}`);
  if (event.method === "turn/completed") {
    const turn = event.params?.turn;
    if (turn?.status === "failed") activity(`任务失败：${turn.error?.message || "模型调用失败。"}`);
    busy(false);
  }
  if (event.method === "app/error") { activity(event.params.message); busy(false); }
};
events.onerror = () => { status.textContent = "连接中断，正在重连…"; };

form.addEventListener("submit", async (event) => {
  event.preventDefault(); const text = prompt.value.trim(); if (!text) return;
  addMessage("user", text); prompt.value = ""; busy(true);
  const response = await fetch("/api/messages", { method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text}) });
  if (!response.ok) { const body=await response.json();activity(body.error || "发送失败。");busy(false); }
});
cancel.addEventListener("click", () => fetch("/api/cancel", { method:"POST" }));
document.querySelector("#newThread").addEventListener("click", async () => {
  const response=await fetch("/api/new-thread",{method:"POST"}); if(response.ok){messages.replaceChildren();addMessage("agent","已开始新对话。");}
});
