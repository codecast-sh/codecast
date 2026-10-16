import { describe, expect, test } from "bun:test";
import {
  buildPiles,
  createPile,
  customPileId,
  groupPileId,
  setFolded,
  freeSpot,
  newPileSize,
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

describe("views", () => {
  const now = 10 * 86_400_000;
  const list = [
    s("a", { state: "done", updated_at: now - 1000, model: "opus", messages: 3 }),
    s("b", { state: "needs_input", updated_at: now - 3 * 86_400_000, model: "opus", messages: 9 }),
    s("c", { state: "working", updated_at: now - 40 * 86_400_000, roleId: "lead" }),
  ];
  const ids = (p: { active: MapSession[]; settled: MapSession[] }) => [...p.active, ...p.settled].map((x) => x.id);

  test("grouping by state keeps done sessions as cards and ranks piles in urgency order", () => {
    const { piles } = buildPiles(list, roles, {}, { group: "state" }, now);
    const done = piles.find((p) => p.id === groupPileId("state", "done"))!;
    expect(done.active.map((x) => x.id)).toEqual(["a"]);
    expect(done.settled).toEqual([]);
    expect(piles.find((p) => p.id === groupPileId("state", "needs_input"))!.rank).toBeLessThan(done.rank);
    // Outside the org grouping, roles draw no piles of their own.
    expect(piles.some((p) => p.kind === "role")).toBe(false);
  });

  test("grouping by last activity buckets by day, model groups name the missing value", () => {
    const day = buildPiles(list, roles, {}, { group: "day" }, now).piles;
    expect(day.map((p) => [p.title, ids(p)])).toEqual(expect.arrayContaining([["Today", ["a"]], ["This week", ["b"]], ["Older", ["c"]]]));
    const model = buildPiles(list, roles, {}, { group: "model" }, now).piles;
    expect(model.find((p) => p.title === "No model")!.active.map((x) => x.id)).toEqual(["c"]);
  });

  test("a pile the person made holds its sessions under every grouping", () => {
    const layout: SessionMapLayout = { piles: { k: { title: "Mine", ids: ["b"] } } };
    for (const group of ["org", "state", "model"] as const) {
      const { piles } = buildPiles(list, roles, layout, { group }, now);
      expect(ids(piles.find((p) => p.id === customPileId("k"))!)).toEqual(["b"]);
    }
  });

  test("sorting orders the cards inside a pile", () => {
    const one = list.map((x) => ({ ...x, roleId: null, state: "working" as const }));
    const pile = (sort: "recent" | "oldest" | "messages") => ids(buildPiles(one, [], {}, { group: "repo", sort }, now).piles[0]);
    expect(pile("recent")).toEqual(["a", "b", "c"]);
    expect(pile("oldest")).toEqual(["c", "b", "a"]);
    expect(pile("messages")[0]).toBe("b");
  });

  test("stacking makes a folded pile; folding many at once is one edit", () => {
    const l = createPile({}, "Deck", ["a", "b"], { x: 0, y: 0 }, "k", true);
    expect(l.folded).toEqual([customPileId("k")]);
    const spread = setFolded(l, [customPileId("k")], false);
    expect(spread.folded).toEqual([]);
    expect(setFolded(spread, ["x", "y"], true).folded).toEqual(["x", "y"]);
  });
});

test("a new pile lands in the nearest open spot, never on another pile", () => {
  const taken = [{ x: 0, y: 0, w: 1000, h: 800 }];
  const size = newPileSize(2, false);
  const at = freeSpot(taken, size, { x: 100, y: 100 });
  const overlaps = at.x < 1000 && at.x + size.w > 0 && at.y < 800 && at.y + size.h > 0;
  expect(overlaps).toBe(false);
  expect(freeSpot([], size, { x: 5, y: 7 })).toEqual({ x: 5, y: 7 });
  expect(newPileSize(5, true)).toEqual(newPileSize(1, true));
});
