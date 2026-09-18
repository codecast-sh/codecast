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
  const ask = (title: string, seqs: number[]) => ({ title, why: "why", effect: "effect", seqs });
  const spec = (changes: any[], asks?: any) => parseOrgProposalSpec({ title: "t", summary_md: "s", mode: "review", changes, ...(asks !== undefined ? { asks } : {}) });

  test("a partition parses and is kept; a spec without asks carries none", () => {
    const r = spec([task("ct-1"), task("ct-2"), role], [ask("Close two tasks", [1, 2]), ask("Add an agent for quality", [3])]);
    expect(r.errors).toEqual([]);
    expect(r.spec!.asks).toEqual([{ title: "Close two tasks", why: "why", effect: "effect", seqs: [1, 2] }, { title: "Add an agent for quality", why: "why", effect: "effect", seqs: [3] }]);
    expect(spec([task("ct-1")]).spec!.asks).toBeUndefined();
  });
  test("a change in no ask, in two asks, or an ask naming a change that is not there is refused, naming the change", () => {
    const left = spec([task("ct-1"), task("ct-2"), role], [ask("a", [1]), ask("b", [3])]);
    expect(left.spec).toBeNull();
    expect(left.errors).toEqual(["changes[1] (mark task ct-2 done) is in no ask: every change belongs to exactly one ask"]);
    const twice = spec([task("ct-1"), role], [ask("a", [1, 2]), ask("b", [2])]);
    expect(twice.errors).toEqual(["changes[1] (create role Head of Quality @quality (standing)) is in asks[0] and asks[1]: every change belongs to exactly one ask"]);
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
    const r = spec([task("ct-1"), goal, role, owner], [ask("Records", [1]), ask("Goals", [2]), ask("The agent", [3, 4])]);
    expect(r.errors).toEqual([]);
    expect(r.spec!.changes.length).toBe(3);
    // The goal sat in the goals ask and the owner in the agent's ask. The
    // merged row names @quality as owner, so it follows the ask that creates
    // @quality: accepting the goals alone never sets an owner nobody accepted.
    expect(r.spec!.asks!.map((a) => [a.title, a.seqs])).toEqual([["Records", [1]], ["The agent", [2, 3]]]);
    expect(r.spec!.asks!.flatMap((a) => a.seqs).sort()).toEqual([1, 2, 3]);
    // With no ask creating the agent it names, the first ask that named the row keeps it.
    const plain = spec([task("ct-1"), goal, owner], [ask("Goals", [2]), ask("Rest", [1, 3])]);
    expect(plain.spec!.asks!.map((a) => a.seqs)).toEqual([[2], [1]]);
  });
  test("deriveAsks: the records are one ask, each role, retire, move and scope its own with its riders, the rest one ask; removed rows are in none", async () => {
    const { deriveAsks, resolveOrgAsks } = await import("./orgProposal");
    const rows = [
      { seq: 1, change: { kind: "plan_status", plan: "pl-1", status: "done", reason: "x" } },
      { seq: 2, change: { kind: "task_status", task: "ct-1", status: "dropped", reason: "x" } },
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
      ["Bring 2 records up to date", [1, 2]],
      ["Add an agent: Head of Quality", [4, 5]],
      ["Retire test-lead", [6]],
      ["3 smaller changes: filing, goals and settings", [3, 7, 8]],
    ]);
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
      ["Add an agent: Head of Platform", "Owns the sync layer.", "A new agent, Head of Platform, reporting to you and looking after the Platform project. It stays until you retire it. It gets a daily limit of its own. It runs Release check every day."],
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
    expect(resolved.slice(2).map((a) => [a.title, a.seqs])).toEqual([["Retire test-lead", [6]], ["3 smaller changes: filing, goals and settings", [3, 7, 8]]]);
    expect(resolveOrgAsks(undefined, rows)).toEqual(asks);
  });
});

describe("what one change needs from another (orgChangeDependencies)", () => {
  test("a role, its adopt and its routine name each other by seq; unrelated rows say nothing", async () => {
    const { orgChangeDependencies } = await import("./orgProposal");
    const rows = [
      { seq: 1, change: { kind: "role", name: "Chief of Staff", handle: "chief-of-staff" } as OrgChange },
      { seq: 2, change: { kind: "routine", handle: "@chief-of-staff", title: "Review", prompt: "p", every: "7d" } as OrgChange },
      { seq: 3, change: { kind: "adopt", handle: "chief-of-staff", conversation: "jx733c7" } as OrgChange },
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
    expect(describeOrgChange(role)).toBe("name session jx7b88a as role Market growth mandate @market-growth reporting to me over Growth");
  });

  test("its derived ask carries the sentence, and a routine on it runs on the session it names", async () => {
    const { deriveAsks, orgChangeDependencies } = await import("./orgProposal");
    const [ask] = deriveAsks([{ seq: 1, change: role }]);
    expect(ask.title).toBe("Name Market growth mandate as a role");
    expect(ask.effect).toContain("Naming it changes nothing about how it works");
    expect(ask.effect).toContain("It becomes a role, reporting to you and looking after the Growth project.");
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
