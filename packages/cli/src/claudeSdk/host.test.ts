// The Claude SDK host against recorded real sessions. The SDK runs unmocked;
// only `claude` is replaced, by a fake that replays a recording
// (testing/fakeClaude.ts). In-process hosts cover the protocol; the last two
// tests run the host as its own process to cover host death and a daemon that
// reconnects.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { runClaudeSdkHost } from "./host.js";
import { SdkHostClient, attachSdkHost, launchSdkHost, pidAlive } from "./client.js";
import { sdkHostPaths } from "./paths.js";
import { fakeWorld, until, type FakeWorld } from "./testing/harness.js";
import type { SdkActivity, SdkPermissionRequest } from "./protocol.js";

const worlds: FakeWorld[] = [];
const stops: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  for (const w of worlds.splice(0)) w.cleanup();
});

async function inProcess(recordings: string[], extraEnv: Record<string, string> = {}) {
  const world = fakeWorld(recordings, extraEnv);
  worlds.push(world);
  const spec = world.spec();
  const paths = sdkHostPaths(spec.sessionId, world.hostDir);
  let exited = false;
  const host = await runClaudeSdkHost({ spec, paths, env: { PATH: process.env.PATH, HOME: process.env.HOME }, log: () => {}, onExit: () => { exited = true; } });
  const client = new SdkHostClient(spec.sessionId, world.hostDir);
  const activity: SdkActivity[] = [];
  const results: Array<{ subtype: string; isError: boolean; text: string | null; error: { kind: string; message: string } | null }> = [];
  const permissions: SdkPermissionRequest[] = [];
  client.on("activity", (a) => activity.push(a));
  client.on("result", (r) => results.push(r));
  client.on("permission", (p) => permissions.push(p));
  await client.connect();
  stops.push(async () => {
    client.close();
    await host.stop();
  });
  return { world, spec, host, client, activity, results, permissions, exited: () => exited };
}

const T = 60_000;

