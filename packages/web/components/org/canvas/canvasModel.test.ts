// The canvas's rules over the synthetic company (essence spec §4.1, §4.2):
// where each project is drawn, the bands and their order, the goal tiles and
// what serves them, and the one word each role's state says.
// Run: ulimit -n 10240; bun test components/org/canvas/canvasModel.test.ts
import { describe, expect, test } from "bun:test";
import { canvasModel, isOpenTarget, missionOf, type CanvasInput, type CanvasRole } from "./canvasModel";
import {
  CANVAS_FIXTURE_GOALS, CANVAS_FIXTURE_PLANS, CANVAS_FIXTURE_PROJECTS, CANVAS_FIXTURE_TASKS, CANVAS_FIXTURE_TREE,
  CANVAS_FIXTURE_WAITING, CANVAS_ME, CANVAS_ROLE,
} from "./canvasFixture";

const INPUT: CanvasInput = {
  tree: CANVAS_FIXTURE_TREE, goals: CANVAS_FIXTURE_GOALS, projects: CANVAS_FIXTURE_PROJECTS, plans: CANVAS_FIXTURE_PLANS,
  tasks: CANVAS_FIXTURE_TASKS, tasksCounted: true, waitingRoleIds: CANVAS_FIXTURE_WAITING, viewerId: CANVAS_ME,
};
const model = (over: Partial<CanvasInput> = {}) => canvasModel({ ...INPUT, ...over });
const roles = (m = model()) => m.bands.flatMap((b) => b.roles);
const roleOf = (id: string, m = model()): CanvasRole => roles(m).find((r) => r.id === id)!;

describe("bands", () => {
  test("you first, then by how many roles, then by name; every live role drawn once", () => {
    const m = model();
    expect(m.bands.map((b) => [b.person.name, b.roles.length])).toEqual([["Maya Okafor", 5], ["Tomas Reyes", 3], ["Ines Park", 2], ["Dev Arora", 1]]);
    expect(m.bands[0].person.me).toBe(true);
    expect(roles(m)).toHaveLength(11);
    expect(new Set(roles(m).map((r) => r.id)).size).toBe(11);
  });

  test("roles in a band are by title", () => {
    expect(model().bands[0].roles.map((r) => r.title)).toEqual(["Cold Email lead", "Head of People", "Market Growth lead", "Partner Outreach lead", "Release Captain"]);
  });

  test("a role under a role sits in its parent's band and says so", () => {
    const ines = model().bands.find((b) => b.person.name === "Ines Park")!;
    expect(ines.roles.map((r) => r.title)).toEqual(["Calling lead", "Escalations lead"]);
    expect(roleOf(CANVAS_ROLE.escalations).under).toBe("Calling lead");
    expect(roleOf(CANVAS_ROLE.calling).under).toBeNull();
  });

  test("the order is stable whatever order the rows arrive in", () => {
    const shuffled = { ...CANVAS_FIXTURE_TREE, roles: [...CANVAS_FIXTURE_TREE.roles].reverse(), people: [...CANVAS_FIXTURE_TREE.people].reverse() };
    const a = model();
    const b = model({ tree: shuffled, projects: [...CANVAS_FIXTURE_PROJECTS].reverse(), goals: [...CANVAS_FIXTURE_GOALS].reverse() });
    const shape = (m: typeof a) => JSON.stringify([m.goals.map((g) => g.id), m.bands.map((x) => [x.person.id, x.roles.map((r) => [r.id, r.projects.map((p) => p.id)])]), m.unled.map((p) => p.id)]);
    expect(shape(b)).toBe(shape(a));
  });

  test("a retired role is drawn nowhere", () => {
    const tree = { ...CANVAS_FIXTURE_TREE, roles: CANVAS_FIXTURE_TREE.roles.map((r) => (r._id === CANVAS_ROLE.release ? { ...r, status: "retired" as const } : r)) };
    expect(roles(model({ tree })).some((r) => r.id === CANVAS_ROLE.release)).toBe(false);
  });
});

