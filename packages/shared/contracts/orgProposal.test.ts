import { describe, expect, test } from "bun:test";
import { applyProposalChanges, extractOrgProposal, orgProposalBlock, orgProposalVerdict } from "./orgProposal";

describe("org proposal block", () => {
  test("round trips through a decision context", () => {
    const p = { kind: "role" as const, name: "Growth", handle: "growth", scope: { projects: ["pr-1"] } };
    const md = `Reasoning first.\n\n${orgProposalBlock(p)}\n\ntrailing note`;
    expect(extractOrgProposal(md)).toEqual(p);
  });
  test("malformed or missing blocks read as null", () => {
    expect(extractOrgProposal("no block")).toBeNull();
    expect(extractOrgProposal("```org-proposal\n{not json\n```")).toBeNull();
    expect(extractOrgProposal("```org-proposal\n{\"kind\":\"role\"}\n```")).toBeNull();
    expect(extractOrgProposal("```org-proposal\n{\"kind\":\"other\",\"handle\":\"x\"}\n```")).toBeNull();
  });
  test("verdict follows the fixed option order", () => {
    expect([0, 1, 2, 3, undefined].map(orgProposalVerdict)).toEqual(["apply", "apply_with_changes", "skip", null, null]);
  });
  test("changes: JSON overrides fields, prose rides as a note", () => {
    const p = { kind: "role" as const, name: "Growth", handle: "growth" };
    expect(applyProposalChanges(p, '{"handle":"grow","kind":"retire"}')).toEqual({ proposal: { kind: "role", name: "Growth", handle: "grow" } });
    expect(applyProposalChanges(p, "weekly reports please")).toEqual({ proposal: p, note: "weekly reports please" });
    expect(applyProposalChanges(p, "  ")).toEqual({ proposal: p });
  });
});

// Staffing changes (org-staffing.md S4): one validator per kind, the spec
// envelope, the accept order and the one-line describer.
import { ORG_CHANGE_APPLY_RANK, ORG_CHANGE_KINDS, describeOrgChange, describeTenure, isOrgChange, orderOrgChanges, orgChangeError, orgTenureError, parseOrgProposalSpec, type OrgChange } from "./orgProposal";

const GOOD: Record<OrgChange["kind"], OrgChange> = {
  role: { kind: "role", name: "Head of Growth", handle: "growth", scope: { projects: ["pr-1"] }, reports_to: "me" },
  projects: { kind: "projects", changes: [{ op: "create", title: "Platform" }, { op: "merge", from: "pr-3", into: "pr-1" }] },
  move: { kind: "move", handle: "growth", reports_to: "@product", scope_add: ["pr-5"] },
  retire: { kind: "retire", handle: "ops", reason: "idle 21 days" },
  scope: { kind: "scope", handle: "growth", add: ["pr-5"], remove: ["pl-2"] },
  budget: { kind: "budget", handle: "growth", caps: { tokens_per_day: 800_000 } },
  trust: { kind: "trust", handle: "growth", trust: "decide" },
  routine: { kind: "routine", handle: "growth", title: "Weekly funnel", prompt: "Read the funnel and report.", every: "7d" },
  project_meta: { kind: "project_meta", project: "pr-1", goal: "Ship the onboarding", success_metrics: ["activation 40%"], priority: "p1", owner: "@growth", non_goals: ["paid ads"], risks: ["one engineer"] },
  adopt: { kind: "adopt", handle: "chief-of-staff", conversation: "jx7abcd" },
  file: { kind: "file", plan: "pl-1", project: "Platform" },
  plan_status: { kind: "plan_status", plan: "pl-7", status: "done", reason: "every task closed" },
  task_status: { kind: "task_status", task: "ct-42", status: "done", reason: "commits landed, still open" },
  project_status: { kind: "project_status", project: "Legacy", status: "paused", reason: "no activity 30d" },
};

