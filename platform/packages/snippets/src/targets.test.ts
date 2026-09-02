// Ported from codecast packages/cli/src/snippets.targets.test.ts. The donor
// read candidates off its agent client registry and the real filesystem; here
// the candidates are declared inline and the filesystem is injected, which is
// the same three rules without the scratch HOME machinery: `always` clients
// appear whether or not their directory exists, every other candidate is
// gated on its config directory existing, and enumeration creates nothing.

import { describe, expect, test } from "bun:test";
import { memoryFs } from "./fs";
import { resolveTargets, type TargetCandidate } from "./targets";

const CANDIDATES: TargetCandidate[] = [
  { path: "~/.claude/CLAUDE.md", always: true },
  { path: "~/.codex/AGENTS.md" },
  { path: "~/.gemini/GEMINI.md" },
];

const home = "/Users/someone";
const withDirs = (...dirs: string[]) => {
  const fsi = memoryFs();
  for (const d of dirs) fsi.mkdir(`${home}/${d}`);
  return fsi;
};

describe("resolveTargets", () => {
  test("a home with only ~/.claude yields exactly the always target", () => {
    const list = resolveTargets(CANDIDATES, { home, fs: withDirs(".claude") });
    expect(list.map((t) => t.label)).toEqual(["~/.claude/CLAUDE.md"]);
    expect(list[0].filePath).toBe(`${home}/.claude/CLAUDE.md`);
    expect(list[0].dirPath).toBe(`${home}/.claude`);
  });

  test("codex joins when ~/.codex exists", () => {
    const labels = resolveTargets(CANDIDATES, { home, fs: withDirs(".claude", ".codex") }).map((t) => t.label);
    expect(labels).toEqual(["~/.claude/CLAUDE.md", "~/.codex/AGENTS.md"]);
  });

  test("an undeclared client never appears, whatever directories exist", () => {
    // The donor's registry declares no user instruction file for gemini, pi
    // or cursor; here that is simply not listing a candidate.
    const labels = resolveTargets(
      CANDIDATES.slice(0, 2),
      { home, fs: withDirs(".claude", ".codex", ".gemini", ".pi", ".cursor") },
    ).map((t) => t.label);
    expect(labels).toEqual(["~/.claude/CLAUDE.md", "~/.codex/AGENTS.md"]);
  });

  test("enumerating creates no directories", () => {
    const fsi = withDirs(".claude", ".cursor");
    resolveTargets(CANDIDATES, { home, fs: fsi });
    expect(fsi.writes.size).toBe(0);
    expect(fsi.dirs.has(`${home}/.codex`)).toBe(false);
  });

  test("the always target appears even before its directory exists — the writer creates it", () => {
    const list = resolveTargets(CANDIDATES, { home, fs: memoryFs() });
    expect(list.map((t) => t.label)).toEqual(["~/.claude/CLAUDE.md"]);
  });
});
