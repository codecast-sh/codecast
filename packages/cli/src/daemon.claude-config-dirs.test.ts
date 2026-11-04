import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findSessionFile, findStaleSessionFiles, primeSessionFileIndexAtBoot, refreshRecentSessionFileForTests, resetSessionFileIndexForTests } from "./daemon.js";
import { resetClaudeConfigDirsCache } from "./claudeConfigDirs.js";

// Alexander Green runs each Claude subscription under its own
// CLAUDE_CONFIG_DIR (~/.claude-account-N). Session 7829f4de lived in
// ~/.claude-account-3/projects and the daemon, which only knew ~/.claude, could
// not find it: not synced, not in the feed, and a resume could not locate the
// transcript to carry into ~/.claude. Every lookup the daemon makes by session
// id now covers every config dir (claudeConfigDirs.ts).

const OLD = "7829f4de-5f42-4cd8-ae5b-56fe1464228a";
const FRESH = "0b6c1f2e-1d3a-4c55-9a77-2f0e8c4d9b10";
const transcript = (id: string) => JSON.stringify({ type: "user", sessionId: id, cwd: "/Users/alexandergreen", message: { role: "user", content: "hi" } }) + "\n";

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-config-dirs-"));
  const priorHome = process.env.HOME;
  const priorConfig = process.env.CODECAST_DIR;
  try {
    process.env.HOME = home;
    process.env.CODECAST_DIR = path.join(home, ".codecast");
    fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
    resetClaudeConfigDirsCache();
    resetSessionFileIndexForTests();
    await run(home);
  } finally {
    process.env.HOME = priorHome;
    if (priorConfig === undefined) delete process.env.CODECAST_DIR;
    else process.env.CODECAST_DIR = priorConfig;
    resetClaudeConfigDirsCache();
    resetSessionFileIndexForTests();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe("sessions under another CLAUDE_CONFIG_DIR", () => {
  test("the session-file index, the recent probe and the stale sweep all see them", async () => {
    await withHome(async (home) => {
      const account3 = path.join(home, ".claude-account-3");
      const project = path.join(account3, "projects", "-Users-alexandergreen");
      fs.mkdirSync(project, { recursive: true });
      fs.writeFileSync(path.join(account3, ".claude.json"), "{}");
      const oldFile = path.join(project, `${OLD}.jsonl`);
      fs.writeFileSync(oldFile, transcript(OLD));

      await primeSessionFileIndexAtBoot();
      expect(findSessionFile(OLD, { staleOk: true })).toEqual({ path: oldFile, agentType: "claude" });

      // Born after the index walk: only the recent probe can find it.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const freshFile = path.join(project, `${FRESH}.jsonl`);
      fs.writeFileSync(freshFile, transcript(FRESH));
      await refreshRecentSessionFileForTests(FRESH);
      expect(findSessionFile(FRESH, { staleOk: true })?.path).toBe(freshFile);

      // Never synced, so the watchdog's catch-up sweep owes both.
      expect((await findStaleSessionFiles()).sort()).toEqual([freshFile, oldFile].sort());
    });
  });

  test("a copy in ~/.claude wins over the same session in another config dir", async () => {
    await withHome(async (home) => {
      const account3 = path.join(home, ".claude-account-3");
      fs.mkdirSync(path.join(account3, "projects", "-Users-alexandergreen"), { recursive: true });
      fs.writeFileSync(path.join(account3, ".claude.json"), "{}");
      fs.writeFileSync(path.join(account3, "projects", "-Users-alexandergreen", `${OLD}.jsonl`), transcript(OLD));
      const mine = path.join(home, ".claude", "projects", "-Users-alexandergreen", `${OLD}.jsonl`);
      fs.mkdirSync(path.dirname(mine), { recursive: true });
      fs.writeFileSync(mine, transcript(OLD));

      await primeSessionFileIndexAtBoot();
      expect(findSessionFile(OLD, { staleOk: true })?.path).toBe(mine);
    });
  });
});
