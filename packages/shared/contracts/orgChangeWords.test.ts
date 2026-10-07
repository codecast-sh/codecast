import { describe, expect, test } from "bun:test";
import { changeLine, describeOrgChange, ORG_CHANGE_KINDS, orgRecordGroups, type OrgAskNames, type OrgChange, type OrgRecordTotal } from "./orgProposal";
import { changeWords, chipLine, fieldMoves, passageDiff, proposalTotals, recordTotalsWords, subjectWords, type ChangeField } from "./orgChangeWords";

const pick = (table: Record<string, string>) => (ref: string): string | undefined => table[ref];
const names: OrgAskNames = {
  role: pick({ growth: "Head of Growth", product: "Head of Product", ops: "Content Lead", calling: "Calling Lead", "head-of-people": "Head of People", escalations: "Escalations lead" }),
  project: pick({ "pr-1": "Growth", "pr-3": "Old site", "pr-5": "Billing", "pr-901": "Matching Engine & Funnel", "pr-902": "Callers & Call Management", "pr-903": "Infrastructure" }),
  plan: pick({ "pl-1": "Launch plan", "pl-2": "Pricing", "pl-7": "Launch", "pl-911": "Counterparty pitches", "pl-912": "Networks" }),
  initiative: pick({ "in-2": "Win the private network", "in-9": "Reach 1k teams" }),
  session: pick({ jx7abcd: "Org review" }),
};

/** One valid change of every kind (the shapes orgProposal.test.ts validates). */
const GOOD: Record<OrgChange["kind"], OrgChange> = {
  role: { kind: "role", name: "Head of Growth", handle: "growth", scope: { projects: ["pr-1"] }, reports_to: "me", charter: "Owns the funnel. Reports spend every Monday." },
  projects: { kind: "projects", changes: [{ op: "create", title: "Platform", description: "The sync layer, the daemon, the CLI." }, { op: "merge", from: "pr-3", into: "pr-1" }] },
  move: { kind: "move", handle: "growth", reports_to: "@product", scope_add: ["pr-5"], reason: "Product owns the funnel now." },
  retire: { kind: "retire", handle: "ops", reason: "idle 21 days" },
  scope: { kind: "scope", handle: "growth", add: ["pr-5"], remove: ["pl-2"] },
  budget: { kind: "budget", handle: "growth", caps: { tokens_per_day: 800_000 } },
  trust: { kind: "trust", handle: "growth", trust: "decide" },
  routine: { kind: "routine", handle: "growth", title: "Weekly funnel", prompt: "Read the funnel and report.", every: "7d" },
  project_meta: { kind: "project_meta", project: "pr-1", goal: "Ship the onboarding", success_metrics: ["activation 40%"], priority: "p1", owner: "@growth", non_goals: ["paid ads"], risks: ["one engineer"] },
  adopt: { kind: "adopt", handle: "head-of-people", conversation: "jx7abcd" },
  file: { kind: "file", plan: "pl-1", project: "pr-1" },
  charter_edit: { kind: "charter_edit", handle: "growth", edits: [{ op: "replace", before: "Owns the funnel on budget.", after: "Owns the funnel under budget." }, { op: "add", line: "Reports spend every Monday." }, { op: "remove", before: "Writes the weekly post." }] },
  plan_status: { kind: "plan_status", plan: "pl-7", status: "done", reason: "every task closed" },
  task_status: { kind: "task_status", task: "ct-42", status: "done", reason: "commits landed, still open", title: "Remove the pilot" },
  project_status: { kind: "project_status", project: "Legacy", status: "paused", reason: "no activity 30d" },
  authority: { kind: "authority", handle: "growth", authority: [{ id: "ads-spend", kind: "spend", label: "Paid search on the configured campaign", limit: { usd_per_month: 300 }, expires: "90d" }] },
  hire: { kind: "hire", handle: "growth", template: "growth", version: "2.0.0", digest: "a".repeat(64), instance: "acme-growth", project: "pr-1" },
  upgrade: { kind: "upgrade", instance: "acme-growth", template: "growth", to: "2.1.0", digest: "b".repeat(64) },
  initiative: { kind: "initiative", title: "Win the private network", description: "Quiet is onboarded and three brokers trade through us.", projects: ["pr-1", "pr-5"], owner: "@calling", metrics: [{ name: "Brokers live", target: "40" }] },
  initiative_projects: { kind: "initiative_projects", initiative: "in-2", title: "Win the private network", projects: ["pr-5"] },
  initiative_owner: { kind: "initiative_owner", initiative: "in-2", title: "Win the private network", owner: "@calling" },
  initiative_shape: { kind: "initiative_shape", initiative: "in-2", title: "Win the private network", parent: "in-9", metrics: [{ name: "Brokers live", target: "40" }] },
};
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const field = (fields: ChangeField[], key: string) => fields.find((f) => f.key === key)!;
const shape = (f: ChangeField) => [f.label, f.kind, f.op, f.before?.text ?? null, f.after?.text ?? null];

