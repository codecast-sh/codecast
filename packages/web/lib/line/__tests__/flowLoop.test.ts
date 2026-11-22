import { describe, expect, test } from "bun:test";
import { flowLoop } from "../flowLoop";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const flow = (slug: string, takes: string[], stations: Array<{ id: string; kind: string }>) => ({ slug, label: slug[0].toUpperCase() + slug.slice(1), takes, stations }) as any;
const library = [
  { ...flow("change", ["branch", "task"], [{ id: "check", kind: "segment" }]), uses: ["check", "review", "judge", "decide", "ship", "deploy"] },
  flow("judge", ["branch"], [{ id: "judge", kind: "call" }]),
  flow("onefix", ["task"], [{ id: "build", kind: "agent" }, { id: "triage", kind: "agent" }, { id: "decide", kind: "person" }]),
  flow("check", ["branch"], [{ id: "verify", kind: "script" }]),
  flow("review", ["branch"], [{ id: "review", kind: "agent" }]),
  flow("decide", ["branch"], [{ id: "decide", kind: "person" }]),
];
const map = {
  lanes: [{ key: "onefix", steps: [{ id: "build", running: 3, stalled: 1, waiting: 0 }, { id: "decide", running: 0, stalled: 0, waiting: 2 }] }],
  sources: [{ key: "a", label: "Errors", today: 5, state: "flowing", route: "onefix" }, { key: "b", label: "Judge", today: 0, state: "stopped", route: "unfiled" }],
  liveFlow: { queued: 13038 }, header: { problemsOpen: 40, watching: 3, regressed: 1, decisionsForYou: 2, decisionsForTeam: 5 },
  shipped: [{ reopenedBy: { source: "a" } }, { reopenedBy: null }],
} as any;
const run = (id: string, slug: string, status: string, node: string) => ({ _id: id, status, workflow_slug: slug, current_node_id: node });

describe("the whole loop", () => {
  const loop = flowLoop({
    map, library, now: NOW, queued: 4,
    owned: [{ merge: true, projects: [{}, {}] }, { merge: false, projects: [{}] }] as any,
    runs: [run("1", "change", "running", "review__review"), run("2", "change", "paused", "decide__decide"), run("3", "change", "running", "ship__rebase"), run("4", "onefix", "running", "build"), run("5", "change", "completed", "deploy")],
    deploys: [{ status: "live", live_at: NOW - 1000, created_at: NOW - 2000 }, { status: "failed", created_at: NOW - 1000 }, { status: "building", created_at: NOW - 500 }, { status: "live", live_at: NOW - 3 * 86_400_000, created_at: NOW - 3 * 86_400_000 }],
  });

  test("the rules: sources, owners, prompts in the live flows, checks and person gates, how many roles merge on their own", () => {
    expect(loop.rules).toEqual({ sources: { feeds: 1, silent: 1, unfiled: 1 }, owners: { roles: 2, projects: 3 }, skills: { prompts: 2 }, gates: { checks: 3, people: 1 }, autonomy: { merging: 1, roles: 2 } });
  });

  test("the two ways in: a person's change on a flow that takes a branch, the line on its lanes", () => {
    expect(loop.person).toEqual({ running: 2, waiting: 1 });
    expect(loop.line).toEqual({ running: 3, waiting: 2, stalled: 1 });
    expect(loop.problems).toEqual({ open: 40, queued: 4 });
  });

  test("the shared checks count the runs standing in them; a person's gate is marked", () => {
    // In the order the Change flow runs them, a new judge with them; landing and deploying are not checks.
    expect(loop.checks.map((c) => [c.slug, c.person, c.at, c.waiting])).toEqual([["check", false, 0, 0], ["review", false, 1, 0], ["judge", false, 0, 0], ["decide", true, 1, 1]]);
  });

  test("ship and watch, and what comes back", () => {
    expect(loop.ship).toEqual({ landing: 1, going: 1, liveToday: 1, failedToday: 1, watching: 3 });
    expect(loop.back).toEqual({ regressed: 1, reopened: 1 });
    expect(loop.decisions).toEqual({ you: 2, team: 5 });
  });
});
