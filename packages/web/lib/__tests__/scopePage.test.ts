import { describe, expect, test } from "bun:test";
import { feedLinkIsServerOwned, feedStateTone, queryProblem, roleStanding, scopeQueryRef } from "../scopePage";

describe("scope page rules", () => {
  test("a standing agent is awake, needs you, or standing by; never done", () => {
    expect(roleStanding("working")?.label).toBe("awake");
    expect(roleStanding("needs_input")?.label).toBe("needs you");
    expect(roleStanding("done")?.label).toBe("standing by");
    expect(roleStanding("dormant")?.label).toBe("standing by");
    expect(roleStanding(undefined)).toBeNull();
  });

  test("only a blocked session or a pending decision gets the needs input colour", () => {
    expect(feedStateTone("session", "needs_input")).toBe("var(--sol-yellow)");
    expect(feedStateTone("decision", "pending")).toBe("var(--sol-yellow)");
    expect(feedStateTone("task", "open")).not.toBe("var(--sol-yellow)");
    expect(feedStateTone("task", "in_review")).not.toBe("var(--sol-yellow)");
    expect(feedStateTone("task", "in_progress")).toBe("var(--sol-green)");
    expect(feedStateTone("task", "done")).toBe("var(--sol-cyan)");
  });

  test("published pages leave the SPA; app routes stay in it", () => {
    expect(feedLinkIsServerOwned("/a/some-slug")).toBe(true);
    expect(feedLinkIsServerOwned("/tasks/ct-12")).toBe(false);
    expect(feedLinkIsServerOwned("/commit/o/r/abc")).toBe(false);
    expect(feedLinkIsServerOwned("/questions?s=x")).toBe(false);
  });

  test("an empty role scope reads the whole workspace, like the root", () => {
    const role = { _id: "r1", scope: { project_ids: [], plan_ids: [] } };
    expect(scopeQueryRef(role, ["p1", "p2"], "t1")).toEqual({ scope: { project_ids: ["p1", "p2"], plan_ids: [] }, team_id: "t1" });
    expect(scopeQueryRef({ _id: "r2", scope: { project_ids: ["p1"], plan_ids: [] } }, ["p1", "p2"], "t1")).toEqual({ role_id: "r2" });
    expect(scopeQueryRef(null, ["p1"], undefined)).toEqual({ scope: { project_ids: ["p1"], plan_ids: [] } });
  });

  test("a failed query becomes one line, not a skeleton", () => {
    expect(queryProblem(undefined, false, "The feed")).toBeNull();
    expect(queryProblem(new Error("Could not find public function"), true, "The feed")).toBe("The feed is not available on this backend yet.");
    expect(queryProblem(new Error("[Request ID: abc] Server Error\nboom\nstack"), false, "The brief")).toBe("The brief did not load: boom");
  });
});
