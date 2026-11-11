import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeFakeDb } from "../testDb";
import { projectTasks, projectProgress } from "./projectWork";
import { backfillProjectCountsPage } from "./projectTaskCounts";

// A project's tasks, as every server read of a project's work sees them:
// access from each row's workspace stamp, never from team_id.

const OWNER = "u".repeat(31) + "o";
const MATE = "u".repeat(31) + "m";
const TEAM = "teams_acme" as any;
const WS = `team:${TEAM}`;
const P = "projects_p" as any;

const db = () => makeFakeDb({
  users: [{ _id: OWNER }, { _id: MATE }],
  teams: [{ _id: TEAM }],
  team_memberships: [
    { _id: "m1", user_id: OWNER, team_id: TEAM, role: "member" },
    { _id: "m2", user_id: MATE, team_id: TEAM, role: "member" },
  ],
  projects: [{ _id: P, user_id: OWNER, team_id: TEAM, workspace: WS, title: "Growth", status: "active" }],
  tasks: [
    { _id: "tasks_shared", _creationTime: 1, user_id: OWNER, team_id: TEAM, workspace: WS, project_id: P, status: "open", source: "human", title: "shared" },
    // Routed to the team, readable by its owner only.
    { _id: "tasks_private", _creationTime: 2, user_id: OWNER, team_id: TEAM, workspace: `user:${OWNER}`, project_id: P, status: "done", source: "human", title: "private" },
  ],
});

describe("projectTasks", () => {
  test("a task routed to the team but keyed to its owner is the owner's alone", async () => {
    const titles = async (who: string) => (await projectTasks({ db: db() }, who as any, P)).map((t: any) => t.title).sort();
    expect(await titles(OWNER)).toEqual(["private", "shared"]);
    expect(await titles(MATE)).toEqual(["shared"]);
    // Progress reads project_task_counts, which the backfill fills from the seeded rows.
    const counted = db();
    await backfillProjectCountsPage({ db: counted }, 100);
    expect(await projectProgress({ db: counted }, MATE as any, P)).toEqual({ total: 1, done: 0, in_progress: 0, open: 1 });
    expect(await projectProgress({ db: counted }, OWNER as any, P)).toEqual({ total: 2, done: 1, in_progress: 0, open: 1 });
  });

  test("a bounded read stops at its limit, newest touched first, and never reads finished tasks", async () => {
    const BIG = "projects_big" as any;
    const row = (i: number, status: string, extra: Record<string, unknown> = {}) =>
      ({ _id: `tasks_${status}_${i}`, _creationTime: i, user_id: OWNER, team_id: TEAM, workspace: WS, project_id: BIG, status, source: "human", title: `${status} ${i}`, updated_at: i, ...extra });
    const real = makeFakeDb({
      users: [{ _id: OWNER }],
      teams: [{ _id: TEAM }],
      team_memberships: [{ _id: "m1", user_id: OWNER, team_id: TEAM, role: "member" }],
      projects: [{ _id: BIG, user_id: OWNER, team_id: TEAM, workspace: WS, title: "Big", status: "active" }],
      tasks: [
        ...Array.from({ length: 500 }, (_, i) => row(i, "done")),
        ...Array.from({ length: 200 }, (_, i) => row(1000 + i, "open", i % 2 ? { triage_status: "suggested" } : {})),
      ],
    });
    // Count the task rows the read pulls off its index.
    let read = 0;
    const asked: string[] = [];
    const spied = { ...real, query: (table: string) => {
      const q = real.query(table);
      if (table !== "tasks") return q;
      return { ...q, withIndex: (name: string, range: any) => {
        asked.push(name);
        const ranged = q.withIndex(name, range);
        return { ...ranged, order: (dir: string) => {
          const ordered = ranged.order(dir);
          return { ...ordered, async *[Symbol.asyncIterator]() { for await (const r of ordered) { read++; yield r; } } };
        } };
      } };
    } };
    const { projectTasksIn } = await import("./projectWork");
    const got = await projectTasksIn({ db: spied }, OWNER as any, BIG, ["open", "in_progress"], { limit: 5, keep: (t: any) => !t.triage_status });
    // The five newest open rows that pass the filter: 1198, 1196, ... (odd ones are suggested).
    expect(got.map((t: any) => t.updated_at)).toEqual([1198, 1196, 1194, 1192, 1190]);
    expect(asked).toEqual(["by_project_status_updated", "by_project_status_updated"]);
    expect(read).toBeLessThan(15);
    // Without mined rows: the triage index skips them, so nothing is read past.
    read = 0; asked.length = 0;
    const real5 = await projectTasksIn({ db: spied }, OWNER as any, BIG, ["open"], { limit: 5, triage: [undefined, "active"] });
    expect(real5.map((t: any) => t.updated_at)).toEqual([1198, 1196, 1194, 1192, 1190]);
    expect(asked).toEqual(["by_project_triage_status_updated", "by_project_triage_status_updated"]);
    expect(read).toBeLessThan(8);
    // No limit: every row of the wanted statuses, still none of the 500 finished.
    expect((await projectTasksIn({ db: real }, OWNER as any, BIG, ["open"])).length).toBe(200);
  });

  test("source-level: tasks.list's project branch bounds its read by the list limit and the row filters", () => {
    const src = readFileSync(join(import.meta.dir, "..", "tasks.ts"), "utf8");
    const start = src.indexOf("} else if (args.project_id || args.initiative) {");
    const branch = src.slice(start, src.indexOf("} else if", start + 10));
    expect(branch).toContain("projectTasksIn(");
    expect(branch).toContain("keep: keepRow");
  });

  test("source-level: tasks.list's project and initiative branch reads through projectTasks, not the team_id filter", () => {
    const src = readFileSync(join(import.meta.dir, "..", "tasks.ts"), "utf8");
    const start = src.indexOf("} else if (args.project_id || args.initiative) {");
    expect(start).toBeGreaterThan(-1);
    const branch = src.slice(start, src.indexOf("} else if", start + 10));
    expect(branch).toContain("projectTasks(");
    expect(branch).not.toContain("needsAccessFilter = true");
    expect(branch).not.toContain('withIndex("by_project_id"');
  });
});