describe("org change validation", () => {
  test("every kind has a valid example and the list is complete", () => {
    expect(Object.keys(GOOD).sort()).toEqual([...ORG_CHANGE_KINDS].sort());
    for (const c of Object.values(GOOD)) expect(orgChangeError(c), c.kind).toBeNull();
  });
  test("each kind names its first fault", () => {
    const faults: Array<[any, string]> = [
      [null, "an object with a kind"],
      [{ kind: "nope" }, "unknown change kind"],
      [{ kind: "role", name: "X" }, "missing its required fields"],
      [{ kind: "role", name: "X", handle: "Bad Handle" }, "not a-z, 0-9 and -"],
      [{ kind: "projects", changes: [{ op: "create" }] }, "missing its required fields"],
      [{ kind: "move" }, "missing its required fields"],
      [{ kind: "retire", handle: "" }, "missing its required fields"],
      [{ kind: "scope", handle: "gr" }, "at least one ref"],
      [{ kind: "scope", handle: "gr", add: "pr-1" }, "lists of project or plan refs"],
      [{ kind: "budget", handle: "gr", caps: {} }, "at least one of hands_per_day"],
      [{ kind: "budget", handle: "gr", caps: { tokens_per_day: -1 } }, "non-negative"],
      [{ kind: "trust", handle: "gr", trust: "god" }, "one of understand, decide, direct"],
      [{ kind: "routine", handle: "gr", title: "t", prompt: "p", every: "weekly" }, "duration like 7d"],
      [{ kind: "routine", handle: "gr", title: "t", every: "7d" }, "title and a prompt"],
      [{ kind: "project_meta", project: "pr-1" }, "changes nothing"],
      [{ kind: "project_meta", project: "pr-1", priority: "p9" }, "priority is one of"],
      [{ kind: "project_meta", project: "pr-1", success_metrics: "x" }, "lists of strings"],
      [{ kind: "adopt", handle: "chief-of-staff" }, "adopt needs the conversation"],
      [{ kind: "adopt", conversation: "jx7abcd" }, "handle is required"],
    ];
    for (const [raw, fault] of faults) {
      const err = orgChangeError(raw);
      expect(err, JSON.stringify(raw)).not.toBeNull();
      expect(err!, JSON.stringify(raw)).toContain(fault);
      expect(isOrgChange(raw)).toBe(false);
    }
  });
});

describe("parseOrgProposalSpec", () => {
  const spec = { title: "Staffing for Acme", summary_md: "Two paragraphs.", mode: "init", changes: Object.values(GOOD).map((change) => ({ change, rationale: `why ${change.kind}`, evidence: [{ label: "3 sessions", href: "https://x" }], expected_effect: "less chatter", risk: "none" })) };
  test("a spec with every kind parses and keeps only the known fields", () => {
    const r = parseOrgProposalSpec({ ...spec, extra: 1 });
    expect(r.errors).toEqual([]);
    expect(r.spec!.changes.length).toBe(ORG_CHANGE_KINDS.length);
    expect(Object.keys(r.spec!)).toEqual(["title", "summary_md", "mode", "changes"]);
    expect(r.spec!.changes[0]).toEqual({ change: GOOD.role, rationale: "why role", evidence: [{ label: "3 sessions", href: "https://x" }], expected_effect: "less chatter", risk: "none" });
  });
  test("every fault is reported, named by index and kind", () => {
    const r = parseOrgProposalSpec({ title: "", mode: "later", changes: [
      { change: GOOD.role },
      { change: { kind: "budget", handle: "gr", caps: {} }, rationale: "r", evidence: [{ href: "x" }] },
      "nope",
    ] });
    expect(r.spec).toBeNull();
    expect(r.errors).toEqual([
      "title is required",
      "summary_md is required: the summary a founder reads on a phone",
      "mode is one of init, review, request",
      "changes[0] (role): rationale is required",
      "changes[1] (budget): budget caps needs at least one of hands_per_day, wakes_per_day, tokens_per_day as a non-negative number",
      "changes[1] (budget): evidence is a list of { label, href? }",
      "changes[2]: an object with change and rationale",
    ]);
    expect(parseOrgProposalSpec([]).errors[0]).toContain("JSON object");
    expect(parseOrgProposalSpec({ title: "t", summary_md: "s", mode: "review", changes: [] }).errors).toEqual(["changes is a non-empty list"]);
  });
});

