import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkState } from "@codecast/shared/contracts";
import { HAND_GROUPS, boundTaskOf, feedLinkIsServerOwned, feedStateTone, groupHands, queryProblem, roleStanding, scopeQueryRef, subtaskCounts, tokensUncounted } from "../scopePage";
import { ORG_STATE_META } from "../../components/org/orgMeta";

describe("scope page rules", () => {
  test("a standing agent is awake, needs you, or standing by; never done", () => {
    expect(roleStanding("working")?.label).toBe("awake");
    expect(roleStanding("needs_input")?.label).toBe("needs you");
    expect(roleStanding("done")?.label).toBe("standing by");
    expect(roleStanding("dormant")?.label).toBe("standing by");
    expect(roleStanding(undefined)).toBeNull();
  });

  test("the role's stripe colour is the org node's colour for the same state", () => {
    for (const state of ["working", "needs_input", "dormant", "done", "idle"] as const) {
      expect(roleStanding(state)?.color).toBe(ORG_STATE_META[state].color);
    }
  });

  test("tokens read uncounted only when every session runs off the Claude backend", () => {
    expect(tokensUncounted({ tokens: 0, uncounted: 2, sessions: 2 })).toBe(true);
    expect(tokensUncounted({ tokens: 0, uncounted: 1, sessions: 2 })).toBe(false);
    expect(tokensUncounted({ tokens: 1200, uncounted: 2, sessions: 2 })).toBe(false);
    expect(tokensUncounted({ tokens: 0, uncounted: 0, sessions: 1 })).toBe(false);
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

// ---------------------------------------------------------------- F4: the scope is a conversation

describe("the panel answers who acts next (F4.3)", () => {
  const hand = (id: string, state: WorkState, age: number) => ({ _id: id, state, updated_at: 1_000_000 - age });

  test("hands group in the inbox's order and an empty group is dropped", () => {
    const rows = [
      hand("w1", "working", 10), hand("d1", "done", 50), hand("n1", "needs_input", 30),
      hand("p1", "dormant", 5), hand("w2", "working", 60), hand("i1", "idle", 1),
    ];
    const groups = groupHands(rows);
    expect(groups.map((g) => g.label)).toEqual(["Needs input", "Done", "Working", "Dormant", "Idle"]);
    expect(groups.map((g) => g.rows.length)).toEqual([1, 1, 2, 1, 1]);
    expect(groupHands([hand("w1", "working", 1)]).map((g) => g.state)).toEqual(["working"]);
    expect(groupHands([])).toEqual([]);
  });

  test("a queue a person clears reads oldest first; the rest freshest first", () => {
    const rows = [hand("n-new", "needs_input", 1), hand("n-old", "needs_input", 90), hand("w-old", "working", 90), hand("w-new", "working", 1)];
    const byState = Object.fromEntries(groupHands(rows).map((g) => [g.state, g.rows.map((r) => r._id)]));
    expect(byState.needs_input).toEqual(["n-old", "n-new"]);
    expect(byState.working).toEqual(["w-new", "w-old"]);
  });

  test("each group paints the org's colour for its state", () => {
    for (const g of groupHands(HAND_GROUPS.map((h, i) => hand(`h${i}`, h.state, i)))) expect(g.color).toBe(ORG_STATE_META[g.state].color);
  });

  test("the group order is the inbox's rendered order", () => {
    // GlobalSessionPanel renders its status sections top down as "who acts
    // next"; the panel must not restate that order differently.
    const src = readFileSync(join(import.meta.dir, "../../components/GlobalSessionPanel.tsx"), "utf8");
    const rendered = [...src.matchAll(/renderSection\("(Needs Input|Done|Working|Dormant)"/g)].map((m) => m[1].toLowerCase());
    expect(rendered).toEqual(HAND_GROUPS.filter((g) => g.state !== "idle").map((g) => g.label.toLowerCase()));
    expect(HAND_GROUPS[HAND_GROUPS.length - 1].state).toBe("idle");
  });

  test("the bound task is the session's own pointer, else the task listing the session", () => {
    const tasks = [
      { _id: "t1", conversation_ids: ["c9"] },
      { _id: "t2", conversation_ids: ["c1", "c2"] },
    ];
    expect(boundTaskOf("c1", "t1", tasks)?._id).toBe("t1");
    expect(boundTaskOf("c1", null, tasks)?._id).toBe("t2");
    expect(boundTaskOf("c1", "t-gone", tasks)?._id).toBe("t2");
    expect(boundTaskOf("c7", null, tasks)).toBeNull();
  });

  test("subtask counts derive live and read nothing for a task without subtasks", () => {
    const tasks = [
      { _id: "p", status: "in_progress" },
      { _id: "s1", parent_id: "p", status: "done" },
      { _id: "s2", parent_id: "p", status: "open" },
      { _id: "s3", parent_id: "p", status: "in_review" },
      { _id: "s4", parent_id: "p", status: "dropped" },
      { _id: "x", parent_id: "other", status: "open" },
    ];
    expect(subtaskCounts("p", tasks)).toEqual({ open: 2, closed: 1 });
    expect(subtaskCounts("x", tasks)).toBeNull();
  });
});