describe("claude sdk host", () => {
  test("startup reports Claude's version and lands idle at a session boundary", async () => {
    const h = await inProcess(["text"]);
    await h.host.session.ready;
    const state = await until(() => (h.client.state?.init?.version ? h.client.state : null), T, "init");
    expect(state.init?.version).toBe("2.1.319");
    expect(state.status).toBe("idle");
    expect(state.activity).toMatchObject({ status: "idle", sessionBoundary: true });
  }, T);

  test("a plain turn: thinking, then idle with a turn stamp and the reply", async () => {
    const h = await inProcess(["text"]);
    const r = await h.client.send("m1", "Reply with exactly the word pong and nothing else.");
    expect(r.ok).toBe(true);
    await until(() => h.results.length, T, "result");
    expect(h.results[0]).toMatchObject({ subtype: "success", isError: false, text: "pong" });
    const statuses = h.activity.map((a) => a.status);
    expect(statuses).toContain("thinking");
    expect(h.activity.at(-1)).toMatchObject({ status: "idle" });
    expect(h.activity.at(-1)?.turnCompletedAt).toBeGreaterThan(0);
    // The same message id twice is one message.
    const again = await h.client.send("m1", "Reply with exactly the word pong and nothing else.");
    expect(again.data).toMatchObject({ duplicate: true });
  }, T);

  test("a send retried while Claude boots is one message", async () => {
    const h = await inProcess(["text"]);
    const [a, b] = await Promise.all([h.client.send("m1", "pong please"), h.client.send("m1", "pong please")]);
    expect([a.ok, b.ok]).toEqual([true, true]);
    await until(() => h.results.length, T, "result");
    expect(h.world.fakeLog().filter((l) => l.startsWith("user ")).length).toBe(1);
  }, T);

  test("a tool that needs permission, allowed", async () => {
    const h = await inProcess(["tool-allow"]);
    await h.client.send("m1", "Use the Bash tool to run exactly this command: echo sdk-ok > marker.txt   Then reply with the single word done.");
    const p = await until(() => h.permissions[0], T, "permission");
    expect(p.toolName).toBe("Bash");
    expect(p.input.command).toBe("echo sdk-ok > marker.txt");
    await until(() => h.client.state?.status === "needs_input", T, "needs_input");
    expect(h.activity.some((a) => a.status === "permission_blocked" && a.dialog && a.message === "Bash: echo sdk-ok > marker.txt")).toBe(true);
    expect((await h.client.answer(p.requestId, { behavior: "allow" })).ok).toBe(true);
    await until(() => h.results.length, T, "result");
    expect(h.results[0].text).toBe("done");
    // A second answer to the same prompt is refused, not applied twice.
    expect((await h.client.answer(p.requestId, { behavior: "allow" })).ok).toBe(false);
  }, T);

  test("a tool that needs permission, denied", async () => {
    const h = await inProcess(["tool-deny"]);
    await h.client.send("m1", "Use the Bash tool to run exactly this command: echo sdk-ok > marker.txt   If it is refused, reply with the single word refused.");
    const p = await until(() => h.permissions[0], T, "permission");
    await h.client.answer(p.requestId, { behavior: "deny", message: "The user declined this command." });
    await until(() => h.results.length, T, "result");
    expect(h.results[0].text).toBe("refused");
    expect(h.client.state?.pending).toEqual([]);
  }, T);

  test("AskUserQuestion arrives as a prompt and takes answers", async () => {
    const h = await inProcess(["ask"]);
    await h.client.send("m1", "ask");
    const p = await until(() => h.permissions[0], T, "question");
    expect(p.toolName).toBe("AskUserQuestion");
    const questions = p.input.questions as Array<{ question: string; options: Array<{ label: string }> }>;
    expect(questions[0].options.map((o) => o.label)).toEqual(["Red", "Blue"]);
    expect(h.activity.some((a) => a.status === "permission_blocked" && a.message === "AskUserQuestion")).toBe(true);
    await h.client.answer(p.requestId, { behavior: "allow", updatedInput: { ...p.input, answers: { [questions[0].question]: "Blue" } } });
    await until(() => h.results.length, T, "result");
    expect(h.results[0].text).toContain("Blue");
  }, T);

  test("a message sent mid-turn goes in with priority next", async () => {
    const h = await inProcess(["steer"]);
    await h.client.send("m1", "first");
    await until(() => h.activity.some((a) => a.status === "working"), T, "working");
    await h.client.send("m2", "Also: end your final reply with the word STEERED.");
    await until(() => h.client.state?.status === "idle" && h.results.length, T, "idle");
    const users = h.world.fakeLog().filter((l) => l.startsWith("user "));
    expect(users).toEqual(["user priority=- images=0", "user priority=next images=0"]);
    expect(h.results.at(-1)?.text).toContain("STEERED");
  }, T);

  test("interrupt waits for the turn to drain before the next send", async () => {
    const h = await inProcess(["interrupt"]);
    await h.client.send("m1", "sleep");
    await until(() => h.activity.some((a) => a.status === "working"), T, "working");
    const r = await h.client.interrupt();
    expect(r.ok).toBe(true);
    // The interrupted turn's result is in before interrupt() answers.
    expect(h.results.length).toBe(1);
    expect(h.client.state?.status).toBe("idle");
    await h.client.send("m2", "Reply with exactly the word after and nothing else.");
    await until(() => h.results.length === 2, T, "second result");
    expect(h.results[1].text).toBe("after");
  }, T);

  test("/clear moves Claude to a new session, reported as a session boundary", async () => {
    const h = await inProcess(["clear"]);
    const moved: string[] = [];
    h.client.on("session", (sid) => moved.push(sid));
    await h.client.send("m1", "Reply with exactly the word one and nothing else.");
    await until(() => h.results.length === 1, T, "first");
    await h.client.send("m2", "/clear");
    await until(() => h.results.length === 2, T, "clear");
    expect(moved.length).toBe(1);
    expect(moved[0]).not.toBe(h.spec.sessionId);
    expect(h.activity.at(-1)).toMatchObject({ status: "idle", sessionBoundary: true });
    expect(h.activity.at(-1)?.turnCompletedAt).toBeUndefined();
    await h.client.send("m3", "Reply with exactly the word two and nothing else.");
    await until(() => h.results.length === 3, T, "after clear");
    expect(h.results[2].text).toBe("two");
    expect(h.client.state?.claudeSessionId).toBe(moved[0]);
    expect(h.client.state?.sessionId).toBe(h.spec.sessionId);
  }, T);

  test("a usage limit ends the turn with the error kind and message", async () => {
    const h = await inProcess(["limit"]);
    await h.client.send("m1", "hi");
    await until(() => h.results.length, T, "result");
    expect(h.results[0].isError).toBe(true);
    expect(h.results[0].error).toMatchObject({ kind: "rate_limit" });
    expect(h.results[0].error?.message).toContain("hit your limit");
    expect(h.client.state?.lastError?.kind).toBe("rate_limit");
  }, T);

  test("a Claude Code older than the minimum is refused at startup", async () => {
    const h = await inProcess(["text"], { FAKE_CLAUDE_VERSION: "2.1.100" });
    let tooOld = "";
    h.client.on("too_old", (v) => (tooOld = v ?? "?"));
    await until(() => tooOld, T, "too_old");
    expect(tooOld as string).toBe("2.1.100");
    await until(() => h.exited(), T, "host exit");
  }, T);
});