describe("orderOrgChanges and describeOrgChange", () => {
  test("record syncs, projects, role, move, scope, budget, trust, routine, adopt, retire; unknown last; ties keep order", () => {
    const rows = [GOOD.retire, GOOD.adopt, GOOD.routine, GOOD.trust, GOOD.budget, GOOD.scope, GOOD.move, GOOD.project_meta, { kind: "role", name: "B", handle: "bb" } as OrgChange, GOOD.role, GOOD.projects, GOOD.project_status, GOOD.task_status, GOOD.plan_status, null];
    expect(orderOrgChanges(rows, (c) => c).map((c) => c ? (c.kind === "role" ? `role:${c.handle}` : c.kind) : "none"))
      .toEqual(["task_status", "plan_status", "project_status", "projects", "role:bb", "role:growth", "project_meta", "move", "scope", "budget", "trust", "adopt", "routine", "retire", "none"]);
    for (const kind of ORG_CHANGE_KINDS) expect(typeof ORG_CHANGE_APPLY_RANK[kind], kind).toBe("number");
  });
  test("one line per kind, in the words the walk and the ghosts use", () => {
    expect(describeOrgChange(GOOD.role)).toBe("create role Head of Growth @growth reporting to me over pr-1");
    expect(describeOrgChange(GOOD.projects)).toBe("create project Platform; merge project pr-3 into pr-1");
    expect(describeOrgChange(GOOD.move)).toBe("move @growth under @product +pr-5");
    expect(describeOrgChange(GOOD.retire)).toBe("retire @ops");
    expect(describeOrgChange(GOOD.scope)).toBe("scope @growth +pr-5 -pl-2");
    expect(describeOrgChange(GOOD.budget)).toBe("budget @growth tokens 800000/day");
    expect(describeOrgChange(GOOD.trust)).toBe("trust @growth to decide");
    expect(describeOrgChange(GOOD.routine)).toBe("routine on @growth: Weekly funnel every 7d");
    expect(describeOrgChange(GOOD.project_meta)).toBe("charter pr-1 owner @growth p1: Ship the onboarding");
    expect(describeOrgChange(GOOD.adopt)).toBe("adopt session jx7abcd as @chief-of-staff's standing session");
    expect(describeOrgChange(GOOD.plan_status)).toBe("mark plan pl-7 done");
    expect(describeOrgChange(GOOD.task_status)).toBe("mark task ct-42 done");
    expect(describeOrgChange(GOOD.project_status)).toBe("mark project Legacy paused");
  });
});

