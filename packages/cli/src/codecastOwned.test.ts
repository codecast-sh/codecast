import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CODECAST_HOOK_SCRIPTS, CODECAST_OWNED_HOME_PATHS, ORCH_AGENT_FILES, ORCH_MARKER, ORCH_SKILL_REL,
  STABLE_FEED_HOOK_FILE, isCodecastHookCommand, isCodecastOwnedHomePath,
} from "./codecastOwned";

const indexSrc = fs.readFileSync(path.join(import.meta.dir, "index.ts"), "utf-8");
const stableSrc = fs.readFileSync(path.join(import.meta.dir, "stableContext.ts"), "utf-8");

describe("CODECAST_HOOK_SCRIPTS is the set the installers actually write", () => {
  test("every installHookScript(\"…\") name in index.ts is listed, and nothing else is", () => {
    const written = new Set<string>();
    for (const m of indexSrc.matchAll(/installHookScript\("([^"]+)"/g)) written.add(m[1]!);
    expect(written.size).toBeGreaterThan(0);
    const listed = new Set<string>(CODECAST_HOOK_SCRIPTS);
    for (const name of written) expect(listed.has(name)).toBe(true);
    // The only listed script index.ts does not install is the stable feed.
    for (const name of listed) expect(written.has(name) || name === STABLE_FEED_HOOK_FILE).toBe(true);
  });

  test("stableContext.ts derives its hook file name from the shared list", () => {
    expect(stableSrc).toContain("STABLE_FEED_HOOK_FILE");
    expect(stableSrc).not.toMatch(/"stable-feed\.sh"/);
    expect(STABLE_FEED_HOOK_FILE).toBe("stable-feed.sh");
  });

  test("index.ts uses the shared orchestration names", () => {
    expect(indexSrc).toContain("ORCH_MARKER");
    expect(indexSrc).not.toContain('const ORCH_MARKER = "/.codecast/orchestration/"');
    expect(indexSrc).toContain("ORCH_AGENT_FILES");
    expect(indexSrc).toContain("ORCH_SKILL_REL");
    expect(ORCH_MARKER).toBe("/.codecast/orchestration/");
    expect([...ORCH_AGENT_FILES]).toEqual(["implementer.md", "reviewer.md", "critic.md"]);
    expect(ORCH_SKILL_REL).toBe(".claude/skills/codecast-orchestrate");
  });
});

describe("isCodecastHookCommand", () => {
  test.each([
    "/Users/x/.claude/hooks/thread-state.sh",
    "/home/u/.claude/hooks/stable-feed.sh",
    "/home/u/.codecast/hooks/stable-feed-codex.sh",
    "~/.codecast/orchestration/scripts/agent-complete.sh",
    "/home/u/.claude/hooks/codecast-status.sh --quiet",
  ])("%s is codecast's", (cmd) => {
    expect(isCodecastHookCommand(cmd, "/home/u")).toBe(true);
  });

  test.each([
    "/Users/x/.claude/hooks/my-formatter.sh",
    "/Users/x/.claude/hooks/thread-state-mine.sh",
    "npx prettier --write",
    "",
  ])("%s is the user's", (cmd) => {
    expect(isCodecastHookCommand(cmd, "/Users/x")).toBe(false);
  });

  test("a missing command is nobody's", () => {
    expect(isCodecastHookCommand(undefined)).toBe(false);
  });
});

describe("isCodecastOwnedHomePath", () => {
  test("owned paths and their children are owned; siblings are not", () => {
    expect(isCodecastOwnedHomePath(".claude/skills/codecast-orchestrate/SKILL.md")).toBe(true);
    expect(isCodecastOwnedHomePath(".claude/agents/reviewer.md")).toBe(true);
    expect(isCodecastOwnedHomePath(".claude/hooks/task-pulse.sh")).toBe(true);
    expect(isCodecastOwnedHomePath(".codecast/hooks/stable-feed-codex.sh")).toBe(true);
    expect(isCodecastOwnedHomePath(".claude/skills/my-skill/SKILL.md")).toBe(false);
    expect(isCodecastOwnedHomePath(".claude/agents/mine.md")).toBe(false);
    expect(isCodecastOwnedHomePath(".claude/hooks/mine.sh")).toBe(false);
    expect(isCodecastOwnedHomePath(".claude/skills/codecast-orchestrate-fork/SKILL.md")).toBe(false);
  });

  test("the table covers the five hooks, the skill, the three agents and .codecast", () => {
    expect(CODECAST_OWNED_HOME_PATHS).toContain(".codecast");
    expect(CODECAST_OWNED_HOME_PATHS.filter((p) => p.startsWith(".claude/hooks/"))).toHaveLength(5);
    expect(CODECAST_OWNED_HOME_PATHS.filter((p) => p.startsWith(".claude/agents/"))).toHaveLength(3);
  });
});
