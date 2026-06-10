// Regression guard for project skills vanishing from Codecast's `/` autocomplete.
//
// A project skill at <project>/.claude/skills/<name>/SKILL.md with only `name`
// + `description` frontmatter (e.g. mac-remote) shows in the native Claude Code
// `/` menu — because CC's default is `user-invocable: true`. The daemon's skill
// scanner originally inverted this: it REQUIRED an opt-in `user_invocable: true`
// flag and silently dropped every skill without it, so such skills never reached
// the compose box. readAvailableSkills now mirrors CC: surface by default, hide
// only on an explicit `user-invocable: false`. These tests pin that contract.

import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readAvailableSkills } from "./daemon.js";

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skills-invocable-"));

function writeSkill(name: string, frontmatter: string, manifest = "SKILL.md"): void {
  const dir = path.join(projectRoot, ".claude", "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, manifest), `---\n${frontmatter}\n---\n\nbody\n`);
}

// Default: name + description only, no invocable flag (the mac-remote shape).
writeSkill("mac-remote", "name: mac-remote\ndescription: Connect to the remote Mac");
// Lowercase manifest filename — works on a case-insensitive FS but must also be
// found case-sensitively (the user's mac-remote/skill.md was lowercase).
writeSkill("lower-case", "name: lower-case\ndescription: Lowercase manifest", "skill.md");
// Explicit opt-out via CC's real hyphenated field — must be hidden.
writeSkill("bg-knowledge", "name: bg-knowledge\ndescription: Reference only\nuser-invocable: false");
// Legacy opt-in spelling still works (back-compat with the old flag).
writeSkill("legacy-optin", "name: legacy-optin\ndescription: Old style\nuser_invocable: true");
// A plain project command alongside the skills.
const cmdDir = path.join(projectRoot, ".claude", "commands");
fs.mkdirSync(cmdDir, { recursive: true });
fs.writeFileSync(path.join(cmdDir, "deploy.md"), "---\ndescription: Deploy the app\n---\nrun it\n");

afterAll(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

describe("readAvailableSkills user-invocable default", () => {
  const byName = (projectPath?: string) =>
    new Map(readAvailableSkills(projectPath).map((s) => [s.name, s.description]));

  test("a skill with no invocable flag surfaces by default (matches Claude Code)", () => {
    const skills = byName(projectRoot);
    expect(skills.has("mac-remote")).toBe(true);
    expect(skills.get("mac-remote")).toBe("Connect to the remote Mac");
  });

  test("a lowercase skill.md manifest is still discovered (case-insensitive)", () => {
    expect(byName(projectRoot).has("lower-case")).toBe(true);
  });

  test("user-invocable: false hides a skill from the menu", () => {
    expect(byName(projectRoot).has("bg-knowledge")).toBe(false);
  });

  test("legacy user_invocable: true still includes the skill", () => {
    expect(byName(projectRoot).has("legacy-optin")).toBe(true);
  });

  test("project commands are listed alongside skills", () => {
    const items = byName(projectRoot);
    expect(items.has("deploy")).toBe(true);
    expect(items.get("deploy")).toBe("Deploy the app");
  });

  test("without a project path, project-only skills are not surfaced", () => {
    // Global scan (~/.claude) must not see the throwaway project's skills.
    expect(byName(undefined).has("mac-remote")).toBe(false);
  });
});
