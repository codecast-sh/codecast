// A kill tears a session's process down only once the session is known to own
// it (planSessionTeardown fails closed). AgentWatch trial, 2026-10-16: under
// load the session-file index is always mid-refresh, the ownership check
// waited out each refresh and then read "unknown", and kill_session skipped
// the hand's teardown 232 times that day. A Propose hand the runner killed at
// its 30 minute timeout was still running 26 minutes later.
import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireSessionProcessOwnership, primeSessionFileIndexAtBoot, refreshSessionFileIndex, resetSessionFileIndexForTests } from "./daemon.js";

describe("kill_session ownership while the session index refreshes", () => {
  test("a Claude hand reads owned at once, and a Codex rollout under its id still vetoes", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "kill-ownership-"));
    const priorHome = process.env.HOME;
    const priorConfig = process.env.CODECAST_DIR;
    const id = "9b7cf9bb-5742-4293-82f3-2fe0f799482f";
    const projects = path.join(home, ".claude", "projects");
    const file = path.join(projects, "-repo-worktrees-agentwatch-trial-ct-59543", `${id}.jsonl`);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let holding = false;
    const original = fs.promises.readdir;
    const read = spyOn(fs.promises, "readdir").mockImplementation((async (dir: unknown, ...args: unknown[]) => {
      if (holding && String(dir) === projects) await held;
      return (original as any)(dir, ...args);
    }) as any);
    let refresh: Promise<void> | undefined;
    try {
      process.env.HOME = home;
      process.env.CODECAST_DIR = path.join(home, ".codecast");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ type: "user", sessionId: id, message: { role: "user", content: "You are running unattended: the Propose step" } }) + "\n");
      resetSessionFileIndexForTests();
      await primeSessionFileIndexAtBoot();

      // A refresh starts and does not finish while the kill asks.
      holding = true;
      refresh = refreshSessionFileIndex();
      const verdict = await Promise.race([
        acquireSessionProcessOwnership(id),
        new Promise<string>((resolve) => setTimeout(() => resolve("still waiting"), 3000)),
      ]);
      expect(verdict).toBe("owned");

      const codex = path.join(home, ".codex", "sessions", "2026", "10", "16");
      fs.mkdirSync(codex, { recursive: true });
      fs.symlinkSync(file, path.join(codex, `rollout-2026-10-16T21-29-00-${id}.jsonl`));
      expect(await acquireSessionProcessOwnership(id)).toBe("unknown");
    } finally {
      release();
      await refresh;
      read.mockRestore();
      process.env.HOME = priorHome;
      if (priorConfig === undefined) delete process.env.CODECAST_DIR;
      else process.env.CODECAST_DIR = priorConfig;
      resetSessionFileIndexForTests();
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20000);
});