describe("changeWords: the sentence is the oracle's", () => {
  test("every kind: sentence is the capitalised brief line with a full stop, terse is describeOrgChange", () => {
    expect(Object.keys(GOOD).sort()).toEqual([...ORG_CHANGE_KINDS].sort());
    for (const c of Object.values(GOOD)) {
      const w = changeWords(c, { names });
      expect(w.sentence, c.kind).toBe(`${capital(changeLine(c, { brief: true, names }))}.`);
      expect(w.terse, c.kind).toBe(describeOrgChange(c));
      expect(w.chip, c.kind).toBe(chipLine(c));
      expect(w.sentence, c.kind).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`));
    }
    // Without names, the same rule holds and refs stand as written.
    for (const c of Object.values(GOOD)) expect(changeWords(c).sentence, c.kind).toBe(`${capital(changeLine(c, { brief: true }))}.`);
  });

  test("subject, was and purpose pass through to the line; the span finds the subject's name", () => {
    expect(changeWords(GOOD.scope, { names, subject: "it" }).sentence).toBe("Have it look after Billing and have it stop looking after Pricing.");
    expect(changeWords({ kind: "project_meta", project: "pr-1", priority: "p1" }, { names, was: { priority: "p2" } }).sentence).toBe("Raise Growth to a high priority.");
    expect(changeWords(GOOD.initiative, { names, purpose: true }).sentence).toBe("Set Win the private network as the purpose.");
    const w = changeWords(GOOD.role, { names });
    expect(w.sentence).toBe("Add the role Head of Growth, reporting to you.");
    expect(w.subjectSpan).toEqual([13, 27]);
    expect(w.sentence.slice(...w.subjectSpan!)).toBe("Head of Growth");
    expect(changeWords(GOOD.scope, { names, subject: "it" }).subjectSpan).toBeNull();
    expect(changeWords(GOOD.task_status, { names }).subjectSpan).toEqual([14, 30]);
    expect(changeWords(GOOD.move).reason).toBe("Product owns the funnel now.");
    expect(changeWords(GOOD.scope).reason).toBeUndefined();
    expect(changeWords(GOOD.file, { seq: 7 }).fields.map((f) => f.seq)).toEqual([7]);
  });
});

describe("changeWords: fields", () => {
  test("a project's priority, with and without a live priority", () => {
    const p1: OrgChange = { kind: "project_meta", project: "pr-1", priority: "p1" };
    expect(changeWords(p1, { names }).fields.map(shape)).toEqual([["Priority", "priority", "set", null, "P1"]]);
    const raised = field(changeWords(p1, { names, was: { priority: "p2" } }).fields, "priority");
    expect(shape(raised)).toEqual(["Priority", "priority", "change", "P2", "P1"]);
    expect(raised.before?.priority).toBe("p2");
    expect(shape(field(changeWords(p1, { names, was: { priority: null } }).fields, "priority"))).toEqual(["Priority", "priority", "change", "not set", "P1"]);
    expect(field(changeWords(p1, { names, was: { priority: null } }).fields, "priority").before?.none).toBe(true);
    expect(shape(field(changeWords(p1, { names, before: { priority: "p3" } }).fields, "priority"))).toEqual(["Priority", "priority", "change", "P3", "P1"]);
    // Equal values: same while it waits, set once settled.
    expect(field(changeWords(p1, { names, was: { priority: "p1" } }).fields, "priority").op).toBe("same");
    expect(shape(field(changeWords(p1, { names, was: { priority: "p1" }, status: "accepted" }).fields, "priority"))).toEqual(["Priority", "priority", "set", null, "P1"]);
    expect(shape(field(changeWords(p1, { names, before: { priority: "p1" }, status: "applied" }).fields, "priority"))).toEqual(["Priority", "priority", "set", null, "P1"]);
  });

  test("a role: reports to, looks after, charter; with a seat the session, and no area when the scope is empty", () => {
    const fields = changeWords(GOOD.role, { names }).fields;
    expect(fields.map(shape)).toEqual([
      ["Reports to", "ref", "set", null, "you"],
      ["Looks after", "list", "set", null, "Growth"],
      ["Charter", "text", "set", null, "Owns the funnel. Reports spend every Monday."],
    ]);
    expect(field(fields, "looks_after").after?.items).toEqual(["Growth"]);
    const under = changeWords({ kind: "role", name: "SEO", handle: "seo", reports_to: "@growth", scope: { plans: ["pl-1"] } }, { names }).fields;
    expect(shape(field(under, "reports_to"))).toEqual(["Reports to", "ref", "set", null, "Head of Growth"]);
    expect(field(under, "reports_to").after?.ref).toEqual({ kind: "role", id: "growth" });
    expect(field(under, "looks_after").after?.items).toEqual(["Launch plan"]);
    const seated = changeWords({ kind: "role", name: "Head of People", handle: "people", seat: { existing: "jx7abcd" }, charter: "Keeps the org honest." }, { names }).fields;
    expect(seated.map(shape)).toEqual([
      ["Reports to", "ref", "set", null, "you"],
      ["Session", "text", "set", null, "Org review"],
      ["Charter", "text", "set", null, "Keeps the org honest."],
    ]);
    expect(field(seated, "session").after?.ref).toEqual({ kind: "session", id: "jx7abcd" });
    expect(seated.some((f) => f.label === "Looks after")).toBe(false);
    const program = changeWords({ kind: "role", name: "SEO", handle: "seo", tenure: { kind: "program", ends: { plan: "pl-7" }, then: "review" } }, { names }).fields;
    expect(shape(field(program, "stays"))).toEqual(["Stays", "text", "set", null, "until Launch ends, then review"]);
    for (const f of [...fields, ...under, ...seated, ...program]) expect(f.label).not.toMatch(/scope|charter_edit|limit|seq|handle/i);
  });

  test("projects say their description; a merge folds; a filing names the project with no project before", () => {
    const fields = changeWords(GOOD.projects, { names }).fields;
    expect(fields.map(shape)).toEqual([
      ["Says", "text", "set", null, "The sync layer, the daemon, the CLI."],
      ["Folds into", "ref", "change", "Old site", "Growth"],
    ]);
    expect(changeWords({ kind: "projects", changes: [{ op: "create", title: "Platform" }] }).fields).toEqual([]);
    const filed = changeWords(GOOD.file, { names, before: { project_id: null } }).fields;
    expect(filed.map(shape)).toEqual([["Project", "ref", "change", "no project", "Growth"]]);
    expect(filed[0].before?.none).toBe(true);
    expect(filed[0].after?.ref).toEqual({ kind: "project", id: "pr-1" });
    expect(changeWords(GOOD.file, { names, before: { project_id: "p-9", labels: { "p-9": "Billing" } } }).fields.map(shape)).toEqual([["Project", "ref", "change", "Billing", "Growth"]]);
    expect(changeWords(GOOD.file, { names }).fields.map(shape)).toEqual([["Project", "ref", "set", null, "Growth"]]);
  });

  test("a move and an area: who it reports to against the live parent, the area as a list diff", () => {
    const cold = changeWords(GOOD.move, { names }).fields;
    expect(cold.map(shape)).toEqual([
      ["Reports to", "ref", "set", null, "Head of Product"],
      ["Looks after", "list", "add", null, "Billing"],
    ]);
    const live = changeWords(GOOD.move, { names, before: { reports_to: { kind: "user", user_id: "u1" }, scope: { project_ids: ["p-1"], plan_ids: [] }, labels: { u1: "Cam", "p-1": "Growth" } } }).fields;
    expect(live.map(shape)).toEqual([
      ["Reports to", "ref", "change", "Cam", "Head of Product"],
      ["Looks after", "list", "add", "Growth", "Growth and Billing"],
    ]);
    expect(field(live, "reports_to").before?.ref).toEqual({ kind: "person", id: "u1" });
    expect(field(live, "looks_after").after?.items).toEqual(["Growth", "Billing"]);
    expect(changeWords(GOOD.scope, { names }).fields.map(shape)).toEqual([
      ["Looks after", "list", "add", null, "Billing"],
      ["Looks after", "list", "remove", null, "Pricing"],
    ]);
    expect(changeWords(GOOD.scope, { names, before: { scope: { project_ids: [], plan_ids: ["l-2"] }, labels: { "l-2": "Pricing" } } }).fields.map(shape)).toEqual([["Looks after", "list", "change", "Pricing", "Billing"]]);
    expect(changeWords({ kind: "scope", handle: "growth", remove: ["pl-2"] }, { names, before: { scope: { project_ids: [], plan_ids: ["l-2"] }, labels: { "l-2": "Pricing" } } }).fields.map(shape)).toEqual([["Looks after", "list", "clear", "Pricing", "nothing"]]);
  });

  test("the small kinds: retire, trust, routine, adopt, authority, hire, upgrade, records; a limit has no row", () => {
    expect(changeWords(GOOD.retire, { names }).fields.map(shape)).toEqual([["Role", "ref", "clear", "Content Lead", null]]);
    expect(changeWords(GOOD.budget, { names }).fields).toEqual([]);
    expect(changeWords(GOOD.trust, { names, before: { trust: "understand" } }).fields.map(shape)).toEqual([["Starts work", "text", "change", "when you start it", "on its own, inside its area"]]);
    const routine = changeWords(GOOD.routine, { names }).fields;
    expect(shape(routine[0])).toEqual(["Runs", "text", "set", null, "Weekly funnel"]);
    expect(routine[0].after?.tail).toBe(", every week");
    expect(changeWords(GOOD.adopt, { names, before: { standing_session: null } }).fields.map(shape)).toEqual([["Session", "text", "change", "not set", "Org review"]]);
    expect(changeWords(GOOD.authority, { names, before: { authority: [] } }).fields.map(shape)).toEqual([["May", "text", "change", "nothing", "spend (Paid search on the configured campaign, up to $300 a month)"]]);
    expect(changeWords(GOOD.hire, { names }).fields.map(shape)).toEqual([["Hired from", "text", "set", null, "growth (2.0.0)"], ["Leads", "ref", "set", null, "Growth"]]);
    expect(changeWords(GOOD.upgrade, { names }).fields.map(shape)).toEqual([["Version", "text", "set", null, "growth 2.1.0"]]);
    expect(changeWords(GOOD.task_status, { names, before: { status: "in_progress" } }).fields.map(shape)).toEqual([["Status", "status", "change", "in progress", "done"]]);
    expect(changeWords({ ...GOOD.plan_status, status: "active" } as OrgChange, { names }).fields.map(shape)).toEqual([["Status", "status", "set", null, "active"]]);
  });

  test("goals: a new goal's owner, measures, carriers and words; a shape's seat and measures; carriers added; an owner against the live one", () => {
    const goal = changeWords(GOOD.initiative, { names }).fields;
    expect(goal.map(shape)).toEqual([
      ["Owned by", "ref", "set", null, "Calling Lead"],
      ["Measured by", "measures", "set", null, "Brokers live (target 40)"],
      ["Carried by", "list", "set", null, "Growth and Billing"],
      ["Says", "text", "set", null, "Quiet is onboarded and three brokers trade through us."],
    ]);
    expect(field(goal, "metrics").after?.measures).toEqual([{ name: "Brokers live", target: "40" }]);
    expect(field(goal, "projects").after?.items).toEqual(["Growth", "Billing"]);
    // No number says so, except on the purpose; a person owner reads by name, no owner as nobody.
    const bare = changeWords({ kind: "initiative", title: "T", description: "", projects: [], owner: "Ashot" }).fields;
    expect(bare.map(shape)).toEqual([["Owned by", "ref", "set", null, "Ashot"], ["Measured by", "measures", "set", null, "no number yet"], ["Carried by", "list", "set", null, "no project"]]);
    expect(changeWords({ kind: "initiative", title: "T", description: "", projects: [] }, { purpose: true }).fields.map(shape)).toEqual([["Owned by", "ref", "set", null, "nobody"], ["Carried by", "list", "set", null, "no project"]]);
    const shaped = changeWords(GOOD.initiative_shape, { names, before: { parent_initiative_id: null, metrics: [] } }).fields;
    expect(shaped.map(shape)).toEqual([
      ["Sits", "ref", "change", "at the top level", "Reach 1k teams"],
      ["Measured by", "measures", "change", "nothing", "Brokers live (target 40)"],
    ]);
    expect(field(shaped, "parent").after?.ref).toEqual({ kind: "goal", id: "in-9" });
    expect(changeWords({ kind: "initiative_shape", initiative: "in-2", parent: null, questions: ["Who pays?"] }, { names }).fields.map(shape)).toEqual([
      ["Sits", "ref", "set", null, "at the top level"],
      ["Open questions", "list", "add", null, "Who pays?"],
    ]);
    expect(changeWords(GOOD.initiative_projects, { names }).fields.map(shape)).toEqual([["Carried by", "list", "add", null, "Billing"]]);
    expect(changeWords(GOOD.initiative_projects, { names, before: { project_ids: ["p-1"], labels: { "p-1": "Growth" } } }).fields.map(shape)).toEqual([["Carried by", "list", "add", "Growth", "Growth and Billing"]]);
    expect(changeWords(GOOD.initiative_owner, { names, before: { owner: { kind: "role", role_id: "r-1" }, labels: { "r-1": "Head of Growth" } } }).fields.map(shape)).toEqual([["Owned by", "ref", "change", "Head of Growth", "Calling Lead"]]);
    expect(changeWords({ kind: "initiative_owner", initiative: "in-2", owner: " " }, { names, before: { owner: null } }).fields.map(shape)).toEqual([["Owned by", "ref", "same", "nobody", "nobody"]]);
  });

  test("prose with a before is a passage with a diff; without one, text; charter edits are one passage per edit", () => {
    const meta: OrgChange = { kind: "project_meta", project: "pr-1", goal: "Ship the onboarding. Keep it short." };
    expect(changeWords(meta, { names }).fields.map(shape)).toEqual([["Says", "text", "set", null, "Ship the onboarding. Keep it short."]]);
    const diffed = field(changeWords(meta, { names, before: { goal: "Ship the onboarding. Keep it long." } }).fields, "goal");
    expect(shape(diffed)).toEqual(["Says", "passage", "change", "Ship the onboarding. Keep it long.", "Ship the onboarding. Keep it short."]);
    expect(diffed.diff!.map((p) => p.kind)).toEqual(["same", "removed", "added"]);
    expect(field(changeWords(meta, { names, before: { goal: "Ship the onboarding. Keep it short." } }).fields, "goal").op).toBe("same");
    expect(field(changeWords(meta, { names, before: { goal: null } }).fields, "goal").kind).toBe("text");
    const why = changeWords({ kind: "initiative_shape", initiative: "in-2", why: "It pays. Twice." }, { names, before: { why: "It pays. Once." } }).fields;
    expect(why[0].kind).toBe("passage");
    const edits = changeWords(GOOD.charter_edit, { names }).fields;
    expect(edits.map((f) => [f.key, f.label, f.kind, f.op])).toEqual([
      ["charter_edit:0", "Charter", "passage", "change"],
      ["charter_edit:1", "Charter", "passage", "add"],
      ["charter_edit:2", "Charter", "passage", "remove"],
    ]);
    expect(edits[0].diff!.map((p) => p.kind)).toEqual(["removed", "added"]);
    expect(edits[1].diff).toEqual([{ kind: "added", text: "Reports spend every Monday." }]);
    expect(edits[2].diff).toEqual([{ kind: "removed", text: "Writes the weekly post." }]);
    expect(edits[1].before).toBeNull();
    expect(edits[2].after).toBeNull();
  });
});

describe("passageDiff", () => {
  const seven = ["One is first.", "Two follows.", "Three is here.", "Four sits still.", "Five goes on.", "Six nearly ends.", "Seven closes."];
  const kinds = (parts: ReturnType<typeof passageDiff>) => parts.map((p) => p.kind);

  test("identical gives one same; a blank side gives one added or removed; two blanks give nothing", () => {
    const whole = seven.join(" ");
    expect(passageDiff(whole, whole)).toEqual([{ kind: "same", text: whole }]);
    expect(passageDiff("", "New words.")).toEqual([{ kind: "added", text: "New words." }]);
    expect(passageDiff("Old words.", "  ")).toEqual([{ kind: "removed", text: "Old words." }]);
    expect(passageDiff("", "")).toEqual([]);
  });

  test("one of seven sentences replaced: same, removed, added, gap; the gap holds the untouched tail", () => {
    const after = seven.map((s, i) => (i === 1 ? "Two is rewritten." : s)).join(" ");
    const parts = passageDiff(seven.join(" "), after);
    expect(kinds(parts)).toEqual(["same", "removed", "added", "gap"]);
    expect(parts[0].text).toBe("One is first. ");
    expect(parts[1].text).toBe("Two follows. ");
    expect(parts[2].text).toBe("Two is rewritten. ");
    expect(parts[3].text).toBe(seven.slice(2).join(" "));
    expect(parts.map((p) => p.text).join("")).toBe(after.replace("Two is rewritten. ", "Two follows. Two is rewritten. "));
  });

  test("added at the end, removed at the start, a replaced middle with one neighbour each side", () => {
    expect(kinds(passageDiff(seven.join(" "), `${seven.join(" ")} Eight is new.`))).toEqual(["gap", "added"]);
    expect(kinds(passageDiff(seven.join(" "), seven.slice(1).join(" ")))).toEqual(["removed", "gap"]);
    expect(kinds(passageDiff("A is here. B is here. C is here.", "A is here. B moved. C is here."))).toEqual(["same", "removed", "added", "same"]);
    expect(kinds(passageDiff("A is here. B is here.", "C is here. D is here."))).toEqual(["removed", "added"]);
  });

  test("a numbered list diffs by line, keeping the line breaks", () => {
    const before = "Steps:\n1. Read the queue.\n2. Pick the oldest.\n3. Post the result.";
    const after = "Steps:\n1. Read the queue.\n2. Pick the newest.\n3. Post the result.";
    const parts = passageDiff(before, after);
    expect(kinds(parts)).toEqual(["gap", "removed", "added", "same"]);
    expect(parts[1].text).toBe("2. Pick the oldest.\n");
    expect(parts[2].text).toBe("2. Pick the newest.\n");
    expect(parts.map((p) => p.text).join("")).toBe("Steps:\n1. Read the queue.\n2. Pick the oldest.\n2. Pick the newest.\n3. Post the result.");
  });

  test("abbreviations, versions and domains never split a sentence", () => {
    const base = "Use the CLI, e.g. the publish verb. Ship v2.1 to codecast.sh today. Ask Dr. Who first.";
    const parts = passageDiff(base, base.replace("today", "tomorrow"));
    expect(kinds(parts)).toEqual(["same", "removed", "added", "same"]);
    expect(parts[1].text).toBe("Ship v2.1 to codecast.sh today. ");
    expect(parts[3].text).toBe("Ask Dr. Who first.");
    expect(kinds(passageDiff("See No. 5 before. Then go.", "See No. 5 before. Then stop."))).toEqual(["same", "removed", "added"]);
    expect(kinds(passageDiff("Close by 2026. Then rest.", "Close by 2027. Then rest."))).toEqual(["removed", "added"]);
  });
});

describe("fieldMoves", () => {
  test("a charter amend is one Charter passage with a diff; a reports_to amend one ref field; a rationale-only amend none", () => {
    const before: OrgChange = { kind: "role", name: "Escalations lead", handle: "escalations", reports_to: "Cam", charter: "Owns escalations. Answers within an hour. Logs every case." };
    const after: OrgChange = { ...before, charter: "Owns escalations. Answers within a day. Logs every case." } as OrgChange;
    const moves = fieldMoves(before, after, { names, seq: 1 });
    expect(moves.map(shape)).toEqual([["Charter", "passage", "change", "Owns escalations. Answers within an hour. Logs every case.", "Owns escalations. Answers within a day. Logs every case."]]);
    expect(moves[0].diff!.map((p) => p.kind)).toEqual(["same", "removed", "added", "same"]);
    expect(moves[0].seq).toBe(1);
    expect(fieldMoves(before, { ...before, reports_to: "me" } as OrgChange, { names }).map(shape)).toEqual([["Reports to", "ref", "change", "Cam", "you"]]);
    expect(fieldMoves(before, { ...before } as OrgChange, { names })).toEqual([]);
    expect(fieldMoves(GOOD.move, { ...GOOD.move, reason: "another reason" } as OrgChange, { names })).toEqual([]);
  });

  test("a field only the new change has is set; one only the old had is cleared; a limit moves nothing", () => {
    const was: OrgChange = { kind: "role", name: "SEO", handle: "seo" };
    expect(fieldMoves(was, { ...was, scope: { projects: ["pr-1"] } } as OrgChange, { names }).map(shape)).toEqual([["Looks after", "list", "set", null, "Growth"]]);
    expect(fieldMoves({ ...was, charter: "Writes." } as OrgChange, was, { names }).map(shape)).toEqual([["Charter", "text", "clear", "Writes.", null]]);
    expect(fieldMoves(GOOD.budget, { kind: "budget", handle: "growth", caps: { tokens_per_day: 600_000 } }, { names })).toEqual([]);
    const measured = fieldMoves({ kind: "initiative_shape", initiative: "in-2", metrics: [{ name: "Brokers live", target: "40" }] }, { kind: "initiative_shape", initiative: "in-2", metrics: [{ name: "Brokers live", target: "50" }] }, { names });
    expect(measured.map(shape)).toEqual([["Measured by", "measures", "change", "Brokers live (target 40)", "Brokers live (target 50)"]]);
  });
});

describe("recordTotalsWords and proposalTotals", () => {
  type Row = { seq: number; change: OrgChange; status?: string };
  const rows: Row[] = [];
  const push = (change: OrgChange, status?: string) => rows.push({ seq: rows.length + 1, change, ...(status ? { status } : {}) });
  const task = (i: number, status: "done" | "dropped" | "open" | "backlog", place: { plan?: string; project?: string } = {}): OrgChange => ({ kind: "task_status", task: `ct-${9100 + i}`, status, reason: "r", title: `Task ${i}`, ...place });
  const plan = (ref: string, status: "done" | "abandoned" | "active", project?: string): OrgChange => ({ kind: "plan_status", plan: ref, status, reason: "r", ...(project ? { project } : {}) });
  // pr-901: 1 plan done, 14 tasks done, 3 open.
  push(plan("pl-901", "done", "pr-901"));
  for (let i = 1; i <= 14; i++) push(task(i, "done", { project: "pr-901" }));
  for (let i = 15; i <= 17; i++) push(task(i, "open", { project: "pr-901" }));
  // pr-902: 2 plans done, 1 abandoned, 12 tasks done, 2 open, 1 dropped.
  push(plan("pl-902", "done", "pr-902")); push(plan("pl-903", "done", "pr-902")); push(plan("pl-904", "abandoned", "pr-902"));
  for (let i = 18; i <= 29; i++) push(task(i, "done", { project: "pr-902" }));
  push(task(30, "open", { project: "pr-902" })); push(task(31, "open", { project: "pr-902" })); push(task(32, "dropped", { project: "pr-902" }));
  // pr-903: 1 plan done, 6 tasks done, 2 open.
  push(plan("pl-905", "done", "pr-903"));
  for (let i = 33; i <= 38; i++) push(task(i, "done", { project: "pr-903" }));
  push(task(39, "open", { project: "pr-903" })); push(task(40, "open", { project: "pr-903" }));
  // pl-911: 1 plan done, 5 tasks done. pl-912: 1 plan active, 4 tasks open.
  push(plan("pl-911", "done"));
  for (let i = 41; i <= 45; i++) push(task(i, "done", { plan: "pl-911" }));
  push(plan("pl-912", "active"));
  for (let i = 46; i <= 49; i++) push(task(i, "open", { plan: "pl-912" }));
  // loose: 2 plans abandoned, 2 tasks done, 3 open, 1 backlog.
  push(plan("pl-920", "abandoned")); push(plan("pl-921", "abandoned"));
  push(task(50, "done")); push(task(51, "done"));
  for (let i = 52; i <= 54; i++) push(task(i, "open"));
  push(task(55, "backlog"));
  const groups = orgRecordGroups(rows, names);

  test("each group's line, the acts summed across nouns, and a single backlog row", () => {
    expect(rows.length).toBe(64);
    expect(groups.map((g) => [g.title ?? g.ref ?? g.kind, recordTotalsWords(g.totals)])).toEqual([
      ["Matching Engine & Funnel", "1 plan done, 14 tasks done and 3 tasks reopened"],
      ["Callers & Call Management", "2 plans done, 1 plan abandoned, 12 tasks done, 1 task dropped and 2 tasks reopened"],
      ["Infrastructure", "1 plan done, 6 tasks done and 2 tasks reopened"],
      ["Counterparty pitches", "1 plan done and 5 tasks done"],
      ["Networks", "1 plan reopened and 4 tasks reopened"],
      // A plan with no project is its own group (orgRecordGroups), never loose.
      ["pl-920", "1 plan abandoned"],
      ["pl-921", "1 plan abandoned"],
      ["loose", "2 tasks done, 3 tasks reopened and 1 task to the backlog"],
    ]);
    expect(recordTotalsWords(groups.flatMap((g) => g.totals), { nouns: false })).toBe("44 done, 15 reopened, 3 abandoned, 1 dropped and 1 to the backlog");
    const one: OrgRecordTotal[] = [{ noun: "task", act: "backlog", count: 1 }];
    expect(recordTotalsWords(one)).toBe("1 task to the backlog");
    expect(recordTotalsWords(one, { nouns: false })).toBe("1 to the backlog");
    // Ties in count keep the acts' own order.
    expect(recordTotalsWords([{ noun: "task", act: "reopened", count: 2 }, { noun: "plan", act: "done", count: 2 }], { nouns: false })).toBe("2 done and 2 reopened");
  });

  test("proposalTotals: records, goals, structure buckets, one change, removed rows left out", () => {
    expect(proposalTotals(rows, names)).toEqual({ count: "64 records", line: "64 records: 44 done, 15 reopened, 3 abandoned, 1 dropped and 1 to the backlog." });
    expect(proposalTotals([rows[0]], names)).toEqual({ count: "1 record", line: null });
    const goals: Row[] = [
      ...Array.from({ length: 7 }, (_, i): Row => ({ seq: i + 1, change: { kind: "initiative", title: `G${i}`, description: "", projects: [] } })),
      { seq: 8, change: GOOD.initiative_shape }, { seq: 9, change: GOOD.initiative_projects }, { seq: 10, change: GOOD.initiative_owner }, { seq: 11, change: { kind: "initiative_shape", initiative: "in-9", parent: null } },
    ];
    expect(proposalTotals(goals, names)).toEqual({ count: "11 changes to goals", line: "11 changes to goals: 7 new goals and 4 changes to goals that exist." });
    expect(proposalTotals(goals.slice(0, 3), names).line).toBe("3 changes to goals: 3 new goals.");
    expect(proposalTotals(goals.slice(7, 9), names).line).toBe("2 changes to goals: 2 changes to goals that exist.");
    expect(proposalTotals(goals.slice(6, 8), names).line).toBe("2 changes to goals: 1 new goal and 1 change to a goal that exists.");
    // op-55: nine priorities and nothing else drops the count.
    const priorities: Row[] = Array.from({ length: 9 }, (_, i): Row => ({ seq: i + 1, change: { kind: "project_meta", project: `pr-${i}`, priority: "p2" } }));
    expect(proposalTotals(priorities, names)).toEqual({ count: "9 changes", line: "9 project priorities." });
    // op-56: a project and the role that leads it, in the order the proposal names them.
    expect(proposalTotals([{ seq: 1, change: { kind: "projects", changes: [{ op: "create", title: "Deals" }] } }, { seq: 2, change: GOOD.role }], names)).toEqual({ count: "2 changes", line: "2 changes: 1 new project and 1 new role." });
    // op-58: a session named as a role and three plans filed.
    const seat: OrgChange = { kind: "role", name: "Head of People", handle: "people", seat: { existing: "jx7abcd" } };
    expect(proposalTotals([{ seq: 1, change: seat }, { seq: 2, change: GOOD.file }, { seq: 3, change: GOOD.file }, { seq: 4, change: GOOD.file }], names)).toEqual({ count: "4 changes", line: "4 changes: 1 session named as a role and 3 plans filed." });
    // Every other noun, once each.
    const mixed: Row[] = [GOOD.projects, GOOD.project_meta, GOOD.move, GOOD.scope, GOOD.retire, GOOD.charter_edit, GOOD.trust, GOOD.routine].map((change, i): Row => ({ seq: i + 1, change }));
    expect(proposalTotals(mixed, names).line).toBe("8 changes: 1 new project, 1 project merged, 1 project charter, 1 move, 1 area change, 1 retirement, 1 charter rewrite and 2 settings.");
    expect(proposalTotals([{ seq: 1, change: GOOD.role }], names)).toEqual({ count: "1 change", line: null });
    expect(proposalTotals([{ seq: 1, change: GOOD.role }, { seq: 2, change: GOOD.move, status: "removed" }], names)).toEqual({ count: "1 change", line: null });
    expect(proposalTotals([], names)).toEqual({ count: "0 changes", line: null });
  });
});

describe("subjectWords", () => {
  const title = "Win the private network";
  const shapeChange: OrgChange = { kind: "initiative_shape", initiative: "in-2", title, parent: "in-9", metrics: [{ name: "A", target: "1" }, { name: "B", target: "2" }] };

  test("one, three and four clauses, and a new subject that stops after the lead", () => {
    const one = subjectWords(GOOD.initiative_owner, [], { names, isNew: false, subject: title });
    expect(one.sentence).toBe(`Make Calling Lead the owner of ${title}.`);
    expect(one.sentence.slice(...one.subjectSpan!)).toBe(title);
    const three = subjectWords(shapeChange, [GOOD.initiative_projects], { names, isNew: false, subject: title });
    expect(three.sentence).toBe(`Move ${title} under Reach 1k teams, give it two measures and have Billing carry it.`);
    const four = subjectWords(shapeChange, [GOOD.initiative_projects, GOOD.initiative_owner], { names, isNew: false, subject: title });
    expect(four.sentence).toBe(`Move ${title} under Reach 1k teams and 3 more changes.`);
    expect(four.subjectSpan).toEqual([5, 5 + title.length]);
    const fresh = subjectWords(GOOD.role, [GOOD.trust, GOOD.routine], { names, isNew: true, subject: "the role Head of Growth" });
    expect(fresh.sentence).toBe("Add the role Head of Growth, reporting to you.");
    expect(fresh.sentence.slice(...fresh.subjectSpan!)).toBe("Head of Growth");
    const grown = subjectWords(GOOD.move, [GOOD.trust], { names, isNew: false, subject: "Head of Growth" });
    expect(grown.sentence).toBe("Have Head of Growth report to Head of Product, have it look after Billing and let it start work in its area on its own.");
  });
});

describe("chipLine", () => {
  test("the delta alone, with counts compacted", () => {
    expect(chipLine({ kind: "budget", handle: "growth", caps: { tokens_per_day: 800_000, wakes_per_day: 12 } })).toBe("wakes 12 · tokens 800k");
    expect(chipLine({ kind: "budget", handle: "growth", caps: { tokens_per_day: 1_500_000 } })).toBe("tokens 1.5M");
    expect(chipLine({ kind: "scope", handle: "growth", add: ["Platform"] })).toBe("+ Platform");
    expect(chipLine({ kind: "move", handle: "growth", reports_to: "@infra", scope_add: ["Billing"] })).toBe("under @infra +Billing");
    expect(chipLine({ kind: "move", handle: "growth" })).toBe("move");
    expect(chipLine({ kind: "file", plan: "pl-9", project: "Growth" })).toBe("pl-9 under Growth");
    expect(chipLine({ kind: "project_meta", project: "Growth", priority: "p1", owner: "@growth" })).toBe("Growth · p1 · owner @growth");
    expect(chipLine(GOOD.charter_edit)).toBe(changeLine(GOOD.charter_edit));
  });
});
