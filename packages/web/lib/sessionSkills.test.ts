import { test, expect, describe } from "bun:test";
import { resolveSessionSkills } from "./sessionSkills";

const map = JSON.stringify({
  global: [{ name: "peon-ping-toggle", description: "toggle" }],
  "/Users/me/proj": [{ name: "mac-remote", description: "Connect to the remote Mac" }],
});

describe("resolveSessionSkills", () => {
  test("merges global + project skills for the matching project, plus built-ins", () => {
    const names = resolveSessionSkills({
      availableSkills: map,
      projectPath: "/Users/me/proj",
      agentType: "claude_code",
    }).map((s) => s.name);
    expect(names).toContain("mac-remote"); // project-scoped
    expect(names).toContain("peon-ping-toggle"); // global
    expect(names).toContain("clear"); // built-in command
  });

  test("project skills do not leak to other/absent projects (only global + built-ins)", () => {
    const names = resolveSessionSkills({ availableSkills: map }).map((s) => s.name);
    expect(names).not.toContain("mac-remote");
    expect(names).toContain("peon-ping-toggle");
  });

  test("a skill shadowing a built-in name appears once, keeping the skill's description", () => {
    const out = resolveSessionSkills({
      availableSkills: JSON.stringify({ global: [{ name: "clear", description: "custom clear" }] }),
    });
    const clears = out.filter((s) => s.name.toLowerCase() === "clear");
    expect(clears).toHaveLength(1);
    expect(clears[0].description).toBe("custom clear");
  });

  test("legacy flat-array form is honored", () => {
    const names = resolveSessionSkills({
      availableSkills: JSON.stringify([{ name: "foo", description: "bar" }]),
    }).map((s) => s.name);
    expect(names).toContain("foo");
  });

  test("missing or malformed available_skills falls back to built-ins without throwing", () => {
    expect(resolveSessionSkills({}).map((s) => s.name)).toContain("compact");
    expect(resolveSessionSkills({ availableSkills: "not json{" }).map((s) => s.name)).toContain("clear");
  });

  test("agent type selects the right built-in set", () => {
    const gemini = resolveSessionSkills({ agentType: "gemini" }).map((s) => s.name);
    expect(gemini).toContain("compress"); // gemini-only built-in
    expect(gemini).not.toContain("compact"); // claude/codex built-in
  });
});
