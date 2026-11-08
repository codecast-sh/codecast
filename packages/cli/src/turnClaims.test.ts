import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { REVIVE_BUDGET } from "./midWorkRevive.js";
import {
  CLAIM_MAX_AGE_MS, MAX_TURN_RESUME_ATTEMPTS, RESUME_START_MS,
  TurnClaimLedger, TurnClaimRecovery, claimDecision, claimTransition,
  type ClaimFacts, type TurnClaim,
} from "./turnClaims.js";

const MIN = 60_000;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function scratch(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "turn-claims-"));
  dirs.push(d);
  return d;
}

const visible = { hideStateKnown: true, inboxKilledAt: null, inboxDismissedAt: null };
const dead = (over: Partial<ClaimFacts> = {}): ClaimFacts => ({
  liveness: "exited", ownedElsewhere: false, lifecycle: visible, interruptedByUser: false, limitParked: false, lastLifeAt: 0, recentRevives: 0, continueState: "unknown", ...over,
});

describe("claimTransition", () => {
  test("mid-turn statuses open, a turn's end releases, a session coming up does neither", () => {
    for (const s of ["thinking", "working", "permission_blocked"]) expect(claimTransition(s)).toBe("open");
    // An automatic compaction runs inside a claimed turn; a manual /compact is no turn.
    expect(claimTransition("compacting")).toBe("none");
    for (const s of ["waiting", "dormant", "stopped", "done", "blocked"]) expect(claimTransition(s)).toBe("release");
    // The Stop's idle ends the turn; Claude's idle_prompt (a bare idle) ends nothing.
    expect(claimTransition("idle", { turnEnded: true })).toBe("release");
    expect(claimTransition("idle")).toBe("none");
    for (const s of ["connected", "starting", "resuming"]) expect(claimTransition(s)).toBe("none");
    // SessionStart landing a resume at its prompt is not the end of the turn being continued.
    expect(claimTransition("idle", { sessionBoundary: true })).toBe("none");
  });
});

