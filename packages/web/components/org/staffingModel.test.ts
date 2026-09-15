import { describe, expect, test } from "bun:test";
import { ORG_FIXTURE } from "./orgFixture";
import { ORG_STAFFING_FIXTURE_HEALTH, ORG_STAFFING_FIXTURE_PROPOSAL } from "./orgStaffingFixture";
import {
  bottleneckRoles,
  changeLine,
  changeNodeId,
  collectHealthFlags,
  findChiefOfStaff,
  groupChanges,
  pickProposal,
  proposalParam,
  proposalProgress,
  remainingChanges,
  spanOfControl,
  staffingMode,
} from "./staffingModel";
import type { OrgTree } from "./orgTypes";

const P = ORG_STAFFING_FIXTURE_PROPOSAL;
const H = ORG_STAFFING_FIXTURE_HEALTH;

describe("proposal progress and grouping", () => {
  test("N of M decided counts every change no longer proposed", () => {
    expect(proposalProgress(P)).toEqual({ decided: 2, total: 6, remaining: 4, applied: 0, skipped: 1, failed: 0 });
  });

  test("remaining changes come back in apply order, not seq order", () => {
    // seq order is role, role, projects, budget, routine, project_meta; the
    // accepted projects change and the skipped routine drop out, and the
    // order puts roles before budget before charters.
    expect(remainingChanges(P).map((c) => c.change.kind)).toEqual(["role", "role", "budget", "project_meta"]);
  });

  test("groups follow the apply order with projects first and one group per kind", () => {
    const groups = groupChanges(P.changes);
    expect(groups.map((g) => `${g.kind}:${g.changes.length}`)).toEqual(["projects:1", "role:2", "budget:1", "routine:1", "project_meta:1"]);
    expect(groups[1].label).toBe("Roles");
  });

  test("every kind reads as one line", () => {
    // The words are the shared describer's (the CLI walk and the ghost chips
    // read the same line); the pane only sentence cases them.
    expect(changeLine(P.changes[0].change)).toBe("Create role Head of Platform @platform reporting to me over Platform");
    expect(changeLine(P.changes[2].change)).toBe("Create project Platform");
    expect(changeLine(P.changes[3].change)).toBe("Budget @growth tokens 800000/day");
    expect(changeLine(P.changes[4].change)).toBe("Routine on @growth: Weekly growth review every 7d");
    expect(changeLine(P.changes[5].change)).toBe("Charter Growth owner @growth p1: Double organic signups by December");
    expect(changeLine({ kind: "move", handle: "content", reports_to: "@growth" })).toBe("Move @content under @growth");
    expect(changeLine({ kind: "retire", handle: "ops" })).toBe("Retire @ops");
    expect(changeLine({ kind: "trust", handle: "growth", trust: "decide" })).toBe("Trust @growth to decide");
  });

  test("a change on an existing role focuses that node; a ghost has no node", () => {
    expect(changeNodeId(P.changes[3].change, ORG_FIXTURE)).toBe("role:fixture-role-growth");
    expect(changeNodeId(P.changes[0].change, ORG_FIXTURE)).toBeNull();
    expect(changeNodeId(P.changes[2].change, ORG_FIXTURE)).toBeNull();
  });
});

describe("pane mode", () => {
  const withChief: OrgTree = { ...ORG_FIXTURE, roles: [...ORG_FIXTURE.roles, { ...ORG_FIXTURE.roles[0], _id: "fixture-role-chief", short_id: "or-9", handle: "chief-of-staff", name: "Chief of Staff" }] };

  test("an open proposal wins over everything", () => {
    expect(staffingMode(ORG_FIXTURE, P)).toBe("proposal");
    expect(staffingMode(withChief, P)).toBe("proposal");
  });

  test("no proposal and a chief of staff shows the health summary", () => {
    expect(findChiefOfStaff(withChief)?.short_id).toBe("or-9");
    expect(staffingMode(withChief, null)).toBe("health");
  });

  test("no proposal and no chief of staff shows the hire buttons", () => {
    expect(findChiefOfStaff(ORG_FIXTURE)).toBeNull();
    expect(staffingMode(ORG_FIXTURE, null)).toBe("no_chief");
    expect(staffingMode(null, null)).toBe("no_chief");
  });

  test("a retired chief of staff does not count", () => {
    const retired: OrgTree = { ...withChief, roles: withChief.roles.map((r) => r.handle === "chief-of-staff" ? { ...r, status: "retired" as const } : r) };
    expect(staffingMode(retired, null)).toBe("no_chief");
  });
});

