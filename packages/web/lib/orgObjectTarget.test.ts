import { describe, expect, test } from "bun:test";
import { orgObjectTarget, orgRefNeedsTypeLookup } from "./orgObjectTarget";

const GOAL = { _id: "kx72qtvpbmmrmwcjqmhzawejsx8bq9gm", short_id: "in-12", title: "Ship v2" };
const PROJECT = { _id: "ux72qtvpbmmrmwcjqmhzawejsx8bq9gm", short_id: "pj-mf3k2a", title: "Lead lists" };
const ROLE = { _id: "vx72qtvpbmmrmwcjqmhzawejsx8bq9gm", short_id: "or-3", name: "Calling lead" };
const STATE = {
  initiatives: { [GOAL._id]: GOAL },
  projects: { [PROJECT._id]: PROJECT },
  orgTree: { roles: [ROLE] },
};
const UNKNOWN = "zx72qtvpbmmrmwcjqmhzawejsx8bq9gm";

describe("orgObjectTarget", () => {
  test("the short forms name their kind", () => {
    expect(orgObjectTarget("in-12", STATE)).toEqual({ kind: "initiative", ref: "in-12" });
    expect(orgObjectTarget("or-3", STATE)).toEqual({ kind: "role", ref: "or-3" });
    expect(orgObjectTarget("pj-mf3k2a", STATE)).toEqual({ kind: "project", ref: "pj-mf3k2a" });
    expect(orgObjectTarget("@samvit", STATE)).toEqual({ kind: "person", ref: "samvit" });
    expect(orgObjectTarget("workspace", STATE)).toEqual({ kind: "scope", ref: "workspace" });
  });

  test("a goal's Convex id the store holds opens the goal, without asking the server", () => {
    expect(orgRefNeedsTypeLookup(GOAL._id, STATE)).toBe(false);
    expect(orgObjectTarget(GOAL._id, STATE)).toEqual({ kind: "initiative", ref: GOAL._id });
  });

  test("a goal's stub key opens the goal", () => {
    expect(orgObjectTarget("in_mfx3k2a_9q8w7e", {})).toEqual({ kind: "initiative", ref: "in_mfx3k2a_9q8w7e" });
  });

  test("a project's Convex id moves to its pj- form; a role's id stays a role", () => {
    expect(orgObjectTarget(PROJECT._id, STATE)).toEqual({ kind: "project", ref: "pj-mf3k2a" });
    expect(orgObjectTarget(ROLE._id, STATE)).toEqual({ kind: "role", ref: ROLE._id });
  });

  test("an id the store does not hold waits for the server, then follows its table", () => {
    expect(orgRefNeedsTypeLookup(UNKNOWN, {})).toBe(true);
    expect(orgObjectTarget(UNKNOWN, {}, undefined)).toEqual({ kind: "pending" });
    expect(orgObjectTarget(UNKNOWN, {}, "initiative")).toEqual({ kind: "initiative", ref: UNKNOWN });
    expect(orgObjectTarget(UNKNOWN, {}, "project")).toEqual({ kind: "project", ref: UNKNOWN });
    expect(orgObjectTarget(UNKNOWN, {}, null)).toEqual({ kind: "role", ref: UNKNOWN });
  });
});
