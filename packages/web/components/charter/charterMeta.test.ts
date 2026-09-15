import { describe, expect, it } from "bun:test";
import { ORG_FIXTURE } from "../org/orgFixture";
import { CHIEF_OF_STAFF_HANDLE } from "../org/orgStaffingTypes";
import {
  CHARTER_PRIORITIES,
  PRIORITY_META,
  charterOf,
  chiefOfStaffOf,
  cleanBudget,
  composeCharterHref,
  formatTokens,
  hasCharter,
  isCharterPriority,
  ownerCandidates,
  ownerRoleOf,
  parseTokens,
  roleHref,
} from "./charterMeta";

describe("charter priority palette", () => {
  it("maps the four levels to the charter's own scale: p0 red, p1 amber, p2 blue, p3 grey", () => {
    expect(CHARTER_PRIORITIES).toEqual(["p0", "p1", "p2", "p3"]);
    expect(PRIORITY_META.p0.color).toBe("var(--sol-red)");
    expect(PRIORITY_META.p1.color).toBe("var(--sol-orange)");
    expect(PRIORITY_META.p2.color).toBe("var(--sol-blue)");
    expect(PRIORITY_META.p3.color).toBe("var(--sol-text-dim)");
    for (const p of CHARTER_PRIORITIES) {
      expect(PRIORITY_META[p].label).toBe(p.toUpperCase());
      expect(PRIORITY_META[p].hint.length).toBeGreaterThan(10);
    }
  });

  it("recognises only the four levels", () => {
    expect(isCharterPriority("p1")).toBe(true);
    expect(isCharterPriority("urgent")).toBe(false);
    expect(isCharterPriority(null)).toBe(false);
  });
});

describe("charterOf / hasCharter", () => {
  const row = {
    _id: "x", title: "T",
    goal: "Ship it", success_metrics: ["a"], priority: "p1", owner_role_id: "or-1",
    non_goals: ["b"], risks: ["c"], budget: { tokens_per_day: 400_000 },
    description: "not a charter field", status: "active",
  };

  it("picks the project field set and the plan subset", () => {
    expect(Object.keys(charterOf(row, "project")).sort()).toEqual(["budget", "goal", "non_goals", "owner_role_id", "priority", "risks", "success_metrics"]);
    expect(Object.keys(charterOf(row, "plan")).sort()).toEqual(["goal", "non_goals", "owner_role_id", "priority", "success_metrics"]);
  });

  it("drops null (a cleared scalar rides the row as null until the echo)", () => {
    expect(charterOf({ ...row, priority: null, owner_role_id: null }, "project").priority).toBeUndefined();
    expect(charterOf(null, "project")).toEqual({});
  });

  it("an empty charter is nothing to show", () => {
    expect(hasCharter({})).toBe(false);
    expect(hasCharter({ goal: "   ", success_metrics: [], non_goals: [], risks: [] })).toBe(false);
    expect(hasCharter({ budget: {} })).toBe(false);
    expect(hasCharter({ goal: "Ship" })).toBe(true);
    expect(hasCharter({ priority: "p3" })).toBe(true);
    expect(hasCharter({ owner_role_id: "r" })).toBe(true);
    expect(hasCharter({ risks: ["x"] })).toBe(true);
    expect(hasCharter({ budget: { hands_per_day: 2 } })).toBe(true);
  });
});

describe("roles from the org tree", () => {
  const chief = { ...ORG_FIXTURE.roles[0], _id: "role-chief", short_id: "or-99", handle: CHIEF_OF_STAFF_HANDLE, name: "Chief of Staff", status: "active" as const };
  const retiredChief = { ...chief, _id: "role-chief-old", status: "retired" as const };

  it("finds a live chief of staff by handle, never a retired one", () => {
    expect(chiefOfStaffOf(ORG_FIXTURE)).toBeNull();
    expect(chiefOfStaffOf({ ...ORG_FIXTURE, roles: [...ORG_FIXTURE.roles, retiredChief] })).toBeNull();
    expect(chiefOfStaffOf({ ...ORG_FIXTURE, roles: [...ORG_FIXTURE.roles, chief] })?._id).toBe("role-chief");
    expect(chiefOfStaffOf(null)).toBeNull();
  });

  it("resolves the owner by id and links to /org/or-N", () => {
    const role = ORG_FIXTURE.roles[0];
    expect(ownerRoleOf(ORG_FIXTURE, role._id)?.handle).toBe(role.handle);
    expect(ownerRoleOf(ORG_FIXTURE, "nope")).toBeNull();
    expect(ownerRoleOf(null, role._id)).toBeNull();
    expect(roleHref(role)).toBe(`/org/${role.short_id}`);
    expect(roleHref(role)).toMatch(/^\/org\/or-/);
  });

  it("a retired owner is no owner: the chip falls to 'No owner' instead of linking to a seat that no longer exists", () => {
    const role = ORG_FIXTURE.roles[0];
    const tree = { ...ORG_FIXTURE, roles: ORG_FIXTURE.roles.map((r) => (r._id === role._id ? { ...r, status: "retired" as const } : r)) };
    expect(ownerRoleOf(tree, role._id)).toBeNull();
    expect(ownerRoleOf(ORG_FIXTURE, role._id)?._id).toBe(role._id);
  });

  it("owner candidates exclude retired roles and the chief of staff", () => {
    const tree = { ...ORG_FIXTURE, roles: [...ORG_FIXTURE.roles, chief, { ...ORG_FIXTURE.roles[0], _id: "gone", status: "retired" as const }] };
    const ids = ownerCandidates(tree).map((r) => r._id);
    expect(ids).not.toContain("role-chief");
    expect(ids).not.toContain("gone");
    expect(ids).toEqual(ORG_FIXTURE.roles.filter((r) => r.status !== "retired").map((r) => r._id));
  });
});

describe("the ask to the chief of staff", () => {
  it("opens /org with the composer prefilled for this title", () => {
    expect(composeCharterHref("Codecast: Product")).toBe(`/org?compose=${encodeURIComponent("draft a charter for Codecast: Product")}`);
  });
});

describe("budget shape", () => {
  it("is the server's cleaner: tokens then hands whatever order the person edited in", () => {
    expect(Object.keys(cleanBudget({ hands_per_day: 2, tokens_per_day: 1 })!)).toEqual(["tokens_per_day", "hands_per_day"]);
    expect(cleanBudget({ hands_per_day: undefined })).toBeUndefined();
  });
});

describe("budget tokens", () => {
  it("formats compactly and parses back", () => {
    expect(formatTokens(400_000)).toBe("400k");
    expect(formatTokens(1_250_000)).toBe("1.3M");
    expect(formatTokens(900)).toBe("900");
    expect(parseTokens("400k")).toBe(400_000);
    expect(parseTokens("1.2M")).toBe(1_200_000);
    expect(parseTokens("400,000")).toBe(400_000);
    expect(parseTokens("lots")).toBeNull();
    expect(parseTokens("-4")).toBeNull();
  });
});
