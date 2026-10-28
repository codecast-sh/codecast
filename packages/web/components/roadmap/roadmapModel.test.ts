import { describe, expect, test } from "bun:test";
import { DAY, history, indexTasks, roadmap, standingOf, visibleRows, type RoadTask } from "./roadmapModel";
import type { CompanyDoc, DocGoal, DocProject } from "../company/companyModel";

const NOW = Date.UTC(2026, 9, 27);
const ago = (d: number) => NOW - d * DAY;

const task = (id: string, project: string, created: number, closed?: number, extra: Partial<RoadTask> = {}): RoadTask => ({
  _id: id, project_id: project, status: closed ? "done" : "open", created_at: created, ...(closed ? { closed_at: closed } : {}), source: "human", ...extra,
});

const project = (id: string, extra: Partial<DocProject> = {}): DocProject => ({ id, title: id, counts: null, sessions: null, lead: null, status: "active", ...extra });
const goal = (id: string, projects: DocProject[], goals: DocGoal[] = [], row: Record<string, unknown> = {}): DocGoal => ({
  id, title: id, depth: 1, owner: null, measures: [], unknown: false, changes: [], arriving: [], refs: [], purpose: null, projects, goals,
  row: { _id: id, short_id: `in-${id}`, title: id, status: "active", health: "on_track", project_ids: projects.map((p) => p.id), created_at: ago(60), updated_at: ago(1), workspace: "team:t", user_id: "u", ...row } as never,
});
const doc = (goals: DocGoal[], unfiled: DocProject[] = []): CompanyDoc => ({ name: "W", state: {} as never, goals, unfiled, roles: [], people: [], outline: [], staffing: [], waiting: 0 });

describe("history", () => {
  test("burn-up counts what existed and what was done at each sample, and forecasts from the last four weeks", () => {
    const stamps = { created: [ago(50), ago(40), ago(30), ago(20)], closed: [ago(25), ago(10)] };
    const h = history(stamps, ago(50), NOW);
    expect(h.total).toBe(4);
    expect(h.done).toBe(2);
    expect(h.series[0]).toMatchObject({ done: 0, total: 1 });
    expect(h.series.at(-1)).toMatchObject({ done: 2, total: 4 });
    // Two closed in the window, one opened: 2 open at 2 per 28 days lands 28 days out.
    expect(h.pace).toEqual({ closed: 2, opened: 1 });
    expect(Math.round((h.forecast! - NOW) / DAY)).toBe(28);
  });

  test("nothing closing is no forecast; nothing open is no forecast", () => {
    expect(history({ created: [ago(5)], closed: [] }, ago(5), NOW).forecast).toBeNull();
    expect(history({ created: [ago(5)], closed: [ago(1)] }, ago(5), NOW).forecast).toBeNull();
  });
});

describe("roadmap", () => {
  const tasks = [
    task("a", "p1", ago(90), ago(10)),
    task("b", "p1", ago(80)),
    task("c", "p2", ago(20), ago(5)),
    // Off the board: dropped tasks and agent problems never count.
    task("d", "p1", ago(20), undefined, { status: "dropped" }),
  ];

  test("rows follow the goal tree; a goal reads its projects and its sub goals'", () => {
    const sub = goal("g2", [project("p2")]);
    const map = roadmap({ doc: doc([goal("g1", [project("p1")], [sub]), goal("g3", [])]), projects: [], tasks, tree: null, now: NOW });
    expect(map.rows.map((r) => r.key)).toEqual(["g:g1", "p:g:g1:p1", "g:g2", "p:g:g2:p2", "g:g3"]);
    const g1 = map.byKey.get("g:g1")!;
    expect([g1.done, g1.total]).toEqual([2, 3]);
    // Work began with its first task, before the goal row was written.
    expect(g1.start).toBe(ago(90));
    expect(g1.children).toEqual(["p:g:g1:p1", "g:g2"]);
    expect(visibleRows(map.rows, new Set(["g:g1"])).map((r) => r.key)).toEqual(["g:g1", "g:g3"]);
  });

  test("a lone top goal with goals under it is the mission: its own projects first, its goals at the top", () => {
    const map = roadmap({ doc: doc([goal("m", [project("p1")], [goal("g2", [project("p2")])])]), projects: [], tasks, tree: null, now: NOW });
    expect(map.rows.map((r) => r.key)).toEqual(["p::p1", "g:g2", "p:g:g2:p2"]);
    expect(map.mission?._id).toBe("m");
  });

  test("finished projects and goals hide until asked for", () => {
    const d = doc([goal("g1", [project("p1"), project("p2", { status: "done" })])]);
    expect(roadmap({ doc: d, projects: [], tasks, tree: null, now: NOW }).rows).toHaveLength(2);
    expect(roadmap({ doc: d, projects: [], tasks, tree: null, now: NOW, showEnded: true }).rows).toHaveLength(3);
  });

  test("standing reads the deadline against the pace", () => {
    const map = roadmap({ doc: doc([], [project("p1", { target_date: ago(1) }), project("p2", { target_date: NOW + 2 * DAY })]), projects: [], tasks: [...tasks, task("e", "p2", ago(3))], tree: null, now: NOW });
    expect(standingOf(map.rows[0], NOW)).toBe("late");
    // p2: one open, one closed in four weeks: lands in 28 days, after its deadline.
    expect(standingOf(map.rows[1], NOW)).toBe("behind");
  });

  test("by role: each project once, under the role that leads it", () => {
    const role = { _id: "r1", short_id: "rl-1", name: "Lead", status: "active", scope: { project_ids: ["p1", "p2"] }, sessions: [] } as never;
    const d = doc([goal("g1", [project("p1", { lead: role }), project("p2")])]);
    const map = roadmap({ doc: d, projects: [], tasks: indexTasks(tasks), tree: { roles: [role] } as never, now: NOW, group: "roles" });
    expect(map.rows.map((r) => r.key)).toEqual(["r:r1", "p:r:r1:p1", "p:r:r1:p2"]);
  });

  test("a session on a project's task counts on the project and its goal", () => {
    const map = roadmap({ doc: doc([goal("g1", [project("p1")])]), projects: [], tasks, tree: null, now: NOW, taskSessions: { b: { _id: "conv1", agent_status: "working", title: "Fixing b" } } });
    expect(map.byKey.get("p:g:g1:p1")!.counts?.working).toBe(1);
    expect(map.byKey.get("g:g1")!.sessions.map((s) => s._id)).toEqual(["conv1"]);
  });
});