describe("TurnClaimLedger", () => {
  test("writes only when a claim opens or is released, and a reopen keeps the attempts", () => {
    const file = path.join(scratch(), "claims.json");
    const ledger = new TurnClaimLedger(file);
    ledger.apply("s1", "c1", "thinking", { at: 1000 });
    const opened = fs.statSync(file).mtimeMs;
    fs.utimesSync(file, 1, 1);
    for (let i = 0; i < 5; i++) ledger.apply("s1", "c1", "working", { at: 2000 + i });
    expect(fs.statSync(file).mtimeMs).toBe(1000); // utimes in seconds: untouched by tool calls
    expect(opened).toBeGreaterThan(0);
    ledger.beginAttempt("s1", 5000);
    ledger.apply("s1", "c1", "thinking", { at: 6000 }); // the continue a resume sent
    expect(new TurnClaimLedger(file).get("s1")).toMatchObject({ conversationId: "c1", claimedAt: 1000, attempts: 1, lastAttemptAt: 5000 });
    ledger.apply("s1", "c1", "idle", { turnEnded: true, at: 7000 });
    expect(new TurnClaimLedger(file).list()).toEqual([]);
  });

  test("a manual /compact opens nothing; an automatic one keeps the turn's claim", () => {
    const ledger = new TurnClaimLedger(path.join(scratch(), "claims.json"));
    ledger.apply("s1", "c1", "compacting", { at: 1000 });
    ledger.apply("s1", "c1", "idle", { sessionBoundary: true, at: 2000 }); // PostCompact, trigger manual
    expect(ledger.list()).toEqual([]);
    ledger.apply("s1", "c1", "thinking", { at: 3000 });
    ledger.apply("s1", "c1", "compacting", { at: 4000 });
    ledger.apply("s1", "c1", "working", { at: 5000 }); // SessionStart(compact): the turn goes on
    expect(ledger.get("s1")).toMatchObject({ claimedAt: 3000 });
  });

  test("a /clear that moved the conversation to a new session releases the old session's claim", () => {
    const ledger = new TurnClaimLedger(path.join(scratch(), "claims.json"));
    ledger.apply("old", "c1", "thinking", { at: 1000 });
    ledger.apply("other", "c2", "thinking", { at: 1000 });
    ledger.apply("new", "c1", "idle", { sessionBoundary: true, at: 2000 });
    expect(ledger.list().map((c) => c.sessionId)).toEqual(["other"]);
  });

  test("a resumed process that speaks is recorded once; an older replayed status is not it", () => {
    const file = path.join(scratch(), "claims.json");
    const ledger = new TurnClaimLedger(file);
    ledger.apply("s1", "c1", "thinking", { at: 1000 });
    ledger.beginAttempt("s1", 60_000);
    ledger.apply("s1", "c1", "working", { at: 30_000 }); // spooled before the death, replayed late
    expect(ledger.get("s1")?.heardAt).toBeUndefined();
    ledger.apply("s1", "c1", "idle", { sessionBoundary: true, at: 61_000 }); // SessionStart(resume)
    ledger.apply("s1", "c1", "thinking", { at: 62_000 }); // the continue starts: same turn
    expect(new TurnClaimLedger(file).get("s1")).toMatchObject({ attempts: 1, lastAttemptAt: 60_000, heardAt: 61_000, claimedAt: 1000 });
  });

  test("a turn starting in the same second as a teardown still opens its claim", () => {
    let clock = 20_400;
    const ledger = new TurnClaimLedger(path.join(scratch(), "claims.json"), () => clock);
    ledger.apply("s1", "c1", "working", { at: 10_000 });
    ledger.releaseConversation("c1"); // a restart at 20.4s
    ledger.apply("s1", "c1", "thinking", { at: 20_000 }); // its first prompt, stamped 20s
    expect(ledger.get("s1")).toMatchObject({ claimedAt: 20_000 });
  });

  test("a status no newer than a release never reopens the claim", () => {
    const file = path.join(scratch(), "claims.json");
    let clock = 10_000;
    const ledger = new TurnClaimLedger(file, () => clock);
    ledger.apply("s1", "c1", "working", { at: 5_000 });
    ledger.releaseConversation("c1"); // a kill at 10s; its status file still says working
    ledger.open("s1", "c1", 5_000); // the watchdog finds that file
    ledger.apply("s1", "c1", "working", { at: 5_000 }); // the boot replay reads it
    expect(new TurnClaimLedger(file).list()).toEqual([]);
    ledger.apply("s1", "c1", "thinking", { at: 20_000 }); // a real new turn
    expect(ledger.get("s1")).toMatchObject({ claimedAt: 20_000 });
  });

  test("the next turn starting in the same second as a Stop still opens its claim", () => {
    const ledger = new TurnClaimLedger(path.join(scratch(), "claims.json"));
    ledger.apply("s1", "c1", "thinking", { at: 1000 });
    ledger.apply("s1", "c1", "idle", { turnEnded: true, at: 5000 });
    ledger.apply("s1", "c1", "thinking", { at: 5000 }); // a queued message injected at the Stop
    expect(ledger.get("s1")).toMatchObject({ claimedAt: 5000 });
  });

  test("a resumed session waiting at its prompt for the continue keeps its attempts", () => {
    const ledger = new TurnClaimLedger(path.join(scratch(), "claims.json"));
    ledger.apply("s1", "c1", "working", { at: 1000 });
    ledger.beginAttempt("s1", 5000);
    ledger.apply("s1", "c1", "idle", { sessionBoundary: true, at: 6000 }); // SessionStart(resume)
    ledger.apply("s1", "c1", "idle", { at: 70_000 }); // idle_prompt while the continue is held
    ledger.apply("s1", "c1", "thinking", { at: 80_000 }); // the continue arrives
    expect(ledger.get("s1")).toMatchObject({ attempts: 1, claimedAt: 1000 });
  });

  test("a boundary idle ends the claim, except the first status after a resume", () => {
    const ledger = new TurnClaimLedger(path.join(scratch(), "claims.json"));
    // An SDK turn whose session id changed reports its end as a boundary.
    ledger.apply("s2", "c1", "working", { at: 1000 });
    ledger.apply("s2", "c1", "idle", { sessionBoundary: true, at: 2000 });
    expect(ledger.get("s2")).toBeUndefined();
    // The resume landing at its prompt keeps the claim; a later boundary does not.
    ledger.apply("s3", "c2", "working", { at: 1000 });
    ledger.beginAttempt("s3", 5000);
    ledger.apply("s3", "c2", "idle", { sessionBoundary: true, at: 6000 });
    expect(ledger.get("s3")).toMatchObject({ attempts: 1, heardAt: 6000 });
    ledger.apply("s3", "c2", "idle", { sessionBoundary: true, at: 7000 });
    expect(ledger.get("s3")).toBeUndefined();
  });

  test("releaseConversation drops every claim of a stopped conversation", () => {
    const ledger = new TurnClaimLedger(path.join(scratch(), "claims.json"));
    ledger.open("s1", "c1", 1);
    ledger.open("s2", "c2", 1);
    ledger.releaseConversation("c1");
    expect(ledger.list().map((c) => c.sessionId)).toEqual(["s2"]);
  });
});

