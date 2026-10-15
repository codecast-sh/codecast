import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findSessionFile, primeSessionFileIndexAtBoot, refreshRecentSessionFileForTests, refreshSessionFileIndex, resetSessionFileIndexForTests, resolveTurnEndStatus } from "./daemon.js";

// ct-59925 (jx72h7t, 2026-10-14): a workflow's Prove hand ended its turn with a
// run_in_background replay and a Monitor open, and the settle read "idle", so
// the runner failed the node while the hand was still waiting on its own work.
// The open task scan was right; the settle never ran it. The Stop hook posts no
// transcript path, so resolveTurnEndStatus asks the session file index, and the
// index lost the six minute old transcript: the daemon was under load, an index
// walk that began before the session's project dir existed landed minutes
// later, and that walk (a) replaced the live map, dropping the entry the recent
// probe had found meanwhile, and (b) "confirmed" the id absent. Every settle
// after that saw no transcript and answered idle with no log line.

const ID = "01689a88-d07b-43e4-8430-08dffdb55589";
const line = (o: unknown) => JSON.stringify(o);
const at = (s: string) => `2026-10-14T08:${s}Z`;

// The transcript at the 08:33:52 turn end, reduced to its shape: the prompt, a
// background Bash start, a Monitor start, and the closing assistant text.
function proveHandTranscript(): string {
  return [
    line({ type: "user", sessionId: ID, timestamp: at("28:07.000"), message: { role: "user", content: "You are running unattended: the \"Prove\" step of workflow agentwatch_trial" } }),
    line({ type: "assistant", sessionId: ID, timestamp: at("33:02.000"), message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_01BgZv2LGMKhJxuTby5ePeJ8", name: "Bash", input: { command: "(bun scripts/repro/ct-59925-brief-fee-figure-replay.ts; echo \"EXIT $?\") > /tmp/ct59925/run1.log 2>&1", run_in_background: true } }] } }),
    line({ type: "user", sessionId: ID, timestamp: at("33:04.000"), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01BgZv2LGMKhJxuTby5ePeJ8", content: "Command running in background with ID: ba1y32yt3. Output is being written to: /private/tmp/claude-501/tasks/ba1y32yt3.output" }] } }),
    line({ type: "assistant", sessionId: ID, timestamp: at("33:47.000"), message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_SSAqAfjf", name: "Monitor", input: { command: "tail -n +1 -f /tmp/ct59925/run1.log | grep -E --line-buffered \"draw\"", description: "ct-59925 replay draws and verdict" } }] } }),
    line({ type: "user", sessionId: ID, timestamp: at("33:49.000"), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_SSAqAfjf", content: "Monitor started (task bed0lhqkf, expires in 20m unless the source ends first; you get one notice at expiry — re-arm if you still need the wait)." }] } }),
    line({ type: "assistant", sessionId: ID, timestamp: at("33:50.000"), message: { role: "assistant", content: [{ type: "text", text: "Waiting on the first draws." }] } }),
    line({ type: "system", subtype: "stop_hook_summary", sessionId: ID, timestamp: at("33:52.000") }),
  ].join("\n") + "\n";
}

describe("a settle finds a transcript born while an index walk was in flight", () => {
  test("ct-59925 shape: the landing walk neither drops nor denies the fresh transcript", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "settle-fresh-"));
    const priorHome = process.env.HOME;
    const priorConfig = process.env.CODECAST_DIR;
    const project = path.join(home, ".claude", "projects", "-Users-ashot-src-union-mobile--codecast-worktrees-agentwatch-trial-ct-59925");
    const file = path.join(project, `${ID}.jsonl`);
    let release!: () => void;
    let reached!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { reached = resolve; });
    const original = fs.promises.readdir;
    let holding = false;
    // The claude store is walked first and finishes; the walk then stalls in
    // the codex store, the way a loaded machine stretched it to minutes.
    const read = spyOn(fs.promises, "readdir").mockImplementation((async (dir: unknown, ...args: unknown[]) => {
      if (holding && String(dir) === path.join(home, ".codex", "sessions")) { reached(); await held; }
      return (original as any)(dir, ...args);
    }) as any);
    let walk: Promise<void> | undefined;
    try {
      process.env.HOME = home;
      process.env.CODECAST_DIR = path.join(home, ".codecast");
      fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
      fs.mkdirSync(path.join(home, ".codex", "sessions"), { recursive: true });
      resetSessionFileIndexForTests();
      await primeSessionFileIndexAtBoot();
      // A lookup before the session's transcript exists (delivery waits on
      // start_session for a spawned hand), then a periodic walk starts.
      expect(findSessionFile(ID, { staleOk: true })).toBeNull();
      await new Promise(resolve => setTimeout(resolve, 5));
      holding = true;
      walk = refreshSessionFileIndex();
      await entered;

      // The hand starts and writes its transcript after the walk read
      // ~/.claude/projects; the recent probe finds it.
      fs.mkdirSync(project, { recursive: true });
      fs.writeFileSync(file, proveHandTranscript());
      await refreshRecentSessionFileForTests(ID);
      expect(findSessionFile(ID, { staleOk: true })?.path).toBe(file);

      // The stale walk lands.
      release();
      await walk;
      expect(findSessionFile(ID, { staleOk: true })?.path).toBe(file);
      expect(resolveTurnEndStatus(ID)).toBe("waiting");
    } finally {
      release();
      await walk;
      read.mockRestore();
      process.env.HOME = priorHome;
      if (priorConfig === undefined) delete process.env.CODECAST_DIR;
      else process.env.CODECAST_DIR = priorConfig;
      resetSessionFileIndexForTests();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("the Stop hook's transcript settles the turn though the index has never seen it", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "settle-hook-path-"));
    const priorHome = process.env.HOME;
    const priorConfig = process.env.CODECAST_DIR;
    // Outside every store the index walks: only the hook can name it.
    const file = path.join(home, "elsewhere", `${ID}.jsonl`);
    try {
      process.env.HOME = home;
      process.env.CODECAST_DIR = path.join(home, ".codecast");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, proveHandTranscript());
      resetSessionFileIndexForTests();
      await primeSessionFileIndexAtBoot();
      expect(findSessionFile(ID, { staleOk: true })).toBeNull();
      expect(resolveTurnEndStatus(ID)).toBe("idle");
      expect(resolveTurnEndStatus(ID, { path: file, agentType: "claude" })).toBe("waiting");
    } finally {
      process.env.HOME = priorHome;
      if (priorConfig === undefined) delete process.env.CODECAST_DIR;
      else process.env.CODECAST_DIR = priorConfig;
      resetSessionFileIndexForTests();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
