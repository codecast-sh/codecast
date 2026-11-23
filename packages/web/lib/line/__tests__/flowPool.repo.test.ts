// A repository's own flows in the pool (lib/line/flowPool.ts appPool, convex repoFlows.ts): they come first and
// override a shipped or published flow of the same slug, as `cast flow run` resolves them in that repository, so the
// Ship picker draws the flow its press runs.
import { describe, expect, test } from "bun:test";
import type { RepoFlow } from "@codecast/shared/contracts/repoFlows";
import { appPool, namedForRepo } from "../flowPool";
import { sessionWorkspaceOf } from "../../../hooks/useRepoFlows";
import { workspaceRows } from "../../../hooks/useWorkspaceCollection";

// A repository's `change`: PR, then CI and a review side by side, then merge, with the session fixing what they find.
const repoChange: RepoFlow = {
  slug: "change", name: "change", kind: "line", label: "Change", description: "PR, CI and review side by side", takes: ["task", "branch"],
  nodes: [
    { id: "start", label: "start", type: "start", shape: "Mdiamond" },
    { id: "pr", label: "PR", type: "command", shape: "parallelogram" },
    { id: "checks", label: "CI and review", type: "parallel_fanout", shape: "component" },
    { id: "ci", label: "CI", type: "command", shape: "parallelogram" },
    { id: "review", label: "Review", type: "agent", shape: "box", backend: "session" },
    { id: "read", label: "Read", type: "parallel_fanin", shape: "tripleoctagon" },
    { id: "brief", label: "Brief", type: "command", shape: "parallelogram" },
    { id: "fix", label: "Fix findings", type: "agent", shape: "box", backend: "subject", max_visits: 3 },
    { id: "merge", label: "Merge", type: "command", shape: "parallelogram" },
    { id: "exit", label: "Live", type: "exit", shape: "Msquare" },
  ],
  edges: [
    { from: "start", to: "pr" }, { from: "pr", to: "checks", condition: "outcome = success" },
    { from: "checks", to: "ci" }, { from: "checks", to: "review" }, { from: "ci", to: "read" }, { from: "review", to: "read" },
    { from: "read", to: "brief", condition: "review.json.verdict = changes", label: "findings" },
    { from: "read", to: "merge", condition: "ci.json.green = true", label: "green, approved" },
    { from: "brief", to: "fix" }, { from: "fix", to: "pr" }, { from: "merge", to: "exit", condition: "outcome = success" },
  ],
};

const team = (slug: string) => ({
  _id: `w-${slug}`, slug, name: slug, workspace: "team:t1", source: `digraph ${slug} { graph [kind="line", takes="task,branch"] }`,
  nodes: [{ id: "start", label: "Start", type: "start", shape: "Mdiamond" }, { id: "go", label: "Go", type: "agent", shape: "box" }],
  edges: [{ from: "start", to: "go" }],
});

describe("a repository's own flows in the pool", () => {
  test("the repository's change replaces the shipped one, first in the pool", () => {
    const pool = appPool([], [repoChange]);
    const changes = pool.filter((f) => f.slug === "change");
    expect(changes.map((f) => f.where)).toEqual(["repo"]);
    // Folded from the reported graph: its fork and branches are the repository's, not the shipped flow's.
    expect(changes[0].stations.filter((s) => s.main).map((s) => s.id)).toEqual(["pr", "checks", "ci", "review", "read", "merge"]);
    // The picker's default is the pool's `change`: now the repository's, which leads the pool.
    expect(pool[0]).toBe(changes[0]);
    expect(changes[0].takes).toContain("branch");
    // Every other shipped flow is still there.
    expect(pool.some((f) => f.slug === "quick-change" && f.where === "shipped")).toBe(true);
  });

  test("a published flow of the repository's slug stays out; one of another slug still joins", () => {
    const pool = appPool([team("change"), team("hotfix")], [repoChange]);
    expect(pool.filter((f) => f.slug === "change").map((f) => f.where)).toEqual(["repo"]);
    expect(pool.find((f) => f.slug === "hotfix")?.where).toBe("team");
  });

  test("with no repository flows the pool is the shipped and published ones, as before", () => {
    const pool = appPool([team("change")]);
    expect(pool.filter((f) => f.slug === "change").map((f) => f.where)).toEqual(["shipped"]);
    expect(pool.some((f) => f.where === "repo")).toBe(false);
  });

  test("the same rows give the same pool, and different repository flows a different one", () => {
    const rows = [team("hotfix")];
    expect(appPool(rows, [repoChange])).toBe(appPool(rows, [repoChange]));
    expect(appPool(rows, [repoChange])).not.toBe(appPool(rows, []));
  });
});

describe("the session's pool", () => {
  test("a repository flow that replaces a library flow carries the repository's name; the rest keep theirs", () => {
    const hotfix: RepoFlow = { ...repoChange, slug: "hotfix", name: "hotfix", label: "Hotfix" };
    const named = namedForRepo(appPool([], [repoChange, hotfix]), "acme/union-mobile");
    expect(named.find((f) => f.slug === "change")!.label).toBe("Change · union-mobile");
    expect(named.find((f) => f.slug === "hotfix")!.label).toBe("Hotfix");
    expect(named.find((f) => f.slug === "quick-change")!.label).toBe("Quick");
    // With the library's own change, nothing is renamed: it reads Ship.
    expect(namedForRepo(appPool([], []), "acme/union-mobile").find((f) => f.slug === "change")!.label).toBe("Ship");
  });

  test("a personal flow is in a personal session's pool and out of a team session's", () => {
    const shipNow = { ...team("ship-now"), _id: "w-ship-now", user_id: "u1", workspace: "user:u1" };
    const teamFlow = { ...team("hotfix"), user_id: "u2" };
    const store = {
      currentUser: { _id: "u1" },
      conversations: { cTeam: { team_id: "t1" }, cMine: {} },
      workflows: { [shipNow._id]: shipNow, [teamFlow._id]: teamFlow },
    };
    const poolOf = (conversation: string) => appPool(workspaceRows("workflows", store.workflows as any, sessionWorkspaceOf(store, conversation))).map((f) => f.slug);
    expect(sessionWorkspaceOf(store, "cTeam")).toBe("team:t1");
    expect(sessionWorkspaceOf(store, "cMine")).toBe("user:u1");
    expect(poolOf("cTeam")).toContain("hotfix");
    expect(poolOf("cTeam")).not.toContain("ship-now");
    expect(poolOf("cMine")).toContain("ship-now");
    expect(poolOf("cMine")).not.toContain("hotfix");
    // An unknown session names no workspace, and the reader falls back to the active one.
    expect(sessionWorkspaceOf(store, "nope")).toBeNull();
  });
});
