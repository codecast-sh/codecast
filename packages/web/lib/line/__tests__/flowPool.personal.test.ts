// The Ship picker in a personal workspace (lib/line/flowPool.ts shipPicks, RunThroughFlow PoolPicker): a session no
// team shares shows `personal`, labelled Ship, as its default, and its press asks for `cast flow run change`, which the
// CLI resolves to personal only where the directory is established as personal (cli directoryTeam.ts). A repository's
// own `change` still wins. A team session's picker is unchanged.
import { describe, expect, test } from "bun:test";
import { PERSONAL_FLOW_SLUG } from "@codecast/shared/contracts/flowPool";
import type { RepoFlow } from "@codecast/shared/contracts/repoFlows";
import { appPool, previewsPersonal, shipPicks, type AppFlow } from "../flowPool";
import { runThroughMessage } from "../flowMessages";
import { sessionWorkspaceOf } from "../../../hooks/useRepoFlows";

/** The shipped pool with the personal Ship in it: the library's own once its snapshot carries it, else a stand-in of
 *  its shape (a whole line labelled Ship that takes a session's change). */
function shippedPool(repo: RepoFlow[] = []): AppFlow[] {
  const pool = appPool([], repo);
  if (pool.some((f) => f.slug === PERSONAL_FLOW_SLUG)) return pool;
  const change = appPool([]).find((f) => f.slug === "change")!;
  return [...pool, { ...change, slug: PERSONAL_FLOW_SLUG, name: PERSONAL_FLOW_SLUG, label: "Ship", where: "shipped" }];
}

const repoChange: RepoFlow = {
  slug: "change", name: "change", kind: "line", label: "Change", description: null, takes: ["task", "branch"],
  nodes: [
    { id: "start", label: "start", type: "start", shape: "Mdiamond" },
    { id: "review", label: "Review", type: "agent", shape: "box" },
    { id: "exit", label: "Live", type: "exit", shape: "Msquare" },
  ],
  edges: [{ from: "start", to: "review" }, { from: "review", to: "exit" }],
};

describe("the Ship picker's default", () => {
  const store = { currentUser: { _id: "u1" }, conversations: { cTeam: { team_id: "t1" }, cMine: {} } };
  const personalOf = (conversation: string) => previewsPersonal(sessionWorkspaceOf(store, conversation), "o/repo", false);

  test("only a session no team shares, in a checkout with an origin, previews the personal Ship: the CLI lands nothing personal without one", () => {
    expect([previewsPersonal(sessionWorkspaceOf(store, "cMine"), "o/repo", false), previewsPersonal(sessionWorkspaceOf(store, "cMine"), null, false), previewsPersonal(sessionWorkspaceOf(store, "cTeam"), "o/repo", false)]).toEqual([true, false, false]);
  });

  test("a repository one of the person's teams knows previews the team's flow, as the CLI runs it; so does the answer still loading", () => {
    expect([previewsPersonal(sessionWorkspaceOf(store, "cMine"), "o/repo", true), previewsPersonal(sessionWorkspaceOf(store, "cMine"), "o/repo", undefined)]).toEqual([false, false]);
  });

  test("a session no team shares defaults to personal, labelled Ship, with no second Ship beside it", () => {
    expect(personalOf("cMine")).toBe(true);
    const { pool, fallback } = shipPicks(shippedPool(), null, null, personalOf("cMine"));
    expect(fallback?.slug).toBe(PERSONAL_FLOW_SLUG);
    expect(fallback?.label).toBe("Ship");
    expect(pool[0]).toBe(fallback);
    expect(pool.map((f) => f.slug)).not.toContain("change");
  });

  test("its press asks for change, labelled Ship, and leaves the CLI to resolve it", () => {
    const { fallback } = shipPicks(shippedPool(), null, null, true);
    const press = runThroughMessage(fallback!);
    expect(press).toContain("Run your change through the Ship flow");
    expect(press).toContain("`cast flow run change --title");
    expect(press).not.toContain("cast flow run personal");
  });

  test("a repository's own change still wins in a personal session", () => {
    const { fallback } = shipPicks(shippedPool([repoChange]), "jb/tweet-only", null, true);
    expect(fallback?.slug).toBe("change");
    expect(fallback?.where).toBe("repo");
    expect(runThroughMessage(fallback!)).toContain("`cast flow run change --title");
  });

  test("a repository's own change leaves no personal Ship beside it in a personal session", () => {
    const { pool } = shipPicks(shippedPool([repoChange]), "jb/tweet-only", null, true);
    expect(pool.map((f) => f.slug)).not.toContain(PERSONAL_FLOW_SLUG);
  });

  test("a team's published flow named personal never stands in for the shipped one, and a team session offers neither", () => {
    const row = {
      _id: "w-tp", slug: PERSONAL_FLOW_SLUG, name: "personal", workspace: "team:t1",
      source: `digraph personal { graph [kind="line", label="Team personal", takes="task,branch"] }`,
      nodes: [{ id: "start", label: "Start", type: "start", shape: "Mdiamond" }, { id: "go", label: "Go", type: "agent", shape: "box" }],
      edges: [{ from: "start", to: "go" }],
    };
    expect(appPool([row]).find((f) => f.slug === PERSONAL_FLOW_SLUG)?.where).toBe("shipped");
    const { pool } = shipPicks(appPool([row]), null, null, false);
    expect(pool.some((f) => f.slug === PERSONAL_FLOW_SLUG)).toBe(false);
  });

  test("a team session is unchanged: change is the default, and personal is not offered", () => {
    expect(personalOf("cTeam")).toBe(false);
    const { pool, fallback } = shipPicks(shippedPool(), null, null, personalOf("cTeam"));
    expect(fallback?.slug).toBe("change");
    expect(pool.map((f) => f.slug)).not.toContain(PERSONAL_FLOW_SLUG);
  });
});
