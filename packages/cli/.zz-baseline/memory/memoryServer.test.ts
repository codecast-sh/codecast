// The /memory routes over a STANDALONE loopback server on port 0 with a fixed
// token, against a throwaway ~/.claude/projects in a temp dir. Never touches
// the daemon or the memories on this machine. HOME points at the temp dir too,
// so a delete lands in its own trash.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import { handleMemoryHttp } from "./memoryServer.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const ORIGIN = "http://localhost:3000";
const PROJECT = "-Users-me-src-app";

let root = "";
let server: http.Server;
let port = 0;
let savedHome: string | undefined;
const memDir = () => path.join(root, "projects", PROJECT, "memory");

function api(pathAndQuery: string, init: RequestInit = {}, auth = true): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${pathAndQuery}`, {
    ...init,
    headers: { Origin: ORIGIN, ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}), "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-http-"));
  savedHome = process.env.HOME;
  process.env.HOME = root;
  fs.mkdirSync(memDir(), { recursive: true });
  fs.writeFileSync(path.join(root, "projects", PROJECT, "s1.jsonl"), `{"type":"user","cwd":"/Users/me/src/my-app"}\n`);
  fs.writeFileSync(path.join(memDir(), "MEMORY.md"), "- [Alpha](alpha.md)\n- [Beta](beta.md)\n");
  fs.writeFileSync(path.join(memDir(), "alpha.md"), "---\nname: alpha\n---\n\nsee [[beta]]\n");
  fs.writeFileSync(path.join(memDir(), "beta.md"), "---\nname: beta\n---\n\nleaf\n");
  fs.mkdirSync(path.join(root, "projects", "-no-memory"), { recursive: true });
  const opts = { token: TOKEN, log: () => {} };
  server = http.createServer((req, res) => {
    if (!handleMemoryHttp(req, res, opts, { projectsDir: () => path.join(root, "projects") })) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.close();
  process.env.HOME = savedHome;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("/memory routes", () => {
  test("refuse a request without the bearer", async () => {
    expect((await api("/memory/projects", {}, false)).status).toBe(403);
  });

  test("list projects with memories, named by their recorded cwd", async () => {
    const { projects } = await (await api("/memory/projects")).json();
    expect(projects.map((p: { id: string; path: string; count: number }) => [p.id, p.path, p.count])).toEqual([[PROJECT, "/Users/me/src/my-app", 2]]);
  });

  test("read a project's files and index", async () => {
    const body = await (await api(`/memory/project?project=${PROJECT}`)).json();
    expect(body.files.map((f: { file: string }) => f.file)).toEqual(["alpha.md", "beta.md"]);
    expect(body.index.raw).toContain("alpha.md");
  });

  test("reject paths that leave the memory folder", async () => {
    expect((await api("/memory/project?project=..")).status).toBe(400);
    expect((await api(`/memory/file?project=${PROJECT}&file=../x.md`, { method: "PUT", body: JSON.stringify({ raw: "x", baseMtime: null }) })).status).toBe(400);
  });

  test("a guarded write succeeds on the version it opened and 409s on a stale one", async () => {
    const { files } = await (await api(`/memory/project?project=${PROJECT}`)).json();
    const alpha = files.find((f: { file: string }) => f.file === "alpha.md");
    const ok = await api(`/memory/file?project=${PROJECT}&file=alpha.md`, { method: "PUT", body: JSON.stringify({ raw: "v2\n", baseMtime: alpha.mtime }) });
    expect(ok.status).toBe(200);
    fs.utimesSync(path.join(memDir(), "alpha.md"), new Date(), new Date(Date.now() + 5000));
    const stale = await api(`/memory/file?project=${PROJECT}&file=alpha.md`, { method: "PUT", body: JSON.stringify({ raw: "v3\n", baseMtime: alpha.mtime }) });
    expect(stale.status).toBe(409);
    expect((await stale.json()).current).toBe("v2\n");
    expect(fs.readFileSync(path.join(memDir(), "alpha.md"), "utf8")).toBe("v2\n");
  });

  test("create refuses an existing name", async () => {
    const dup = await api(`/memory/file?project=${PROJECT}&file=beta.md`, { method: "PUT", body: JSON.stringify({ raw: "x", baseMtime: null }) });
    expect(dup.status).toBe(409);
    const made = await api(`/memory/file?project=${PROJECT}&file=gamma.md`, { method: "PUT", body: JSON.stringify({ raw: "g\n", baseMtime: null }) });
    expect(made.status).toBe(200);
  });

  test("delete moves to the trash and drops the index line", async () => {
    const res = await api("/memory/op", { method: "POST", body: JSON.stringify({ op: "delete", project: PROJECT, file: "beta.md", unindex: true }) });
    const body = await res.json();
    expect(body.removedLines).toBe(1);
    expect(fs.existsSync(path.join(memDir(), "beta.md"))).toBe(false);
    expect(fs.existsSync(body.trashed)).toBe(true);
    expect(fs.readFileSync(path.join(memDir(), "MEMORY.md"), "utf8")).toBe("- [Alpha](alpha.md)\n");
  });
});
