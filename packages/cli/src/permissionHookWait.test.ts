import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import {
  PermissionHookWaiters,
  parsePermissionHookInput,
  permissionDecisionOutput,
  type PermissionHookInput,
} from "./permissionHookWait.js";
import { CODECAST_STATUS_HOOK } from "./statusHook.js";
import { handleHookIngressHttp, type HookIngressDeps, type HookStatusData } from "./daemon.js";

const RULE = { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "bun test:*" }], behavior: "allow", destination: "localSettings" };
const PAYLOAD = {
  session_id: "perm-1",
  hook_event_name: "PermissionRequest",
  tool_name: "Bash",
  tool_input: { command: "bun test src/x.test.ts", description: "run tests" },
  permission_mode: "default",
  permission_suggestions: [RULE],
};
const decisionOf = (out: string) => JSON.parse(out).hookSpecificOutput.decision;

describe("parsePermissionHookInput", () => {
  test("reads the tool, a preview and Claude's suggestions", () => {
    expect(parsePermissionHookInput(JSON.stringify(PAYLOAD))).toEqual({
      sessionId: "perm-1",
      toolName: "Bash",
      preview: "bun test src/x.test.ts",
      permissionMode: "default",
      suggestions: [RULE],
    });
  });

  test("refuses anything that is not a PermissionRequest", () => {
    expect(parsePermissionHookInput("not json")).toBeNull();
    expect(parsePermissionHookInput(JSON.stringify({ ...PAYLOAD, hook_event_name: "PreToolUse" }))).toBeNull();
    expect(parsePermissionHookInput(JSON.stringify({ ...PAYLOAD, tool_name: "" }))).toBeNull();
  });
});

describe("permissionDecisionOutput", () => {
  test("allow carries the suggested rules only when remembered", () => {
    expect(JSON.parse(permissionDecisionOutput({ approved: true }, [RULE])).hookSpecificOutput).toEqual({
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow" },
    });
    expect(decisionOf(permissionDecisionOutput({ approved: true, remember: true }, [RULE]))).toEqual({
      behavior: "allow",
      updatedPermissions: [RULE],
    });
  });

  test("a reason reaches the model and lets it continue; no reason stops the turn", () => {
    expect(decisionOf(permissionDecisionOutput({ approved: false, message: " run only the one file " }, []))).toEqual({
      behavior: "deny",
      message: "run only the one file",
    });
    expect(decisionOf(permissionDecisionOutput({ approved: false }, []))).toMatchObject({ behavior: "deny", interrupt: true });
  });
});

describe("PermissionHookWaiters", () => {
  test("answers the waiter bound to the permission, once", async () => {
    const w = new PermissionHookWaiters();
    const a = w.wait("s", [RULE]);
    expect(w.answer("p1", { approved: true })).toBe(false);
    a.bind("p1");
    expect(w.answer("p1", { approved: true, remember: true })).toBe(true);
    expect(decisionOf((await a.done)!)).toEqual({ behavior: "allow", updatedPermissions: [RULE] });
    // The second sighting of the same answer (subscription after poll) must
    // still read as owned by the hook, so nobody presses a key.
    expect(w.answer("p1", { approved: true })).toBe(true);
  });

  test("leaving the prompt and the bound end the wait empty", async () => {
    const w = new PermissionHookWaiters();
    const a = w.wait("s", []);
    a.bind("p2");
    w.releaseSession("s");
    expect(await a.done).toBeNull();
    expect(w.answer("p2", { approved: true })).toBe(false);
    expect(await w.wait("s", [], 5).done).toBeNull();
  });
});

// The installed script against the real route, as Claude Code runs it.
describe("codecast-status.sh on a PermissionRequest", () => {
  let home: string;
  let hookFile: string;
  let server: http.Server;
  let mode: "answer" | "missing" = "answer";
  const statuses: Array<{ sessionId: string; data: HookStatusData }> = [];
  const held: PermissionHookInput[] = [];

  const deps = (): HookIngressDeps => ({
    admit: () => ({ ok: true }) as any,
    refuse: (_r, _why, res) => { res.writeHead(401); res.end(); },
    deliver: (sessionId, data) => { statuses.push({ sessionId, data }); return "delivered"; },
    statusLine: (_req, res) => { res.end(); },
    ...(mode === "answer" && {
      permission: (input, res) => {
        held.push(input);
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(permissionDecisionOutput({ approved: false, message: "use the watcher" }, input.suggestions));
        }, 50);
      },
    }),
  });

  const runHook = (payload: object) =>
    new Promise<string>((resolve, reject) => {
      const child = execFile("bash", [hookFile], { env: { ...process.env, HOME: home } }, (err, stdout) =>
        err ? reject(err) : resolve(stdout),
      );
      child.stdin!.end(JSON.stringify(payload));
    });

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-permhook-"));
    hookFile = path.join(home, "codecast-status.sh");
    fs.writeFileSync(hookFile, CODECAST_STATUS_HOOK, { mode: 0o755 });
    server = http.createServer((req, res) => {
      if (!handleHookIngressHttp(req, res, deps())) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    fs.mkdirSync(path.join(home, ".codecast"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codecast", "hook-port"), String((server.address() as any).port));
  });

  afterAll(() => {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("prints the daemon's decision and sends the whole payload", async () => {
    mode = "answer";
    const big = { ...PAYLOAD, tool_name: "Write", tool_input: { file_path: "/tmp/a", content: "x".repeat(200_000) } };
    const out = await runHook(big);
    expect(decisionOf(out)).toEqual({ behavior: "deny", message: "use the watcher" });
    expect(held.at(-1)).toMatchObject({ sessionId: "perm-1", toolName: "Write", preview: "/tmp/a", suggestions: [RULE] });
    // The route reported the status itself; the script did not post it twice.
    expect(statuses).toHaveLength(0);
  });

  test("a daemon without the route gets an ordinary status report and no output", async () => {
    mode = "missing";
    const out = await runHook(PAYLOAD);
    expect(out).toBe("");
    expect(statuses.at(-1)).toMatchObject({ sessionId: "perm-1", data: { status: "permission_blocked", message: "Bash: bun test src/x.test.ts" } });
  });
});
