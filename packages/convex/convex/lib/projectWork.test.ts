import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeFakeDb } from "../testDb";
import { projectTasks, projectProgress } from "./projectWork";

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
    { _id: "tasks_shared", user_id: OWNER, team_id: TEAM, workspace: WS, project_id: P, status: "open", source: "human", title: "shared" },
    // Routed to the team, readable by its owner only.
    { _id: "tasks_private", user_id: OWNER, team_id: TEAM, workspace: `user:${OWNER}`, project_id: P, status: "done", source: "human", title: "private" },
  ],
});

describe("projectTasks", () => {
  test("a task routed to the team but keyed to its owner is the owner's alone", async () => {
    const titles = async (who: string) => (await projectTasks({ db: db() }, who as any, P)).map((t: any) => t.title).sort();
    expect(await titles(OWNER)).toEqual(["private", "shared"]);
    expect(await titles(MATE)).toEqual(["shared"]);
    expect(await projectProgress({ db: db() }, MATE as any, P)).toEqual({ total: 1, done: 0, in_progress: 0, open: 1 });
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