// Bring records in line and tenure (org-staffing.md S9, S10).
describe("status changes, tenure and horizon", () => {
  test("each status kind names its faults; the reason is required", () => {
    expect(orgChangeError({ kind: "plan_status", plan: "pl-1", status: "paused", reason: "x" })).toContain("done, abandoned, active");
    expect(orgChangeError({ kind: "plan_status", plan: "pl-1", status: "done" })).toContain("reason");
    expect(orgChangeError({ kind: "task_status", status: "done", reason: "x" })).toContain("task ref");
    expect(orgChangeError({ kind: "task_status", task: "ct-1", status: "in_progress", reason: "x" })).toContain("done, dropped, open, backlog");
    expect(orgChangeError({ kind: "task_status", task: "ct-1", status: "open", reason: "filed in bulk, never picked up" })).toBeNull();
    expect(orgChangeError({ kind: "project_status", project: "P", status: "planning", reason: "x" })).toContain("paused, done, active");
  });
  test("tenure on a role change: standing, or a program with one end and a then", () => {
    const role = (tenure: any) => ({ kind: "role", name: "Push lead", handle: "push", tenure });
    expect(orgChangeError(role({ kind: "standing" }))).toBeNull();
    expect(orgChangeError(role({ kind: "program", ends: { plan: "pl-3" }, then: "retire" }))).toBeNull();
    expect(orgChangeError(role({ kind: "program", ends: { date: 1_800_000_000_000 }, then: "review" }))).toBeNull();
    expect(orgChangeError(role({ kind: "program", ends: { plan: "pl-3", project: "P" }, then: "retire" }))).toContain("exactly one");
    expect(orgChangeError(role({ kind: "program", ends: { date: "tomorrow" }, then: "retire" }))).toContain("unix ms");
    expect(orgChangeError(role({ kind: "program", ends: { plan: "pl-3" }, then: "party" }))).toContain("retire or review");
    expect(orgChangeError(role({ kind: "seasonal" }))).toContain("standing or program");
    expect(orgTenureError({ kind: "program", ends: { plan: "" }, then: "retire" })).toContain("is a ref");
    expect(describeTenure({ kind: "program", ends: { plan: "pl-3" }, then: "retire" })).toBe("program · ends with pl-3, then retire");
    // A date reads the way a person says it. The year rides along only when it
    // is not the current one, so these two are built relative to now and stay
    // true whatever year the suite runs in.
    const thisYear = new Date().getUTCFullYear();
    expect(describeTenure({ kind: "program", ends: { date: Date.UTC(thisYear, 11, 1) }, then: "review" })).toBe("program · ends Dec 1, then review");
    expect(describeTenure({ kind: "program", ends: { date: Date.UTC(thisYear + 2, 11, 1) }, then: "review" })).toBe(`program · ends Dec 1 ${thisYear + 2}, then review`);
    expect(describeTenure({ kind: "standing" })).toBe("standing");
    expect(describeOrgChange(role({ kind: "program", ends: { plan: "pl-3" }, then: "retire" }) as any)).toContain("(program · ends with pl-3, then retire)");
  });
  test("a project create carries a horizon", () => {
    expect(orgChangeError({ kind: "projects", changes: [{ op: "create", title: "Migration", horizon: "bounded" }] })).toBeNull();
    expect(orgChangeError({ kind: "projects", changes: [{ op: "create", title: "Migration", horizon: "forever" }] })).toContain("ongoing, bounded");
    expect(describeOrgChange({ kind: "projects", changes: [{ op: "create", title: "Migration", horizon: "bounded" }] })).toBe("create project Migration (bounded)");
  });
});

describe("file change", () => {
  test("validates, describes and sorts after projects", async () => {
    const { orgChangeError, describeOrgChange, orderOrgChanges } = await import("./orgProposal");
    expect(orgChangeError({ kind: "file", plan: "pl-1", project: "Platform" })).toBeNull();
    expect(orgChangeError({ kind: "file", plan: "pl-1" })).toContain("plan ref and a project ref");
    expect(describeOrgChange({ kind: "file", plan: "pl-1", project: "Platform" })).toBe("file plan pl-1 under project Platform");
    const rows = [{ kind: "role", name: "A", handle: "a" }, { kind: "file", plan: "pl-1", project: "P" }, { kind: "projects", changes: [] }] as any[];
    expect(orderOrgChanges(rows, (r) => r).map((r) => r.kind)).toEqual(["projects", "file", "role"]);
  });
});

describe("a proposal carries one change per subject", () => {
  test("the same task status twice is refused with both positions named; different subjects pass", () => {
    const c = (task: string) => ({ change: { kind: "task_status", task, status: "open", reason: "never worked" }, rationale: "r" });
    const twice = parseOrgProposalSpec({ title: "t", summary_md: "s", mode: "review", changes: [c("ct-1"), c("ct-2"), c("ct-1")] });
    expect(twice.spec).toBeNull();
    expect(twice.errors).toEqual(["changes[2] (mark task ct-1 open) repeats changes[0]: one change per subject"]);
    expect(parseOrgProposalSpec({ title: "t", summary_md: "s", mode: "review", changes: [c("ct-1"), c("ct-2")] }).errors).toEqual([]);
  });
});
