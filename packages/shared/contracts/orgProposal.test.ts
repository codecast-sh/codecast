import { describe, expect, test } from "bun:test";
import { applyProposalChanges, extractOrgProposal, normalizeAutonomyChange, orgProposalBlock, orgProposalVerdict, recordChangeParts, changeLine } from "./orgProposal";

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
import { ORG_CHANGE_APPLY_RANK, ORG_CHANGE_KINDS, ORG_CHARTER_MAX, ORG_PROPOSAL_MAX, ORG_PROPOSAL_WORKS, ORG_VERDICT_REVISED, applyCharterEdits, deriveAsks, describeOrgChange, describeTenure, isOrgChange, latestOrgRevisionAt, orderOrgChanges, orgChangeDependencies, orgChangeError, orgProposalWork, orgProposalWorkErrors, orgRecordGroups, orgRecordRedundancyErrors, orgTenureError, orgVerdictSeenFault, orgWorkOfChange, parseOrgProposalSpec, recordGroupTotalsLine, type OrgChange } from "./orgProposal";

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
  adopt: { kind: "adopt", handle: "head-of-people", conversation: "jx7abcd" },
  file: { kind: "file", plan: "pl-1", project: "Platform" },
  charter_edit: { kind: "charter_edit", handle: "growth", edits: [{ op: "replace", before: "on budget", after: "under budget" }, { op: "add", line: "Reports spend every Monday." }] },
  plan_status: { kind: "plan_status", plan: "pl-7", status: "done", reason: "every task closed" },
  task_status: { kind: "task_status", task: "ct-42", status: "done", reason: "commits landed, still open" },
  project_status: { kind: "project_status", project: "Legacy", status: "paused", reason: "no activity 30d" },
  authority: { kind: "authority", handle: "growth", authority: [{ id: "ads-spend", kind: "spend", label: "Paid search on the configured campaign", limit: { usd_per_month: 300 }, expires: "90d" }, { id: "site-write", kind: "write", label: "Ship pages into the working tree" }] },
  hire: { kind: "hire", handle: "growth", template: "growth", version: "2.0.0", digest: "a".repeat(64), instance: "acme-growth", project: "pr-1", config: { "product.domain": "acme.io" }, update_policy: "stable" },
  upgrade: { kind: "upgrade", instance: "acme-growth", template: "growth", to: "2.1.0", digest: "b".repeat(64) },
  initiative: { kind: "initiative", title: "Win the private network", description: "Quiet is onboarded and three brokers trade through us.", projects: ["Callers", "Broker network"], owner: "@calling" },
  initiative_projects: { kind: "initiative_projects", initiative: "in-2", title: "Win the private network", projects: ["Callers"] },
  initiative_owner: { kind: "initiative_owner", initiative: "in-2", title: "Win the private network", owner: "@calling" },
  initiative_shape: { kind: "initiative_shape", initiative: "in-2", title: "Win the private network", parent: "Reach 1k teams", metrics: [{ name: "Brokers live", target: "40" }] },
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
      [{ kind: "trust", handle: "gr", trust: "god" }, "autonomy on is true or false"],
      [{ kind: "routine", handle: "gr", title: "t", prompt: "p", every: "weekly" }, "duration like 7d"],
      [{ kind: "routine", handle: "gr", title: "t", every: "7d" }, "title and a prompt"],
      [{ kind: "project_meta", project: "pr-1" }, "changes nothing"],
      [{ kind: "project_meta", project: "pr-1", priority: "p9" }, "priority is one of"],
      [{ kind: "project_meta", project: "pr-1", success_metrics: "x" }, "lists of strings"],
      [{ kind: "adopt", handle: "head-of-people" }, "adopt needs the conversation"],
      [{ kind: "adopt", conversation: "jx7abcd" }, "handle is required"],
      [{ kind: "role", name: "Line lead", handle: "line-lead", line: "Line.cast" }, "line is a workflow slug"],
      [{ kind: "role", name: "Line lead", handle: "line-lead", caps: { cards: 0 } }, "caps.cards is a positive whole number"],
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
  test("a spec with every kind of one work parses and keeps only the known fields; every kind is one work", () => {
    let parsed = 0;
    for (const work of ORG_PROPOSAL_WORKS) {
      const mine = spec.changes.filter((c) => orgWorkOfChange(c.change) === work);
      // The structure kinds alone outnumber a structure proposal's cap, so they parse in two.
      for (let at = 0; at < mine.length; at += ORG_PROPOSAL_MAX[work] ?? mine.length) {
        const r = parseOrgProposalSpec({ ...spec, changes: mine.slice(at, at + (ORG_PROPOSAL_MAX[work] ?? mine.length)), extra: 1 });
        expect(r.errors, work).toEqual([]);
        expect(Object.keys(r.spec!)).toEqual(["title", "summary_md", "mode", "changes"]);
        parsed += r.spec!.changes.length;
        if (work === "structure" && at === 0) expect(r.spec!.changes[0]).toEqual({ change: GOOD.role, rationale: "why role", evidence: [{ label: "3 sessions", href: "https://x" }], expected_effect: "less chatter", risk: "none" });
      }
    }
    expect(parsed).toBe(ORG_CHANGE_KINDS.length);
  });
  test("a proposal holds one kind of work: a mixed spec is refused with how to split it; structure and goals are capped, records are not", () => {
    const r = parseOrgProposalSpec(spec);
    expect(r.spec).toBeNull();
    expect(r.errors).toEqual(["a proposal holds one kind of work, and this one mixes 3 record changes (plan_status, task_status, project_status), 15 structure changes (role, projects, move, retire, scope, budget, trust, routine, project_meta, adopt, file, charter_edit, authority, hire, upgrade) and 4 goal changes (initiative, initiative_projects, initiative_owner, initiative_shape): post the records as one proposal, the structure as another and the goals as a third, each with its own title and summary"]);
    expect(orgProposalWork(spec.changes)).toBeNull();
    expect(orgProposalWork([{ change: GOOD.role }, { change: GOOD.move }])).toBe("structure");
    expect(orgProposalWork([])).toBeNull();
    expect(orgProposalWorkErrors([])).toEqual([]);
    const tasks = (n: number) => Array.from({ length: n }, (_, i) => ({ change: { kind: "task_status", task: `ct-${i}`, status: "done", reason: "landed" }, rationale: "r" }));
    const metas = (n: number) => Array.from({ length: n }, (_, i) => ({ change: { kind: "project_meta", project: `pr-${i}`, priority: "p2" }, rationale: "r" }));
    const goals = (n: number) => Array.from({ length: n }, (_, i) => ({ change: { kind: "initiative", title: `Goal ${i}`, description: "d", projects: ["pr-1"] }, rationale: "r" }));
    expect(ORG_PROPOSAL_MAX).toEqual({ records: null, structure: 12, goals: 12 });
    expect(parseOrgProposalSpec({ ...spec, changes: tasks(64) }).errors).toEqual([]);
    expect(parseOrgProposalSpec({ ...spec, changes: metas(12) }).errors).toEqual([]);
    expect(parseOrgProposalSpec({ ...spec, changes: metas(13) }).errors).toEqual(["a structure proposal holds at most 12 changes, and this one has 13: split it by area (one proposal per lead, project or goal) or leave the smaller changes for the next review"]);
    expect(parseOrgProposalSpec({ ...spec, changes: goals(13) }).errors).toEqual(["a goal proposal holds at most 12 changes, and this one has 13: split it by area (one proposal per lead, project or goal) or leave the smaller changes for the next review"]);
  });
  test("a task dropped under a plan the same spec closes is refused: the plan's close drops it; a task done on its own evidence keeps its row", () => {
    const plan = (status: string) => ({ change: { kind: "plan_status", plan: "pl-7", status, reason: "every task closed" }, rationale: "r" });
    const task = (status: string, plan?: string) => ({ change: { kind: "task_status", task: "ct-42", status, reason: "landed", ...(plan ? { plan } : {}) }, rationale: "r" });
    const covered = (i: number, j: number, status: string) => `changes[${i}] (mark task ct-42 dropped) is covered by changes[${j}], which marks its plan pl-7 ${status}: closing the plan drops its open tasks, so drop this change (a task finished on its own evidence keeps its own done change)`;
    expect(parseOrgProposalSpec({ ...spec, changes: [plan("done"), task("dropped", "pl-7")] }).errors).toEqual([covered(1, 0, "done")]);
    expect(parseOrgProposalSpec({ ...spec, changes: [task("dropped", "pl-7"), plan("abandoned")] }).errors).toEqual([covered(0, 1, "abandoned")]);
    expect(parseOrgProposalSpec({ ...spec, changes: [plan("done"), task("done", "pl-7")] }).errors).toEqual([]);
    expect(parseOrgProposalSpec({ ...spec, changes: [plan("abandoned"), task("dropped", "pl-8")] }).errors).toEqual([]);
    expect(parseOrgProposalSpec({ ...spec, changes: [plan("done"), task("dropped")] }).errors).toEqual([]);
    expect(parseOrgProposalSpec({ ...spec, changes: [plan("active"), task("dropped", "pl-7")] }).errors).toEqual([]);
    expect(orgRecordRedundancyErrors([plan("done"), task("open", "pl-7")] as any)).toEqual([]);
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
    expect(describeOrgChange(GOOD.trust)).toBe("autonomy @growth on");
    expect(describeOrgChange(GOOD.routine)).toBe("routine on @growth: Weekly funnel every 7d");
    expect(describeOrgChange(GOOD.project_meta)).toBe("charter pr-1 owner @growth p1: Ship the onboarding");
    expect(describeOrgChange(GOOD.adopt)).toBe("adopt session jx7abcd as @head-of-people's standing session");
    expect(describeOrgChange(GOOD.plan_status)).toBe("mark plan pl-7 done");
    expect(describeOrgChange(GOOD.task_status)).toBe("mark task ct-42 done");
    expect(describeOrgChange(GOOD.project_status)).toBe("mark project Legacy paused");
    expect(describeOrgChange(GOOD.initiative)).toBe("set goal Win the private network over Callers, Broker network owned by @calling");
    expect(describeOrgChange(GOOD.initiative_projects)).toBe("goal in-2 +Callers");
    expect(describeOrgChange(GOOD.initiative_owner)).toBe("goal in-2 owner @calling");
    expect(describeOrgChange(GOOD.charter_edit)).toBe('charter @growth: replace "on budget" with "under budget"; add "Reports spend every Monday."');
  });

  test("a record change carries its record's title: the row reads the title with the id beside it, the CLI walk keeps the id", () => {
    const task = { ...GOOD.task_status, title: "Shadow mode for the machine-listening judge" };
    expect(orgChangeError(task)).toBeNull();
    expect(recordChangeParts(task)).toEqual({ act: "mark done", ref: "ct-42", title: "Shadow mode for the machine-listening judge" });
    expect(changeLine(task)).toBe("Mark done: Shadow mode for the machine-listening judge (ct-42)");
    expect(describeOrgChange(task)).toBe("mark task ct-42 done");
    // Without a title the row keeps its old line; a title that repeats the ref is not said twice.
    expect(recordChangeParts(GOOD.task_status)).toEqual({ act: "mark done", ref: "ct-42", title: null });
    expect(changeLine(GOOD.task_status)).toBe("Mark task ct-42 done");
    expect(recordChangeParts({ ...GOOD.project_status, title: "legacy" })).toEqual({ act: "mark paused", ref: "Legacy", title: null });
    expect(changeLine({ ...GOOD.plan_status, title: "  Launch  " })).toBe("Mark done: Launch (pl-7)");
    expect(recordChangeParts(GOOD.budget)).toBeNull();
    expect(orgChangeError({ ...GOOD.task_status, title: 7 })).toBe("task_status title is the task's title, a string");
  });
});

