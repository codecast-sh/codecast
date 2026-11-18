/**
 * `cast plan create/update --policy` sends the plan's messaging policy, against
 * a stub backend. The wire field is plans.messaging_policy (convex/plans.ts).
 */
import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const scratchHomes: string[] = [];
const processEntry = path.join(import.meta.dir, "main.ts");

afterEach(() => {
  for (const home of scratchHomes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

async function withStub(args: string[]): Promise<{ code: number | null; stderr: string; bodies: Record<string, any[]> }> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-plan-policy-"));
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
      if (req.url === "/cli/plans/create") return res.end(JSON.stringify({ short_id: "pl-1", doc_id: "d1" }));
      if (req.url === "/cli/plans/update") return res.end(JSON.stringify({ success: true, short_id: "pl-1" }));
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
    const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CODECAST_DIR: path.join(home, ".codecast"), NO_COLOR: "1" };
      delete env.CLAUDE_CODE_SESSION_ID;
      const child = spawn(process.execPath, [processEntry, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
      let err = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (c) => { err += c; });
      child.stdout.resume();
      child.on("error", reject);
      child.on("close", (c) => resolve({ code: c, stderr: err }));
      child.stdin.end("");
    });
    return { code, stderr, bodies };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

test("plan create --policy shared-log sends the policy; without it none is sent", async () => {
  const chosen = await withStub(["plan", "create", "Logged plan", "--policy", "shared-log"]);
  expect(chosen.code).toBe(0);
  expect(chosen.bodies["/cli/plans/create"]?.[0]?.messaging_policy).toBe("shared-log");
  const plain = await withStub(["plan", "create", "Plain plan"]);
  expect(plain.code).toBe(0);
  expect(plain.bodies["/cli/plans/create"]?.[0]).not.toHaveProperty("messaging_policy");
}, 30_000);

test("plan update --policy alone writes the policy", async () => {
  const r = await withStub(["plan", "update", "pl-1", "--policy", "lead"]);
  expect(r.stderr).toBe("");
  expect(r.code).toBe(0);
  expect(r.bodies["/cli/plans/update"]).toEqual([{ api_token: "test-token", short_id: "pl-1", messaging_policy: "lead" }]);
}, 30_000);

test("an unknown policy is refused before anything is sent", async () => {
  const r = await withStub(["plan", "create", "Bad plan", "--policy", "gossip"]);
  expect(r.code).not.toBe(0);
  expect(r.bodies["/cli/plans/create"]).toBeUndefined();
}, 30_000);
