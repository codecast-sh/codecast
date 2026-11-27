/**
 * What `cast priorities create`, `cast plan create --from-call` and `cast task
 * create --under` send, against a stub backend. The wire fields are
 * priorities.cliCreate, plans.create from_call and tasks.create
 * parent_id / plan_id / under_priority (convex/priorityCreate.ts).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { underTarget } from "./taskClaim.js";

const scratchHomes: string[] = [];
const processEntry = path.join(import.meta.dir, "main.ts");

afterEach(() => {
  for (const home of scratchHomes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

type StubRun = { code: number | null; stdout: string; stderr: string; bodies: Record<string, any[]> };

async function withStub(args: string[]): Promise<StubRun> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-scribe-entities-"));
  scratchHomes.push(home);
  fs.mkdirSync(path.join(home, ".codecast"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codecast", "update-state.json"), JSON.stringify({ lastCheck: new Date().toISOString() }));
  const bodies: Record<string, any[]> = {};
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      (bodies[req.url ?? ""] ??= []).push(raw ? JSON.parse(raw) : null);
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/cli/teams") return res.end(JSON.stringify({ teams: [{ _id: "team1", name: "Acme" }], active_team_id: "team1" }));
      if (req.url === "/cli/priorities/create") return res.end(JSON.stringify({ short_id: "pri-9", title: "Ship the board", owner_id: "u1" }));
      if (req.url === "/cli/plans/create") return res.end(JSON.stringify({ short_id: "pl-1", doc_id: "d1" }));
      if (req.url === "/cli/work/create") return res.end(JSON.stringify({ id: "t1", short_id: "ct-5" }));
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");
    fs.writeFileSync(path.join(home, ".codecast", "config.json"), JSON.stringify({
      auth_token: "test-token", convex_url: `http://127.0.0.1:${address.port}`, auto_update: false,
    }));
    return await new Promise<StubRun>((resolve, reject) => {
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CODECAST_DIR: path.join(home, ".codecast"), NO_COLOR: "1" };
      delete env.CLAUDE_CODE_SESSION_ID;
      const child = spawn(process.execPath, [processEntry, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (c) => { out += c; });
      child.stderr.on("data", (c) => { err += c; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout: out, stderr: err, bodies }));
      child.stdin.end("");
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

describe("underTarget", () => {
  test("a task, plan or priority id routes to its field", () => {
    expect(underTarget("CT-12", {})).toEqual({ parent_id: "ct-12" });
    expect(underTarget("pl-3", {})).toEqual({ plan_id: "pl-3" });
    expect(underTarget(" pri-4 ", {})).toEqual({ under_priority: "pri-4" });
  });

  test("anything else, or the same field twice, is refused", () => {
    expect(() => underTarget("in-5", {})).toThrow("--under takes a task, plan or priority id");
    expect(() => underTarget("ct-1", { parent: "ct-2" })).toThrow("Use --under or --parent, not both");
    expect(() => underTarget("pl-1", { plan: "pl-2" })).toThrow("Use --under or --plan, not both");
  });
});

test("priorities create sends the title, owner and call, and where it is run from so it lands where a task filed there does", async () => {
  const r = await withStub(["priorities", "create", "Ship", "the", "board", "--summary", "Frames", "--owner", "@ana", "--from-call", "cl-7"]);
  expect(r.stderr).toBe("");
  expect(r.code).toBe(0);
  const [body] = r.bodies["/cli/priorities/create"];
  expect(body).toMatchObject({ api_token: "test-token", title: "Ship the board", summary: "Frames", owner: "@ana", from_call: "cl-7" });
  expect(typeof body.project_path).toBe("string");
  expect(body).not.toHaveProperty("team_id");
  expect(r.bodies["/cli/teams"]).toBeUndefined();
  expect(r.stdout).toContain("ok Created pri-9: Ship the board");
}, 30_000);

test("priorities create --team names the workspace as task create --team does", async () => {
  const r = await withStub(["priorities", "create", "Ship", "--team", "Acme"]);
  expect(r.code).toBe(0);
  expect(r.bodies["/cli/priorities/create"]?.[0]).toMatchObject({ workspace: "team", team_id: "team1" });
}, 30_000);

test("plan create --from-call sends the call", async () => {
  const r = await withStub(["plan", "create", "Follow-ups", "--from-call", "cl-7"]);
  expect(r.code).toBe(0);
  expect(r.bodies["/cli/plans/create"]?.[0]?.from_call).toBe("cl-7");
}, 30_000);

test("task create --under sends the field its id names; a bad id files nothing", async () => {
  for (const [under, field] of [["ct-2", "parent_id"], ["pl-3", "plan_id"], ["pri-4", "under_priority"]] as const) {
    const r = await withStub(["task", "create", "Draw frames", "--under", under]);
    expect(r.code).toBe(0);
    expect(r.bodies["/cli/work/create"]?.[0]?.[field]).toBe(under);
  }
  const bad = await withStub(["task", "create", "Draw frames", "--under", "doc-1"]);
  expect(bad.code).not.toBe(0);
  expect(bad.stderr).toContain("--under takes a task, plan or priority id");
  expect(bad.bodies["/cli/work/create"]).toBeUndefined();
}, 60_000);
