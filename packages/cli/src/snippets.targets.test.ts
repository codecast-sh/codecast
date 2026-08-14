import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// getSnippetTargets used to hardcode three facts the client registry now owns.
// The lookup must preserve two behaviours exactly and drop one side effect:
// DECLARED gates which clients can ever appear (gemini/pi never, whatever dirs
// exist), directory presence gates non-claude clients, and enumerating targets
// creates nothing on disk — directory creation belongs to the writer.
describe("getSnippetTargets over the registry", () => {
  const dirs: string[] = [];
  const originalHome = process.env.HOME;

  function withHome(subdirs: string[]): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-targets-"));
    dirs.push(home);
    for (const d of subdirs) fs.mkdirSync(path.join(home, d), { recursive: true });
    process.env.HOME = home;
    return home;
  }

  afterEach(() => {
    process.env.HOME = originalHome;
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  // The module caches nothing, but os.homedir() reads $HOME at call time on
  // POSIX, which is what lets these tests re-point it per case.
  async function targets() {
    const mod = await import("./snippets.js");
    return mod.getSnippetTargets();
  }

  test("a HOME with only ~/.claude yields exactly the claude target", async () => {
    const home = withHome([".claude"]);
    const list = await targets();
    expect(list.map((t) => t.label)).toEqual(["~/.claude/CLAUDE.md"]);
    expect(list[0].filePath).toBe(path.join(home, ".claude", "CLAUDE.md"));
  });

  test("codex joins when ~/.codex exists", async () => {
    withHome([".claude", ".codex"]);
    const labels = (await targets()).map((t) => t.label);
    expect(labels).toContain("~/.codex/AGENTS.md");
  });

  test("enumerating creates no directories", async () => {
    const home = withHome([".claude", ".cursor"]);
    await targets();
    // The old code created ~/.cursor/rules as a side effect of LISTING.
    expect(fs.existsSync(path.join(home, ".cursor", "rules"))).toBe(false);
  });

  test("no gemini or pi target appears even when those directories exist", async () => {
    withHome([".claude", ".gemini", ".pi", ".cursor"]);
    const labels = (await targets()).map((t) => t.label);
    for (const label of labels) {
      expect(label.includes("gemini")).toBe(false);
      expect(label.includes("pi/")).toBe(false);
      // Cursor declares no USER instruction file — its user-level .mdc was
      // never loaded by Cursor, so it no longer appears either.
      expect(label.includes("cursor")).toBe(false);
    }
  });

  test("claude appears even before ~/.claude exists — the writer creates it", async () => {
    withHome([]);
    expect((await targets()).map((t) => t.label)).toEqual(["~/.claude/CLAUDE.md"]);
  });
});
