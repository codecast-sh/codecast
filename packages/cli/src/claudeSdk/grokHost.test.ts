// The direct host running Grok over ACP (grokSession.ts), against a fake
// `grok agent stdio` (testing/fakeGrok.ts). The host, socket protocol and
// daemon client are the real ones the Claude SDK backend uses.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runClaudeSdkHost } from "./host.js";
import { SdkHostClient } from "./client.js";
import { sdkHostPaths } from "./paths.js";
import { until } from "./testing/harness.js";
import { grokOptionFor, grokTurnError, parseGrokArgs } from "./grokSession.js";
import type { SdkActivity, SdkPermissionRequest } from "./protocol.js";
import type { SdkLaunchSpec } from "./options.js";

const SESSION = "01a1ebe0-3e56-7ae3-98a8-58ba9f3e0561";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
}, 30_000);

async function grokHost(opts: { permissionMode?: string; resume?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-host-"));
  const log = path.join(dir, "fake.log");
  const bin = path.join(dir, "grok");
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${path.join(import.meta.dir, "testing", "fakeGrok.ts")}" "$@"\n`, { mode: 0o755 });
  const spec: SdkLaunchSpec = {
    agent: "grok",
    conversationId: "conv1",
    sessionId: SESSION,
    resume: opts.resume ?? true,
    cwd: dir,
    executable: bin,
    args: ["-m", "grok-4.7", ...(opts.permissionMode ? ["--permission-mode", opts.permissionMode] : [])],
    env: { CODECAST_LAUNCH_TOKEN: "tok" },
  };
  const paths = sdkHostPaths(SESSION, dir);
  let exited = false;
  const host = await runClaudeSdkHost({ spec, paths, env: { PATH: process.env.PATH, HOME: process.env.HOME, FAKE_GROK_LOG: log }, log: () => {}, onExit: () => { exited = true; } });
  const client = new SdkHostClient(SESSION, dir);
  const activity: SdkActivity[] = [];
  const results: Array<{ subtype: string; isError: boolean; error: { kind: string } | null }> = [];
  const permissions: SdkPermissionRequest[] = [];
  client.on("activity", (a) => activity.push(a));
  client.on("result", (r) => results.push(r));
  client.on("permission", (p) => permissions.push(p));
  await client.connect();
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  cleanups.push(async () => { client.close(); await host.stop(); });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { host, client, activity, results, permissions, calls, exited: () => exited };
}

const T = 20_000;

describe("grok direct host", () => {
  test("loads the session with the launch's permission mode and lands idle at a boundary", async () => {
    const h = await grokHost({ permissionMode: "bypassPermissions" });
    const info = await h.host.session.ready;
    expect(info).toMatchObject({ version: "1.0.89", model: "grok-4.7", permissionMode: "bypassPermissions" });
    const load = h.calls().find((c) => c.method === "session/load");
    expect(load.params).toMatchObject({ sessionId: SESSION, _meta: { yoloMode: true } });
    // Model rides the agent's argv; the codecast status hook stands down inside the session.
    expect(load.argv).toEqual(["agent", "-m", "grok-4.7", "stdio"]);
    expect(load.sdkSession).toBe("1");
    await until(() => h.client.state?.status === "idle" || null, T, "idle");
    expect(h.client.state?.activity).toMatchObject({ status: "idle", sessionBoundary: true });
  }, T);

  test("a turn: thinking, working on the tool call, then idle with a turn stamp; a repeat id is one message", async () => {
    const h = await grokHost({ permissionMode: "bypassPermissions" });
    expect((await h.client.send("m1", "hello")).ok).toBe(true);
    await until(() => h.results.length || null, T, "result");
    expect(h.results[0]).toMatchObject({ subtype: "end_turn", isError: false });
    expect(h.activity.map((a) => a.status)).toEqual(expect.arrayContaining(["thinking", "working", "idle"]));
    expect(h.activity.at(-1)?.turnCompletedAt).toBeGreaterThan(0);
    expect((await h.client.send("m1", "hello")).data).toMatchObject({ duplicate: true });
    expect(h.calls().filter((c) => c.method === "session/prompt").length).toBe(1);
  }, T);

  test("a permission grok asks for waits for the answer, and the answer picks grok's option", async () => {
    const h = await grokHost({ permissionMode: "default" });
    await h.client.send("m1", "PERMISSION please");
    const request = await until(() => h.permissions[0] ?? null, T, "permission");
    expect(request).toMatchObject({ toolName: "run_terminal_command", input: { command: "rm -rf build" } });
    await until(() => (h.client.state?.status === "needs_input" ? true : null), T, "needs_input");
    expect(h.activity.at(-1)).toMatchObject({ status: "permission_blocked", dialog: true, message: "run_terminal_command: rm -rf build" });
    expect((await h.client.answer(request.requestId, { behavior: "allow" })).ok).toBe(true);
    await until(() => h.results.length || null, T, "result");
    expect(h.calls().find((c) => c.permissionAnswer)?.permissionAnswer).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
  }, T);

  test("interrupt cancels the running turn and waits for it to end", async () => {
    const h = await grokHost({ permissionMode: "bypassPermissions" });
    await h.client.send("m1", "SLOW work");
    await until(() => (h.activity.some((a) => a.status === "working") ? true : null), T, "working");
    expect((await h.client.interrupt()).ok).toBe(true);
    expect(h.results[0]).toMatchObject({ subtype: "cancelled", isError: false });
    expect(h.client.state?.status).toBe("idle");
  }, T);

  test("a refused prompt is the turn's error", async () => {
    const h = await grokHost({ permissionMode: "bypassPermissions" });
    await h.client.send("m1", "FAIL now");
    await until(() => h.results.length || null, T, "result");
    expect(h.results[0]).toMatchObject({ isError: true, error: { kind: "authentication_failed" } });
  }, T);

  test("a fresh start creates the session with its rules and follows grok's id", async () => {
    const h = await grokHost({ resume: false, permissionMode: "bypassPermissions" });
    await h.host.session.ready;
    const created = h.calls().find((c) => c.method === "session/new");
    expect(created.params._meta).toMatchObject({ yoloMode: true });
    expect(h.host.session.claudeSessionId).toBe("01a1f000-0000-7000-8000-000000000001");
  }, T);

  test("stop ends grok and the host", async () => {
    const h = await grokHost();
    await h.host.session.ready;
    await h.host.stop();
    await until(() => (h.exited() ? true : null), T, "exit");
  }, T);
});

describe("grok session helpers", () => {
  test("parseGrokArgs reads the flags agent mode needs from the tmux argv", () => {
    expect(parseGrokArgs(["--resume", "x", "--permission-mode", "bypassPermissions", "-m", "grok-4.7", "--rules=be brief"]))
      .toEqual({ permissionMode: "bypassPermissions", model: "grok-4.7", rules: "be brief" });
  });
  test("grokOptionFor maps a remembered allow to allow_always and a deny to reject", () => {
    const options = [{ optionId: "a1", kind: "allow_once" }, { optionId: "a2", kind: "allow_always" }, { optionId: "r1", kind: "reject_once" }];
    expect(grokOptionFor({ behavior: "allow" }, options)).toBe("a1");
    expect(grokOptionFor({ behavior: "allow", updatedPermissions: [{} as never] }, options)).toBe("a2");
    expect(grokOptionFor({ behavior: "deny", message: "no" }, options)).toBe("r1");
  });
  test("grokTurnError names auth and limit failures", () => {
    expect(grokTurnError(new Error("grok agent error -32000: Authentication required")).kind).toBe("authentication_failed");
    expect(grokTurnError(new Error("429 rate limit exceeded")).kind).toBe("rate_limit");
  });
});
