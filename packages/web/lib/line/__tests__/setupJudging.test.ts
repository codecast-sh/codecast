import { describe, expect, test } from "bun:test";
import { WRONG_CASES_SHOWN, judgingSetupPlace, judgingSetupPrompt } from "../setupJudging";

describe("set up judging (learning-loop.md LL4)", () => {
  test("a whole project: names it by short id and points at the pass", () => {
    const p = judgingSetupPrompt({ title: "Agent Quality", short_id: "pr-7" });
    expect(p).toContain("Set up judging for Agent Quality (pr-7)");
    expect(p).toContain("`cast line judging --project pr-7`");
    expect(p).toContain("bring one card");
    expect(p).not.toContain("--judge");
  });

  test("a project with no short id is quoted by title", () => {
    expect(judgingSetupPrompt({ title: "Agent Quality" })).toContain('--project "Agent Quality"');
  });

  test("one judge: starts from it and carries the cases marked wrong, capped", () => {
    const wrong = Array.from({ length: WRONG_CASES_SHOWN + 3 }, (_, i) => ({ ref: `mo-${i}`, note: i === 0 ? "the reply did go out" : null }));
    const p = judgingSetupPrompt({ title: "Union", short_id: "pr-2" }, { judge: "comms", wrong });
    expect(p).toContain("Improve the judge comms for Union (pr-2)");
    expect(p).toContain("--judge comms");
    expect(p).toContain("- mo-0: the reply did go out");
    expect(p).toContain("- mo-1\n");
    expect(p).toContain("- and 3 more");
  });

  test("runs where the line profile was published, else the project's folder anywhere", () => {
    expect(judgingSetupPlace({ project_path: "/p", line_profile: { root: "/host/repo", device_id: "d1" } })).toEqual({ projectPath: "/host/repo", targetDeviceId: "d1" });
    expect(judgingSetupPlace({ project_path: "/p", line_profile: null })).toEqual({ projectPath: "/p" });
    expect(judgingSetupPlace(undefined)).toEqual({});
  });
});
