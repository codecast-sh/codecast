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
function makeBackend(world: FakeWorld, answer: (r: SdkPermissionRequest) => SdkPermissionAnswer | null = () => null) {
  const activity: SdkActivity[] = [];
  const permissions: SdkPermissionRequest[] = [];
  const stopped: string[] = [];
  const cards: string[] = [];
  const deps: ClaudeSdkBackendDeps = {
    log: () => {},
    castArgv: () => castArgv,
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
    transcriptHas: () => false,
  };
  const backend = new ClaudeSdkBackend(deps, world.hostDir, { noLaunchd: true, startTimeoutMs: 240_000 });
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
