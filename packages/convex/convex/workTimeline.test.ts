import { describe, expect, test } from "bun:test";
import schema from "./schema";
import { makeFakeDb, schemaIndexes } from "./testDb";
import { since } from "./workTimeline";

const h = (fn: any) => fn._handler;
const WS = "team:team_1";
const TEAM = { workspace: "team" as const, team_id: "team_1" as any };

function world(tasks: any[]) {
  const db = makeFakeDb(
    {
      users: [{ _id: "u1", name: "Cam", active_team_id: "team_1" }],
      teams: [{ _id: "team_1", name: "Union" }],
      team_memberships: [{ _id: "m1", user_id: "u1", team_id: "team_1" }],
      projects: [{ _id: "p1", title: "People & Deals", workspace: WS }],
      conversations: [],
      tasks,
    },
    { indexes: schemaIndexes(schema as any) },
  );
  return { as: (userId: string) => ({ auth: { getUserIdentity: async () => ({ subject: `${userId}|sess` }) }, db }) as any };
}

const task = (id: string, o: Record<string, any>) => ({
  _id: id, workspace: WS, short_id: `ct-${id}`, title: `Task ${id}`, user_id: "u1", status: "open", created_at: 100, updated_at: 100, ...o,
});

describe("workTimeline.since", () => {
  test("tasks opened and closed, the line's problems only when fixed, changes landed, nothing from another workspace", async () => {
    const w = world([
      task("1", { created_at: 200, updated_at: 210, project_id: "p1", source: "manual" }),
      task("2", { created_at: 150, updated_at: 300, status: "done", closed_at: 300 }),
      // The line's problems: one fixed, one opened, one dropped.
      task("3", { source: "signal", cause: {}, created_at: 220, updated_at: 320, status: "done", closed_at: 320 }),
      task("4", { source: "signal", cause: {}, created_at: 230, updated_at: 230 }),
      task("5", { source: "signal", cause: {}, created_at: 240, updated_at: 330, status: "dropped", closed_at: 330 }),
      // Bookkeeping and untriaged rows stay out.
      task("6", { created_at: 250, updated_at: 250, ephemeral: true }),
      task("7", { created_at: 260, updated_at: 260, triage_status: "suggested" }),
      task("8", { created_at: 120, updated_at: 400, status: "done", closed_at: 390, landed: { sha: "abcdef1234567", at: 395, url: "u", repository: "union-ai/union-mobile", branch: "main" } }),
      { ...task("9", { created_at: 270, updated_at: 270 }), workspace: "team:other" },
    ]);
    const res = await h(since)(w.as("u1"), { ...TEAM, after: 0, floor: 140 });
    expect(res.events.map((e: any) => [e.kind, e.task.short_id, e.detail ?? null])).toEqual([
      ["task_opened", "ct-2", null],
      ["task_opened", "ct-1", null],
      ["task_closed", "ct-2", "fixed"],
      ["task_closed", "ct-3", "fixed"],
      ["task_closed", "ct-8", "fixed"],
      ["change_landed", "ct-8", "abcdef1234"],
    ]);
    expect(res.events[1]).toMatchObject({ by: "Cam", task: { project: "People & Deals", title: "Task 1" } });
    expect(res.events[5]).toMatchObject({ repository: "union-ai/union-mobile" });
    expect(res.cursor).toBe(400);
    expect(res.landed_cursor).toBe(395);
    expect(res.digest).toBeUndefined();
  });

  test("a full page reads through its last millisecond, so a tie larger than the page is neither skipped nor read forever", async () => {
    const w = world([
      ...[1, 2, 3].map((n) => task(String(n), { created_at: 500, updated_at: 500 })),
      task("4", { created_at: 600, updated_at: 600 }),
    ]);
    const first = await h(since)(w.as("u1"), { ...TEAM, after: 0, floor: 0, limit: 2 });
    expect(first.events.map((e: any) => e.task.short_id)).toEqual(["ct-1", "ct-2", "ct-3"]);
    expect(first.cursor).toBe(500);
    const next = await h(since)(w.as("u1"), { ...TEAM, after: first.cursor, floor: 0, limit: 2 });
    expect(next.events.map((e: any) => e.task.short_id)).toEqual(["ct-4"]);
    expect(next.cursor).toBe(600);
  });

  test("landings page by their own cursor and the page limit, so a window of many landings never grows a page", async () => {
    const landed = (n: number, at: number) => task(`L${n}`, { created_at: 10, updated_at: 10, status: "done", closed_at: 10, landed: { sha: `sha${n}xxxxxxxx`, at, url: "u", repository: "r", branch: "main" } });
    // 75 landings, three of them in one millisecond at the first page's edge.
    const w = world(Array.from({ length: 75 }, (_, i) => landed(i, 1000 + (i >= 9 && i <= 11 ? 9 : i))));
    const seen: string[] = [];
    let after = 0, landedAfter: number | undefined, pages = 0;
    for (;;) {
      const res = await h(since)(w.as("u1"), { ...TEAM, after, landed_after: landedAfter, floor: 500, limit: 10 });
      const landings = res.events.filter((e: any) => e.kind === "change_landed");
      expect(landings.length).toBeLessThanOrEqual(12);
      if (!landings.length) break;
      seen.push(...landings.map((e: any) => e.id));
      after = res.cursor;
      landedAfter = res.landed_cursor;
      pages++;
    }
    expect(new Set(seen).size).toBe(75);
    expect(seen.length).toBe(75);
    expect(pages).toBe(8);
  });

  test("the digest: what is in progress by project, and how many problems the line opened since its time", async () => {
    const w = world([
      task("1", { status: "in_progress", project_id: "p1", updated_at: 50 }),
      task("2", { status: "in_progress", project_id: "p1", source: "signal", cause: {}, updated_at: 50 }),
      task("3", { status: "in_progress", updated_at: 50 }),
      task("4", { source: "signal", cause: {}, created_at: 600, updated_at: 600 }),
      task("5", { source: "signal", cause: {}, created_at: 300, updated_at: 600 }),
    ]);
    const res = await h(since)(w.as("u1"), { ...TEAM, after: 0, floor: 0, digest_since: 500 });
    expect(res.digest).toEqual({
      in_progress: [{ project: "People & Deals", count: 2, titles: ["Task 1"] }, { project: "No project", count: 1, titles: ["Task 3"] }],
      problems_opened: 1,
    });
  });

  test("an outsider reads nothing", async () => {
    const w = world([task("1", { created_at: 200, updated_at: 200 })]);
    await expect(h(since)(w.as("u_stranger"), { ...TEAM, after: 0, floor: 0 })).rejects.toThrow();
  });
});
