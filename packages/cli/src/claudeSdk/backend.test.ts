// The daemon's side of the SDK backend, with real host processes running the
// real SDK against the replaying fake claude (testing/fakeClaude.ts).

import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { ClaudeSdkBackend, imagesFromTags, type ClaudeSdkBackendDeps } from "./backend.js";
import { fakeWorld, until, type FakeWorld } from "./testing/harness.js";
import type { SdkActivity, SdkPermissionAnswer, SdkPermissionRequest } from "./protocol.js";

const castArgv = [process.execPath, path.join(import.meta.dir, "..", "main.ts")];
const worlds: FakeWorld[] = [];
const backends: ClaudeSdkBackend[] = [];
afterEach(async () => {
  for (const b of backends.splice(0)) for (const c of b.conversations()) await b.stop(c, { forget: true });
  for (const w of worlds.splice(0)) w.cleanup();
});

// `answer` returning null is a person who has not answered yet: the card stays open.
function makeBackend(world: FakeWorld, answer: (r: SdkPermissionRequest) => SdkPermissionAnswer | null = () => null, over: Partial<ClaudeSdkBackendDeps> = {}, castArgvOverride?: string[]) {
  const activity: SdkActivity[] = [];
  const permissions: SdkPermissionRequest[] = [];
  const stopped: string[] = [];
  const cards: string[] = [];
  const deps: ClaudeSdkBackendDeps = {
    log: (l) => { if (process.env.DEBUG_SDK) console.log(`[dbg] ${l}`); },
    castArgv: () => castArgvOverride ?? castArgv,
    shellPrefix: () => "",
    activity: (_c, _s, a) => activity.push(a),
    permission: async (_c, _s, request, _settled, opened) => {
      permissions.push(request);
      if (!request.cardId) {
        opened(`card-${permissions.length}`);
        cards.push(`card-${permissions.length}`);
      }
      const a = answer(request);
      return a ?? new Promise<SdkPermissionAnswer | null>(() => {});
    },
    turnError: () => {},
    stopped: (_c, _s, why) => stopped.push(why),
    tooOld: () => {},
    sessionChanged: () => {},
    transcriptHas: async () => false,
    mayResume: async () => true,
    resumeAccount: async (_c, saved) => saved,
    transcriptExists: () => true,
  };
  Object.assign(deps, over);
  const backend = new ClaudeSdkBackend(deps, world.hostDir, { noLaunchd: true, startTimeoutMs: castArgvOverride ? 3_000 : 240_000, initTimeoutMs: world.dir.includes("hang") ? 5_000 : 240_000 });
  backends.push(backend);
  return { backend, activity, permissions, stopped, cards };
}

const T = 600_000;

