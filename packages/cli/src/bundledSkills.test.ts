// The bundle is what `cast install` writes, so the bundle is what gets checked:
// every skill parses as the capability inventory will parse it once installed,
// carries the identity the directory name gives it, and reaches every install
// path in index.ts. index.ts cannot be imported (it parses argv on load), so
// the wiring checks read it as text, the way codecastOwned.test.ts does.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BUNDLED_SKILLS, ORCHESTRATION_BUNDLE } from "./bundledSkills";
import { CODECAST_SKILL_NAMES, ORCH_AGENT_FILES, ORCH_MARKER } from "./codecastOwned";
import { parseSkillMd } from "./capabilities/manifests";
import { readInventoryAsyncLocal } from "./capabilities/inventory";

const indexSrc = fs.readFileSync(path.join(import.meta.dir, "index.ts"), "utf-8");
const skillsDir = path.join(import.meta.dir, "..", "skills");

describe("bundled skills", () => {
  test("every name in CODECAST_SKILL_NAMES is bundled, and nothing else is", () => {
    expect(BUNDLED_SKILLS.map((s) => s.name).sort()).toEqual([...CODECAST_SKILL_NAMES].sort());
  });

  test("each bundled body is the on-disk SKILL.md of the same name", () => {
    for (const skill of BUNDLED_SKILLS) {
      const onDisk = fs.readFileSync(path.join(skillsDir, skill.name, "SKILL.md"), "utf-8");
      expect(skill.body).toBe(onDisk);
    }
  });

  test("each skill parses cleanly with the directory name as its identity", () => {
    for (const skill of BUNDLED_SKILLS) {
      const obs = parseSkillMd(skill.body, skill.name);
      expect(obs.issues).toEqual([]);
      expect(obs.portable.name).toBe(skill.name);
      expect(obs.portable.description?.length ?? 0).toBeGreaterThan(40);
      expect(obs.portable.description?.length ?? 0).toBeLessThanOrEqual(1024);
      // Progressive disclosure keeps the body small: agentskills.io says under 500 lines.
      expect(skill.body.split("\n").length).toBeLessThan(500);
    }
  });

  test("the orchestration bundle carries every agent file and every hook command points at the marker", () => {
    expect(Object.keys(ORCHESTRATION_BUNDLE.agents).sort()).toEqual([...ORCH_AGENT_FILES].sort());
    expect(ORCHESTRATION_BUNDLE.skill).toContain("name: orchestrate");
    const commands = Object.values(ORCHESTRATION_BUNDLE.hooks).flat().flatMap((e) => e.hooks.map((h) => h.command));
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).toContain(ORCH_MARKER);
      const script = command.split(ORCH_MARKER)[1]?.replace(/^scripts\//, "").split(" ")[0];
      expect(Object.keys(ORCHESTRATION_BUNDLE.scripts)).toContain(script);
    }
  });
});

describe("index.ts installs from the bundle", () => {
  test("the orchestration installer reads the bundle, never a path beside the binary", () => {
    const body = indexSrc.slice(indexSrc.indexOf("function installOrchestration("), indexSrc.indexOf("function installCodecastSkills("));
    expect(body).toContain("ORCHESTRATION_BUNDLE");
    expect(body).not.toContain('path.resolve(__dirname, "..", "orchestration")');
  });

  test("skills ride onboarding, the wizard and every refresh; a single-slug install leaves them alone", () => {
    const calls = indexSrc.match(/\binstallCodecastSkills\(/g)?.length ?? 0;
    // definition + onboarding + refresh + wizard/--all
    expect(calls).toBe(4);
    const onboarding = indexSrc.slice(indexSrc.indexOf("async function runOnboarding("), indexSrc.indexOf("async function runOnboarding(") + 400);
    expect(onboarding).toContain("installCodecastSkills()");
    const refresh = indexSrc.slice(indexSrc.indexOf("async function refreshEnabledSnippets("), indexSrc.indexOf("function uninstallOrchestration("));
    expect(refresh).toContain("installCodecastSkills()");
    // The single-slug branch returns before the wizard loop; the call sits after the loop.
    const singleSlug = indexSrc.slice(indexSrc.indexOf("if (snippetArg) {"), indexSrc.indexOf("if (options.disable) {", indexSrc.indexOf("if (snippetArg) {")));
    expect(singleSlug).not.toContain("installCodecastSkills");
  });

  test("uninstall paths remove them", () => {
    expect(indexSrc.split("uninstallCodecastSkills()").length - 1).toBeGreaterThanOrEqual(3); // definition + --disable + cast uninstall
  });
});

describe("installed skills are what the daemon lists", () => {
  test("a home with the bundled skills written reports each one by directory name", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-bundled-skills-"));
    try {
      for (const skill of BUNDLED_SKILLS) {
        const dir = path.join(home, ".claude", "skills", skill.name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "SKILL.md"), skill.body);
      }
      const inventory = await readInventoryAsyncLocal(home);
      const names = inventory.items.filter((i) => i.kind === "skill").map((i) => i.name);
      for (const skill of BUNDLED_SKILLS) expect(names).toContain(skill.name);
      expect(inventory.unreadable).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
