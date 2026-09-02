import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { measureLoopHold } from "./test-helpers/loopHold.js";
import { setSlowSyncFsThresholdForTests, setSlowSyncSink } from "./slowSync.js";
import {
  classifySharedPidSessions,
  resetSessionFileIndexForTests,
  sessionFileIndexBuiltAtForTests,
} from "./daemon.js";

// The 30s resource tick asks which cached sessions borrow their process. With
// a cold session file index that verdict rebuilt the index synchronously (a
// walk of every transcript store, 6s at boot under load) and read codex
// rollout heads with readSync. classifySharedPidSessions loads both off the
// loop first; the verdict then answers from memory.

const realHome = process.env.HOME;
let tmpHome: string;

const PARENT = "019fd000-0000-7000-8000-0000000000aa";
const THREAD = "019fd000-0000-7000-8000-0000000000bb";
const CLAUDE = "7d3b1e9a-0000-4000-8000-0000000000cc";
const UNKNOWN = "7d3b1e9a-0000-4000-8000-0000000000dd";

function metaLine(sessionId: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd: "/tmp/proj", ...payload } });
}

function writeRollout(dir: string, sessionId: string, payload: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(dir, `rollout-2026-09-02T10-00-00-${sessionId}.jsonl`),
    metaLine(sessionId, payload) + "\n" + JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }) + "\n",
  );
}

beforeAll(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cc-resource-prologue-"));
  process.env.HOME = tmpHome;
  const rollouts = path.join(tmpHome, ".codex", "sessions", "2026", "09", "02");
  fs.mkdirSync(rollouts, { recursive: true });
  writeRollout(rollouts, PARENT, { originator: "codex-tui", source: "cli", thread_source: "user" });
  writeRollout(rollouts, THREAD, {
    parent_thread_id: PARENT,
    originator: "codex-tui",
    thread_source: "subagent",
    source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1, agent_path: "/root/x", agent_role: null } } },
  });
  // A large claude store: the walk must happen off the loop. A hundred
  // project dirs, so the walk is many readdir batches rather than one.
  for (let d = 0; d < 100; d++) {
    const dir = path.join(tmpHome, ".claude", "projects", `-Users-x-proj-${d}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 50; i++) {
      fs.writeFileSync(path.join(dir, `${String(d).padStart(8, "0")}-0000-4000-8000-${String(i).padStart(12, "0")}.jsonl`), "{}\n");
    }
    if (d === 0) fs.writeFileSync(path.join(dir, `${CLAUDE}.jsonl`), JSON.stringify({ type: "user", cwd: "/tmp/proj" }) + "\n");
  }
  resetSessionFileIndexForTests();
});

afterAll(() => {
  setSlowSyncSink(null);
  setSlowSyncFsThresholdForTests(null);
  process.env.HOME = realHome;
  resetSessionFileIndexForTests();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

describe("classifySharedPidSessions", () => {
  test("a cold index is built off the loop and only the codex thread borrows", async () => {
    // With the threshold at zero every timed sync call reports, however
    // short: the absence of a walkDirsSync or readCodexSessionMetaHead line
    // while the index went from cold to built is the proof that neither ran
    // on the loop. (The 5k file fixture rebuilds in under 10ms, so a loop
    // hold measure alone cannot tell the sync walk from the async one.)
    const reports: string[] = [];
    setSlowSyncFsThresholdForTests(0);
    setSlowSyncSink((m) => reports.push(m));
    expect(sessionFileIndexBuiltAtForTests()).toBe(0);
    const { result, ticks, maxGapMs } = await measureLoopHold(
      () => classifySharedPidSessions([THREAD, PARENT, CLAUDE, UNKNOWN]),
      1,
    );
    expect([...result]).toEqual([THREAD]);
    expect(ticks).toBeGreaterThanOrEqual(2);
    expect(maxGapMs).toBeLessThan(200);
    const builtAt = sessionFileIndexBuiltAtForTests();
    expect(builtAt).toBeGreaterThan(0);
    expect(reports.filter((m) => m.includes("walkDirsSync"))).toEqual([]);
    expect(reports.filter((m) => m.includes("readCodexSessionMetaHead"))).toEqual([]);
    expect(reports.filter((m) => m.includes("probeRecent"))).toEqual([]);

    // Warm: the same answer, no new walk.
    const again = await classifySharedPidSessions([THREAD, PARENT, CLAUDE, UNKNOWN]);
    expect([...again]).toEqual([THREAD]);
    expect(sessionFileIndexBuiltAtForTests()).toBe(builtAt);
    expect(reports.filter((m) => m.includes("walkDirsSync"))).toEqual([]);
  }, 30_000);
});
