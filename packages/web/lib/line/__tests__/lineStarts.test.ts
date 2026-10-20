// Who starts work (lib/line/lineStarts): each role that leads a project with a line is one row, with its projects and their
// waiting and ready problems summed; the review of a change of limits names only what changes and what it starts.
import { describe, expect, test } from "bun:test";
import { limitsLedger, roleLines } from "../lineStarts";

const role = (id: string, handle: string, projects: string[], over: Record<string, unknown> = {}) => ({
  _id: id, short_id: `or-${id}`, scope_type: "team", host_user_id: "u", name: `${handle} lead`, handle, status: "active",
  scope: { project_ids: projects, plan_ids: [] }, reports_to: { kind: "user", user_id: "u" }, ...over,
}) as never;
const rollup = (key: string, ready: number, notReady: number) => ({ key, title: key, ready, notReady: notReady ? [{ count: notReady, words: "held" }] : [] }) as never;

describe("who starts work", () => {
  test("one row per role leading a line, its projects' problems summed; a project no role leads is not a row", () => {
    const rows = roleLines(
      [role("1", "calling", ["p1"]), role("2", "agent-quality", ["p2", "p3"])],
      [{ _id: "p1", title: "Callers" }, { _id: "p2", title: "AgentWatch" }, { _id: "p3", title: "Agent Quality" }] as never,
      [rollup("p1", 69, 39), rollup("p2", 100, 20), rollup("p3", 77, 24), rollup("p9", 3, 0)],
    );
    expect(rows.map((r) => [r.role.handle, r.projects.map((p) => p.title), r.waiting, r.ready])).toEqual([
      ["agent-quality", ["AgentWatch", "Agent Quality"], 221, 177],
      ["calling", ["Callers"], 108, 69],
    ]);
  });

  test("the limits review names the change, what the line then allows, and on a running line what starts at once", () => {
    const l = limitsLedger("@agent-quality · AgentWatch", 5, null, 20, null, true, 15, [{ k: "Cards", v: "5 → 20", tone: "warn" }]);
    expect(l.shift).toEqual(["5 · no limit", "20 · no limit"]);
    expect(l.figures.map((f) => [f.value, f.label])).toEqual([["20", "at a time"], ["∞", "sessions a day"], ["15", "start now"]]);
    expect(l.confirm).toBe("Set limits");
    // An off line starts nothing from new limits.
    expect(limitsLedger("@calling · Callers", 5, null, 20, 2, false, 2, []).figures.map((f) => f.label)).toEqual(["at a time", "sessions a day"]);
  });
});