describe("ClaudeSdkBackend", () => {
  test("start, deliver, and a turn reported as hook-shaped activity", async () => {
    const world = fakeWorld(["text"]);
    worlds.push(world);
    const b = makeBackend(world);
    await b.backend.start("conv1", world.spec());
    expect(b.backend.owns("conv1")).toBe(true);
    expect(b.backend.conversationForSession(world.spec().sessionId)).toBe("conv1");
    await b.backend.deliver("conv1", "m1", "Reply with exactly the word pong and nothing else.");
    await until(() => b.activity.some((a) => a.status === "idle" && a.turnCompletedAt), 240_000, "turn end");
    expect(b.activity.map((a) => a.status)).toContain("thinking");
  }, T);

  test("a message that arrives while the host boots waits for it, and no second host starts", async () => {
    const world = fakeWorld(["text"]);
    worlds.push(world);
    const b = makeBackend(world);
    const starting = b.backend.start("conv1", world.spec());
    await b.backend.deliver("conv1", "m1", "Reply with exactly the word pong and nothing else.");
    await starting;
    await until(() => b.activity.some((a) => a.turnCompletedAt), 240_000, "turn end");
    expect(world.fakeLog().filter((l) => l.startsWith("spawn ")).length).toBe(1);
  }, T);

  test("a start racing a resume leaves one host, not two", async () => {
    const world = fakeWorld(["interrupt", "text", "text"]);
    worlds.push(world);
    const b = makeBackend(world);
    await b.backend.start("conv1", world.spec());
    await b.backend.deliver("conv1", "m1", "sleep");
    await until(() => b.activity.some((a) => a.status === "working"), 240_000, "working");
    const { readHostState } = await import("./client.js");
    process.kill(readHostState(world.spec().sessionId, world.hostDir)!.pid, "SIGKILL");
    await until(() => b.stopped.length, 60_000, "gone");
    const fresh = { ...world.spec(), sessionId: crypto.randomUUID() };
    await Promise.all([b.backend.deliver("conv1", "m2", "resume me").catch(() => {}), b.backend.start("conv1", fresh)]);
    const { spawnSync } = await import("node:child_process");
    const hosts = spawnSync("/usr/bin/pgrep", ["-f", `_claude-sdk-host ${world.hostDir}`], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
    expect(hosts.length).toBe(1);
    expect(b.backend.sessionFor("conv1")).toBe(fresh.sessionId);
  }, T);

  test("a poll answer that arrives right after a daemon restart reaches the open question", async () => {
    const world = fakeWorld(["ask"]);
    worlds.push(world);
    const first = makeBackend(world);
    await first.backend.start("conv1", world.spec());
    await first.backend.deliver("conv1", "m1", "ask me");
    await until(() => first.activity.some((a) => a.message === "AskUserQuestion"), 240_000, "question");
    first.backend.detachAll();
    backends.splice(backends.indexOf(first.backend), 1);
    // No reattachAll first: the delivery itself attaches.
    const second = makeBackend(world);
    expect(await second.backend.deliver("conv1", "m2", JSON.stringify({ __cc_poll: true, keys: ["2"], display: "Blue" }))).toBe("answered");
    await until(() => second.activity.some((a) => a.turnCompletedAt), 240_000, "turn end");
  }, T);

  test("a Claude that never finishes starting fails the start, and its host is stopped", async () => {
    const world = fakeWorld(["hang"], {}, "hang");
    worlds.push(world);
    const b = makeBackend(world);
    await expect(b.backend.start("conv1", world.spec())).rejects.toThrow(/did not finish starting/);
    expect(b.backend.owns("conv1")).toBe(false);
    const { spawnSync } = await import("node:child_process");
    expect(spawnSync("/usr/bin/pgrep", ["-f", `_claude-sdk-host ${world.hostDir}`]).status).toBe(1);
  }, T);

  test("a pick that names no option dismisses the question instead of leaving Claude waiting", async () => {
    const world = fakeWorld(["ask"]);
    worlds.push(world);
    const b = makeBackend(world);
    await b.backend.start("conv1", world.spec());
    await b.backend.deliver("conv1", "m1", "ask me");
    await until(() => b.activity.some((a) => a.message === "AskUserQuestion"), 240_000, "question");
    expect(await b.backend.deliver("conv1", "m2", JSON.stringify({ __cc_poll: true, keys: ["9"] }))).toBe("answered");
    await until(() => b.activity.some((a) => a.turnCompletedAt), 240_000, "turn end");
  }, T);

  test("a start whose host never comes up leaves no binding behind", async () => {
    const world = fakeWorld(["text"]);
    worlds.push(world);
    const b = makeBackend(world, undefined, {}, ["/usr/bin/false"]);
    await expect(b.backend.start("conv1", world.spec())).rejects.toThrow();
    expect(b.backend.owns("conv1")).toBe(false);
  }, T);

  test("a dead host whose session has no transcript starts fresh; a refused resume stays down", async () => {
    const world = fakeWorld(["text", "text"]);
    worlds.push(world);
    let allowed = true;
    const b = makeBackend(world, undefined, { transcriptExists: () => false, mayResume: async () => allowed });
    await b.backend.start("conv1", world.spec());
    const { readHostState } = await import("./client.js");
    process.kill(readHostState(world.spec().sessionId, world.hostDir)!.pid, "SIGKILL");
    await until(() => b.stopped.length, 60_000, "gone");
    allowed = false;
    await expect(b.backend.deliver("conv1", "m1", "hi")).rejects.toThrow(/may not be resumed/);
    allowed = true;
    await b.backend.deliver("conv1", "m2", "Reply with exactly the word pong and nothing else.");
    await until(() => b.activity.some((a) => a.turnCompletedAt), 240_000, "turn end");
    const spawns = world.fakeLog().filter((l) => l.startsWith("spawn "));
    expect(spawns.length).toBe(2);
    expect(spawns[1]).toContain(`--session-id=${world.spec().sessionId}`);
  }, T);

  test("a permission prompt is answered through the card the daemon opens", async () => {
    const world = fakeWorld(["tool-allow"]);
    worlds.push(world);
    const b = makeBackend(world, () => ({ behavior: "allow" }));
    await b.backend.start("conv1", world.spec());
    await b.backend.deliver("conv1", "m1", "run it");
    await until(() => b.activity.some((a) => a.turnCompletedAt), 240_000, "turn end");
    expect(b.permissions.map((p) => p.toolName)).toEqual(["Bash"]);
    expect(b.activity.some((a) => a.status === "permission_blocked")).toBe(true);
  }, T);

  test("the web's poll answer reaches a pending AskUserQuestion", async () => {
    const world = fakeWorld(["ask"]);
    worlds.push(world);
    const b = makeBackend(world);
    await b.backend.start("conv1", world.spec());
    await b.backend.deliver("conv1", "m1", "ask me");
    await until(() => b.activity.some((a) => a.status === "permission_blocked" && a.message === "AskUserQuestion"), 240_000, "question");
    // Questions are not permission cards.
    expect(b.permissions).toEqual([]);
    await b.backend.deliver("conv1", "m2", JSON.stringify({ __cc_poll: true, keys: ["2"], display: "Blue" }));
    await until(() => b.activity.some((a) => a.turnCompletedAt), 240_000, "turn end");
  }, T);

  test("a restarted daemon reattaches and binds to the card already open", async () => {
    const world = fakeWorld(["tool-allow"]);
    worlds.push(world);
    const first = makeBackend(world);
    await first.backend.start("conv1", world.spec());
    await first.backend.deliver("conv1", "m1", "run it");
    await until(() => first.cards.length, 240_000, "card");
    const { readHostState } = await import("./client.js");
    await until(() => readHostState(world.spec().sessionId, world.hostDir)?.pending[0]?.cardId, 60_000, "card id on the host");
    first.backend.detachAll();
    backends.splice(backends.indexOf(first.backend), 1);

    const second = makeBackend(world, () => ({ behavior: "allow" }));
    expect(await second.backend.reattachAll()).toEqual(["conv1"]);
    // The prompt opened before this daemon: its status comes from the host's snapshot.
    expect(second.activity[0]).toMatchObject({ status: "permission_blocked", dialog: true });
    await until(() => second.activity.some((a) => a.turnCompletedAt), 240_000, "turn end");
    expect(second.permissions.map((p) => p.cardId)).toEqual(["card-1"]);
    expect(second.cards).toEqual([]);
  }, T);

  test("a host that died is resumed by the next delivery", async () => {
    const world = fakeWorld(["interrupt", "resume"]);
    worlds.push(world);
    const b = makeBackend(world);
    await b.backend.start("conv1", world.spec());
    await b.backend.deliver("conv1", "m1", "sleep");
    await until(() => b.activity.some((a) => a.status === "working"), 240_000, "working");
    const { readHostState } = await import("./client.js");
    process.kill(readHostState(world.spec().sessionId, world.hostDir)!.pid, "SIGKILL");
    await until(() => b.stopped.length, 60_000, "gone");
    expect(b.backend.isRunning("conv1")).toBe(false);
    await b.backend.deliver("conv1", "m2", "What was the code word?");
    await until(() => b.activity.some((a) => a.turnCompletedAt), 240_000, "resumed turn end");
    expect(world.fakeLog().filter((l) => l.startsWith("spawn ")).at(-1)).toContain("--resume=");
  }, T);
});

test("imagesFromTags reads each tagged image, skipping unknown types", () => {
  const files: Record<string, string> = { "/tmp/a.png": "png-bytes", "/tmp/b.txt": "x" };
  const images = imagesFromTags("look [Image /tmp/a.png] and [Image /tmp/b.txt]", (p) => Buffer.from(files[p]));
  expect(images).toEqual([{ mediaType: "image/png", data: Buffer.from("png-bytes").toString("base64") }]);
});