describe("health summary", () => {
  test("flags come back worst first, each pointing at its node", () => {
    const rows = collectHealthFlags(H, ORG_FIXTURE);
    expect(rows.map((r) => r.flag.severity)).toEqual(["blocker", "warn", "warn", "warn", "info"]);
    expect(rows[0].subject).toEqual({ kind: "company" });
    const growth = rows.find((r) => r.subject.kind === "role");
    expect(growth?.subject).toMatchObject({ kind: "role", handle: "growth", nodeId: "role:fixture-role-growth" });
  });

  test("span of control reads every person against the model's limit", () => {
    const span = spanOfControl(H, ORG_FIXTURE);
    expect(span.map((s) => [s.name, s.direct_roles, s.wide])).toEqual([["Ashot Petrosian", 1, false], ["Samvit Jain", 0, false]]);
    expect(span[0].limit).toBe(7);
    const wide = spanOfControl({ ...H, people: [{ ...H.people[0], direct_roles: 9 }, H.people[1]] }, ORG_FIXTURE);
    expect(wide[0].wide).toBe(true);
  });

  test("span falls back to the tree when health has no row for a person", () => {
    const span = spanOfControl(null, ORG_FIXTURE);
    expect(span[0]).toMatchObject({ name: "Ashot Petrosian", direct_roles: 1 });
  });

  test("bottleneck roles carry only their warn and blocker flags", () => {
    const rows = bottleneckRoles(H);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ handle: "growth", worst: "warn" });
    expect(rows[0].flags.map((f) => f.code)).toEqual(["overloaded", "cap_hit"]);
    expect(bottleneckRoles(null)).toEqual([]);
  });
});

describe("the ?proposal= parameter", () => {
  test("reads op-N in either case and rejects anything else", () => {
    expect(proposalParam("?proposal=op-7")).toBe("op-7");
    expect(proposalParam("proposal=OP-12&x=1")).toBe("op-12");
    expect(proposalParam("?proposal=ds-3")).toBeNull();
    expect(proposalParam("")).toBeNull();
    expect(proposalParam(null)).toBeNull();
  });

  test("picks the named proposal, else the newest open one", () => {
    const older = { ...P, _id: "p-old", short_id: "op-3", created_at: P.created_at - 1000 };
    const resolved = { ...P, _id: "p-res", short_id: "op-5", status: "resolved" as const, created_at: P.created_at + 5000 };
    expect(pickProposal([older, P, resolved], "op-3")?.short_id).toBe("op-3");
    expect(pickProposal([older, P, resolved], "op-99")?.short_id).toBe("op-7");
    expect(pickProposal([older, P, resolved], null)?.short_id).toBe("op-7");
    expect(pickProposal([resolved], null)).toBeNull();
  });
});

describe("inline edit of a change", () => {
  test("fields flatten one level and edits come back nested, only where changed", async () => {
    const { changeEdits, changeFields } = await import("./staffingModel");
    const budget = P.changes[3].change;
    const fields = changeFields(budget);
    expect(fields).toEqual([
      { key: "handle", label: "handle", kind: "text", value: "growth" },
      { key: "caps.tokens_per_day", label: "caps tokens per day", kind: "number", value: "800000" },
    ]);
    expect(changeEdits(budget, fields)).toEqual({});
    expect(changeEdits(budget, fields.map((f) => f.key === "caps.tokens_per_day" ? { ...f, value: "600000" } : f))).toEqual({ caps: { tokens_per_day: 600000 } });
    const meta = P.changes[5].change;
    const metaFields = changeFields(meta);
    expect(metaFields.find((f) => f.key === "success_metrics")).toEqual({ key: "success_metrics", label: "success metrics", kind: "list", value: "organic signups per week, AI citation count" });
    expect(changeEdits(meta, metaFields.map((f) => f.key === "success_metrics" ? { ...f, value: "signups, citations" } : f))).toEqual({ success_metrics: ["signups", "citations"] });
  });
});