describe("projects", () => {
  test("each project is drawn once, inside its lead's card", () => {
    expect(roleOf(CANVAS_ROLE.network).projects.map((p) => p.title)).toEqual(["Private Network"]);
    expect(roleOf(CANVAS_ROLE.calling).projects.map((p) => p.title)).toEqual(["Callers & Call Management", "Ines's ideas"]);
    const drawn = [...roles().flatMap((r) => r.projects), ...model().unled].filter((p) => p.kind === "project").map((p) => p.id);
    expect(drawn).toHaveLength(new Set(drawn).size);
    expect(drawn).toHaveLength(10);
  });

  test("projects nobody leads go to the No lead band; ended ones draw nowhere", () => {
    const m = model();
    expect(m.unled.map((p) => p.title)).toEqual(["Matching Engine & Funnel", "Public Launch & Fundraise"]);
    expect(m.unled[1].status).toBe("planning");
    expect([...roles(m).flatMap((r) => r.projects), ...m.unled].some((p) => p.title === "Last year's pilot")).toBe(false);
  });

  test("counts read the board: done of all, and what is in progress; partial while the store fills", () => {
    const p = roleOf(CANVAS_ROLE.network).projects[0];
    expect(p.work).toEqual({ done: 70, total: 145, inProgress: 4 });
    expect(p.counting).toBe(false);
    expect(p.href).toBe("/projects/pj-1");
    expect(roleOf(CANVAS_ROLE.network, model({ tasksCounted: false })).projects[0].counting).toBe(true);
  });

  test("a project names each adopted goal it serves", () => {
    expect(roleOf(CANVAS_ROLE.network).projects[0].goals.map((g) => g.title)).toEqual(["Win the private network"]);
    expect(roleOf(CANVAS_ROLE.deals).projects[0].goals).toEqual([]);
    expect(model().unled[0].goals.map((g) => g.title)).toEqual(["Lower the cost of each match"]);
  });

  test("a plan sits on its role's card, marked as a plan", () => {
    const plans = roleOf(CANVAS_ROLE.cold).projects;
    expect(plans.map((p) => [p.kind, p.title])).toEqual([["plan", "Cold email deliverability"]]);
    expect(plans[0].href).toBe("/plans/pl-2");
  });

  test("a role with no project on its card says what it looks after in one line", () => {
    expect(roleOf(CANVAS_ROLE.people).area).toBe("Keeps the structure of the whole company honest.");
    expect(roleOf(CANVAS_ROLE.network).area).toBeNull();
  });
});

describe("goals", () => {
  test("the mission is the one top level goal the others feed; it is not a tile", () => {
    const m = model();
    expect(m.mission?.title).toBe("Broker introductions that turn into real transactions");
    expect(m.mission?.workspace).toBe("Lantern");
    expect(m.goals.some((g) => g.id === m.mission?.id)).toBe(false);
    expect(missionOf(CANVAS_FIXTURE_GOALS.filter((g) => g.parent_initiative_id))).toBeNull();
  });

  test("adopted goals only, by priority then creation; drafts fold to a count; ended goals draw nowhere", () => {
    const m = model();
    expect(m.goals.map((g) => g.title)).toEqual(["Win the private network", "Lower the cost of each match"]);
    expect(m.drafts).toBe(7);
    expect(model({ goals: CANVAS_FIXTURE_GOALS.filter((g) => g.status !== "proposed") }).drafts).toBe(0);
  });

  test("a tile names the projects that serve it and their leads", () => {
    const [win, cost] = model().goals;
    expect(win.serving.map((s) => [s.title, s.lead?.name ?? null])).toEqual([["Private Network", "Private Network lead"], ["Partner Outreach", "Partner Outreach lead"]]);
    expect(cost.serving.map((s) => [s.title, s.lead?.name ?? null])).toEqual([["Matching Engine & Funnel", null]]);
    const none = model({ goals: CANVAS_FIXTURE_GOALS.map((g) => (g.short_id === "in-3" ? { ...g, project_ids: [] } : g)) }).goals[1];
    expect(none.serving).toEqual([]);
  });

  test("health is said only once an update exists", () => {
    const [win, cost] = model().goals;
    expect(win.health).toBe("at_risk");
    expect(cost.health).toBeNull();
    expect(win.owner).toMatchObject({ kind: "person", name: "Maya Okafor" });
  });
});