describe("claimDecision", () => {
  const claim: TurnClaim = { sessionId: "s", conversationId: "c", claimedAt: 0, attempts: 0 };
  const now = 60 * MIN;

  test("resumes a dead, visible, uninterrupted claim", () => {
    expect(claimDecision(claim, dead({ lastLifeAt: now - MIN }), now)).toEqual({ action: "resume" });
  });

  test("never resumes beside a process that is alive or could not be checked", () => {
    expect(claimDecision(claim, dead({ liveness: "live" }), now).action).toBe("keep");
    expect(claimDecision(claim, dead({ liveness: "unverifiable" }), now).action).toBe("keep");
  });

  test("waits until the resumed process has spoken, and when a lookup failed", () => {
    // A continue still queued (a load hold, a slow server) is not a second death.
    expect(claimDecision({ ...claim, attempts: 1, lastAttemptAt: now - RESUME_START_MS + MIN }, dead({ lastLifeAt: now }), now)).toEqual({ action: "keep", reason: "resume-in-flight" });
    // A resume that never reported in that long died before its first hook: the next attempt goes.
    expect(claimDecision({ ...claim, attempts: 1, lastAttemptAt: now - RESUME_START_MS - MIN }, dead({ lastLifeAt: now }), now)).toEqual({ action: "resume" });
    expect(claimDecision({ ...claim, attempts: 1, lastAttemptAt: now - RESUME_START_MS - MIN }, dead({ lastLifeAt: now, continueState: "landed" }), now)).toEqual({ action: "resume" });
    // ...unless its continue is still queued on the server: delivery is slow, nothing died again.
    expect(claimDecision({ ...claim, attempts: 1, lastAttemptAt: MIN }, dead({ lastLifeAt: MIN, continueState: "pending" }), 10 * RESUME_START_MS)).toEqual({ action: "keep", reason: "resume-in-flight" });
    // A person cancelled the continue: they do not want the turn back.
    expect(claimDecision({ ...claim, attempts: 1, lastAttemptAt: now - MIN }, dead({ continueState: "cancelled" }), now)).toEqual({ action: "release", reason: "continue-cancelled" });
    expect(claimDecision({ ...claim, attempts: 1, lastAttemptAt: now - MIN, heardAt: now - MIN }, dead({ lastLifeAt: now }), now)).toEqual({ action: "resume" });
    // A blip is not a decision: a failed lookup, or the legacy fallback with no hide state.
    expect(claimDecision(claim, dead({ lifecycle: undefined }), now).action).toBe("keep");
    expect(claimDecision(claim, dead({ lifecycle: { hideStateKnown: false } }), now).action).toBe("keep");
    expect(claimDecision(claim, dead({ ownedElsewhere: null }), now).action).toBe("keep");
    // A claim nobody can answer for (a message stuck in the queue) ends at the age bound; a live one never does.
    expect(claimDecision(claim, dead({ liveness: "unverifiable", lastLifeAt: MIN }), CLAIM_MAX_AGE_MS + 2 * MIN)).toEqual({ action: "release", reason: "too-old" });
    expect(claimDecision(claim, dead({ liveness: "live", lastLifeAt: MIN }), CLAIM_MAX_AGE_MS + 2 * MIN).action).toBe("keep");
    // ...and a claim whose lookups keep failing still ends at the age bound.
    expect(claimDecision(claim, dead({ lifecycle: undefined }), CLAIM_MAX_AGE_MS + 2 * MIN)).toEqual({ action: "release", reason: "too-old" });
  });

  test("releases what is not codecast's to continue", () => {
    expect(claimDecision(claim, dead({ ownedElsewhere: true, liveness: "unverifiable" }), now)).toEqual({ action: "release", reason: "moved" });
    expect(claimDecision(claim, dead({ lifecycle: { ...visible, inboxKilledAt: 1 } }), now)).toEqual({ action: "release", reason: "retired" });
    expect(claimDecision(claim, dead({ lifecycle: null }), now)).toEqual({ action: "release", reason: "conversation-gone" });
    expect(claimDecision(claim, dead({ interruptedByUser: true }), now)).toEqual({ action: "release", reason: "interrupted" });
    expect(claimDecision(claim, dead({ limitParked: true }), now)).toEqual({ action: "release", reason: "limit-parked" });
    const later = CLAIM_MAX_AGE_MS + 2 * MIN;
    expect(claimDecision(claim, dead({ lastLifeAt: MIN }), later)).toEqual({ action: "release", reason: "too-old" });
    // Gone that long after a resume of its own: the session says so, not a quiet "completed".
    expect(claimDecision({ ...claim, attempts: 1, lastAttemptAt: MIN }, dead({ lastLifeAt: MIN }), later)).toEqual({ action: "fail", reason: "attempts-spent" });
  });

  test("fails once every attempt is spent, in this turn or across turns", () => {
    expect(claimDecision({ ...claim, attempts: MAX_TURN_RESUME_ATTEMPTS, lastAttemptAt: 0, heardAt: 0 }, dead({ lastLifeAt: now }), now)).toEqual({ action: "fail", reason: "attempts-spent" });
    // Each resumed turn ended and the next one killed the process: the turn count reset, the window did not.
    expect(claimDecision(claim, dead({ lastLifeAt: now, recentRevives: REVIVE_BUDGET }), now)).toEqual({ action: "fail", reason: "attempts-spent" });
  });
});

