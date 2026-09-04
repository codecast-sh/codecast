import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const [binary, home, path, cwd] = process.argv.slice(2);
const child = spawn(binary, ["app-server"], {
  cwd,
  env: { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: home },
  stdio: ["pipe", "pipe", "pipe"],
});
const lines = createInterface({ input: child.stdout });
let stderr = "";
child.stderr.on("data", chunk => { stderr += String(chunk); });
process.on("SIGTERM", () => child.kill());
let sequence = 0;
function wait(matches) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); lines.off("line", onLine); child.off("exit", onExit); };
    const onExit = () => { cleanup(); reject(new Error(`Native import exited (${child.exitCode}, ${child.signalCode}): ${stderr.slice(-2000)}`)); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Native import timeout: ${stderr.slice(-2000)}`)); }, 30_000);
    const onLine = line => {
      const row = JSON.parse(line);
      if (matches(row)) { cleanup(); resolve(row); }
    };
    lines.on("line", onLine);
    child.once("exit", onExit);
  });
}
async function rpc(method, params) {
  const id = ++sequence;
  const response = wait(row => row.id === id);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  const row = await response;
  if (row.error) throw new Error(JSON.stringify(row.error));
  return row.result;
}
try {
  await rpc("initialize", { clientInfo: { name: "import_test", version: "1.0.0" }, capabilities: { experimentalApi: true } });
  const fork = await rpc("thread/fork", { threadId: "", path, cwd, approvalPolicy: "never", sandbox: "read-only" });
  const done = wait(row => row.method === "turn/completed");
  await rpc("turn/start", { threadId: fork.thread.id, input: [{ type: "text", text: "Report import readiness only." }] });
  const completion = await done;
  writeFileSync(join(home, "result.json"), JSON.stringify(completion.params.turn));
} finally {
  lines.close();
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once("exit", resolve));
    child.kill();
    await exited;
  }
}