describe("state words", () => {
  test("Waiting on you exactly when the list holds the role", () => {
    const waiting = roles().filter((r) => r.state.kind === "waiting").map((r) => r.id).sort();
    expect(waiting).toEqual([...CANVAS_FIXTURE_WAITING].sort());
    expect(roleOf(CANVAS_ROLE.people).state.label).toBe("Waiting on you");
    expect(roles(model({ waitingRoleIds: new Set() })).some((r) => r.state.kind === "waiting")).toBe(false);
  });

  test("a blocked pin with no ask of the viewer is Quiet; its line says on whom it waits", () => {
    const infra = CANVAS_FIXTURE_TREE.roles.find((r) => r._id === CANVAS_ROLE.infra)!;
    expect(infra.standing?.state_status).toBe("blocked");
    const tree = { ...CANVAS_FIXTURE_TREE, roles: CANVAS_FIXTURE_TREE.roles.map((r) => (r._id === CANVAS_ROLE.infra ? { ...r, sessions: [] } : r)) };
    const card = roleOf(CANVAS_ROLE.infra, model({ tree }));
    expect(card.state).toEqual({ kind: "quiet", label: "Quiet" });
    expect(card.line).toContain("waiting on Tomas");
  });

  test("Working when the standing session or any session under it works; else Quiet", () => {
    expect(roleOf(CANVAS_ROLE.network).state.kind).toBe("working");
    expect(roleOf(CANVAS_ROLE.escalations).state.kind).toBe("waiting");
    expect(roleOf(CANVAS_ROLE.release).state.kind).toBe("quiet");
  });

  test("Paused, Not started and Handing over are said as facts", () => {
    const tree = {
      ...CANVAS_FIXTURE_TREE,
      roles: CANVAS_FIXTURE_TREE.roles.map((r) =>
        r._id === CANVAS_ROLE.release ? { ...r, status: "paused" as const }
        : r._id === CANVAS_ROLE.quality ? { ...r, standing: null }
        : r._id === CANVAS_ROLE.deals ? { ...r, handing_over: { reason: "scope" as const, started_at: 0, deadline: 0, by: CANVAS_ME, receivers: [{ role_id: CANVAS_ROLE.network, handle: "private-network", project_ids: [], plan_ids: [] }] } }
        : r),
    };
    const m = model({ tree });
    expect(roleOf(CANVAS_ROLE.release, m).state.label).toBe("Paused");
    expect(roleOf(CANVAS_ROLE.quality, m).state.label).toBe("Not started");
    expect(roleOf(CANVAS_ROLE.deals, m).state.label).toBe("Handing over to Private Network lead");
  });

  test("working now lists the sessions that work or wait for input, by title", () => {
    expect(roleOf(CANVAS_ROLE.infra).working.map((s) => [s.title, s.state])).toEqual([["Bounce-gate floors rollout", "working"], ["Dead-login inbox in the pool", "needs_input"]]);
    expect(roleOf(CANVAS_ROLE.network).working.map((s) => s.title)).toEqual(["Accreditation gate defect", "Fund price leak fix"]);
    expect(roleOf(CANVAS_ROLE.release).working).toEqual([]);
  });

  test("a role reads its persona and handle", () => {
    expect(roleOf(CANVAS_ROLE.cold)).toMatchObject({ title: "Cold Email lead", persona: "Sorrel", handle: "cold-email", ref: "or-3" });
  });
});

describe("an open proposal", () => {
  const stubId = "fixture-canvas-change-1";
  const merged = {
    ...CANVAS_FIXTURE_TREE,
    roles: [...CANVAS_FIXTURE_TREE.roles, { ...CANVAS_FIXTURE_TREE.roles[1], _id: stubId, short_id: "or-…", name: "Pricing lead", handle: "pricing", given_name: null, standing: null, sessions: [], scope: { project_ids: [], plan_ids: [] } }],
  };
  const ghosts = {
    merged,
    stubs: { [`role:${stubId}`]: { line: "Hire a Pricing lead", solid: false } },
    retires: { [`role:${CANVAS_ROLE.release}`]: { line: "Retire the Release Captain" } },
    moves: [{ nodeId: `role:${CANVAS_ROLE.quality}`, to: { kind: "user" as const, user_id: "fixture-canvas-tomas" }, line: "Move the Agent Quality lead" }],
  };

  test("draws a new role, a move and a retirement in place, and nothing once closed", () => {
    const m = model({ ghosts });
    expect(roleOf(stubId, m).ghost).toEqual({ kind: "new", line: "Hire a Pricing lead", solid: false });
    expect(roleOf(CANVAS_ROLE.release, m).ghost).toEqual({ kind: "retires", line: "Retire the Release Captain" });
    expect(roleOf(CANVAS_ROLE.quality, m).ghost).toEqual({ kind: "moves", line: "Move the Agent Quality lead", to: "Tomas Reyes" });
    expect(roles(model()).some((r) => r.ghost)).toBe(false);
  });
});

test("the open target matches by short id, id or handle, case aside", () => {
  expect(isOpenTarget({ kind: "role", ref: "OR-3" }, "role", "or-3", "x")).toBe(true);
  expect(isOpenTarget({ kind: "person", ref: "@maya" }, "person", "maya")).toBe(true);
  expect(isOpenTarget({ kind: "project", ref: "pj-1" }, "role", "pj-1")).toBe(false);
  expect(isOpenTarget({ kind: "session", id: "s1" }, "session", "s1")).toBe(true);
  expect(isOpenTarget(null, "role", "or-3")).toBe(false);
});