function harness(file: string, facts: (c: TurnClaim) => ClaimFacts | Promise<ClaimFacts>) {
  let clock = 100 * MIN;
  const resumes: TurnClaim[] = [];
  const settled: string[] = [];
  const failed: string[] = [];
  const ledger = new TurnClaimLedger(file);
  const recovery = new TurnClaimRecovery({
    ledger,
    now: () => clock,
    inspect: async (c) => facts(c),
    resume: async (c) => { resumes.push(c); return `cont-${resumes.length}`; },
    settle: (_c, why) => settled.push(why),
    fail: (_c, message) => failed.push(message),
    log: () => {},
  });
  return { ledger, recovery, resumes, settled, failed, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

describe("TurnClaimRecovery", () => {
  test("a session that dies on every resume is tried the capped number of times, then failed visibly", async () => {
    const h = harness(path.join(scratch(), "claims.json"), () => dead({ lastLifeAt: h.now() }));
    h.ledger.open("s1", "c1", h.now());
    for (let i = 1; i <= MAX_TURN_RESUME_ATTEMPTS; i++) {
      await h.recovery.request();
      expect(h.resumes.length).toBe(i);
      // Delivery is slow: until the resumed process speaks, no pass queues another continue.
      h.advance(RESUME_START_MS - MIN);
      await h.recovery.request();
      expect(h.resumes.length).toBe(i);
      // The resumed process starts the continue (same turn, attempts kept), then dies again.
      h.ledger.apply("s1", "c1", "idle", { sessionBoundary: true, at: h.now() });
      h.ledger.apply("s1", "c1", "thinking", { at: h.now() });
      expect(h.ledger.get("s1")?.attempts).toBe(i);
      h.advance(MIN);
    }
    await h.recovery.request();
    expect(h.resumes.map((c) => c.attempts)).toEqual([1, 2, 3]);
    expect(h.failed).toHaveLength(1);
    expect(h.failed[0]).toContain(`${MAX_TURN_RESUME_ATTEMPTS} times`);
    expect(h.ledger.list()).toEqual([]);
    await h.recovery.request();
    expect(h.resumes).toHaveLength(MAX_TURN_RESUME_ATTEMPTS);
  });

  test("a claim whose agent is still alive is never resumed, and keeps its claim", async () => {
    const h = harness(path.join(scratch(), "claims.json"), () => dead({ liveness: "live", lastLifeAt: 0 }));
    h.ledger.open("s1", "c1", 0);
    for (let i = 0; i < 3; i++) { await h.recovery.request(); h.advance(RESUME_START_MS); }
    expect(h.resumes).toEqual([]);
    expect(h.ledger.get("s1")?.attempts).toBe(0);
  });

  test("a status that lands while the pass looks means the session is alive", async () => {
    let h!: ReturnType<typeof harness>;
    h = harness(path.join(scratch(), "claims.json"), () => {
      h.ledger.apply("s1", "c1", "working", { at: h.now() });
      return dead({ lastLifeAt: 0 });
    });
    h.ledger.open("s1", "c1", 0);
    await h.recovery.request();
    expect(h.resumes).toEqual([]);
  });

  test("a queue call that failed keeps its attempt spent and in flight; recovery off releases", async () => {
    const file = path.join(scratch(), "claims.json");
    let mode: "throw" | "off" = "throw";
    const settled: string[] = [];
    const ledger = new TurnClaimLedger(file);
    const recovery = new TurnClaimRecovery({
      ledger, now: () => 10 * MIN, log: () => {}, fail: () => {},
      inspect: async () => dead({ lastLifeAt: 10 * MIN }),
      resume: async () => { if (mode === "throw") throw new Error("offline"); return null; },
      settle: (_c, why) => settled.push(why),
    });
    ledger.open("s1", "c1", 10 * MIN);
    await recovery.request();
    // The server may have stored it: no second continue until the start window passes.
    expect(ledger.get("s1")).toMatchObject({ attempts: 1, lastAttemptAt: 10 * MIN });
    await recovery.request();
    expect(ledger.get("s1")).toMatchObject({ attempts: 1 });
    ledger.apply("s1", "c1", "working", { at: 11 * MIN }); // it came up, then died again
    mode = "off";
    await recovery.request();
    expect(ledger.get("s1")).toBeUndefined();
    expect(settled).toEqual(["recovery-off"]);
  });
});

// A fixture daemon in its own process: it applies hook statuses to the real
// ledger exactly as handleStatusData does, and runs the real recovery pass at
// boot, recording each continue it queues. Killing it with SIGKILL proves the
// claim and the attempt count live on disk, not in the process.
const FIXTURE = `
import { createInterface } from "node:readline";
import fs from "node:fs";
import { TurnClaimLedger, TurnClaimRecovery } from ${JSON.stringify(path.join(import.meta.dir, "turnClaims.ts"))};
const [file, resumes] = process.argv.slice(2);
const ledger = new TurnClaimLedger(file);
const recovery = new TurnClaimRecovery({
  ledger,
  now: () => Date.now(),
  log: () => {},
  // The agent died with the machine: nothing runs the session any more.
  inspect: async () => ({ liveness: "exited", ownedElsewhere: false, lifecycle: { hideStateKnown: true }, interruptedByUser: false, limitParked: false, lastLifeAt: Date.now(), recentRevives: 0 }),
  resume: async (c) => { fs.appendFileSync(resumes, JSON.stringify(c) + "\\n"); return "cont-" + c.attempts; },
  settle: () => {},
  fail: () => {},
});
await recovery.request();
console.log("booted");
createInterface({ input: process.stdin }).on("line", (line) => {
  const { session, conv, status, boundary } = JSON.parse(line);
  // A non-boundary idle here is the Stop hook's, which carries turn_completed_at.
  ledger.apply(session, conv, status, { sessionBoundary: boundary, turnEnded: status === "idle" && !boundary, at: Date.now() });
  console.log("ack " + status);
});
`;

async function bootFixture(dir: string) {
  const script = path.join(dir, "daemon.ts");
  fs.writeFileSync(script, FIXTURE);
  const child = spawn(process.execPath, [script, path.join(dir, "claims.json"), path.join(dir, "resumes.jsonl")], { stdio: ["pipe", "pipe", "inherit"] });
  const lines: string[] = [];
  const waiters: Array<() => void> = [];
  createInterface({ input: child.stdout! }).on("line", (l) => { lines.push(l); waiters.splice(0).forEach((w) => w()); });
  const waitFor = async (want: string) => {
    while (!lines.includes(want)) await new Promise<void>((r) => waiters.push(r));
    lines.splice(lines.indexOf(want), 1);
  };
  await waitFor("booted");
  return {
    status: async (status: string, boundary = false) => {
      child.stdin!.write(JSON.stringify({ session: "sess-1", conv: "conv-1", status, boundary }) + "\n");
      await waitFor(`ack ${status}`);
    },
    kill: async () => { child.kill("SIGKILL"); await new Promise((r) => child.once("exit", r)); },
    stop: async () => { child.stdin!.end(); child.kill(); await new Promise((r) => child.once("exit", r)); },
  };
}

const resumesIn = (dir: string): TurnClaim[] => {
  try { return fs.readFileSync(path.join(dir, "resumes.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};

test("a daemon killed mid-turn resumes the claimed session exactly once after it restarts", async () => {
  const dir = scratch();
  const first = await bootFixture(dir);
  expect(resumesIn(dir)).toEqual([]);
  await first.status("thinking");
  await first.status("working");
  await first.kill();

  // The restart resumes the claim, with the attempt on disk before the continue is queued.
  const second = await bootFixture(dir);
  expect(resumesIn(dir)).toHaveLength(1);
  expect(resumesIn(dir)[0]).toMatchObject({ sessionId: "sess-1", conversationId: "conv-1", attempts: 1 });
  await second.kill();

  // A crash while that resume is still starting does not resume it again.
  const third = await bootFixture(dir);
  expect(resumesIn(dir)).toHaveLength(1);
  // The resumed session lands at its prompt, takes the continue, and finishes the turn.
  await third.status("idle", true);
  await third.status("thinking");
  await third.status("idle");
  await third.stop();

  const fourth = await bootFixture(dir);
  expect(resumesIn(dir)).toHaveLength(1);
  expect(JSON.parse(fs.readFileSync(path.join(dir, "claims.json"), "utf8")).claims).toEqual({});
  await fourth.stop();
}, 30_000);
