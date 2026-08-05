import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import readline from "node:readline";

export class CodexClient extends EventEmitter {
  #proc;
  #nextId = 1;
  #pending = new Map();

  constructor({ cwd, codexHome }) {
    super();
    const childEnv = { ...process.env, CODEX_HOME: codexHome };
    delete childEnv.CODEX_MODEL_API_KEY;
    delete childEnv.CLOUDFLARE_API_KEY;
    delete childEnv.CLOUDFLARE_API_TOKEN;
    this.#proc = spawn("codex", ["app-server"], {
      cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    readline.createInterface({ input: this.#proc.stdout }).on("line", (line) => this.#receive(line));
    this.#proc.stderr.on("data", (data) => this.emit("diagnostic", data.toString()));
    this.#proc.on("exit", (code, signal) => {
      const error = new Error(`Codex App Server exited (${code ?? signal}).`);
      for (const { reject } of this.#pending.values()) reject(error);
      this.#pending.clear();
      this.emit("exit", error);
    });
  }

  async initialize() {
    await this.request("initialize", {
      clientInfo: { name: "biunivers_codex", title: "Biunivers Codex", version: "0.1.1" },
    });
    this.notify("initialized", {});
  }

  request(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#send({ method, id, params });
    });
  }

  notify(method, params = {}) { this.#send({ method, params }); }

  stop() { this.#proc?.kill("SIGTERM"); }

  #send(message) { this.#proc.stdin.write(`${JSON.stringify(message)}\n`); }

  #receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { return this.emit("diagnostic", line); }
    if (message.id !== undefined && this.#pending.has(message.id)) {
      const pending = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "Codex request failed."));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) this.emit("notification", message);
  }
}