// Bring records in line and tenure (org-staffing.md S9, S10).
describe("status changes, tenure and horizon", () => {
  test("each status kind names its faults; the reason is required", () => {
    expect(orgChangeError({ kind: "plan_status", plan: "pl-1", status: "paused", reason: "x" })).toContain("done, abandoned, active");
    expect(orgChangeError({ kind: "plan_status", plan: "pl-1", status: "done" })).toContain("reason");
  });
  test("authority, hire and upgrade (org-hire.md W8) are checked field by field", () => {
    const a = GOOD.authority as any;
    expect(orgChangeError({ ...a, authority: [] })).toContain("one to fifty");
    expect(orgChangeError({ ...a, authority: [{ ...a.authority[0], kind: "delete" }] })).toContain("spend, publish, write, connect");
    expect(orgChangeError({ ...a, authority: [a.authority[0], a.authority[0]] })).toContain("unique slug id");
    expect(orgChangeError({ ...a, authority: [{ ...a.authority[0], limit: { usd_per_month: -1 } }] })).toContain("non-negative");
    expect(orgChangeError({ ...a, authority: [{ ...a.authority[0], limit: {} }] })).toContain("non-negative");
    expect(orgChangeError({ ...a, authority: [{ ...a.authority[0], expires: "never" }] })).toContain("duration like 90d");
    const h = GOOD.hire as any;
    expect(orgChangeError({ ...h, template: "Growth Pack" })).toContain("slug");
    expect(orgChangeError({ ...h, version: "2" })).toContain("version like 2.0.0");
    expect(orgChangeError({ ...h, digest: "abc" })).toContain("sha256");
    expect(orgChangeError({ ...h, project: "" })).toContain("project ref");
    expect(orgChangeError({ ...h, config: { a: 1 } })).toContain("answers");
    expect(orgChangeError({ ...h, update_policy: "weekly" })).toContain("manual, canary or stable");
    const u = GOOD.upgrade as any;
    expect(orgChangeError({ ...u, to: "next" })).toContain("version and sha256");
    expect(describeOrgChange(GOOD.authority)).toBe("authority @growth: spend (Paid search on the configured campaign), write (Ship pages into the working tree)");
    expect(describeOrgChange(GOOD.hire)).toBe("hire @growth from template growth@2.0.0 on pr-1 as acme-growth");
    expect(describeOrgChange(GOOD.upgrade)).toBe("upgrade instance acme-growth to growth@2.1.0");
    // Order: authority after trust on a role that exists; hire after role, authority and routine; upgrade alone; retire last.
    const kinds = orderOrgChanges(["retire", "hire", "routine", "authority", "role", "upgrade", "trust"] as const, (k) => ({ kind: k } as any));
    expect(kinds).toEqual(["role", "trust", "authority", "routine", "hire", "upgrade", "retire"]);
    const deps = orgChangeDependencies([{ seq: 1, change: GOOD.role }, { seq: 2, change: GOOD.authority }, { seq: 3, change: GOOD.hire }]);
    expect(deps[2]).toContain("authority for the role #1 creates");
    expect(deps[3]).toContain("hires the role #1 creates");
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

// The company's goals (initiatives-projects-role-page.md "I1, revised"): three
// kinds, one sentence each for a person who has not read the letter, one ask.
describe("goal changes", () => {
  test("each kind names its first fault", () => {
    expect(orgChangeError({ kind: "initiative", title: "Win" })).toContain("description");
    expect(orgChangeError({ kind: "initiative", title: "Win", description: "d", projects: [] })).toContain("non-empty list of project refs");
    expect(orgChangeError({ kind: "initiative", title: "Win", description: "d", projects: ["p"], owner: " " })).toContain("owner is");
    expect(orgChangeError({ kind: "initiative_projects", initiative: "in-2" })).toContain("projects is a non-empty list");
    expect(orgChangeError({ kind: "initiative_owner", initiative: "in-2" })).toContain("owner is");
    expect(orgChangeError({ kind: "initiative", title: "Win", description: "d", projects: ["p"], target_date: 1_800_000_000_000 })).toBeNull();
  });
  test("the sentence reads cold, with the owner as written and \"me\" as you", () => {
    expect(changeLine(GOOD.initiative)).toBe("Set a goal: Win the private network, carried by Callers and Broker network, owned by @calling");
    expect(changeLine({ ...GOOD.initiative, owner: "me" } as any)).toBe("Set a goal: Win the private network, carried by Callers and Broker network, owned by you");
    expect(changeLine({ ...GOOD.initiative, owner: undefined } as any)).toBe("Set a goal: Win the private network, carried by Callers and Broker network");
    expect(changeLine(GOOD.initiative_projects)).toBe("Add Callers to the goal Win the private network");
    expect(changeLine({ kind: "initiative_projects", initiative: "in-2", projects: ["Callers", "Broker network"] })).toBe("Add Callers and Broker network to the goal in-2");
    expect(changeLine(GOOD.initiative_owner)).toBe("Make @calling the owner of the goal Win the private network");
    expect(changeLine({ kind: "initiative_owner", initiative: "in-2", owner: "Ashot Petrosian" })).toBe("Make Ashot Petrosian the owner of the goal in-2");
    // The tree and the numbers (I4): on the create, and on a goal that exists.
    expect(changeLine({ ...GOOD.initiative, parent: "Reach 1k teams", metrics: [{ name: "Brokers live", target: "40" }, { name: "Weekly active teams", target: "1,000" }] })).toBe("Set a goal: Win the private network, carried by Callers and Broker network, owned by @calling, under Reach 1k teams, measured by Brokers live (target 40) and Weekly active teams (target 1,000)");
    expect(changeLine(GOOD.initiative_shape)).toBe("Put the goal Win the private network under Reach 1k teams and measured by Brokers live (target 40)");
    expect(changeLine({ kind: "initiative_shape", initiative: "in-2", parent: null })).toBe("Make the goal in-2 a top level goal");
    expect(changeLine({ kind: "initiative_shape", initiative: "in-2", metrics: [] })).toBe("Put the goal in-2 with no metric");
    expect(orgChangeError({ kind: "initiative_shape", initiative: "in-2" })).toContain("needs a parent, metrics, why");
    expect(orgChangeError({ kind: "initiative_shape", initiative: "in-2", metrics: [{ name: "A", target: "1" }, { name: "B", target: "2" }, { name: "C", target: "3" }] })).toContain("at most two");
    expect(orgChangeError({ ...GOOD.initiative, metrics: [{ name: "A" }] })).toContain("{ name, target }");
  });
  // The intent record (I5 "Proposals"): a goal change may carry why, done
  // when, milestones, sources, questions and decisions. The sentence stays
  // short and the words are the effect's.
  test("a goal change carries its record: validated, counted in the sentence, written out in the effect", async () => {
    const { deriveAsks } = await import("./orgProposal");
    const record = { why: "Brokers bring the sellers", done_when: "Three brokers trade through us.", milestones: [{ title: "Quiet onboarded", date: Date.UTC(new Date().getUTCFullYear(), 10, 1) }, { title: "Second broker live" }], sources: ["call:cl-42#14 our goal is three brokers", "jx7c6zk:142"] };
    const set = { ...GOOD.initiative, ...record } as const;
    expect(orgChangeError(set)).toBeNull();
    expect(changeLine(set)).toBe("Set a goal: Win the private network, carried by Callers and Broker network, owned by @calling, with 2 milestones");
    expect(describeOrgChange(set)).toBe("set goal Win the private network over Callers, Broker network owned by @calling why done_when +2 milestones +2 sources");
    expect(deriveAsks([{ seq: 1, change: set }] as any)[0].effect).toBe("A new goal, Win the private network, appears on the goals page with the Callers and Broker network projects under it and calling as its owner. Quiet is onboarded and three brokers trade through us. Why it matters: Brokers bring the sellers. Done when: Three brokers trade through us. Milestones: Quiet onboarded (Nov 1); Second broker live. Its record says where it was stated (2 sources).");
    const shape = { kind: "initiative_shape", initiative: "in-2", title: "Win the private network", ...record, questions: ["Do we price per seat?"], decisions: ["Ship to brokers first", "Quiet goes first."] } as const;
    expect(orgChangeError(shape)).toBeNull();
    expect(changeLine(shape)).toBe("Record on the goal Win the private network: why it matters, what done looks like, 2 milestones, an open question, 2 decisions and 2 places it was stated");
    expect(changeLine({ kind: "initiative_shape", initiative: "in-2", parent: "Reach 1k teams", milestones: [{ title: "Quiet onboarded" }], sources: ["ct-12"] })).toBe("Put the goal in-2 under Reach 1k teams, and record the milestone Quiet onboarded and where it was stated");
    expect(describeOrgChange(shape)).toBe("goal in-2 why done_when +2 milestones +1 questions +2 decisions +2 sources");
    expect(deriveAsks([{ seq: 1, change: { kind: "initiative_shape", initiative: "in-2", metrics: [{ name: "Brokers live", target: "40" }], questions: shape.questions, decisions: shape.decisions } }] as any)[0].effect).toBe("On track means against Brokers live (target 40); its owner reports the numbers. Still open: Do we price per seat? Decided: Ship to brokers first. Quiet goes first.");
    // Each list adds, so an empty one changes nothing, and each is held to the row's own cap.
    expect(orgChangeError({ kind: "initiative_shape", initiative: "in-2", questions: [] })).toContain("what it changes about the goal");
    expect(orgChangeError({ kind: "initiative_shape", initiative: "in-2", why: "It pays for the rest." })).toBeNull();
    expect(orgChangeError({ ...GOOD.initiative, why: " " })).toContain("why is a string");
    expect(orgChangeError({ ...GOOD.initiative, done_when: 3 })).toContain("done_when is a string");
    expect(orgChangeError({ ...GOOD.initiative, milestones: [{ title: "A", date: "Nov 1" }] })).toContain("{ title, date? }");
    expect(orgChangeError({ ...GOOD.initiative, milestones: Array.from({ length: 13 }, (_, i) => ({ title: `Step ${i}` })) })).toContain("at most 12");
    expect(orgChangeError({ ...GOOD.initiative, sources: [""] })).toContain("sources is a list of at most 20 strings");
    expect(orgChangeError({ kind: "initiative_shape", initiative: "in-2", decisions: [7] })).toContain("decisions is a list of at most 40 strings");
    // Two shape rows about one goal fold into one, and their lists join: each adds, so they cannot disagree. The words still can.
    const { foldRepeatedSubjects } = await import("./orgProposal");
    const two = foldRepeatedSubjects([
      { change: { kind: "initiative_shape", initiative: "in-2", parent: "Reach 1k teams", questions: ["Do we price per seat?"] }, rationale: "a" },
      { change: { kind: "initiative_shape", initiative: "in-2", questions: ["Do we price per seat?", "Who signs?"], decisions: ["Ship to brokers first"] }, rationale: "b" },
    ]);
    expect(two.errors).toEqual([]);
    expect(two.changes.map((c) => c.change)).toEqual([{ kind: "initiative_shape", initiative: "in-2", parent: "Reach 1k teams", questions: ["Do we price per seat?", "Who signs?"], decisions: ["Ship to brokers first"] }]);
    expect(foldRepeatedSubjects([{ change: { kind: "initiative_shape", initiative: "in-2", why: "a" } }, { change: { kind: "initiative_shape", initiative: "in-2", why: "b" } }]).errors[0]).toContain("with a different why");
    expect(orgChangeError({ kind: "initiative_shape", initiative: "in-2", questions: Array.from({ length: 21 }, (_, i) => `Q${i}?`) })).toContain("questions is a list of at most 20 strings");
    // A new goal may carry the questions and decisions too: the card prints them, so they are held to the same rules and written on accept.
    const asked = { ...GOOD.initiative, questions: ["Do we price per seat?"], decisions: ["Ship to brokers first"] };
    expect(orgChangeError(asked)).toBeNull();
    expect(deriveAsks([{ seq: 1, change: asked }] as any)[0].effect).toContain("Still open: Do we price per seat? Decided: Ship to brokers first.");
    expect(describeOrgChange(asked)).toContain("+1 questions +1 decisions");
    expect(orgChangeError({ ...GOOD.initiative, decisions: [7] })).toContain("initiative decisions is a list of at most 40 strings");
    expect(orgChangeError({ ...GOOD.initiative, questions: Array.from({ length: 21 }, (_, i) => `Q${i}?`) })).toContain("initiative questions is a list of at most 20 strings");
  });
  test("one subject per proposal, and the owner handle counts as a role the change names", async () => {
    const { orgChangeKey, orgChangeHandles } = await import("./orgProposal");
    expect(orgChangeKey(GOOD.initiative)).toBe("initiative:win the private network");
    expect(orgChangeKey(GOOD.initiative_projects)).toBe("initiative_projects:in-2");
    expect(orgChangeKey(GOOD.initiative_owner)).toBe("initiative_owner:in-2");
    expect(orgChangeHandles(GOOD.initiative)).toEqual(["calling"]);
    expect(orgChangeHandles(GOOD.initiative_owner)).toEqual(["calling"]);
  });
  test("goals land after the projects and roles they name and before moves; every goal change is one ask", async () => {
    const { deriveAsks } = await import("./orgProposal");
    expect(ORG_CHANGE_APPLY_RANK.initiative).toBeGreaterThan(ORG_CHANGE_APPLY_RANK.role);
    expect(ORG_CHANGE_APPLY_RANK.initiative).toBeGreaterThan(ORG_CHANGE_APPLY_RANK.projects);
    expect(ORG_CHANGE_APPLY_RANK.initiative_owner).toBeLessThan(ORG_CHANGE_APPLY_RANK.move);
    const one = deriveAsks([{ seq: 1, change: GOOD.initiative, rationale: "Three projects say the same goal.", expected_effect: "One page says what winning looks like." }]);
    expect(one).toEqual([{ title: "Set a goal: Win the private network, carried by Callers and Broker network, owned by @calling", why: "Three projects say the same goal.", effect: "One page says what winning looks like.", seqs: [1] }]);
    const names = { role: (h: string) => (h === "calling" ? "Calling lead" : undefined), project: (r: string) => (r === "Callers" ? "Callers & Call Management" : undefined), initiative: (r: string) => (r === "in-2" ? "Win the private network" : undefined) };
    const many = deriveAsks([
      { seq: 1, change: { kind: "task_status", task: "ct-1", status: "done", reason: "x" } },
      { seq: 2, change: GOOD.initiative_owner },
      { seq: 3, change: { kind: "initiative", title: "Grow trades", description: "d", projects: ["Matching"] } },
      { seq: 4, change: { kind: "initiative_projects", initiative: "in-2", projects: ["Callers"] } },
      { seq: 5, change: { kind: "role", name: "Calling lead", handle: "calling" } },
    ] as any, names);
    expect(many.map((a) => [a.title, a.seqs])).toEqual([
      ["Mark the task ct-1 as done", [1]],
      ["1 goal to set, and 2 changes to the goals that exist", [2, 3, 4]],
      ["Add an agent: Calling lead", [5]],
    ]);
    // With names, a lone change speaks in the tree's names, not the refs.
    expect(deriveAsks([{ seq: 1, change: { kind: "initiative_projects", initiative: "in-2", projects: ["Callers"] } }] as any, names)[0].title).toBe("Add Callers & Call Management to the goal Win the private network");
    expect(deriveAsks([{ seq: 1, change: GOOD.initiative_owner }] as any, names)[0].effect).toBe("Calling lead drives the goal from now on: its health is what they say, and the goal's projects join their area.");
  });
});

describe("a proposal carries one change per subject", () => {
  const spec = (changes: any[]) => parseOrgProposalSpec({ title: "t", summary_md: "s", mode: "review", changes });
  test("the same task status twice folds into one row, named; a different status is refused with both positions named", () => {
    const c = (task: string, status = "open", reason = "never worked") => ({ change: { kind: "task_status", task, status, reason }, rationale: "r" });
    const twice = spec([c("ct-1"), c("ct-2"), c("ct-1", "open", "its plan moved on")]);
    expect(twice.errors).toEqual([]);
    expect(twice.spec!.changes.map((x) => (x.change as any).task)).toEqual(["ct-1", "ct-2"]);
    expect((twice.spec!.changes[0].change as any).reason).toBe("never worked\n\nits plan moved on");
    expect((twice as any).notes).toEqual(["changes[2] (mark task ct-1 open) folded into changes[0]: one change per subject"]);
    const conflict = spec([c("ct-1"), c("ct-2"), c("ct-1", "done")]);
    expect(conflict.spec).toBeNull();
    expect(conflict.errors).toEqual(["changes[2] (mark task ct-1 done) repeats changes[0] with a different status: one change per subject"]);
    expect(spec([c("ct-1"), c("ct-2")]).errors).toEqual([]);
    expect((spec([c("ct-1"), c("ct-2")]) as any).notes).toBeUndefined();
  });
  // The analyzer builds a spec from lists: a project in its charter list and
  // in its owner list arrives as two project_meta rows. One row can carry
  // both, so the parser folds them and the post never refuses the spec.
  test("a project's charter and its owner, handed in as two project_meta rows, become one row with both fields and all the evidence", () => {
    const goal = { change: { kind: "project_meta", project: "pr-7", goal: "Inbox zero on issue clusters" }, rationale: "The project's own tasks say so.", evidence: [{ label: "31 tasks", href: "https://x/pr-7" }], expected_effect: "A goal on the page." };
    const owner = { change: { kind: "project_meta", project: "pr-7", owner: "@agent-quality" }, rationale: "The new seat owns the line.", evidence: [{ label: "31 tasks", href: "https://x/pr-7" }, { label: "the role", href: "https://x/or-3" }], risk: "None." };
    const r = spec([goal, { change: { kind: "file", plan: "pl-1", project: "pr-7" }, rationale: "r" }, owner]);
    expect(r.errors).toEqual([]);
    expect(r.spec!.changes.length).toBe(2);
    expect(r.spec!.changes[0]).toEqual({
      change: { kind: "project_meta", project: "pr-7", goal: "Inbox zero on issue clusters", owner: "@agent-quality" },
      rationale: "The project's own tasks say so.\n\nThe new seat owns the line.",
      evidence: [{ label: "31 tasks", href: "https://x/pr-7" }, { label: "the role", href: "https://x/or-3" }],
      expected_effect: "A goal on the page.",
      risk: "None.",
    });
    expect((r as any).notes).toEqual(["changes[2] (charter pr-7 owner @agent-quality) folded into changes[0]: one change per subject"]);
    // The same field with a different value is a disagreement, not a repeat.
    const two = spec([goal, { ...goal, change: { ...goal.change, goal: "Something else" } }]);
    expect(two.spec).toBeNull();
    expect(two.errors[0]).toContain("with a different goal");
  });
});

// S19: a proposal is a few asks with its changes folded inside each. The
// author writes them; the parser holds the partition; a proposal with none
// derives them, so nothing old stops rendering.
describe("asks partition a proposal's changes", () => {
  const task = (t: string) => ({ change: { kind: "task_status", task: t, status: "done", reason: "landed" }, rationale: "r" });
  const role = { change: { kind: "role", name: "Head of Quality", handle: "quality", tenure: { kind: "standing" } }, rationale: "Nobody watches the quality line.", expected_effect: "One daily list of fixes waiting on you." };
  const plan = { change: { kind: "plan_status", plan: "pl-9", status: "done", reason: "every task closed" }, rationale: "r" };
  const ask = (title: string, seqs: number[]) => ({ title, why: "why", effect: "effect", seqs });
  const spec = (changes: any[], asks?: any) => parseOrgProposalSpec({ title: "t", summary_md: "s", mode: "review", changes, ...(asks !== undefined ? { asks } : {}) });

  test("a partition parses and is kept; a spec without asks carries none", () => {
    const r = spec([task("ct-1"), task("ct-2"), plan], [ask("Close two tasks", [1, 2]), ask("Close the plan", [3])]);
    expect(r.errors).toEqual([]);
    expect(r.spec!.asks).toEqual([{ title: "Close two tasks", why: "why", effect: "effect", seqs: [1, 2] }, { title: "Close the plan", why: "why", effect: "effect", seqs: [3] }]);
    expect(spec([task("ct-1")]).spec!.asks).toBeUndefined();
  });
  test("a change in no ask, in two asks, or an ask naming a change that is not there is refused, naming the change", () => {
    const left = spec([task("ct-1"), task("ct-2"), plan], [ask("a", [1]), ask("b", [3])]);
    expect(left.spec).toBeNull();
    expect(left.errors).toEqual(["changes[1] (mark task ct-2 done) is in no ask: every change belongs to exactly one ask"]);
    const twice = spec([task("ct-1"), plan], [ask("a", [1, 2]), ask("b", [2])]);
    expect(twice.errors).toEqual(["changes[1] (mark plan pl-9 done) is in asks[0] and asks[1]: every change belongs to exactly one ask"]);
    expect(spec([task("ct-1")], [ask("a", [1, 9])]).errors).toEqual(["asks[0] names change 9, and the spec has 1"]);
    expect(spec([task("ct-1")], []).errors).toEqual(["asks is a non-empty list of { title, why, effect, seqs }"]);
    expect(spec([task("ct-1")], [{ title: "a", seqs: [1] }]).errors).toEqual(["asks[0]: title, why and effect are required"]);
    expect(spec([task("ct-1")], [{ title: "a", why: "w", effect: "e", seqs: [0] }]).errors).toEqual(["asks[0]: seqs is a non-empty list of change numbers (1 is the first change)"]);
    // A long miss is capped, so a spec that forgot a hundred rows reads in one screen.
    const many = spec(Array.from({ length: 14 }, (_, i) => task(`ct-${i}`)), [ask("a", [1])]);
    expect(many.errors.length).toBe(11);
    expect(many.errors[10]).toBe("and 3 more changes outside the partition");
  });
  test("asks name changes as written, and survive the fold: a folded row answers to the ask of the row it folded into", () => {
    const goal = { change: { kind: "project_meta", project: "pr-7", goal: "Inbox zero" }, rationale: "r" };
    const owner = { change: { kind: "project_meta", project: "pr-7", owner: "@quality" }, rationale: "r" };
    const file = { change: { kind: "file", plan: "pl-3", project: "pr-7" }, rationale: "r" };
    const r = spec([file, goal, role, owner], [ask("Filing", [1]), ask("Goals", [2]), ask("The agent", [3, 4])]);
    expect(r.errors).toEqual([]);
    expect(r.spec!.changes.length).toBe(3);
    // The goal sat in the goals ask and the owner in the agent's ask. The
    // merged row names @quality as owner, so it follows the ask that creates
    // @quality: accepting the goals alone never sets an owner nobody accepted.
    expect(r.spec!.asks!.map((a) => [a.title, a.seqs])).toEqual([["Filing", [1]], ["The agent", [2, 3]]]);
    expect(r.spec!.asks!.flatMap((a) => a.seqs).sort()).toEqual([1, 2, 3]);
    // With no ask creating the agent it names, the first ask that named the row keeps it.
    const plain = spec([file, goal, owner], [ask("Goals", [2]), ask("Rest", [1, 3])]);
    expect(plain.spec!.asks!.map((a) => a.seqs)).toEqual([[2], [1]]);
  });
  test("deriveAsks: each record group is one ask, each role, retire, move, scope and charter edit its own with its riders, the rest one ask; removed rows are in none", async () => {
    const { deriveAsks, resolveOrgAsks } = await import("./orgProposal");
    const rows = [
      { seq: 1, change: { kind: "plan_status", plan: "pl-1", status: "done", reason: "x" } },
      { seq: 2, change: { kind: "task_status", task: "ct-1", status: "dropped", reason: "x", plan: "pl-1" } },
      { seq: 3, change: { kind: "file", plan: "pl-2", project: "pr-1" } },
      { seq: 4, change: role.change, rationale: role.rationale, expected_effect: role.expected_effect },
      { seq: 5, change: { kind: "routine", handle: "@quality", title: "Daily list", prompt: "p", every: "1d" } },
      { seq: 6, change: { kind: "retire", handle: "test-lead" } },
      { seq: 7, change: { kind: "project_meta", project: "pr-1", goal: "g" } },
      { seq: 8, change: { kind: "budget", handle: "growth", caps: { wakes_per_day: 10 } } },
      { seq: 9, change: { kind: "task_status", task: "ct-9", status: "done", reason: "x" }, status: "removed" },
    ] as any[];
    const asks = deriveAsks(rows);
    expect(asks.map((a) => [a.title, a.seqs])).toEqual([
      ["Settle 2 records under the plan pl-1", [1, 2]],
      ["Add an agent: Head of Quality", [4, 5]],
      ["Retire test-lead", [6]],
      // Three rows ride in the ask; the words count two, because the limit (seq 8) is never a row a person reads (S23.2).
      ["2 smaller changes: filing, goals and settings", [3, 7, 8]],
    ]);
    expect(asks[0].effect).toBe("1 plan done and 1 task dropped. No work starts or stops.");
    expect(asks[1].why).toBe("Nobody watches the quality line.");
    expect(asks[1].effect).toBe("One daily list of fixes waiting on you.");
    // A derived ask with no words of its own reads as sentences: no handle,
    // no parenthetical tenure, the riders said in the same breath.
    expect(asks[2].effect).toBe("test-lead retires. Its sessions go back to their owners, and anything under it reports one level up.");
    expect(asks[2].why).toBe("The author did not say why. Ask about this.");
    const bare = deriveAsks([
      { seq: 1, change: { kind: "role", name: "Head of Platform", handle: "platform", reports_to: "me", scope: { projects: ["Platform"] }, charter: "Owns the sync layer.", tenure: { kind: "standing" } } },
      { seq: 2, change: { kind: "budget", handle: "platform", caps: { tokens_per_day: 800_000 } } },
      { seq: 3, change: { kind: "routine", handle: "@platform", title: "Release check", prompt: "p", every: "1d" } },
      { seq: 4, change: { kind: "role", name: "Content Lead", handle: "content", reports_to: "@growth", scope: { plans: ["pl-88"] }, tenure: { kind: "program", ends: { plan: "pl-88" }, then: "review" } } },
      { seq: 5, change: { kind: "move", handle: "@ops", reports_to: "@growth", scope_add: ["pr-1"], scope_remove: ["pr-2"] } },
      { seq: 6, change: { kind: "scope", handle: "product", add: ["Calls"] } },
    ] as any[]);
    expect(bare.map((a) => [a.title, a.why, a.effect])).toEqual([
      ["Add an agent: Head of Platform", "The author did not say why. Ask about this.", "A new agent, Head of Platform, reporting to you and looking after the Platform project. It stays until you retire it. It runs Release check every day." /* the limit rider says nothing (S23.2) */],
      ["Add an agent: Content Lead", "The author did not say why. Ask about this.", "A new agent, Content Lead, reporting to growth and looking after the pl-88 plan. It ends with the pl-88 plan, then comes up for review."],
      ["Move ops", "The author did not say why. Ask about this.", "ops reports to growth from now on, takes on pr-1 and hands off pr-2."],
      ["Change what product looks after", "The author did not say why. Ask about this.", "product takes on Calls."],
    ]);
    // With names from the chart, the handles and refs become what the person calls them.
    const names = { role: (h: string) => ({ growth: "Growth lead", ops: "Ops" } as Record<string, string>)[h], project: (r: string) => ({ "pr-1": "Calls", "pr-2": "Billing" } as Record<string, string>)[r], plan: (r: string) => ({ "pl-88": "SEO" } as Record<string, string>)[r] };
    const named = deriveAsks([
      { seq: 4, change: { kind: "role", name: "Content Lead", handle: "content", reports_to: "@growth", scope: { plans: ["pl-88"] }, tenure: { kind: "program", ends: { plan: "pl-88" }, then: "retire" } } },
      { seq: 5, change: { kind: "move", handle: "@ops", reports_to: "@growth", scope_add: ["pr-1"], scope_remove: ["pr-2"] } },
    ] as any[], names);
    expect(named.map((a) => [a.title, a.effect])).toEqual([
      ["Add an agent: Content Lead", "A new agent, Content Lead, reporting to Growth lead and looking after the SEO plan. It ends with the SEO plan, then retires."],
      ["Move Ops", "Ops reports to Growth lead from now on, takes on the Calls project and hands off the Billing project."],
    ]);
    // Every live change is in exactly one ask.
    expect(asks.flatMap((a) => a.seqs).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(deriveAsks([])).toEqual([]);
    // Stored asks lose a removed change and gain a derived ask for a change a revise added.
    const stored = [{ title: "Records", why: "w", effect: "e", seqs: [1, 2, 9] }, { title: "The agent", why: "w", effect: "e", seqs: [4, 5] }];
    const resolved = resolveOrgAsks(stored, rows);
    expect(resolved.slice(0, 2).map((a) => a.seqs)).toEqual([[1, 2], [4, 5]]);
    expect(resolved.slice(2).map((a) => [a.title, a.seqs])).toEqual([["Retire test-lead", [6]], ["2 smaller changes: filing, goals and settings", [3, 7, 8]]]);
    expect(resolveOrgAsks(undefined, rows)).toEqual(asks);
  });
});

describe("what one change needs from another (orgChangeDependencies)", () => {
  test("a role, its adopt and its routine name each other by seq; unrelated rows say nothing", async () => {
    const { orgChangeDependencies } = await import("./orgProposal");
    const rows = [
      { seq: 1, change: { kind: "role", name: "Head of People", handle: "head-of-people" } as OrgChange },
      { seq: 2, change: { kind: "routine", handle: "@head-of-people", title: "Review", prompt: "p", every: "7d" } as OrgChange },
      { seq: 3, change: { kind: "adopt", handle: "head-of-people", conversation: "jx733c7" } as OrgChange },
      { seq: 4, change: { kind: "role", name: "Growth", handle: "growth" } as OrgChange },
      { seq: 5, change: { kind: "file", plan: "pl-1", project: "P" } as OrgChange },
    ];
    expect(orgChangeDependencies(rows)).toEqual({
      1: "created without a standing session; #3 seats it",
      2: "runs on the session #3 seats",
      3: "seats the role #1 creates; skip it and that role is provisioned a fresh session instead",
    });
    expect(orgChangeDependencies(rows.slice(3))).toEqual({});
  });
});

// org-roles-run-work.md R2: a long running session is a role that has not been named.
describe("a role that names an existing session (seat)", () => {
  const NOW = Date.UTC(2026, 8, 18);
  const seat = { existing: "jx7b88a", title: "Market growth mandate", started_at: NOW - 34 * 86_400_000, helpers: 391 };
  const role = { kind: "role", name: "Market growth mandate", handle: "market-growth", seat, scope: { projects: ["Growth"] }, reports_to: "me" } as OrgChange;

  test("the sentence says what it is and what naming changes, from what the author read; missing facts shorten it", async () => {
    const { seatSentence } = await import("./orgProposal");
    expect(seatSentence(seat, NOW)).toBe("This is Market growth mandate, which has run for 34 days with 391 helper sessions. Naming it changes nothing about how it works and gives it a place on the chart.");
    expect(seatSentence({ existing: "jx7b88a", helpers: 1 }, NOW)).toBe("This is the session jx7b88a, which has started 1 helper session. Naming it changes nothing about how it works and gives it a place on the chart.");
    expect(seatSentence({ existing: "jx7b88a", title: "Ops" }, NOW)).toBe("This is Ops. Naming it changes nothing about how it works and gives it a place on the chart.");
  });

  test("validates, and describes as naming a session, never as creating a role", async () => {
    const { orgChangeError, describeOrgChange } = await import("./orgProposal");
    expect(orgChangeError(role)).toBeNull();
    expect(orgChangeError({ ...role, seat: {} })).toContain("seat is { existing");
    expect(orgChangeError({ ...role, seat: { existing: "jx7b88a", helpers: -1 } })).toContain("helpers is a count");
    // Naming keeps the session's reporting line; a role as parent is a separate move.
    expect(orgChangeError({ ...role, reports_to: "@matching" })).toContain("keeps the session's reporting line");
    expect(orgChangeError({ ...role, reports_to: undefined })).toBeNull();
    expect(describeOrgChange(role)).toBe("name session jx7b88a as role Market growth mandate @market-growth reporting to me over Growth");
  });

  test("its derived ask carries the sentence, and a routine on it runs on the session it names", async () => {
    const { deriveAsks, orgChangeDependencies } = await import("./orgProposal");
    const [ask] = deriveAsks([{ seq: 1, change: role }]);
    expect(ask.title).toBe("Name Market growth mandate as a role");
    expect(ask.effect).toContain("Naming it changes nothing about how it works");
    expect(ask.effect).toContain("It becomes a role, reporting to you and looking after the Growth project.");
    // A move on the named role rides in its ask as its own sentence, so the person can skip it.
    const [withMove] = deriveAsks([{ seq: 1, change: role }, { seq: 2, change: { kind: "move", handle: "market-growth", reports_to: "@matching", reason: "same area" } as OrgChange }]);
    expect(withMove.seqs).toEqual([1, 2]);
    expect(withMove.effect).toContain("A separate change puts it under matching; skip that and it keeps reporting to whoever runs it today.");
    expect(orgChangeDependencies([{ seq: 1, change: role }, { seq: 2, change: { kind: "routine", handle: "market-growth", title: "Daily run", prompt: "p", every: "1d" } as OrgChange }])).toEqual({ 2: "runs on the session #1 seats" });
  });

  test("one session is one role, and a role that names its session carries no adopt", async () => {
    const { parseOrgProposalSpec } = await import("./orgProposal");
    const spec = (changes: OrgChange[]) => parseOrgProposalSpec({ title: "t", summary_md: "s", mode: "review", changes: changes.map((change) => ({ change, rationale: "r" })) });
    expect(spec([role]).errors).toEqual([]);
    expect((spec([role]).spec!.changes[0].change as any).seat).toEqual(seat);
    expect(spec([role, { ...role, handle: "growth-two" } as OrgChange]).errors[0]).toContain("one session is one role");
    expect(spec([role, { kind: "adopt", handle: "@market-growth", conversation: "jx7b88a" }]).errors[0]).toContain("needs no adopt");
  });
});

describe("a verdict is read against what the page showed (S18)", () => {
  const rows = (...ats: Array<number | null>) => ats.map((at) => (at === null ? {} : { revision: { at } }));

  test("the latest revise is read off the rows; no revise is 0", () => {
    expect(latestOrgRevisionAt(rows(null, null))).toBe(0);
    expect(latestOrgRevisionAt(rows(null, 7, 3))).toBe(7);
  });

  test("a verdict that names the revise it read and the seqs its card held stands; one that names another revise or other seqs does not", () => {
    expect(orgVerdictSeenFault("op-1", { revised_at: 7, seqs: [3, 2] }, rows(7, 3), [2, 3])).toBeNull();
    expect(orgVerdictSeenFault("op-1", { revised_at: 7 }, rows(7, 3))).toBeNull();
    expect(orgVerdictSeenFault("op-1", { revised_at: 3, seqs: [2] }, rows(7, 3), [2])).toBe(`op-1 ${ORG_VERDICT_REVISED}`);
    expect(orgVerdictSeenFault("op-1", { revised_at: 7, seqs: [2] }, rows(7, 3), [3])).toBe(`op-1 ${ORG_VERDICT_REVISED}`);
    expect(orgVerdictSeenFault("op-1", { revised_at: 7 }, rows(7, 3), [3])).toBe(`op-1 ${ORG_VERDICT_REVISED}`);
  });

  test("a caller that says nothing is taken only on a proposal nobody revised", () => {
    expect(orgVerdictSeenFault("op-1", undefined, rows(null, null))).toBeNull();
    expect(orgVerdictSeenFault("op-1", undefined, rows(null, 5))).toBe(`op-1 ${ORG_VERDICT_REVISED}`);
    expect(orgVerdictSeenFault("op-1", { revised_at: 0 }, rows(null, null))).toBeNull();
  });
});

// org-roles-run-work.md R1: which changes take sessions over, in the words
// the preview query takes, and the one sentence that says what moves.
describe("orgChangeTakeover and takeoverPhrase", () => {
  const { orgChangeTakeover, orgChangeTakesOver, takeoverPhrase } = require("./orgProposal");

  test("a change takes over only when a scope gains something, and says what in typed refs", () => {
    expect(orgChangeTakeover({ kind: "role", name: "Growth", handle: "growth", scope: { projects: ["pr-1", "project:Billing"], plans: ["pl-7"] } })).toEqual({ handle: "growth", add: ["project:pr-1", "project:Billing", "plan:pl-7"] });
    expect(orgChangeTakeover({ kind: "scope", handle: "@growth", add: ["pr-2"] })).toEqual({ handle: "@growth", add: ["pr-2"] });
    expect(orgChangeTakeover({ kind: "move", handle: "growth", scope_add: ["pl-3"] })).toEqual({ handle: "growth", add: ["pl-3"] });
    // An adopt gains nothing itself: the seated role takes what its scope already holds.
    expect(orgChangeTakeover({ kind: "adopt", handle: "growth", conversation: "jx70001" })).toEqual({ handle: "growth", add: [] });
    // The session a role names is its seat by then, so it is named as one that never moves.
    expect(orgChangeTakeover({ kind: "role", name: "Growth", handle: "growth", scope: { projects: ["pr-1"] }, seat: { existing: "jx70009" } } as any)?.seat).toBe("jx70009");
  });

  test("no scope gained, or the change already leaves the sessions: nothing moves", () => {
    for (const c of [
      { kind: "role", name: "Ops", handle: "ops" },
      { kind: "scope", handle: "growth", remove: ["pr-1"] },
      { kind: "move", handle: "growth", reports_to: "me" },
      { kind: "scope", handle: "growth", add: ["pr-2"], leave_sessions: true },
      { kind: "budget", handle: "growth", caps: { wakes_per_day: 3 } },
      { kind: "retire", handle: "growth" },
    ] as any[]) expect(orgChangeTakesOver(c)).toBe(false);
  });

  test("the sentence reads from a result or from counts, and says what was told only after the apply", () => {
    expect(takeoverPhrase("growth", { sessions: ["a"], kept_in_front: [], over_cap: 0 }, false)).toBe("1 session now reports to @growth and leaves your needs input");
    expect(takeoverPhrase("@growth", { sessions: 12, kept_in_front: 2, over_cap: 5 }, false)).toBe("12 sessions now report to @growth and leave your needs input; 2 of them stay in front of you with a question still open; 5 more stay where they are until the next change");
    expect(takeoverPhrase("growth", { sessions: ["a", "b"], kept_in_front: [], over_cap: 0, told: { sessions: 1, deferred: 1 } }, true)).toBe("2 sessions now report to @growth and leave your needs input; 1 told now, 1 will read it on their next turn");
    expect(takeoverPhrase("growth", { sessions: [], kept_in_front: [], over_cap: 0 }, false)).toBe("");
    expect(takeoverPhrase("growth", null, true)).toBe("");
  });
});

describe("the switch in a spec (org-staffing.md S23.1)", () => {
  test("autonomy { on } maps onto the stored kind: on is direct, off is understand", () => {
    expect(normalizeAutonomyChange({ kind: "autonomy", handle: "growth", on: true })).toEqual({ kind: "trust", handle: "growth", trust: "direct" });
    expect(normalizeAutonomyChange({ kind: "autonomy", handle: "growth", on: false })).toEqual({ kind: "trust", handle: "growth", trust: "understand" });
    expect(normalizeAutonomyChange({ kind: "scope", handle: "growth", add: ["pr-1"] })).toEqual({ kind: "scope", handle: "growth", add: ["pr-1"] });
  });
  test("parseOrgProposalSpec accepts the autonomy spelling and the words never say a stage", () => {
    const r = parseOrgProposalSpec({ title: "t", summary_md: "s", mode: "review", changes: [{ change: { kind: "autonomy", handle: "growth", on: false }, rationale: "quiet quarter" }] });
    expect(r.errors).toEqual([]);
    const c = r.spec!.changes[0].change as any;
    expect(c).toEqual({ kind: "trust", handle: "growth", trust: "understand" });
    expect(changeLine(c)).toBe("@growth stops starting work on its own");
    const bad = parseOrgProposalSpec({ title: "t", summary_md: "s", mode: "review", changes: [{ change: { kind: "autonomy", handle: "growth", on: "maybe" }, rationale: "r" }] });
    expect(bad.errors.join("\n")).toContain("autonomy on is true or false");
  });
});

// A role that owns a project's line (line-profile.md LP7): the person reads
// the workflow and the cards cap they are approving.
describe("a role proposal with a line", () => {
  test("validates and says the line and the cap in the ask", () => {
    const change = { kind: "role", name: "Line lead", handle: "codecast-line", scope: { projects: ["Codecast"] }, caps: { hands_per_day: 6, cards: 5 }, line: "line" } as const;
    expect(orgChangeError(change)).toBeNull();
    const [ask] = deriveAsks([{ seq: 1, change: change as OrgChange }]);
    expect(ask!.effect).toContain("runs the project's line on the line workflow, starting new work only while fewer than 5 change cards wait on a person");
    const plain = deriveAsks([{ seq: 1, change: { kind: "role", name: "Ops", handle: "ops" } as OrgChange }]);
    expect(plain[0]!.effect).not.toContain("workflow");
  });
});

// The words of a change (org-staffing.md S17, S21, S39). With nothing passed a
// change reads the way the log and the terminal print it; a card passes the
// names it has and asks for the brief form: verb first, the subject's name
// written once, nothing a field row already shows.
import { andList, changeClauses, changeSentence, goalChangeSentence, PRIORITY_WORDS, type ChangeWords, type OrgAskNames, type OrgGoalChange, type OrgPriority, type OrgProjectMetaChange } from "./orgProposal";

describe("the words of a change", () => {
  const pick = (table: Record<string, string>) => (ref: string): string | undefined => table[ref];
  const names: OrgAskNames = {
    role: pick({ growth: "Head of Growth", product: "Head of Product", ops: "Content Lead", calling: "Calling Lead", "head-of-people": "Head of People" }),
    project: pick({ "pr-1": "Growth", "pr-3": "Old site", "pr-5": "Billing" }),
    plan: pick({ "pl-1": "Launch plan", "pl-2": "Pricing", "pl-7": "Launch" }),
    initiative: pick({ "in-2": "Win the private network", "in-9": "Reach 1k teams" }),
    session: pick({ jx7abcd: "Org review" }),
  };
  const brief = (c: OrgChange, more: ChangeWords = {}) => changeLine(c, { brief: true, names, ...more });
  const meta = (over: Partial<OrgProjectMetaChange>): OrgProjectMetaChange => ({ kind: "project_meta", project: "pr-1", ...over });

  test("with no words every kind but a project's fields reads as it always did", () => {
    const lines = Object.fromEntries(Object.entries(GOOD).map(([kind, c]) => [kind, changeLine(c)]));
    expect(lines).toEqual({
      role: "Add a role, Head of Growth (@growth), reporting to you, looking after pr-1",
      projects: "Create the project Platform; fold the project pr-3 into pr-1",
      move: "Move @growth under @product; now also looks after pr-5",
      retire: "Retire @ops; its sessions go back to their owners",
      scope: "@growth also looks after pr-5 and stops looking after pl-2",
      budget: "@growth may use up to 800,000 tokens a day",
      charter_edit: "Rewrite a passage of @growth's charter and add a line to its charter",
      trust: "@growth starts work on its own",
      routine: '@growth runs "Weekly funnel" every week',
      project_meta: "Make pr-1 a high priority, make @growth its lead and write down what it is for, how it is measured, what it leaves out and its risks",
      adopt: "Make session jx7abcd the standing session of @head-of-people",
      file: "Put plan pl-1 under the project Platform",
      plan_status: "Mark plan pl-7 done",
      task_status: "Mark task ct-42 done",
      project_status: "Mark project Legacy paused",
      authority: "@growth may spend (Paid search on the configured campaign, up to $300 a month) and write (Ship pages into the working tree), inside the limits you set",
      hire: "Hire @growth from the template growth (2.0.0) to lead pr-1",
      upgrade: "Move the instance acme-growth to growth 2.1.0",
      initiative: "Set a goal: Win the private network, carried by Callers and Broker network, owned by @calling",
      initiative_projects: "Add Callers to the goal Win the private network",
      initiative_owner: "Make @calling the owner of the goal Win the private network",
      initiative_shape: "Put the goal Win the private network under Reach 1k teams and measured by Brokers live (target 40)",
    });
    expect(changeLine({ kind: "role", name: "Head of People", handle: "people", reports_to: "@growth", seat: { existing: "jx7abcd", title: "Org review" } })).toBe("Name the session Org review as a role, Head of People (@people), reporting to @growth");
    expect(changeLine({ kind: "move", handle: "growth", scope_remove: ["pr-5", "pl-2"] })).toBe("Move @growth; no longer looks after pr-5 and pl-2");
    expect(changeLine({ kind: "trust", handle: "growth", trust: "understand" })).toBe("@growth stops starting work on its own");
    // The sentence is the line before its capital, and one clause in every form but the card's.
    for (const c of Object.values(GOOD)) {
      const sentence = changeSentence(c);
      expect(changeLine(c), c.kind).toBe(sentence.charAt(0).toUpperCase() + sentence.slice(1));
      if (c.kind !== "project_meta") expect(changeClauses(c), c.kind).toEqual([sentence]);
    }
  });

  test("a project's fields: no charter, the priority in words, what is written down named and never printed", () => {
    expect(PRIORITY_WORDS).toEqual({ p0: "the top priority", p1: "a high priority", p2: "a medium priority", p3: "a low priority" });
    expect((["p0", "p1", "p2", "p3"] as const).map((priority) => changeLine(meta({ priority })))).toEqual([
      "Make pr-1 the top priority", "Make pr-1 a high priority", "Make pr-1 a medium priority", "Make pr-1 a low priority",
    ]);
    // The priority before, when the caller knows it: up is raise, down is lower, and the top is always made.
    const from = (priority: OrgPriority, was: OrgPriority | null) => changeLine(meta({ priority }), { was: { priority: was } });
    expect(from("p1", "p2")).toBe("Raise pr-1 to a high priority");
    expect(from("p2", "p3")).toBe("Raise pr-1 to a medium priority");
    expect(from("p3", "p1")).toBe("Lower pr-1 to a low priority");
    expect(from("p2", "p0")).toBe("Lower pr-1 to a medium priority");
    expect(from("p0", "p2")).toBe("Make pr-1 the top priority");
    expect(from("p1", "p1")).toBe("Make pr-1 a high priority");
    expect(from("p1", null)).toBe("Make pr-1 a high priority");
    expect(changeLine(meta({ priority: "p1" }), { was: {} })).toBe("Make pr-1 a high priority");
    // Names: the project by its title, the lead by the role's name.
    expect(changeLine(meta({ priority: "p0" }), { names })).toBe("Make Growth the top priority");
    expect(changeLine(meta({ owner: "@growth" }), { names })).toBe("Make Head of Growth the lead of Growth");
    expect(changeLine(meta({ owner: "@nobody" }), { names })).toBe("Make @nobody the lead of Growth");
    expect(changeLine(meta({ owner: "growth" }))).toBe("Make @growth the lead of pr-1");
    // What it writes down, each part named once and the project named first.
    expect(changeLine(meta({ goal: "Ship the onboarding" }), { names })).toBe("Write down what Growth is for");
    expect(changeLine(meta({ success_metrics: ["activation 40%"], risks: ["one engineer"] }), { names })).toBe("Write down how Growth is measured and its risks");
    expect(changeLine(meta({ risks: ["one engineer"] }), { names })).toBe("Write down the risks to Growth");
    expect(changeLine(meta({ non_goals: ["paid ads"] }), { names })).toBe("Write down what Growth leaves out");
    expect(changeLine(GOOD.project_meta, { names, was: { priority: "p3" } })).toBe("Raise Growth to a high priority, make Head of Growth its lead and write down what it is for, how it is measured, what it leaves out and its risks");
    // As a clause after another about the same project.
    expect(changeSentence(meta({ priority: "p1" }), { subject: "it" })).toBe("make it a high priority");
    expect(changeSentence(meta({ priority: "p3" }), { subject: "it", was: { priority: "p1" } })).toBe("lower it to a low priority");
    expect(changeSentence(meta({ owner: "@growth", goal: "g" }), { subject: "it", names })).toBe("make Head of Growth its lead and write down what it is for");
    expect(changeClauses(GOOD.project_meta, { names })).toEqual(["make Growth a high priority", "make Head of Growth its lead", "write down what it is for, how it is measured, what it leaves out and its risks"]);
    // A row that names no field (the way back of one) still reads as a sentence.
    expect(changeLine(meta({}))).toBe("Change the project pr-1");
    for (const line of [changeLine(GOOD.project_meta), changeLine(GOOD.project_meta, { brief: true, names })]) {
      expect(line).not.toMatch(/charter|\bp[0-3]\b|Ship the onboarding|activation|paid ads|one engineer/);
    }
  });

  test("names without the card's form: the same sentences, each ref by the name the reader knows", () => {
    const named = (c: OrgChange) => changeLine(c, { names });
    expect(named(GOOD.role)).toBe("Add a role, Head of Growth (@growth), reporting to you, looking after Growth");
    expect(named({ kind: "role", name: "SEO", handle: "seo", reports_to: "@growth", scope: { plans: ["pl-1"] } })).toBe("Add a role, SEO (@seo), reporting to Head of Growth, looking after Launch plan");
    expect(named(GOOD.projects)).toBe("Create the project Platform; fold the project Old site into Growth");
    expect(named(GOOD.move)).toBe("Move Head of Growth under Head of Product; now also looks after Billing");
    expect(named(GOOD.retire)).toBe("Retire Content Lead; its sessions go back to their owners");
    expect(named(GOOD.scope)).toBe("Head of Growth also looks after Billing and stops looking after Pricing");
    expect(named(GOOD.budget)).toBe("Head of Growth may use up to 800,000 tokens a day");
    expect(named(GOOD.trust)).toBe("Head of Growth starts work on its own");
    expect(named(GOOD.routine)).toBe('Head of Growth runs "Weekly funnel" every week');
    expect(named(GOOD.adopt)).toBe("Make the session Org review the standing session of Head of People");
    expect(named(GOOD.hire)).toBe("Hire Head of Growth from the template growth (2.0.0) to lead Growth");
    expect(named(GOOD.file)).toBe("Put plan Launch plan under the project Platform");
    // A ref the names do not know stands as written.
    expect(named({ kind: "move", handle: "design", reports_to: "Ashot Petrosian", scope_add: ["pr-99"] })).toBe("Move @design under Ashot Petrosian; now also looks after pr-99");
    expect(named({ kind: "adopt", handle: "design", conversation: "jx7zzzz" })).toBe("Make session jx7zzzz the standing session of @design");
    // The subject by another word, where a caller already said its name.
    expect(changeSentence(GOOD.scope, { subject: "it", names })).toBe("it also looks after Billing and stops looking after Pricing");
    expect(changeSentence(GOOD.retire, { subject: "it" })).toBe("retire it; its sessions go back to their owners");
    expect(goalChangeSentence(GOOD.initiative_projects as OrgGoalChange, names, { subject: "it" })).toBe("add Callers to it");
    expect(goalChangeSentence(GOOD.initiative_owner as OrgGoalChange, undefined, { subject: "it" })).toBe("make @calling the owner of it");
  });

  // Every row of the ledger's sentence table (S39): the words a card prints,
  // before the card adds its full stop and its emphasis.
  test("the card's sentences: verb first, the subject named once, no markup and no full stop", () => {
    const goal = GOOD.initiative, title = "Win the private network";
    const rows: Array<[string, string, string]> = [
      // [the sentence, the subject's name, what the row is]
      [brief({ ...goal, parent: "in-9" } as OrgChange), title, "a new goal under a parent"],
      [brief(goal), title, "a new goal at the top level"],
      [brief(goal, { purpose: true }), title, "the purpose"],
      [brief({ kind: "initiative_shape", initiative: "in-2", parent: "in-9" }), title, "a goal moved under another"],
      [brief({ kind: "initiative_shape", initiative: "in-2", parent: null }), title, "a goal moved to the top"],
      [brief({ kind: "initiative_shape", initiative: "in-2", metrics: [{ name: "Brokers live", target: "40" }] }), title, "a goal measured"],
      [brief({ kind: "initiative_shape", initiative: "in-2", metrics: [{ name: "Brokers live", target: "40" }, { name: "Reply rate", target: "1% higher (Cameron)" }] }), title, "a goal with two measures"],
      [brief(GOOD.initiative_projects), title, "projects added to a goal"],
      [brief(GOOD.initiative_owner), title, "a goal's owner"],
      [brief(meta({ priority: "p0" })), "Growth", "the top priority"],
      [brief(meta({ priority: "p1" })), "Growth", "a high priority"],
      [brief(meta({ priority: "p2" })), "Growth", "a medium priority"],
      [brief(meta({ priority: "p3" })), "Growth", "a low priority"],
      [brief(meta({ priority: "p1" }), { was: { priority: "p2" } }), "Growth", "a priority raised"],
      [brief(meta({ priority: "p3" }), { was: { priority: "p2" } }), "Growth", "a priority lowered"],
      [brief(meta({ priority: "p0" }), { was: { priority: "p2" } }), "Growth", "the top priority from another"],
      [brief(meta({ owner: "@product" })), "Growth", "a project's lead"],
      [brief(GOOD.role), "Head of Growth", "a new role under the reader"],
      [brief({ kind: "role", name: "SEO Lead", handle: "seo", reports_to: "@growth" }), "SEO Lead", "a new role under a role"],
      [brief({ kind: "role", name: "Head of People", handle: "people", seat: { existing: "jx7abcd" } }), "Head of People", "a session named as a role"],
      [brief({ kind: "move", handle: "growth", reports_to: "@product" }), "Head of Growth", "a move"],
      [brief({ kind: "scope", handle: "growth", add: ["pr-5"] }), "Head of Growth", "looks after"],
      [brief({ kind: "scope", handle: "growth", remove: ["pl-2"] }), "Head of Growth", "stops looking after"],
      [brief(GOOD.trust), "Head of Growth", "starts work on its own"],
      [brief({ kind: "trust", handle: "growth", trust: "understand" }), "Head of Growth", "asks before it starts"],
      [brief(GOOD.routine), "Head of Growth", "a routine"],
      [brief({ ...GOOD.task_status, title: "Remove the pilot" } as OrgChange), "Remove the pilot", "a task done"],
      [brief(GOOD.plan_status), "Launch", "a plan done"],
      [brief({ ...GOOD.project_status, status: "done" } as OrgChange), "Legacy", "a project done"],
      [brief({ ...GOOD.plan_status, status: "active" } as OrgChange), "Launch", "a plan reopened"],
      [brief({ ...GOOD.task_status, status: "open", title: "Remove the pilot" } as OrgChange), "Remove the pilot", "a task reopened"],
      [brief(GOOD.retire), "Content Lead", "a retirement"],
      [brief(GOOD.budget), "Head of Growth", "a limit alone"],
    ];
    expect(rows.map(([sentence]) => sentence)).toEqual([
      "Add the goal Win the private network under Reach 1k teams",
      "Add the goal Win the private network at the top level",
      "Set Win the private network as the purpose",
      "Move Win the private network under Reach 1k teams",
      "Move Win the private network to the top level",
      "Measure Win the private network by Brokers live",
      "Give Win the private network two measures",
      "Have Callers carry Win the private network",
      "Make Calling Lead the owner of Win the private network",
      "Make Growth the top priority",
      "Make Growth a high priority",
      "Make Growth a medium priority",
      "Make Growth a low priority",
      "Raise Growth to a high priority",
      "Lower Growth to a low priority",
      "Make Growth the top priority",
      "Make Head of Product the lead of Growth",
      "Add the role Head of Growth, reporting to you",
      "Add the role SEO Lead, reporting to Head of Growth",
      "Name the session Org review as the role Head of People, reporting to you",
      "Have Head of Growth report to Head of Product",
      "Have Head of Growth look after Billing",
      "Have Head of Growth stop looking after Pricing",
      "Let Head of Growth start work in its area on its own",
      "Have Head of Growth ask before it starts work",
      "Have Head of Growth run Weekly funnel every week",
      "Mark the task Remove the pilot as done",
      "Mark the plan Launch as done",
      "Mark the project Legacy as done",
      "Reopen the plan Launch",
      "Reopen the task Remove the pilot",
      "Retire Content Lead. Its sessions go back to their owners",
      "Head of Growth keeps a safety net on its daily work",
    ]);
    for (const [sentence, name, what] of rows) {
      expect(sentence.split(name).length - 1, what).toBe(1);
      expect(sentence, what).not.toMatch(/[.*_<>]$|\*\*|<b>|@|\bscope\b|\bcharter\b|\d{3}/);
    }
  });

  test("the card's sentences for the kinds the table leaves as they are, and the forms on the edges", () => {
    expect(brief(GOOD.adopt)).toBe("Make the session Org review the standing session of Head of People");
    expect(brief(GOOD.authority)).toBe("Let Head of Growth spend (Paid search on the configured campaign, up to $300 a month) and write (Ship pages into the working tree), inside the limits you set");
    expect(brief(GOOD.hire)).toBe("Hire Head of Growth from the template growth (2.0.0) to lead Growth");
    expect(brief(GOOD.upgrade)).toBe("Move the instance acme-growth to growth 2.1.0");
    expect(brief(GOOD.file)).toBe("Put the plan Launch plan under the project Platform");
    expect(brief(GOOD.projects)).toBe("Create the project Platform and fold the project Old site into Growth");
    expect(brief({ ...GOOD.plan_status, status: "abandoned" } as OrgChange)).toBe("Mark the plan Launch as abandoned");
    expect(brief({ ...GOOD.task_status, status: "dropped" } as OrgChange)).toBe("Mark the task ct-42 as dropped");
    expect(brief({ ...GOOD.task_status, status: "backlog", title: "Remove the pilot" } as OrgChange)).toBe("Move the task Remove the pilot to the backlog");
    expect(brief(GOOD.project_status)).toBe("Mark the project Legacy as paused");
    expect(brief({ ...GOOD.project_status, status: "active" } as OrgChange)).toBe("Reopen the project Legacy");
    // A goal: a measure taken away, an owner taken away, its record alone, and a handle the names do not know.
    expect(brief({ kind: "initiative_shape", initiative: "in-2", metrics: [] })).toBe("Stop measuring Win the private network by a number");
    expect(brief({ kind: "initiative_owner", initiative: "in-2", owner: " " })).toBe("Leave Win the private network with no owner");
    expect(brief({ kind: "initiative_shape", initiative: "in-2", why: "It pays.", milestones: [{ title: "Quiet onboarded" }] })).toBe("Record why it matters and the milestone Quiet onboarded on Win the private network");
    expect(brief({ kind: "initiative_owner", initiative: "in-2", owner: "@nobody" })).toBe("Make @nobody the owner of Win the private network");
    expect(brief({ kind: "initiative_owner", initiative: "in-2", owner: "me" })).toBe("Make yourself the owner of Win the private network");
    // With no names the card's form still reads, each ref as written.
    expect(changeLine(GOOD.move, { brief: true })).toBe("Have @growth report to @product and have it look after pr-5");
    expect(changeLine(GOOD.budget, { brief: true })).toBe("@growth keeps a safety net on its daily work");
    expect(changeLine(GOOD.adopt, { brief: true })).toBe("Make session jx7abcd the standing session of @head-of-people");
    // A role's handle and its area are the card's rows, never its sentence.
    expect(brief(GOOD.role)).not.toMatch(/growth\)|looking after/);
    // A kind this build does not know reads the same in every form.
    expect(changeLine({ kind: "rename" } as any, { brief: true, names })).toBe('A change this version of codecast cannot show yet ("rename")');
  });

  test("the purpose: the one top level goal reads as the purpose, and every goal under it says so through the names", () => {
    const purpose = "Broker introductions that become transactions";
    const under: OrgAskNames = { ...names, initiative: (ref) => ref === purpose ? "the purpose" : names.initiative!(ref) };
    expect(changeLine({ ...GOOD.initiative, title: purpose } as OrgChange, { brief: true, names: under, purpose: true })).toBe(`Set ${purpose} as the purpose`);
    expect(changeLine({ ...GOOD.initiative, parent: purpose } as OrgChange, { brief: true, names: under })).toBe("Add the goal Win the private network under the purpose");
    expect(changeLine({ kind: "initiative_shape", initiative: "in-2", parent: purpose }, { brief: true, names: under })).toBe("Move Win the private network under the purpose");
    // Only a goal the change sets can be the purpose.
    expect(changeLine({ kind: "initiative_shape", initiative: "in-2", parent: null }, { brief: true, names: under, purpose: true })).toBe("Move Win the private network to the top level");
  });

  test("several changes to one subject join as clauses: the lead names it, the rest say it", () => {
    const names54: OrgAskNames = { initiative: pick({ "Broker introductions": "the purpose" }), project: pick({ "pr-8": "Agent Quality" }) };
    const title = "Every relationship is one we'd be proud of";
    const shape: OrgChange = { kind: "initiative_shape", initiative: "in-4", title, parent: "Broker introductions", metrics: [{ name: "Trust breaking issues per day", target: "0" }, { name: "Average comms score", target: "0.9 or higher" }] };
    const carry: OrgChange = { kind: "initiative_projects", initiative: "in-4", title, projects: ["pr-8"] };
    const lead = changeClauses(shape, { brief: true, names: names54 });
    expect(lead).toEqual([`move ${title} under the purpose`, "give it two measures"]);
    expect(changeLine(shape, { brief: true, names: names54 })).toBe(`Move ${title} under the purpose and give it two measures`);
    const rest = changeClauses(carry, { brief: true, names: names54, subject: "it" });
    expect(rest).toEqual(["have Agent Quality carry it"]);
    expect(andList([...lead, ...rest])).toBe(`move ${title} under the purpose, give it two measures and have Agent Quality carry it`);
    // Every kind takes the word, so any change can follow another about its subject.
    const it = (c: OrgChange) => changeSentence(c, { brief: true, names, subject: "it" });
    expect([GOOD.move, GOOD.scope, GOOD.trust, GOOD.routine, GOOD.retire, GOOD.budget, GOOD.authority, GOOD.adopt, GOOD.hire, GOOD.file, GOOD.plan_status, GOOD.upgrade, GOOD.initiative_owner, GOOD.initiative_shape, GOOD.role, GOOD.initiative].map(it)).toEqual([
      "have it report to Head of Product and have it look after Billing",
      "have it look after Billing and have it stop looking after Pricing",
      "let it start work in its area on its own",
      "have it run Weekly funnel every week",
      "retire it. Its sessions go back to their owners",
      "it keeps a safety net on its daily work",
      "let it spend (Paid search on the configured campaign, up to $300 a month) and write (Ship pages into the working tree), inside the limits you set",
      "make the session Org review the standing session of it",
      "hire it from the template growth (2.0.0) to lead Growth",
      "put it under the project Platform",
      "mark it as done",
      "move it to growth 2.1.0",
      "make Calling Lead its owner",
      "move it under Reach 1k teams and measure it by Brokers live",
      "add it, reporting to you",
      "add it at the top level",
    ]);
  });
});

// A card answers the agent (org-staffing.md S39): a person's approvals,
// rejections and notes on one proposal, written as the one message the agent
// reads. The web's send and the server's thread send both print this text.
import { ORG_REPLY_WORDS, aboutChangeHeader, aboutProposalHeader, parseAboutChange, proposalRepliesText, proposalReplyText, type OrgProposalReply, type OrgReplyItem } from "./orgProposal";
import { parseProposalChangeRef } from "../entities";

describe("a person's answers as the message the agent reads (proposalReplyText)", () => {
  const TITLE = "Rank Union's projects by the goals they carry";
  const HEAD = `On op-55:`;
  const reply = (...items: OrgReplyItem[]): OrgProposalReply => ({ proposal: "op-55", title: TITLE, items });
  const approve = (seqs: number[], text?: string): OrgReplyItem => ({ verdict: "approve", seqs, text, line: "Make Growth the top priority." });
  const FUNNEL = "Make Matching Engine & Funnel a high priority.";
  const CALLERS = "Make Callers & Call Management a medium priority.";

  test("the whole shape: approvals, a rejection, a note and words on the proposal", () => {
    expect(proposalReplyText(reply(
      approve([1]), approve([3]), approve([4]),
      { verdict: "reject", seqs: [2], text: "P1 is too high, make it P2.", line: FUNNEL },
      { verdict: "note", seqs: [6], text: "Cameron owns this, not Samvit.", line: CALLERS },
      { verdict: "note", seqs: [], text: "do the same for the plans next.", line: "" },
    ))).toBe([
      HEAD,
      "- Approved, and applied: op-55#1, op-55#3 and op-55#4.",
      "- Rejected op-55#2 (make Matching Engine & Funnel a high priority): P1 is too high, make it P2.",
      "- On op-55#6 (make Callers & Call Management a medium priority): Cameron owns this, not Samvit.",
      "- On the whole proposal: do the same for the plans next.",
    ].join("\n"));
  });

  test("approvals with no words fold into one line, in the order of the changes", () => {
    expect(proposalReplyText(reply(approve([4]), approve([1]), approve([3])))).toBe(`${HEAD}\n- Approved, and applied: op-55#1, op-55#3 and op-55#4.`);
    expect(proposalReplyText(reply(approve([7])))).toBe(`${HEAD}\n- Approved, and applied: op-55#7.`);
    // Blank words are no words.
    expect(proposalReplyText(reply(approve([1], "  "), approve([2])))).toBe(`${HEAD}\n- Approved, and applied: op-55#1 and op-55#2.`);
  });

  test("an approval that carries words gets its own line", () => {
    expect(proposalReplyText(reply(approve([1]), approve([5], "but revisit in a month."), approve([3])))).toBe([
      HEAD,
      "- Approved, and applied: op-55#1 and op-55#3.",
      "- Approved op-55#5, and applied: but revisit in a month.",
    ].join("\n"));
  });

  test("a reply whose approvals have not all landed says Approved alone, so the agent reads the rows", () => {
    expect(proposalReplyText({ ...reply(approve([1]), approve([5], "but revisit in a month."), approve([3])), applied: false })).toBe([
      HEAD,
      "- Approved: op-55#1 and op-55#3.",
      "- Approved op-55#5: but revisit in a month.",
    ].join("\n"));
    // Absent reads as applied: the web's send knows nothing else.
    expect(proposalReplyText({ ...reply(approve([1])), applied: true })).toBe(proposalReplyText(reply(approve([1]))));
  });

  test("a rejection reads with its words, and with a full stop when it has none", () => {
    expect(proposalReplyText(reply({ verdict: "reject", seqs: [2], text: "P1 is too high, make it P2.", line: FUNNEL })))
      .toBe(`${HEAD}\n- Rejected op-55#2 (make Matching Engine & Funnel a high priority): P1 is too high, make it P2.`);
    expect(proposalReplyText(reply({ verdict: "reject", seqs: [2], line: FUNNEL })))
      .toBe(`${HEAD}\n- Rejected op-55#2 (make Matching Engine & Funnel a high priority).`);
    expect(proposalReplyText(reply({ verdict: "reject", seqs: [2], text: " \n ", line: FUNNEL })))
      .toBe(`${HEAD}\n- Rejected op-55#2 (make Matching Engine & Funnel a high priority).`);
  });

  test("a note names its change and carries the words; a note with no words says nothing", () => {
    expect(proposalReplyText(reply({ verdict: "note", seqs: [6], text: "Cameron owns this, not Samvit.", line: CALLERS })))
      .toBe(`${HEAD}\n- On op-55#6 (make Callers & Call Management a medium priority): Cameron owns this, not Samvit.`);
    expect(proposalReplyText(reply({ verdict: "note", seqs: [6], line: CALLERS }))).toBe("");
    expect(proposalReplyText(reply())).toBe("");
  });

  test("a card of several changes names them all", () => {
    const two: OrgProposalReply = { proposal: "op-54", title: "Give every goal an owner", items: [
      { verdict: "reject", seqs: [10, 9], text: "Agent Quality is full.", line: "Move Reach 1k teams under the purpose and have Agent Quality carry it." },
      { verdict: "approve", seqs: [3, 4], line: "Add the goal Retention." },
      { verdict: "approve", seqs: [1], line: "Add the purpose." },
    ] };
    expect(proposalReplyText(two)).toBe([
      'On op-54:',
      "- Approved, and applied: op-54#1, op-54#3 and op-54#4.",
      "- Rejected op-54#9 and op-54#10 (move Reach 1k teams under the purpose and have Agent Quality carry it): Agent Quality is full.",
    ].join("\n"));
  });

  test("a note on the whole proposal comes last, whatever order the answers were given in", () => {
    expect(proposalReplyText(reply(
      { verdict: "note", seqs: [], text: "do the same for the plans next.", line: "" },
      { verdict: "note", seqs: [6], text: "Cameron owns this.", line: CALLERS },
      { verdict: "reject", seqs: [2], line: FUNNEL },
      approve([1]),
    ))).toBe([
      HEAD,
      "- Approved, and applied: op-55#1.",
      "- Rejected op-55#2 (make Matching Engine & Funnel a high priority).",
      "- On op-55#6 (make Callers & Call Management a medium priority): Cameron owns this.",
      "- On the whole proposal: do the same for the plans next.",
    ].join("\n"));
    expect(proposalReplyText(reply({ verdict: "note", seqs: [], text: "do the same for the plans next.", line: "" })))
      .toBe(`${HEAD}\n- On the whole proposal: do the same for the plans next.`);
  });

  test("the sentence is written without its capital and full stop, either way it arrives", () => {
    const as = (line: string) => proposalReplyText(reply({ verdict: "note", seqs: [6], text: "ok", line }));
    const want = `${HEAD}\n- On op-55#6 (make Callers & Call Management a medium priority): ok`;
    expect(as(CALLERS)).toBe(want);
    expect(as("make Callers & Call Management a medium priority")).toBe(want);
    expect(as("")).toBe(`${HEAD}\n- On op-55#6: ok`);
  });

  test("a person's lines stay inside their bullet, and the header is the ref alone", () => {
    expect(proposalReplyText({ proposal: "op-7", title: 'Rename "Growth"', items: [{ verdict: "reject", seqs: [1], text: "Two things.\n\nFirst this.\nThen that.", line: "Rename Growth." }] }))
      .toBe(`On op-7:\n- Rejected op-7#1 (rename Growth): Two things.\n  First this.\n  Then that.`);
    expect(proposalReplyText({ proposal: "op-7", title: " ", items: [{ verdict: "approve", seqs: [1], line: "" }] })).toBe("On op-7:\n- Approved, and applied: op-7#1.");
  });

  test("every change is written as a reference the pills and the agent read back", () => {
    const text = proposalReplyText(reply(approve([1]), { verdict: "reject", seqs: [2, 12], line: FUNNEL }));
    expect((text.match(/op-\d+#\d+/g) ?? []).map((r) => parseProposalChangeRef(r))).toEqual([
      { proposal: "op-55", seq: 1 }, { proposal: "op-55", seq: 2 }, { proposal: "op-55", seq: 12 },
    ]);
  });

  test("two proposals in one send are two blocks with a blank line between", () => {
    const other: OrgProposalReply = { proposal: "op-56", title: "Hire a growth lead", items: [{ verdict: "note", seqs: [1], text: "Who pays for this?", line: "Hire Growth Lead from the template growth." }] };
    expect(proposalRepliesText([reply(approve([1]), approve([3])), other])).toBe([
      HEAD,
      "- Approved, and applied: op-55#1 and op-55#3.",
      "",
      'On op-56:',
      "- On op-56#1 (hire Growth Lead from the template growth): Who pays for this?",
    ].join("\n"));
    // A proposal whose answers say nothing leaves no block and no stray blank line.
    expect(proposalRepliesText([reply(), other])).toBe(proposalReplyText(other));
    expect(proposalRepliesText([])).toBe("");
  });

  test("the words a surface shows per verdict", () => {
    expect(ORG_REPLY_WORDS).toEqual({
      approve: { act: "Approve", done: "Approved" },
      reject: { act: "Reject", done: "Rejected" },
      note: { act: "Reply", done: "Noted" },
    });
  });

  test("the About headers read as before", () => {
    expect(aboutChangeHeader("op-55", 3, 'Rename "Growth"')).toBe(`About op-55 change 3 ("Rename 'Growth'"):`);
    expect(aboutProposalHeader("op-55", TITLE)).toBe(`About op-55 ("${TITLE}"):`);
    expect(parseAboutChange(`${aboutChangeHeader("op-55", 3, "Retire @growth")}\n\nwhy?`)).toEqual({ proposal: "op-55", seq: 3, line: "Retire @growth", body: "why?" });
  });
});

describe("record groups (S9, revised)", () => {
  const row = (seq: number, change: any, status?: string) => ({ seq, change, ...(status ? { status } : {}) });
  test("every record change is in exactly one group: its project, else its plan, else loose; biggest first, loose last", () => {
    const rows = [
      row(1, { kind: "task_status", task: "ct-1", status: "done", reason: "r", project: "pr-1" }),
      row(2, { kind: "task_status", task: "ct-2", status: "open", reason: "r", plan: "pl-5" }),
      row(3, { kind: "plan_status", plan: "pl-5", status: "done", reason: "r", title: "Member app", project: "pr-1" }),
      row(4, { kind: "task_status", task: "ct-4", status: "dropped", reason: "r" }),
      row(5, { kind: "task_status", task: "ct-5", status: "backlog", reason: "r", plan: "pl-9" }),
      row(6, { kind: "plan_status", plan: "pl-9", status: "abandoned", reason: "r", title: "Old funnel" }),
      row(7, { kind: "project_status", project: "pr-2", status: "paused", reason: "r", title: "Legacy" }),
      row(8, { kind: "task_status", task: "ct-8", status: "done", reason: "r", project: "pr-1" }, "removed"),
      row(9, { kind: "role", name: "X", handle: "x" }),
    ];
    const names = { project: (r: string) => ({ "pr-1": "Desire DB" } as Record<string, string>)[r] };
    const groups = orgRecordGroups(rows, names);
    expect(groups.map((g) => [g.key, g.kind, g.ref, g.title, g.seqs])).toEqual([
      ["project:pr-1", "project", "pr-1", "Desire DB", [1, 2, 3]],
      ["plan:pl-9", "plan", "pl-9", "Old funnel", [5, 6]],
      ["project:pr-2", "project", "pr-2", "Legacy", [7]],
      ["loose", "loose", undefined, undefined, [4]],
    ]);
    expect(groups[0].totals).toEqual([{ noun: "plan", act: "done", count: 1 }, { noun: "task", act: "done", count: 1 }, { noun: "task", act: "reopened", count: 1 }]);
    expect(recordGroupTotalsLine(groups[0])).toBe("1 plan done, 1 task done and 1 task reopened");
    expect(recordGroupTotalsLine(groups[1])).toBe("1 plan abandoned and 1 task backlog");
    expect(recordGroupTotalsLine(groups[2])).toBe("1 project paused");
    // A title that only repeats the ref is dropped; a ref nobody can name stands alone.
    expect(orgRecordGroups([row(1, { kind: "plan_status", plan: "pl-3", status: "done", reason: "r", title: "pl-3" })])[0]).toEqual({ key: "plan:pl-3", kind: "plan", ref: "pl-3", seqs: [1], totals: [{ noun: "plan", act: "done", count: 1 }] });
    expect(orgRecordGroups([])).toEqual([]);
  });
  test("the asks of a record proposal are its groups, with the totals as the effect", () => {
    const asks = deriveAsks([
      { seq: 1, change: { kind: "task_status", task: "ct-1", status: "done", reason: "r", project: "pr-1" } },
      { seq: 2, change: { kind: "plan_status", plan: "pl-5", status: "done", reason: "r", title: "Member app", project: "pr-1" } },
      { seq: 3, change: { kind: "task_status", task: "ct-3", status: "dropped", reason: "nobody picked it up" } },
    ] as any, { project: (r: string) => ({ "pr-1": "Desire DB" } as Record<string, string>)[r] });
    expect(asks.map((a) => [a.title, a.effect, a.seqs])).toEqual([
      ["Settle 2 records in Desire DB", "1 plan done and 1 task done. No work starts or stops.", [1, 2]],
      ["Mark the task ct-3 as dropped", "1 task dropped. No work starts or stops.", [3]],
    ]);
    expect(asks[1].why).toBe("nobody picked it up");
  });
});

describe("a role's charter edited in place", () => {
  const charter = "Keeps paid acquisition on budget and pointed at the funnel.\n\nReads the ads account every morning.";
  test("each edit names a passage; a passage must be short, and a replace must change something", () => {
    expect(orgChangeError({ kind: "charter_edit", handle: "growth", edits: [] })).toBe('charter_edit edits is a list of one to 5 edits: { op: "replace", before, after }, { op: "add", line } or { op: "remove", before }');
    expect(orgChangeError({ kind: "charter_edit", handle: "growth", edits: [{ op: "swap", before: "a" }] })).toBe('charter_edit op is replace, add or remove, not "swap"');
    expect(orgChangeError({ kind: "charter_edit", handle: "growth", edits: [{ op: "replace", before: "a", after: " a " }] })).toBe("charter_edit replace: after is the same as before");
    expect(orgChangeError({ kind: "charter_edit", handle: "growth", edits: [{ op: "add", line: "x".repeat(301) }] })).toBe("charter_edit add: line is 301 characters; a passage is at most 300, so quote the sentence that changes, not the whole charter");
    expect(orgChangeError({ kind: "charter_edit", handle: "growth", edits: [{ op: "remove", before: "" }] })).toBe("charter_edit remove: before is the passage, a non-empty string");
    expect(orgChangeError({ kind: "role", name: "G", handle: "growth", charter: "x".repeat(ORG_CHARTER_MAX + 1) })).toBe(`charter is ${ORG_CHARTER_MAX + 1} characters; a charter is the job in a few sentences, at most ${ORG_CHARTER_MAX} characters: what the role watches, what it does on its own, and what it brings to a person; cut examples, procedures, and anything its routine or its scope already says`);
    expect(orgChangeError({ kind: "role", name: "G", handle: "growth", charter: "x".repeat(ORG_CHARTER_MAX) })).toBeNull();
    expect(ORG_CHANGE_APPLY_RANK.charter_edit).toBeGreaterThan(ORG_CHANGE_APPLY_RANK.role);
    expect(ORG_CHANGE_APPLY_RANK.charter_edit).toBeLessThan(ORG_CHANGE_APPLY_RANK.retire);
  });
  test("the words say what the edit does, never the text", () => {
    const names = { role: (h: string) => (h === "growth" ? "Growth lead" : undefined) };
    expect(changeLine(GOOD.charter_edit, { names, brief: true })).toBe("Rewrite a passage of Growth lead's charter and add a line to its charter");
    expect(changeLine({ kind: "charter_edit", handle: "growth", edits: [{ op: "remove", before: "x" }, { op: "remove", before: "y" }] })).toBe("Cut 2 passages from @growth's charter");
    const [ask] = deriveAsks([{ seq: 1, change: GOOD.charter_edit, rationale: "The role now reports spend." }] as any, names);
    expect([ask.title, ask.why, ask.effect, ask.seqs]).toEqual(["Change what Growth lead's charter says", "The role now reports spend.", "Growth lead's charter changes in 2 places; each passage is shown before and after. Its area and its reporting line stay as they are.", [1]]);
  });
  test("applyCharterEdits substitutes exact, unique passages and keeps the result under the cap", () => {
    expect(applyCharterEdits(charter, GOOD.charter_edit.edits as any)).toEqual({ charter: "Keeps paid acquisition under budget and pointed at the funnel.\n\nReads the ads account every morning.\n\nReports spend every Monday." });
    expect(applyCharterEdits(charter, [{ op: "remove", before: "Reads the ads account every morning." }])).toEqual({ charter: "Keeps paid acquisition on budget and pointed at the funnel." });
    // Spacing in the quote does not matter; the words do.
    expect(applyCharterEdits(charter, [{ op: "replace", before: "on  budget and\npointed", after: "steady" }])).toEqual({ charter: "Keeps paid acquisition steady at the funnel.\n\nReads the ads account every morning." });
    expect(applyCharterEdits(charter, [{ op: "replace", before: "spend", after: "x" }])).toEqual({ error: 'the passage "spend" is not in the charter as it stands; quote it exactly' });
    expect(applyCharterEdits(charter, [{ op: "remove", before: "the" }])).toEqual({ error: 'the passage "the" appears 2 times in the charter; quote more of it so it names one place' });
    expect(applyCharterEdits("", [{ op: "add", line: "First line." }])).toEqual({ charter: "First line." });
    const long = applyCharterEdits("y".repeat(600), [{ op: "add", line: "x".repeat(250) }]);
    expect(long.error).toBe("the charter would be 852 characters after this edit; a charter is the job in a few sentences, at most 800 characters: what the role watches, what it does on its own, and what it brings to a person; cut examples, procedures, and anything its routine or its scope already says");
  });
});
