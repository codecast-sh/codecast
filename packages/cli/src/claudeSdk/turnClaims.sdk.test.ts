// Turn claims on the SDK backend, with real host processes running the real
// SDK against the replaying fake claude. The ledger is fed the host's activity
// the way the daemon feeds it (activity -> status sink -> ledger.apply), and the
// recovery pass asks the backend whether the host lives and delivers the
// continue through it, as the daemon's queued revive message does.

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { MID_WORK_REVIVE_MESSAGE } from "@codecast/shared/contracts";
import { ClaudeSdkBackend, type ClaudeSdkBackendDeps } from "./backend.js";
import { readHostState } from "./client.js";
import { fakeWorld, until, type FakeWorld } from "./testing/harness.js";
import type { SdkActivity } from "./protocol.js";
import { TurnClaimLedger, TurnClaimRecovery, type TurnClaim } from "../turnClaims.js";

const castArgv = [process.execPath, path.join(import.meta.dir, "..", "main.ts")];
const worlds: FakeWorld[] = [];
const backends: ClaudeSdkBackend[] = [];
afterEach(async () => {
  for (const b of backends.splice(0)) for (const c of b.conversations()) await b.stop(c, { forget: true });
  for (const w of worlds.splice(0)) w.cleanup();
});

const T = 600_000;

function setup(recordings: string[]) {
  const world = fakeWorld(recordings);
  worlds.push(world);
  const ledger = new TurnClaimLedger(path.join(world.dir, "turn-claims.json"));
  const activity: SdkActivity[] = [];
  const resumes: TurnClaim[] = [];
  let recovery!: TurnClaimRecovery;
  const deps: ClaudeSdkBackendDeps = {
    log: (l) => { if (process.env.DEBUG_SDK) console.log(`[dbg] ${l}`); },
    castArgv: () => castArgv,
    shellPrefix: () => "",
    activity: (conv, sessionId, a) => {
      activity.push(a);
      ledger.apply(sessionId, conv, a.status, { sessionBoundary: a.sessionBoundary, at: a.ts * 1000 });
    },
    permission: async () => null,
    turnError: () => {},
    // What the daemon's stopped dep does: a host gone with its claim open asks for a pass.
    stopped: (_conv, sessionId) => { if (ledger.get(sessionId)) void recovery.request(); },
    tooOld: () => {},
    sessionChanged: () => {},
    transcriptHas: async () => false,
    mayResume: async () => true,
    resumeAccount: async (_c, saved) => saved,
    resumeModelEffort: () => ({ model: [], effort: [] }),
    transcriptExists: () => true,
  };
  const backend = new ClaudeSdkBackend(deps, world.hostDir, { noLaunchd: true, startTimeoutMs: 240_000, initTimeoutMs: 240_000 });
  backends.push(backend);
  recovery = new TurnClaimRecovery({
    ledger,
    now: () => Date.now(),
    log: deps.log,
    inspect: async (c) => ({
      liveness: await backend.hostVerdict(c.conversationId),
      ownedElsewhere: false,
      lifecycle: { hideStateKnown: true },
      interruptedByUser: false,
      limitParked: false,
      lastLifeAt: Date.now(),
      recentRevives: resumes.length,
    }),
    resume: async (c) => {
      resumes.push(c);
      await backend.deliver(c.conversationId, `revive-${resumes.length}`, MID_WORK_REVIVE_MESSAGE);
      return true;
    },
    settle: () => {},
    fail: () => {},
  });
  const spawns = () => world.fakeLog().filter((l) => l.startsWith("spawn "));
  return { world, ledger, backend, recovery, activity, resumes, spawns };
}

test("a live SDK host mid-turn is not resumed; killed, it is resumed exactly once and the turn finishes", async () => {
  const t = setup(["interrupt", "resume"]);
  const sessionId = t.world.spec().sessionId;
  await t.backend.start("conv1", t.world.spec());
  await t.backend.deliver("conv1", "m1", "sleep");
  await until(() => t.activity.some((a) => a.status === "working"), 240_000, "working");
  expect(t.ledger.get(sessionId)).toMatchObject({ conversationId: "conv1", attempts: 0 });

  // Still alive: a pass (a daemon restart would run one) leaves it alone.
  await t.recovery.request();
  expect(t.resumes).toEqual([]);
  expect(t.spawns()).toHaveLength(1);

  // The host dies mid-turn: its claim survives, and the pass continues it in a new host.
  process.kill(readHostState(sessionId, t.world.hostDir)!.pid, "SIGKILL");
  await until(() => t.resumes.length === 1, 240_000, "resume");
  await until(() => t.activity.some((a) => a.turnCompletedAt), 240_000, "resumed turn end");
  expect(t.spawns()).toHaveLength(2);
  expect(t.spawns()[1]).toContain("--resume=");
  expect(t.world.fakeLog().filter((l) => l.startsWith("user "))).toHaveLength(2);
  // The turn ended, so the claim is gone and another pass resumes nothing.
  await until(() => !t.ledger.get(sessionId), 60_000, "claim released");
  await t.recovery.request();
  expect(t.resumes).toHaveLength(1);
  expect(fs.readFileSync(path.join(t.world.dir, "turn-claims.json"), "utf8")).toBe("{}");
}, T);
