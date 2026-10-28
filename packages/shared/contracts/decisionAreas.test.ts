import { describe, expect, test } from "bun:test";
import { areaPool, areasText, decisionOwnerOf, parseAreasReply, pickAreaOwner, planShareOut, proposeSplit, type AreaMember } from "./decisionAreas";

const m = (user_id: string, project_ids: string[], over: Partial<AreaMember> = {}): AreaMember => ({ user_id, project_ids, takes_decisions: true, away: false, bot: false, open: 0, ...over });

describe("decisionOwnerOf", () => {
  test("passed to, else holder, else the one asked, else the asking session's owner", () => {
    expect(decisionOwnerOf({ passed_to: { kind: "user", id: "a" }, holder: { kind: "user", id: "b" } })).toEqual({ kind: "user", id: "a" });
    expect(decisionOwnerOf({ holder: { kind: "role", id: "r" }, asked_user_ids: ["c"] })).toEqual({ kind: "role", id: "r" });
    expect(decisionOwnerOf({ asked_user_ids: ["c", "d"] })).toEqual({ kind: "user", id: "c" });
    expect(decisionOwnerOf({ asked_user_ids: [] , user_id: "e" })).toBeNull();
    expect(decisionOwnerOf({ user_id: "e" })).toEqual({ kind: "user", id: "e" });
  });
});

describe("the pool and the rotation", () => {
  test("only people who take decisions, are not away and cover the project", () => {
    const pool = areaPool([m("a", ["p"]), m("b", ["p"], { away: true }), m("c", ["p"], { bot: true }), m("d", ["p"], { takes_decisions: false }), m("e", ["q"])], ["p"]);
    expect(pool.map((x) => x.user_id)).toEqual(["a"]);
    expect(areaPool([m("a", ["p"])], [])).toEqual([]);
  });

  test("fewest open, then given one longest ago (never first), then a stable order", () => {
    expect(pickAreaOwner([m("a", [], { open: 2 }), m("b", [], { open: 1 })])!.user_id).toBe("b");
    expect(pickAreaOwner([m("a", [], { assigned_at: 10 }), m("b", [], { assigned_at: 5 })])!.user_id).toBe("b");
    expect(pickAreaOwner([m("a", [], { assigned_at: 10 }), m("b", [])])!.user_id).toBe("b");
    expect(pickAreaOwner([m("b", []), m("a", [])])!.user_id).toBe("a");
    expect(pickAreaOwner([])).toBeNull();
  });
});

describe("planShareOut", () => {
  test("spreads a backlog evenly, oldest first, and leaves what nobody covers", () => {
    const rows = [1, 2, 3, 4].map((i) => ({ id: `d${i}`, project_ids: ["p"], owner: "boss", created_at: i }));
    rows.push({ id: "x", project_ids: ["none"], owner: "boss", created_at: 0 });
    const { moves, unmatched } = planShareOut(rows, [m("a", ["p"]), m("b", ["p"], { open: 1 })], 100);
    expect(unmatched).toBe(1);
    expect(moves.map((x) => `${x.decision_id}>${x.to}`)).toEqual(["d1>a", "d2>b", "d3>a", "d4>b"]);
  });

  test("a decision its pick already owns does not move, and it counts toward them", () => {
    const { moves } = planShareOut([{ id: "d", project_ids: ["p"], owner: "a", created_at: 1 }, { id: "e", project_ids: ["p"], owner: null, created_at: 2 }], [m("a", ["p"], { open: 1 }), m("b", ["p"])], 0);
    expect(moves).toEqual([{ decision_id: "e", from: null, to: "b" }]);
  });
});

describe("the words onto the roster", () => {
  const members = [{ user_id: "u1", name: "Samvit" }, { user_id: "u2", name: "Jason" }, { user_id: "u3", name: "Ashot" }];
  const projects = [{ id: "P1", title: "Deals" }, { id: "P2", title: "Desk" }];

  test("keys become ids, invented keys drop, the unmentioned keep nothing", () => {
    const r = parseAreasReply({ members: [{ member: "M1", projects: ["p1", "p9"] }, { member: "m2", projects: ["p2"], takes_decisions: false }, { member: "m7", projects: ["p1"] }], unplaced: ["calling", ""] }, members, projects, new Map([["u3", false]]));
    expect(r).toEqual({
      assignments: [
        { user_id: "u1", project_ids: ["P1"], takes_decisions: true },
        { user_id: "u2", project_ids: ["P2"], takes_decisions: false },
        { user_id: "u3", project_ids: [], takes_decisions: false },
      ],
      unplaced: ["calling"],
    });
    expect(parseAreasReply("nope", members, projects)).toBeNull();
    expect(areasText(r!.assignments, (u) => members.find((x) => x.user_id === u)!.name, (p) => projects.find((x) => x.id === p)!.title)).toBe("Samvit: Deals; Jason (not taking decisions): Desk");
  });
});

describe("proposeSplit", () => {
  test("each project to the person its signals point at most", () => {
    const split = proposeSplit(["P1", "P2", "P3"], ["a", "b"], [
      { project_id: "P1", user_id: "a", kind: "answered" },
      { project_id: "P1", user_id: "b", kind: "lead" },
      { project_id: "P2", user_id: "a", kind: "kept" },
      { project_id: "P2", user_id: "zz", kind: "lead" },
    ]);
    expect(split).toEqual([{ user_id: "a", project_ids: ["P2"], takes_decisions: true }, { user_id: "b", project_ids: ["P1"], takes_decisions: true }]);
  });

  test("no signals at all: everyone on every project", () => {
    expect(proposeSplit(["P1"], ["a", "b"], [])).toEqual([{ user_id: "a", project_ids: ["P1"], takes_decisions: true }, { user_id: "b", project_ids: ["P1"], takes_decisions: true }]);
  });
});
