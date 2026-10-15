import { describe, expect, test } from "bun:test";
import {
  buildPiles,
  createPile,
  customPileId,
  defaultPositions,
  dissolvePile,
  makeLoose,
  moveToPile,
  personNodeId,
  pileSize,
  repoOf,
  repoPileId,
  rolePileId,
  type MapRole,
  type MapSession,
  type SessionMapLayout,
} from "./sessionMapModel";

const s = (id: string, over: Partial<MapSession> = {}): MapSession => ({ id, title: id, state: "working", updated_at: 1, agent_type: "claude_code", repo: "codecast", workers: 0, ...over });
const roles: MapRole[] = [
  { id: "lead", name: "Lead", handle: "lead", parent: personNodeId("u1") },
  { id: "growth", name: "Growth", handle: "growth", parent: rolePileId("lead") },
];

describe("buildPiles", () => {
  test("a session sits in its custom pile, else loose, else its role, else its repo", () => {
    const layout: SessionMapLayout = { piles: { k: { title: "Mine", ids: ["a"] } }, loose: ["b"] };
    const { piles, loose } = buildPiles([s("a", { roleId: "lead" }), s("b"), s("c", { roleId: "growth" }), s("d", { repo: "mail" })], roles, layout);
    const where = (id: string) => piles.find((p) => [...p.active, ...p.settled].some((x) => x.id === id))?.id;
    expect(where("a")).toBe(customPileId("k"));
    expect(loose.map((x) => x.id)).toEqual(["b"]);
    expect(where("c")).toBe(rolePileId("growth"));
    expect(where("d")).toBe(repoPileId("mail"));
  });

  test("every role keeps a pile, even with no sessions; settled sessions are split off, needs-input first", () => {
    const { piles } = buildPiles([s("x", { roleId: "lead", state: "done" }), s("y", { roleId: "lead", state: "needs_input", updated_at: 0 }), s("z", { roleId: "lead", updated_at: 9 })], roles, {});
    const lead = piles.find((p) => p.id === rolePileId("lead"))!;
    expect(lead.active.map((x) => x.id)).toEqual(["y", "z"]);
    expect(lead.settled.map((x) => x.id)).toEqual(["x"]);
    expect(piles.find((p) => p.id === rolePileId("growth"))!.active).toEqual([]);
  });
});

describe("edits", () => {
  test("moving into a custom pile takes the session out of the one it was in, and drops a pile left empty", () => {
    const layout: SessionMapLayout = { piles: { a: { title: "A", ids: ["1"] }, b: { title: "B", ids: ["2"] } }, pos: { [customPileId("a")]: [5, 5] } };
    const next = moveToPile(layout, ["1"], customPileId("b"));
    expect(next.piles).toEqual({ b: { title: "B", ids: ["2", "1"] } });
    expect(next.pos?.[customPileId("a")]).toBeUndefined();
  });

  test("moving onto a role or repo pile sends the session back to where it belongs by default", () => {
    const layout: SessionMapLayout = { piles: { a: { title: "A", ids: ["1", "2"] } }, loose: ["3"] };
    const next = moveToPile(layout, ["1", "3"], repoPileId("codecast"));
    expect(next.piles).toEqual({ a: { title: "A", ids: ["2"] } });
    expect(next.loose).toEqual([]);
  });

  test("loose keeps the drop spot; a new pile claims its sessions; unpiling frees them", () => {
    let l = makeLoose({}, [{ id: "1", x: 10.4, y: 20.6 }]);
    expect(l).toMatchObject({ loose: ["1"], pos: { "s:1": [10, 21] } });
    l = createPile(l, "Pair", ["1", "2"], { x: 0, y: 0 }, "k");
    expect(l.loose).toEqual([]);
    expect(l.pos?.["s:1"]).toBeUndefined();
    expect(l.piles?.k.ids).toEqual(["1", "2"]);
    expect(dissolvePile(l, customPileId("k")).piles).toEqual({});
  });
});

describe("defaultPositions", () => {
  test("roles hang below whoever they report to, and other piles shelve below the org", () => {
    const { piles, loose } = buildPiles([s("a", { roleId: "lead" }), s("b", { roleId: "growth" }), s("c")], roles, {});
    const pos = defaultPositions(piles, [{ id: "u1", name: "Ash" }], roles, loose);
    const person = pos[personNodeId("u1")], lead = pos[rolePileId("lead")], growth = pos[rolePileId("growth")], repo = pos[repoPileId("codecast")];
    expect(lead.y).toBeGreaterThan(person.y);
    expect(growth.y).toBeGreaterThan(lead.y + pileSize(piles.find((p) => p.id === rolePileId("lead"))!).h);
    expect(repo.y).toBeGreaterThan(growth.y);
  });
});

test("repoOf names the remote's repo, else the checkout folder", () => {
  expect(repoOf({ git_remote_url: "git@github.com:ashot/codecast.git", project_path: "/x/y" })).toBe("codecast");
  expect(repoOf({ project_path: "/Users/a/src/mail/" })).toBe("mail");
  expect(repoOf({})).toBe("Elsewhere");
});