describe("claude sdk host as its own process", () => {
  const castArgv = [process.execPath, path.join(import.meta.dir, "..", "main.ts")];

  test("a daemon that reconnects sees the pending prompt and can answer it", async () => {
    const world = fakeWorld(["tool-allow"]);
    worlds.push(world);
    const spec = world.spec();
    const first = await launchSdkHost(spec, { castArgv, dir: world.hostDir, noLaunchd: true, startTimeoutMs: 120_000 });
    stops.push(async () => { await first.stop(); });
    await first.send("m1", "run it");
    await until(() => first.state?.pending.length, 90_000, "permission");
    const pid = first.state!.pid;
    first.close(); // the daemon goes away; the host stays
    expect(pidAlive(pid)).toBe(true);

    const second = await attachSdkHost(spec.sessionId, world.hostDir);
    expect(second).not.toBeNull();
    stops.push(async () => { await second!.stop(); });
    const state = await until(() => second!.state, T, "state");
    expect(state.pid).toBe(pid);
    expect(state.status).toBe("needs_input");
    const request = state.pending[0];
    expect(request.toolName).toBe("Bash");
    const results: string[] = [];
    second!.on("result", (r) => results.push(r.text ?? ""));
    expect((await second!.answer(request.requestId, { behavior: "allow" })).ok).toBe(true);
    await until(() => results.length, T, "result");
    expect(results[0]).toBe("done");
  }, 240_000);

  test("a host that dies mid-turn is reported gone, and a resumed host continues the session", async () => {
    const world = fakeWorld(["interrupt", "resume"]);
    worlds.push(world);
    const spec = world.spec();
    const client = await launchSdkHost(spec, { castArgv, dir: world.hostDir, noLaunchd: true, startTimeoutMs: 120_000 });
    let gone = "";
    client.on("gone", (why) => (gone = why));
    await client.send("m1", "sleep");
    await until(() => client.state?.activity?.status === "working", 90_000, "working");
    process.kill(client.state!.pid, "SIGKILL");
    await until(() => gone, T, "gone");

    const resumed = await launchSdkHost({ ...spec, resume: true }, { castArgv, dir: world.hostDir, noLaunchd: true, startTimeoutMs: 120_000 });
    stops.push(async () => { await resumed.stop(); });
    const results: string[] = [];
    resumed.on("result", (r) => results.push(r.text ?? ""));
    await resumed.send("m2", "What was the code word? Reply with just the word.");
    await until(() => results.length, T, "result");
    expect(results[0]).toBe("avocado");
    const spawns = world.fakeLog().filter((l) => l.startsWith("spawn "));
    expect(spawns[1]).toContain(`--resume=${spec.sessionId}`);
    expect(fs.existsSync(sdkHostPaths(spec.sessionId, world.hostDir).socket)).toBe(true);
  }, 240_000);
});
