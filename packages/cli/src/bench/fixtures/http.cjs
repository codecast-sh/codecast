const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const [root, socket] = process.argv.slice(2);
const records = new Map();
const hooks = [];
let stallNext = 0;
let scanning = null;
async function discover() {
  if (scanning) return scanning;
  scanning = (async () => {
    const projects = path.join(root, ".claude", "projects");
    for (const dir of await fs.readdir(projects).catch(() => [])) {
      for (const name of await fs.readdir(path.join(projects, dir)).catch(() => [])) {
        if (!name.endsWith(".jsonl")) continue;
        const file = path.join(projects, dir, name);
        const raw = await fs.readFile(file, "utf8").catch(() => "");
        const first = raw.split("\n").find(Boolean);
        if (!first) continue;
        const row = JSON.parse(first);
        const id = `conv-${row.sessionId}`;
        if (!records.has(id)) records.set(id, { id, session_id: row.sessionId, project_path: row.cwd, file });
      }
    }
    const mapping = Object.fromEntries([...records.values()].map(r => [r.session_id, r.id]));
    await fs.writeFile(path.join(root, "conversations.tmp"), JSON.stringify(mapping));
    await fs.rename(path.join(root, "conversations.tmp"), path.join(root, "conversations.json"));
  })().finally(() => { scanning = null; });
  return scanning;
}
const scanFailures = [];
const scanTimer = setInterval(() => { discover().catch(e => scanFailures.push(String(e))); }, 25);
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const reply = (status, value) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
  try {
    if (url.pathname === "/stall-next") { stallNext = 1200; return reply(200, {}); }
    if (url.pathname === "/hang") return;
    if (url.pathname === "/events") return reply(200, { hooks, records: [...records.values()], scanFailures });
    if (url.pathname === "/health") {
      if (stallNext) { const until = Date.now() + stallNext; stallNext = 0; while (Date.now() < until) {} }
      return reply(200, {});
    }
    if (url.pathname === "/term/sessions") return reply(req.headers.authorization === "Bearer private-integration-term" ? 200 : 401, []);
    if (url.pathname === "/hook/status") {
      if (!url.searchParams.has("session_id")) return reply(400, {});
      const q = Object.fromEntries(url.searchParams);
      const row = [...records.values()].find(r => r.session_id === q.session_id);
      if (!row || q.transcript_path !== row.file || q.status !== "working" || !/^\d+$/.test(q.ts) || Math.abs(Date.now() / 1000 - Number(q.ts)) > 5) return reply(409, {});
      const registry = JSON.parse(await fs.readFile(path.join(root, "session-registry", `${row.session_id}.json`), "utf8"));
      const identity = (await exec("ps", ["-p", String(registry.pid), "-o", "args="])).stdout;
      if (!identity.includes(row.session_id) || !identity.includes("stub.cjs")) return reply(409, {});
      await fs.mkdir(path.join(root, "agent-status"), { recursive: true });
      await fs.writeFile(path.join(root, "agent-status", `${row.session_id}.json`), JSON.stringify({ status: q.status, ts: Number(q.ts), message: q.message, transcript_path: q.transcript_path }));
      hooks.push({ ...q, pid: registry.pid }); return reply(200, {});
    }
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (body.api_token !== "private-integration-api") return reply(401, {});
    await discover();
    if (url.pathname === "/cli/export") {
      const row = records.get(body.conversation_id); if (!row) return reply(404, {});
      const raw = await fs.readFile(row.file, "utf8");
      const lines = raw.split("\n"); lines.pop();
      const messages = lines.map(line => JSON.parse(line)).map(r => ({ role: r.message.role, content: typeof r.message.content === "string" ? r.message.content : r.message.content.map(c => c.text).join("") }));
      return reply(200, { conversation: row, messages, done: true });
    }
    if (url.pathname === "/cli/messages/send") {
      const row = records.get(body.to); if (!row) return reply(404, {});
      const name = path.basename(row.project_path).match(/^(bench-[a-f0-9-]{36})-/)?.[1];
      if (!name) return reply(409, {});
      const target = `${name}-${row.session_id}:0.0`;
      await exec("tmux", ["-S", socket, "send-keys", "-t", target, "-l", body.body]);
      await exec("tmux", ["-S", socket, "send-keys", "-t", target, "Enter"]);
      return reply(200, { ok: true });
    }
    if (url.pathname === "/cli/conversations/delete-by-path") {
      if (!String(body.path_prefix).startsWith(`${root}/bench-`)) return reply(409, {});
      let deleted = 0;
      for (const [id, row] of records) if (row.project_path === body.path_prefix) { records.delete(id); deleted++; }
      return reply(200, { conversationsDeleted: deleted, hasMore: false });
    }
    reply(404, {});
  } catch { reply(500, { error: "fixture request failed" }); }
});
server.listen(0, "127.0.0.1", () => process.stdout.write(`${server.address().port}\n`));
const shutdown = () => { clearInterval(scanTimer); server.closeAllConnections(); server.close(() => process.exit(0)); };
process.stdin.resume(); process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);
