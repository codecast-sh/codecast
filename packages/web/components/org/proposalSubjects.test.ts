// A proposal's changes as cards, one per subject (org-staffing.md S39): which
// changes belong together, the one sentence each card reads as, what every
// field read as before (the live record while a change waits, the stamp once
// it is applied, nothing for a skip or another workspace), and the order a
// verdict on a card is sent in. The rows are synthetic and shaped like the two
// proposals the design was drawn against: nine project priorities, and a goal
// tree with one purpose.
// Run: bun test components/org/proposalSubjects.test.ts
import { describe, expect, test } from "bun:test";
import type { OrgAppliedDiffRow } from "@codecast/shared/contracts/orgChange";
import { ORG_FIXTURE } from "./orgFixture";
import type { OrgProposalChange } from "./orgStaffingTypes";
import { decideTogether } from "./proposalDecide";
import { askNames } from "./staffingAsks";
import {
  changeReply, namedTaskRefs, ordinalWord, placeWords, proposalProgressWords, proposalSubjects, subjectCounts, subjectKeyOf, subjectOfSeq, subjectSentence, subjectStatus, subjectStatusWords,
  type FieldRow, type FieldValue, type SubjectCard, type SubjectLive,
} from "./proposalSubjects";

const ME = "fixture-user-me";
const SAM = "fixture-user-sam";
const GROWTH = "fixture-role-growth";

const change = (id: string, seq: number, c: any, status: OrgProposalChange["status"] = "proposed", extra: Partial<OrgProposalChange> = {}): OrgProposalChange =>
  ({ _id: id, proposal_id: "p1", seq, change: c, rationale: `why ${id}`, evidence: [], status, ...extra });

const PROJECTS: SubjectLive["projects"] = [
  { _id: "p-infra", short_id: "pr-1", title: "Infrastructure", status: "active" },
  { _id: "p-funnel", short_id: "pr-2", title: "Matching & Funnel", status: "active" },
  { _id: "p-deals", short_id: "pr-3", title: "People & Deals", status: "active", owner_role_id: GROWTH, goal: "Close the first fee" },
  { _id: "p-network", short_id: "pr-5", title: "Private Network", status: "active", priority: "p2" },
  { _id: "p-quality", short_id: "pr-6", title: "Agent Quality", status: "active" },
  { _id: "p-callers", short_id: "pr-7", title: "Callers", status: "active" },
  { _id: "p-outreach", short_id: "pr-8", title: "Broker Outreach", status: "active" },
  { _id: "p-launch", short_id: "pr-9", title: "Public Launch", status: "paused" },
  { _id: "p-ideas", short_id: "pr-10", title: "Ideas", status: "active" },
  { _id: "fixture-project-growth", short_id: "pr-4", title: "Growth", status: "active" },
  { _id: "p-platform", short_id: "pr-11", title: "Platform", status: "active" },
];
const goal = (id: string, short: string, title: string, extra: Record<string, unknown> = {}) =>
  ({ _id: id, short_id: short, title, status: "active", project_ids: [], health: "none", workspace: "team:x", user_id: ME, created_at: 0, updated_at: 0, ...extra }) as any;
const GOALS = [
  goal("g-org", "in-1", "Every project has a lead", { owner: { kind: "role", role_id: GROWTH }, project_ids: ["p-quality"] }),
  goal("g-net", "in-2", "Win the private network", { owner: { kind: "user", user_id: ME }, project_ids: ["p-network"] }),
  goal("g-proud", "in-4", "Proud relationships"),
  goal("g-old", "in-5", "Old parent"),
  goal("g-kid", "in-6", "Measured child", { parent_initiative_id: "g-old", metrics: [{ key: "replies", name: "Replies", target: "5%" }], why: "It pays" }),
];
const LIVE: SubjectLive = {
  tree: ORG_FIXTURE,
  goals: GOALS,
  projects: PROJECTS,
  plans: [{ _id: "fixture-plan-seo", short_id: "pl-88", title: "SEO and AI citations", status: "active", project_id: "fixture-project-growth" }, { _id: "plan-loose", short_id: "pl-90", title: "Loose plan", status: "active" }],
  tasks: [{ _id: "t9", short_id: "ct-9", title: "Remove the pilot", status: "in_progress" }, { _id: "t10", short_id: "ct-10", title: "Ship the page", status: "open" }],
};

// Nine project priorities, one change each, written out of rank order.
const RANKING = [
  change("r1", 1, { kind: "project_meta", project: "Infrastructure", priority: "p0" }),
  change("r2", 2, { kind: "project_meta", project: "Matching & Funnel", priority: "p1" }),
  change("r3", 3, { kind: "project_meta", project: "Ideas", priority: "p3" }),
  change("r4", 4, { kind: "project_meta", project: "Private Network", priority: "p1" }),
  change("r5", 5, { kind: "project_meta", project: "Agent Quality", priority: "p1" }),
  change("r6", 6, { kind: "project_meta", project: "Callers", priority: "p2" }),
  change("r7", 7, { kind: "project_meta", project: "Broker Outreach", priority: "p2" }),
  change("r8", 8, { kind: "project_meta", project: "Public Launch", priority: "p2" }),
  change("r9", 9, { kind: "project_meta", project: "People & Deals", priority: "p1" }),
];

// A goal tree: one purpose, goals set under it, live goals moved under it.
const PURPOSE = "Broker introductions that close";
const TREE = [
  change("g1", 1, { kind: "initiative", title: PURPOSE, description: "The business earns its fee when an introduction becomes a transaction.", owner: "Ashot Petrosian", projects: PROJECTS.slice(0, 9).map((p) => p.title) }),
  change("g2", 2, { kind: "initiative", title: "Make revenue", description: "First on the list.", owner: "Samvit Jain", parent: PURPOSE, projects: ["People & Deals"], metrics: [{ name: "Fees collected", target: "The first dollar" }], evidence: ["Core focuses in #team"] }),
  change("g3", 3, { kind: "initiative", title: "Fundraise", description: "", owner: "me", parent: PURPOSE, projects: ["Public Launch"] }),
  change("g6", 6, { kind: "initiative_shape", initiative: "in-2", parent: PURPOSE, title: "Win the private network" }),
  change("g10", 10, { kind: "initiative_projects", initiative: "in-4", projects: ["Agent Quality"], title: "Proud relationships" }),
  change("g9", 9, { kind: "initiative_shape", initiative: "in-4", parent: PURPOSE, title: "Proud relationships", metrics: [{ name: "Trust breaks per day", target: "0" }, { name: "Comms score", target: "0.9 or higher" }] }),
];

const cardsOf = (changes: OrgProposalChange[], live: SubjectLive | null = LIVE, opts?: Parameters<typeof proposalSubjects>[2]) => proposalSubjects(changes, live, opts);
const one = (changes: OrgProposalChange[], live: SubjectLive | null = LIVE): SubjectCard => {
  const cards = cardsOf(changes, live);
  expect(cards).toHaveLength(1);
  return cards[0];
};
const rowOf = (card: SubjectCard, key: string, op?: FieldRow["op"]): FieldRow => card.rows.find((r) => r.key === key && (!op || r.op === op))!;
/** A value as the words a person reads. */
const read = (v: FieldValue | null): string | null => {
  if (!v) return null;
  switch (v.kind) {
    case "text": return v.text + (v.tail ?? "");
    case "none": return v.text;
    case "face": return v.you ? "you" : v.face.name;
    case "priority": return v.priority;
    case "names": return v.summary ?? v.names.join(", ");
    case "measures": return v.measures.map((m) => `${m.name}, target ${m.target}`).join("; ");
  }
};
const diff = (card: SubjectCard, key: string) => { const r = rowOf(card, key); return [r.op, read(r.before), read(r.after)]; };
const stamp = (kind: string, before: Record<string, unknown>, after: Record<string, unknown>, extra: Partial<OrgAppliedDiffRow> = {}): OrgAppliedDiffRow[] =>
  [{ kind: kind as any, subject: { type: "project", id: "x", label: "x" }, before, after, labels: {}, ...extra }];

describe("grouping", () => {
  test("nine project changes are nine cards, ordered by the priority each is left with", () => {
    const cards = cardsOf(RANKING);
    expect(cards.map((c) => c.title)).toEqual(["Infrastructure", "Matching & Funnel", "Private Network", "Agent Quality", "People & Deals", "Callers", "Broker Outreach", "Public Launch", "Ideas"]);
    expect(cards.every((c) => c.kind === "project" && c.changes.length === 1 && !c.isNew)).toBe(true);
    expect(cards[0]).toMatchObject({ key: "project:p-infra", face: { kind: "record", record: "project", id: "p-infra" }, change_ids: ["r1"], seqs: [1], status: "proposed", waiting: 1, proposal_id: "p1" });
    expect(cards[0].reasons).toEqual(["why r1"]);
  });

  test("a project's fields and its status are one card; without live rows the ref still joins them", () => {
    const both = [change("m", 1, { kind: "project_meta", project: "Public Launch", priority: "p1" }), change("s", 2, { kind: "project_status", project: "pr-9", status: "active", reason: "work resumed" })];
    expect(one(both).change_ids).toEqual(["s", "m"]);
    expect(one(both).seqs).toEqual([1, 2]);
    const byRef = [change("m", 1, { kind: "project_meta", project: "Public Launch", priority: "p1" }), change("s", 2, { kind: "project_status", project: "public launch", status: "active", reason: "r" })];
    expect(cardsOf(byRef, null)).toHaveLength(1);
  });

  test("two changes to one goal are one card; goals read purpose first, then what sits under it", () => {
    const cards = cardsOf(TREE);
    expect(cards.map((c) => c.title)).toEqual([PURPOSE, "Make revenue", "Fundraise", "Win the private network", "Proud relationships"]);
    const proud = cards[4];
    expect(proud).toMatchObject({ key: "goal:g-proud", kind: "goal", isNew: false, seqs: [9, 10] });
    // Read in the author's order, sent in the order the server applies them.
    expect(proud.changes.map((c) => c._id)).toEqual(["g9", "g10"]);
    expect(proud.change_ids).toEqual(["g10", "g9"]);
    expect(cards[0]).toMatchObject({ isNew: true, key: "goal:g1" });
  });

  test("a role with its session, routine and limit is one card, the limit riding unseen", () => {
    const card = one([
      change("limit", 1, { kind: "budget", handle: "platform", caps: { tokens_per_day: 800_000 } }),
      change("routine", 2, { kind: "routine", handle: "platform", title: "Weekly platform review", prompt: "Review", every: "7d" }),
      change("adopt", 3, { kind: "adopt", handle: "@platform", conversation: "jx7abcd" }),
      change("role", 4, { kind: "role", name: "Head of Platform", handle: "Platform", reports_to: "me", scope: { projects: ["Platform"] }, trust: "direct" }),
      change("trust", 5, { kind: "trust", handle: "platform", trust: "direct" }),
    ]);
    expect(card).toMatchObject({ key: "role:platform", kind: "role", title: "Head of Platform", isNew: true, struck: false, waiting: 5 });
    expect(card.changes.map((c) => c._id)).toEqual(["role", "routine", "adopt", "trust"]);
    expect(card.riders.map((c) => c._id)).toEqual(["limit"]);
    // Apply order: the role, its limit, the switch, the session, then the routine that needs the session.
    expect(card.change_ids).toEqual(["role", "limit", "trust", "adopt", "routine"]);
    expect(card.sentence).toBe("Add the role Head of Platform, reporting to you.");
    expect(card.sentence.slice(...card.subjectSpan!)).toBe("Head of Platform");
    expect(card.rows.map((r) => [r.key, r.label, r.op, read(r.after), r.seq])).toEqual([
      ["handle", "Answers to", "set", "@platform", 4],
      ["area", "Looks after", "set", "Platform", 4],
      ["routine", "Runs", "set", "Weekly platform review, every week", 2],
      ["session", "Session", "set", "Offered session", 3],
      ["starts_work", "Starts work", "set", "on its own, inside its area", 5],
    ]);
    // The cadence is a quiet tail on the routine's name, the way ", target" is on a measure.
    expect(rowOf(card, "routine").after).toEqual({ kind: "text", text: "Weekly platform review", tail: ", every week" });
    expect(card.sits).toBe("Reports to you");
    expect(JSON.stringify(card.rows) + card.sentence + card.reasons.join(" ")).not.toMatch(/800|tokens|wakes|caps|why limit/);
  });

  test("roles read parents first: a new lead comes before the role moved under it", () => {
    const cards = cardsOf([
      change("move", 1, { kind: "move", handle: "growth", reports_to: "@platform" }),
      change("role", 2, { kind: "role", name: "Head of Platform", handle: "platform", reports_to: "me" }),
    ]);
    expect(cards.map((c) => c.key)).toEqual(["role:platform", "role:growth"]);
    expect(cards[1].sentence).toBe("Have Head of Growth report to Head of Platform.");
    expect(diff(cards[1], "reports_to")).toEqual(["change", "you", "Head of Platform"]);
    expect(cards[1].sits).toBeNull();
  });

  test("kinds come in one order: goals, projects, roles, plans, tasks", () => {
    const cards = cardsOf([
      change("t", 1, { kind: "task_status", task: "ct-9", status: "done", reason: "shipped" }),
      change("p", 2, { kind: "plan_status", plan: "pl-88", status: "done", reason: "all closed" }),
      change("r", 3, { kind: "trust", handle: "growth", trust: "direct" }),
      change("m", 4, { kind: "project_meta", project: "Ideas", priority: "p3" }),
      change("g", 5, { kind: "initiative_owner", initiative: "in-4", owner: "me" }),
    ]);
    expect(cards.map((c) => c.kind)).toEqual(["goal", "project", "role", "plan", "task"]);
  });

  test("within a kind an ending sorts last: a retirement after the roles that go on, a record closed after one reopened", () => {
    const cards = cardsOf([
      change("retire", 1, { kind: "retire", handle: "growth" }),
      change("trust", 2, { kind: "trust", handle: "platform", trust: "direct" }),
      change("done", 3, { kind: "task_status", task: "ct-9", status: "done", reason: "shipped" }),
      change("open", 4, { kind: "task_status", task: "ct-10", status: "open", reason: "not yet" }),
    ]);
    expect(cards.map((c) => [c.key, c.struck])).toEqual([["role:platform", false], ["role:growth", true], ["task:ct-10", false], ["task:ct-9", true]]);
  });

  test("the seqs option groups one ask's changes and never crosses it, while refs still read the whole proposal", () => {
    const cards = cardsOf(TREE, LIVE, { seqs: new Set([6, 9]) });
    expect(cards.map((c) => [c.title, c.seqs])).toEqual([["Win the private network", [6]], ["Proud relationships", [9]]]);
    expect(cards[1].change_ids).toEqual(["g9"]);
    // The purpose is not in this ask, and is still what the sentence calls the parent.
    expect(cards[0].sentence).toBe("Move Win the private network under the purpose.");
  });

  test("a plan carries the tasks it closes; they get no card and are decided with it", () => {
    const changes = [
      change("task-a", 1, { kind: "task_status", task: "ct-9", status: "done", reason: "shipped on main" }),
      change("task-b", 2, { kind: "task_status", task: "ct-10", status: "dropped", reason: "plan done", title: "Ship the page" }),
      change("plan", 3, { kind: "plan_status", plan: "pl-88", status: "done", reason: "every task closed", tasks: ["ct-9", "ct-10"] }),
      change("file", 4, { kind: "file", plan: "fixture-plan-seo", project: "Platform" }),
    ];
    const card = one(changes);
    expect(card).toMatchObject({ key: "plan:fixture-plan-seo", kind: "plan", title: "SEO and AI citations", struck: true });
    expect(card.carried.map((c) => c._id)).toEqual(["task-a", "task-b"]);
    expect(card.change_ids).toEqual(["task-a", "task-b", "plan", "file"]);
    expect(card.sentence).toBe("Mark the plan SEO and AI citations as done and put it under the project Platform.");
    expect(diff(card, "status")).toEqual(["change", "active", "done"]);
    expect(diff(card, "carried")).toEqual(["set", null, "Remove the pilot, Ship the page"]);
    expect(diff(card, "project")).toEqual(["change", "Growth", "Platform"]);
    // A record's reason is what the agent saw, so it reads as a source, never as a why.
    expect(card.reasons).toEqual(["why plan", "why file"]);
    expect(card.evidence).toEqual([{ label: "every task closed" }]);
    expect(subjectOfSeq([card], 2)).toBe(card);
    expect(namedTaskRefs(changes)).toEqual(["ct-9", "ct-10"]);
  });

  test("a limit alone is one plain sentence with no rows and no number", () => {
    const card = one([change("limit", 1, { kind: "budget", handle: "growth", caps: { tokens_per_day: 800_000 } })]);
    expect(card).toMatchObject({ key: "role:growth", title: "Head of Growth", changes: [], rows: [], change_ids: ["limit"], seqs: [], status: "proposed", waiting: 1, reasons: [] });
    expect(card.sentence).toBe("Head of Growth keeps a safety net on its daily work.");
    expect(card.sentence.slice(...card.subjectSpan!)).toBe("Head of Growth");
    expect(subjectStatusWords(card)).toBe("To decide");
    expect(one([change("limit", 1, { kind: "budget", handle: "growth", caps: { tokens_per_day: 800_000 } })], null).sentence).toBe("@growth keeps a safety net on its daily work.");
    expect(JSON.stringify(card)).not.toMatch(/"sentence":"[^"]*800/);
  });

  test("subjectKeyOf: everything on a handle is one role; a plan by ref or id is one plan", () => {
    expect(subjectKeyOf(null, { kind: "budget", handle: "@Growth", caps: {} })).toBe("role:growth");
    expect(subjectKeyOf(null, { kind: "routine", handle: "growth", title: "t", prompt: "p", every: "1d" })).toBe("role:growth");
    const plans = [{ id: "fixture-plan-seo", title: "SEO", short_id: "pl-88" }];
    expect(subjectKeyOf(null, { kind: "file", plan: "PL-88", project: "x" }, plans)).toBe("plan:fixture-plan-seo");
    expect(subjectKeyOf(null, { kind: "plan_status", plan: "pl-12", status: "done", reason: "r" })).toBe("plan:pl-12");
    expect(subjectKeyOf(null, { kind: "task_status", task: "CT-9", status: "done", reason: "r" })).toBe("task:ct-9");
    expect(subjectKeyOf(null, { kind: "upgrade", instance: "Growth-Pack", template: "growth", to: "2", digest: "d" })).toBe("instance:growth-pack");
    expect(subjectKeyOf({ change_id: "c9", node: { kind: "unknown", id: "c9", name: "" } }, { kind: "projects", changes: [{ op: "create", title: "A" }] })).toBe("projects:c9");
  });

  test("subjectOfSeq: a drawn change, one that rides along, and nothing for a removed or unknown number", () => {
    const cards = cardsOf([
      change("trust", 1, { kind: "trust", handle: "growth", trust: "direct" }),
      change("limit", 2, { kind: "budget", handle: "growth", caps: { wakes_per_day: 4 } }),
      change("gone", 3, { kind: "scope", handle: "growth", add: ["Platform"] }, "removed"),
      change("meta", 4, { kind: "project_meta", project: "Ideas", priority: "p3" }),
    ]);
    expect(subjectOfSeq(cards, 1)?.key).toBe("role:growth");
    expect(subjectOfSeq(cards, 2)?.key).toBe("role:growth");
    expect(subjectOfSeq(cards, 4)?.key).toBe("project:p-ideas");
    expect(subjectOfSeq(cards, 3)).toBeNull();
    expect(subjectOfSeq(cards, 99)).toBeNull();
    expect(cards.flatMap((c) => c.change_ids)).not.toContain("gone");
  });
});

describe("sentences", () => {
  test("a project priority: the top one, a raise from what it holds now, a first one", () => {
    const cards = cardsOf(RANKING);
    expect(cards[0].sentence).toBe("Make Infrastructure the top priority.");
    expect(cards[0].sentence.slice(...cards[0].subjectSpan!)).toBe("Infrastructure");
    expect(cards[2].sentence).toBe("Raise Private Network to a high priority.");
    expect(cards[8].sentence).toBe("Make Ideas a low priority.");
    expect(subjectSentence(cards[2], "this")).toBe("Raise this project to a high priority.");
    expect(subjectSentence(cards[2], "named")).toBe(cards[2].sentence);
    // Nothing to compare against in another workspace: it reads as a first priority.
    expect(cardsOf(RANKING, null).find((c) => c.title === "Private Network")!.sentence).toBe("Make Private Network a high priority.");
  });

  test("several changes to a goal that exists join into one sentence, its name the only one written", () => {
    const proud = cardsOf(TREE)[4];
    expect(proud.sentence).toBe("Move Proud relationships under the purpose, give it two measures and have Agent Quality carry it.");
    expect(proud.sentence.slice(...proud.subjectSpan!)).toBe("Proud relationships");
    expect(proud.sentenceThis).toBe("Move this goal under the purpose, give it two measures and have Agent Quality carry it.");
    expect(proud.reasons).toEqual(["why g9", "why g10"]);
  });

  test("more than three clauses: the lead clause, then how many more", () => {
    const card = one([
      change("a", 1, { kind: "move", handle: "growth", reports_to: "Samvit Jain", scope_add: ["Platform"], scope_remove: ["Growth"] }),
      change("b", 2, { kind: "trust", handle: "growth", trust: "direct" }),
    ]);
    expect(card.sentence).toBe("Have Head of Growth report to Samvit Jain and 3 more changes.");
  });

  test("the other kinds, each verb first and by name", () => {
    expect(one([change("a", 1, { kind: "task_status", task: "ct-9", status: "done", reason: "shipped on main" })]).sentence).toBe("Mark the task Remove the pilot as done.");
    expect(one([change("a", 1, { kind: "task_status", task: "ct-9", status: "open", reason: "still going", title: "Remove the pilot" })]).sentence).toBe("Reopen the task Remove the pilot.");
    const retire = one([change("a", 1, { kind: "retire", handle: "growth" })]);
    expect(retire).toMatchObject({ sentence: "Retire Head of Growth. Its sessions go back to their owners.", struck: true, sits: "Reports to you" });
    // The role itself is the one row, struck, with nothing after it.
    expect(retire.rows.map((r) => [r.key, r.label, r.op, read(r.before), r.after])).toEqual([["role", "Role", "clear", "Head of Growth", null]]);
    expect(rowOf(retire, "role").before).toMatchObject({ kind: "face", face: { kind: "role", handle: "growth" } });
    expect(one([change("a", 1, { kind: "trust", handle: "growth", trust: "understand" })]).sentence).toBe("Have Head of Growth ask before it starts work.");
    expect(one([change("a", 1, { kind: "routine", handle: "growth", title: "Weekly review", prompt: "p", every: "7d" })]).sentence).toBe("Have Head of Growth run Weekly review every week.");
    expect(one([change("a", 1, { kind: "scope", handle: "growth", add: ["pr-11"], remove: ["pl-88"] })]).sentence).toBe("Have Head of Growth look after Platform and have it stop looking after SEO and AI citations.");
    expect(one([change("a", 1, { kind: "initiative_owner", initiative: "in-4", owner: "@growth" })]).sentence).toBe("Make Head of Growth the owner of Proud relationships.");
    expect(one([change("a", 1, { kind: "role", name: "Funnel lead", handle: "funnel", reports_to: "@growth", seat: { existing: "jx7b88a", title: "Market growth mandate" } })]).sentence).toBe("Name the session Market growth mandate as the role Funnel lead, reporting to Head of Growth.");
    expect(one([change("a", 1, { kind: "projects", changes: [{ op: "create", title: "Billing" }] })])).toMatchObject({ kind: "projects", title: "Billing", sentence: "Create the project Billing." });
  });
});

describe("rows with nothing to compare", () => {
  test("a hire, an instance's version, and projects made or folded", () => {
    const hire = one([change("a", 1, { kind: "hire", handle: "growth", template: "growth-lead", version: "1.2.0", digest: "d", instance: "growth-pack", project: "pr-11" })]);
    expect(hire.rows.map((r) => [r.key, r.label, r.op, read(r.after)])).toEqual([["hired", "Hired from", "set", "growth-lead (1.2.0)"], ["leads", "Leads", "set", "Platform"]]);
    expect(hire).toMatchObject({ key: "role:growth", isNew: false });
    const upgrade = one([change("a", 1, { kind: "upgrade", instance: "growth-pack", template: "growth-lead", to: "1.3.0", digest: "d" })]);
    expect(upgrade).toMatchObject({ key: "instance:growth-pack", kind: "instance", title: "growth-pack", sentence: "Move the instance growth-pack to growth-lead 1.3.0." });
    expect(upgrade.rows.map((r) => [r.label, read(r.after)])).toEqual([["Version", "growth-lead 1.3.0"]]);
    const made = one([change("a", 1, { kind: "projects", changes: [{ op: "create", title: "Billing" }, { op: "merge", from: "pr-10", into: "Platform" }] })]);
    expect(made.title).toBe("2 projects");
    expect(made.subjectSpan).toBeNull();
    expect(made.sentence).toBe("Create the project Billing and fold the project Ideas into Platform.");
    expect(made.rows.map((r) => [r.key, r.label, r.op, read(r.before), read(r.after)])).toEqual([["new", "Project", "set", null, "Billing"], ["folds", "Folds into", "change", "Ideas", "Platform"]]);
  });

  test("no label is a word a person was never taught", () => {
    const labels = [...cardsOf(TREE), ...cardsOf(RANKING), ...cardsOf([
      change("a", 1, { kind: "role", name: "Head of Platform", handle: "platform", scope: { projects: ["Platform"] }, tenure: { kind: "standing" }, seat: { existing: "jx7b88a", title: "Market growth mandate" } }),
      change("b", 2, { kind: "move", handle: "growth", reports_to: "@platform", scope_add: ["Platform"] }),
      change("c", 3, { kind: "plan_status", plan: "pl-88", status: "done", reason: "r" }),
    ])].flatMap((card) => card.rows.map((r) => r.label));
    expect(new Set(labels)).toEqual(new Set(["Owned by", "Measured by", "Carried by", "Says", "Sits", "Priority", "Answers to", "Looks after", "Session", "Stays", "Reports to", "Status"]));
    expect(labels.join(" ")).not.toMatch(/scope|charter|limit|seq|proposal|initiative|_/i);
  });
});

describe("the purpose", () => {
  test("the one top level goal others sit under is set as the purpose, and named so wherever it is a parent", () => {
    const [purpose, revenue, , network] = cardsOf(TREE);
    expect(purpose.sentence).toBe(`Set ${PURPOSE} as the purpose.`);
    expect(purpose.sentence.slice(...purpose.subjectSpan!)).toBe(PURPOSE);
    expect(purpose.sits).toBeNull();
    expect(revenue.sentence).toBe("Add the goal Make revenue under the purpose.");
    expect(revenue.sits).toBe("Under the purpose");
    expect(network.sentence).toBe("Move Win the private network under the purpose.");
    expect(diff(network, "parent")).toEqual(["change", "at the top level", "under the purpose"]);
  });

  test("a goal with goals below it does not list its projects; every other list is running text", () => {
    const [purpose, revenue] = cardsOf(TREE);
    const carried = rowOf(purpose, "projects");
    expect(carried.after).toMatchObject({ kind: "names", summary: "9 projects, through the goals below" });
    expect((carried.after as { names: string[] }).names).toHaveLength(9);
    expect(rowOf(revenue, "projects").after).toEqual({ kind: "names", names: ["People & Deals"] });
    // The purpose is read through its goals: no "no number yet" on it.
    expect(purpose.rows.map((r) => r.key)).toEqual(["owner", "projects", "says"]);
  });

  test("the purpose's card says so; every other goal is read short", () => {
    const cards = cardsOf(TREE);
    expect(cards.map((c) => [c.title, c.purpose])).toEqual([[PURPOSE, true], ["Make revenue", false], ["Fundraise", false], ["Win the private network", false], ["Proud relationships", false]]);
    expect(cardsOf(RANKING).some((c) => c.purpose)).toBe(false);
  });

  test("two top level goals, or one with nothing under it, is no purpose", () => {
    const flat = cardsOf([
      change("a", 1, { kind: "initiative", title: "Alpha", description: "d", projects: ["Ideas"] }),
      change("b", 2, { kind: "initiative", title: "Beta", description: "d", projects: ["Ideas"], parent: "Alpha" }),
      change("c", 3, { kind: "initiative", title: "Gamma", description: "d", projects: ["Ideas"] }),
    ]);
    expect(flat.map((c) => c.sentence)).toEqual(["Add the goal Alpha at the top level.", "Add the goal Beta under Alpha.", "Add the goal Gamma at the top level."]);
    expect(flat[1].sits).toBe("Under Alpha");
    expect(one([change("a", 1, { kind: "initiative", title: "Alpha", description: "d", projects: ["Ideas"] })]).sentence).toBe("Add the goal Alpha at the top level.");
  });
});

describe("rows of a new goal", () => {
  test("owner, measures as written, projects, what it says; a goal with no number says so", () => {
    const [, revenue, fundraise] = cardsOf(TREE);
    expect(revenue.rows.map((r) => [r.key, r.label, r.op, read(r.before), read(r.after)])).toEqual([
      ["owner", "Owned by", "set", null, "Samvit Jain"],
      ["metrics", "Measured by", "set", null, "Fees collected, target The first dollar"],
      ["projects", "Carried by", "set", null, "People & Deals"],
      ["says", "Says", "set", null, "First on the list."],
    ]);
    expect(revenue.evidence).toEqual([{ label: "Core focuses in #team" }]);
    expect(rowOf(fundraise, "metrics").after).toEqual({ kind: "none", text: "no number yet" });
    expect(rowOf(fundraise, "owner").after).toMatchObject({ kind: "face", you: true });
    const loose = one([change("a", 1, { kind: "initiative", title: "Alpha", description: "d", projects: ["Ideas"], metrics: [{ name: "Reply rate", target: "1% higher (Cameron)" }], why: "It pays", done_when: "Paid", milestones: [{ title: "Beta open" }] })]);
    expect(read(rowOf(loose, "metrics").after)).toBe("Reply rate, target 1% higher (Cameron)");
    expect(loose.rows.map((r) => r.label)).toEqual(["Owned by", "Measured by", "Carried by", "Says", "Why it matters", "Done when", "Milestones"]);
    expect(read(rowOf(loose, "owner").after)).toBe("nobody");
  });
});

describe("which before a row shows", () => {
  test("while a change waits, the live record: a project", () => {
    const cards = cardsOf(RANKING);
    expect(diff(cards[0], "priority")).toEqual(["change", "not set", "p0"]);
    expect(rowOf(cards[0], "priority").label).toBe("Priority");
    expect(diff(cards[2], "priority")).toEqual(["change", "p2", "p1"]);
    const meta = one([change("m", 1, { kind: "project_meta", project: "pr-3", owner: "@growth", goal: "Close two fees", success_metrics: ["Fees"], non_goals: [], risks: ["One client"] })]);
    expect(meta.rows.map((r) => [r.key, r.label, r.op, read(r.before), read(r.after)])).toEqual([
      ["owner", "Led by", "same", "Head of Growth", "Head of Growth"],
      ["goal", "Says", "change", "Close the first fee", "Close two fees"],
      ["success_metrics", "Measured by", "change", "nothing", "Fees"],
      ["non_goals", "Leaves out", "same", "nothing", "nothing"],
      ["risks", "Risks", "change", "nothing", "One client"],
    ]);
    expect(meta.title).toBe("People & Deals");
    expect(meta.sentence).toBe("Make Head of Growth the lead of People & Deals and write down what it is for, how it is measured, what it leaves out and its risks.");
    const lead = one([change("m", 1, { kind: "project_meta", project: "Infrastructure", owner: "@growth", priority: "p1" })]);
    expect(diff(lead, "owner")).toEqual(["change", "nobody", "Head of Growth"]);
    expect(lead.sentence).toBe("Make Infrastructure a high priority and make Head of Growth its lead.");
  });

  test("while a change waits, the live record: a record's status and a plan's project", () => {
    expect(diff(one([change("a", 1, { kind: "task_status", task: "ct-9", status: "done", reason: "r" })]), "status")).toEqual(["change", "in progress", "done"]);
    expect(diff(one([change("a", 1, { kind: "project_status", project: "Public Launch", status: "active", reason: "r" })]), "status")).toEqual(["change", "paused", "active"]);
    expect(diff(one([change("a", 1, { kind: "project_status", project: "Ideas", status: "active", reason: "r" })]), "status")).toEqual(["same", "active", "active"]);
    expect(diff(one([change("a", 1, { kind: "file", plan: "pl-90", project: "pr-11" })]), "project")).toEqual(["change", "no project", "Platform"]);
  });

  test("while a change waits, the live record: a role", () => {
    expect(diff(one([change("a", 1, { kind: "trust", handle: "growth", trust: "direct" })]), "starts_work")).toEqual(["change", "when you start it", "on its own, inside its area"]);
    expect(diff(one([change("a", 1, { kind: "trust", handle: "growth", trust: "understand" })]), "starts_work")).toEqual(["same", "when you start it", "when you start it"]);
    expect(diff(one([change("a", 1, { kind: "scope", handle: "growth", add: ["Platform"] })]), "area")).toEqual(["add", "Growth, SEO and AI citations", "Growth, SEO and AI citations, Platform"]);
    expect(diff(one([change("a", 1, { kind: "scope", handle: "growth", add: ["Platform"], remove: ["pr-4"] })]), "area")).toEqual(["change", "Growth, SEO and AI citations", "SEO and AI citations, Platform"]);
    expect(diff(one([change("a", 1, { kind: "scope", handle: "growth", remove: ["pr-4", "pl-88"] })]), "area")).toEqual(["clear", "Growth, SEO and AI citations", "nothing"]);
    expect(diff(one([change("a", 1, { kind: "adopt", handle: "growth", conversation: "jx7abcd" })]), "session")).toEqual(["change", "jx7gr0w", "Offered session"]);
    const may = one([change("a", 1, { kind: "authority", handle: "growth", authority: [{ id: "ads", kind: "spend", label: "Google Ads", limit: { usd_per_month: 500 } }] })]);
    expect(diff(may, "may")).toEqual(["change", "nothing", "spend (Google Ads, up to $500 a month)"]);
    expect(rowOf(may, "may").label).toBe("May");
    const move = one([change("a", 1, { kind: "move", handle: "growth", reports_to: "Samvit Jain", scope_add: ["Platform"] })]);
    expect(diff(move, "reports_to")).toEqual(["change", "you", "Samvit Jain"]);
    expect(diff(move, "area")).toEqual(["add", "Growth, SEO and AI citations", "Growth, SEO and AI citations, Platform"]);
  });

  test("while a change waits, the live record: a goal", () => {
    const shaped = one([change("a", 1, { kind: "initiative_shape", initiative: "in-6", parent: null, metrics: [], why: "It pays more", done_when: "Paid twice", milestones: [{ title: "Beta open" }], questions: ["Who signs?"], decisions: ["Fee is 2%"], sources: ["#team, Sep 23"] })]);
    expect(shaped.rows.map((r) => [r.key, r.label, r.op, read(r.before), read(r.after)])).toEqual([
      ["parent", "Sits", "change", "under Old parent", "at the top level"],
      ["metrics", "Measured by", "clear", "Replies, target 5%", "nothing"],
      ["why", "Why it matters", "change", "It pays", "It pays more"],
      ["done_when", "Done when", "change", "not set", "Paid twice"],
      ["milestones", "Milestones", "add", null, "Beta open"],
      ["questions", "Open questions", "add", null, "Who signs?"],
      ["decisions", "Decisions", "add", null, "Fee is 2%"],
    ]);
    expect(shaped.evidence).toEqual([{ label: "#team, Sep 23" }]);
    const proud = cardsOf(TREE)[4];
    expect(proud.rows.map((r) => [r.key, r.op, read(r.before), read(r.after), r.seq])).toEqual([
      ["parent", "change", "at the top level", "under the purpose", 9],
      ["metrics", "change", "nothing", "Trust breaks per day, target 0; Comms score, target 0.9 or higher", 9],
      ["projects", "add", "no project", "Agent Quality", 10],
    ]);
    expect(diff(one([change("a", 1, { kind: "initiative_projects", initiative: "in-2", projects: ["Agent Quality", "Private Network"] })]), "projects")).toEqual(["add", "Private Network", "Private Network, Agent Quality"]);
    expect(diff(one([change("a", 1, { kind: "initiative_owner", initiative: "in-2", owner: "@growth" })]), "owner")).toEqual(["change", "you", "Head of Growth"]);
    expect(diff(one([change("a", 1, { kind: "initiative_owner", initiative: "in-1", owner: "" })]), "owner")).toEqual(["clear", "Head of Growth", "nobody"]);
    expect(diff(one([change("a", 1, { kind: "initiative_owner", initiative: "in-4", owner: "me" })]), "owner")).toEqual(["change", "nobody", "you"]);
  });

  test("a failed change still reads the live record: a failed apply wrote nothing", () => {
    const card = one([{ ...RANKING[3], status: "failed", applied_note: "No project Private Network in this workspace" }]);
    expect(diff(card, "priority")).toEqual(["change", "p2", "p1"]);
    expect(card.failed).toEqual([{ seq: 4, note: "No project Private Network in this workspace" }]);
    expect(card).toMatchObject({ status: "failed", waiting: 1 });
  });

  test("the accepted beat: live, and a record that already moved shows the value alone", () => {
    expect(diff(one([{ ...RANKING[3], status: "accepted" }]), "priority")).toEqual(["change", "p2", "p1"]);
    const moved: SubjectLive = { ...LIVE, projects: PROJECTS.map((p) => (p._id === "p-network" ? { ...p, priority: "p1" } : p)) };
    expect(diff(one([{ ...RANKING[3], status: "accepted" }], moved), "priority")).toEqual(["set", null, "p1"]);
    // The same record while the change still waits says so instead.
    expect(diff(one([RANKING[3]], moved), "priority")).toEqual(["same", "p1", "p1"]);
  });

  test("once applied, the stamp: the live record has moved on and the card still says what it was", () => {
    const moved: SubjectLive = { ...LIVE, projects: PROJECTS.map((p) => (p._id === "p-network" ? { ...p, priority: "p0" } : p)) };
    const card = one([{ ...RANKING[3], status: "applied", applied_diff: stamp("project_meta", { priority: "p2" }, { priority: "p1" }) }], moved);
    expect(diff(card, "priority")).toEqual(["change", "p2", "p1"]);
    expect(card.sentence).toBe("Raise Private Network to a high priority.");
    expect(card).toMatchObject({ status: "applied", waiting: 0 });
    const first = one([{ ...RANKING[0], status: "applied", applied_diff: stamp("project_meta", { priority: null }, { priority: "p0" }) }]);
    expect(diff(first, "priority")).toEqual(["change", "not set", "p0"]);
  });

  test("once applied, the stamp names ids by the live record, else by its own labels", () => {
    const lead = one([change("m", 1, { kind: "project_meta", project: "People & Deals", owner: "@growth" }, "applied", { applied_diff: stamp("project_meta", { owner_role_id: "role-gone" }, { owner_role_id: "fixture-role-growth" }, { labels: { "role-gone": "Content Lead" } }) })]);
    expect(diff(lead, "owner")).toEqual(["change", "Content Lead", "Head of Growth"]);
    const move = one([change("a", 1, { kind: "move", handle: "growth", reports_to: "Samvit Jain", scope_add: ["Platform"] }, "applied", {
      applied_diff: stamp("move", { reports_to: { kind: "user", user_id: ME }, scope: { project_ids: ["fixture-project-growth"], plan_ids: [] } }, { reports_to: { kind: "user", user_id: SAM }, scope: { project_ids: ["fixture-project-growth", "p-gone"], plan_ids: [] } }, { labels: { "p-gone": "Platform (archived)" } }),
    })]);
    expect(diff(move, "reports_to")).toEqual(["change", "you", "Samvit Jain"]);
    expect(diff(move, "area")).toEqual(["add", "Growth", "Growth, Platform (archived)"]);
    const goalStamp = stamp("initiative_shape", { parent_initiative_id: null, metrics: null }, { parent_initiative_id: "g-new", metrics: [{ key: "t", name: "Trust breaks per day", target: "0" }] }, { labels: { "g-new": "Broker introductions" }, added: { milestones: ["Beta open"] } });
    const shaped = one([change("a", 1, { kind: "initiative_shape", initiative: "in-4", parent: "Broker introductions", metrics: [{ name: "Trust breaks per day", target: "0" }], milestones: [{ title: "Beta open" }, { title: "Already there" }] }, "applied", { applied_diff: goalStamp })]);
    expect(shaped.rows.map((r) => [r.key, r.op, read(r.before), read(r.after)])).toEqual([
      ["parent", "change", "at the top level", "under Broker introductions"],
      ["metrics", "change", "nothing", "Trust breaks per day, target 0"],
      ["milestones", "add", null, "Beta open"],
    ]);
    const carried = one([change("a", 1, { kind: "initiative_projects", initiative: "in-2", projects: ["Agent Quality"] }, "applied", { applied_diff: stamp("initiative_projects", { project_ids: ["p-network"] }, { project_ids: ["p-network", "p-quality"] }) })]);
    expect(diff(carried, "projects")).toEqual(["add", "Private Network", "Private Network, Agent Quality"]);
    const status = one([change("a", 1, { kind: "task_status", task: "ct-9", status: "done", reason: "r" }, "applied", { applied_diff: stamp("task_status", { status: "in_progress" }, { status: "done" }) })], { ...LIVE, tasks: [{ _id: "t9", short_id: "ct-9", title: "Remove the pilot", status: "done" }] });
    expect(diff(status, "status")).toEqual(["change", "in progress", "done"]);
    const trust = one([change("a", 1, { kind: "trust", handle: "growth", trust: "direct" }, "applied", { applied_diff: stamp("trust", { trust: "understand" }, { trust: "direct" }) })]);
    expect(diff(trust, "starts_work")).toEqual(["change", "when you start it", "on its own, inside its area"]);
  });

  test("a stamp of two rows: the change's own kind is the before and after, a sources-only row is what was added", () => {
    const own: OrgAppliedDiffRow = { kind: "initiative_projects", subject: { type: "initiative", id: "g-net", label: "Win the private network" }, before: { project_ids: ["p-network"] }, after: { project_ids: ["p-network", "p-quality"] }, labels: {} };
    const sources: OrgAppliedDiffRow = { kind: "initiative_shape", subject: own.subject, before: {}, after: {}, added: { sources: ["North star goals, admin home page", "Core focuses in #team"] }, labels: {} };
    const card = one([change("a", 1, { kind: "initiative_projects", initiative: "in-2", projects: ["Agent Quality"] }, "applied", { applied_diff: [own, sources] })]);
    expect(card.rows.map((r) => [r.key, r.op, read(r.before), read(r.after)])).toEqual([
      ["projects", "add", "Private Network", "Private Network, Agent Quality"],
      ["sources", "add", null, "North star goals, admin home page, Core focuses in #team"],
    ]);
    expect(card.rows[1].label).toBe("Sources added");
    // The sources row first: the change's own row is still the one read, and no second diff is drawn from the sources.
    const reversed = one([change("a", 1, { kind: "initiative_projects", initiative: "in-2", projects: ["Agent Quality"] }, "applied", { applied_diff: [sources, own] })]);
    expect(reversed.rows.map((r) => [r.key, r.op, read(r.before)])).toEqual([["projects", "add", "Private Network"], ["sources", "add", null]]);
    // A shape change whose own row is also an initiative_shape: the FIRST of that kind is the change's.
    const shapeOwn: OrgAppliedDiffRow = { kind: "initiative_shape", subject: own.subject, before: { why: null }, after: { why: "It pays" }, labels: {} };
    const shaped = one([change("a", 1, { kind: "initiative_shape", initiative: "in-2", why: "It pays" }, "applied", { applied_diff: [shapeOwn, sources] })]);
    expect(shaped.rows.map((r) => [r.key, r.op, read(r.before), read(r.after)])).toEqual([["why", "change", "not set", "It pays"], ["sources", "add", null, "North star goals, admin home page, Core focuses in #team"]]);
    // A stamp with no row of the change's kind keeps its first row, and nothing is added.
    const odd = one([{ ...RANKING[3], status: "applied", applied_diff: stamp("initiative_shape", { priority: "p2" }, { priority: "p1" }) }]);
    expect(diff(odd, "priority")).toEqual(["change", "p2", "p1"]);
    expect(odd.rows.map((r) => r.key)).toEqual(["priority"]);
    // While the change waits there is no stamp, so no sources row either.
    expect(one([change("a", 1, { kind: "initiative_projects", initiative: "in-2", projects: ["Agent Quality"] })]).rows.map((r) => r.key)).toEqual(["projects"]);
  });

  test("applied with no stamp, a field the stamp does not hold, another workspace: the value alone; a rejected change still reads the live record", () => {
    expect(diff(one([{ ...RANKING[3], status: "applied" }]), "priority")).toEqual(["set", null, "p1"]);
    const partial = one([change("m", 1, { kind: "project_meta", project: "People & Deals", priority: "p1", goal: "Close the first fee" }, "applied", { applied_diff: stamp("project_meta", { priority: null }, { priority: "p1" }) })]);
    expect(diff(partial, "goal")).toEqual(["set", null, "Close the first fee"]);
    // A rejection wrote nothing, so the record is still what it was: the card keeps the diff in view and folds it on its next mount.
    expect(diff(one([{ ...RANKING[3], status: "skipped" }]), "priority")).toEqual(["change", "p2", "p1"]);
    expect(diff(one([RANKING[3]], null), "priority")).toEqual(["set", null, "p1"]);
    // No before for a list either: the row holds what the change adds, and what it takes away.
    const scope = one([change("a", 1, { kind: "scope", handle: "growth", add: ["Platform"], remove: ["Growth"] })], null);
    expect(scope.rows.map((r) => [r.key, r.op, read(r.before), read(r.after)])).toEqual([["area", "add", null, "Platform"], ["area", "remove", null, "Growth"]]);
    expect(diff(one([change("a", 1, { kind: "initiative_projects", initiative: "in-2", projects: ["Agent Quality"] }, "skipped")]), "projects")).toEqual(["add", "Private Network", "Private Network, Agent Quality"]);
    // Records the tree does not hold (a cold store) read the same way.
    expect(diff(one([RANKING[3]], { ...LIVE, projects: [] }), "priority")).toEqual(["set", null, "p1"]);
  });
});

describe("status", () => {
  const member = (status: OrgProposalChange["status"]) => ({ status });
  test("subjectStatus: alike, any failure, on its way in, ended differently", () => {
    expect(subjectStatus([member("proposed"), member("proposed")])).toBe("proposed");
    expect(subjectStatus([member("applied"), member("failed"), member("proposed")])).toBe("failed");
    expect(subjectStatus([member("applied"), member("accepted")])).toBe("accepted");
    expect(subjectStatus([member("applied"), member("skipped")])).toBe("mixed");
    expect(subjectStatus([member("applied"), member("proposed")])).toBe("mixed");
    expect(subjectStatus([member("skipped")])).toBe("skipped");
  });

  test("the card's words, and each row keeps its own change's status on a card that ended differently", () => {
    const pair = (a: OrgProposalChange["status"], b: OrgProposalChange["status"]) => cardsOf([{ ...TREE[5], status: a }, { ...TREE[4], status: b }, TREE[0]])[1];
    expect(subjectStatusWords(pair("proposed", "proposed"))).toBe("2 to decide");
    expect(subjectStatusWords(pair("applied", "applied"))).toBe("Approved");
    expect(subjectStatusWords(pair("accepted", "applied"))).toBe("Approved");
    expect(subjectStatusWords(pair("skipped", "skipped"))).toBe("Rejected");
    expect(subjectStatusWords(pair("failed", "failed"))).toBe("Failed");
    expect(subjectStatusWords(pair("applied", "failed"))).toBe("1 of 2 approved, 1 failed");
    expect(subjectStatusWords(pair("proposed", "failed"))).toBe("1 of 2 failed");
    expect(subjectStatusWords(pair("applied", "proposed"))).toBe("1 of 2 approved");
    expect(subjectStatusWords(pair("skipped", "proposed"))).toBe("1 of 2 rejected");
    const mixed = pair("applied", "proposed");
    expect(mixed).toMatchObject({ status: "mixed", waiting: 1 });
    expect(mixed.rows.map((r) => [r.key, r.seq, r.status])).toEqual([["parent", 9, "applied"], ["metrics", 9, "applied"], ["projects", 10, "proposed"]]);
    expect(subjectStatusWords(cardsOf(RANKING)[0])).toBe("To decide");
  });

  test("a card carries the person's latest answer that still stands, and reads Noted while it waits on a revision", () => {
    const note = { verdict: "note" as const, text: "Cameron owns this, not Samvit.", at: 20, by: "u1" };
    const noted = one([{ ...RANKING[5], reply: note }]);
    expect(noted.reply).toEqual(note);
    expect(noted).toMatchObject({ status: "proposed", waiting: 1 });
    expect(subjectStatusWords(noted)).toBe("Noted");
    // The author amended the change after the note: the words retire and the card is plainly to decide again.
    const amended = { ...RANKING[5], reply: note, revision: { kind: "amended" as const, note: "Moved to Cameron.", at: 30 } };
    expect(changeReply(amended)).toBeNull();
    expect(one([amended])).toMatchObject({ reply: null });
    expect(subjectStatusWords(one([amended]))).toBe("To decide");
    expect(changeReply({ reply: note, revision: { kind: "amended", note: "", at: 20 } })).toBeNull();
    expect(changeReply({ reply: note, revision: { kind: "amended", note: "", at: 10 } })).toEqual(note);
    expect(changeReply({})).toBeNull();
    // A rejection keeps its words on the row; on a card of two changes the later answer is the card's.
    const rejected = one([{ ...RANKING[5], status: "skipped", reply: { verdict: "reject", text: "P1 is too high.", at: 5 } }]);
    expect(rejected.reply).toMatchObject({ verdict: "reject", text: "P1 is too high." });
    expect(subjectStatusWords(rejected)).toBe("Rejected");
    const two = cardsOf([{ ...TREE[5], reply: { verdict: "note", text: "first", at: 1 } }, { ...TREE[4], reply: { verdict: "note", text: "second", at: 2 } }, TREE[0]])[1];
    expect(two.reply).toMatchObject({ text: "second" });
  });

  test("the proposal's line counts cards: to decide, mid way, and the outcome", () => {
    const at = (statuses: Partial<Record<number, OrgProposalChange["status"]>>) => cardsOf(RANKING.map((c) => ({ ...c, status: statuses[c.seq] ?? c.status })));
    expect(proposalProgressWords(at({}))).toBe("9 to decide");
    const mid = at({ 1: "applied", 2: "accepted", 3: "skipped", 4: "failed" });
    expect(proposalProgressWords(mid)).toBe("5 of 9 to decide · 2 approved, 1 rejected, 1 failed");
    expect(subjectCounts(mid)).toEqual({ total: 9, waiting: 5, approved: 2, rejected: 1, failed: 1 });
    const all = Object.fromEntries(RANKING.map((c) => [c.seq, "applied" as const]));
    expect(proposalProgressWords(at(all))).toBe("9 approved");
    expect(proposalProgressWords(at({ ...all, 8: "skipped", 9: "skipped" }))).toBe("7 approved, 2 rejected");
    expect(proposalProgressWords([])).toBe("");
    for (const words of [proposalProgressWords(mid), ...mid.map(subjectStatusWords)]) expect(words).not.toMatch(/accept|skip/i);
    // Two changes on one goal are one card to count, whatever their numbers.
    expect(proposalProgressWords(cardsOf(TREE))).toBe("5 to decide");
  });

  test("ordinals are words up to twelfth, and a card's place counts cards", () => {
    expect([1, 2, 3, 9, 12].map(ordinalWord)).toEqual(["First", "Second", "Third", "Ninth", "Twelfth"]);
    expect([13, 21, 22, 23, 111].map(ordinalWord)).toEqual(["13th", "21st", "22nd", "23rd", "111th"]);
    const cards = cardsOf(RANKING);
    expect(placeWords(cards, cards[0])).toBe("First of nine");
    expect(placeWords(cards, cards[8])).toBe("Ninth of nine");
    expect(placeWords(cards.slice(0, 1), cards[0])).toBe("The only change");
    // One card holding several changes is the proposal's only entry, not its only change.
    expect(placeWords(cardsOf([TREE[5], TREE[4]]), cardsOf([TREE[5], TREE[4]])[0])).toBe("The only entry");
    expect(placeWords(cards.slice(0, 2), cards[5])).toBe("");
    const many = Array.from({ length: 14 }, (_, i) => ({ ...cards[0], key: `k${i}` }));
    expect(placeWords(many, many[12])).toBe("13th of 14");
  });
});

describe("what a card carries beside its rows", () => {
  test("evidence, what a change depends on, and what a revise did", () => {
    const card = one([
      change("a", 1, { kind: "trust", handle: "growth", trust: "direct" }, "proposed", { evidence: [{ label: "3 decisions waiting", href: "/decisions" }], depends: "needs the role first", revision: { kind: "amended", note: "was the other way", at: 5, before: { kind: "trust", handle: "growth", trust: "understand" } } }),
      change("b", 2, { kind: "routine", handle: "growth", title: "Weekly review", prompt: "p", every: "7d" }, "proposed", { evidence: [{ label: "3 decisions waiting", href: "/decisions" }], rationale: "why a" }),
    ]);
    expect(card.evidence).toEqual([{ label: "3 decisions waiting", href: "/decisions" }]);
    expect(card.reasons).toEqual(["why a"]);
    expect(card.depends).toEqual(["needs the role first"]);
    expect(card.revisions).toHaveLength(1);
    expect(card.revisions[0]).toMatchObject({ seq: 1, word: "Changed", note: "was the other way" });
  });
});

describe("askNames with what a card has in hand", () => {
  test("a project in no role's area, a plan, a goal, a role the proposal creates and a session all read by name", () => {
    const names = askNames(ORG_FIXTURE, {
      projects: [{ id: "p-platform", title: "Platform", short_id: "pr-11" }],
      plans: [{ id: "plan-loose", title: "Loose plan", short_id: "pl-90" }],
      goals: [{ id: "g-net", title: "Win the private network", short_id: "in-2" }],
      roles: [{ handle: "@Platform", name: "Head of Platform" }],
      sessions: (ref) => (ref === "jx7abcd" ? "Market growth mandate" : undefined),
    })!;
    expect([names.project!("pr-11"), names.project!("platf"), names.project!("Growth"), names.project!("nope")]).toEqual(["Platform", "Platform", "Growth", undefined]);
    expect([names.plan!("pl-90"), names.plan!("pl-88"), names.plan!("pl-1")]).toEqual(["Loose plan", "SEO and AI citations", undefined]);
    expect([names.initiative!("IN-2"), names.initiative!("win the private network"), names.initiative!("in-9")]).toEqual(["Win the private network", "Win the private network", undefined]);
    expect([names.role!("platform"), names.role!("growth")]).toEqual(["Head of Platform", "Head of Growth"]);
    expect(names.session!("jx7abcd")).toBe("Market growth mandate");
  });

  test("the tree alone reads as it always did, and nothing in hand is no names", () => {
    const names = askNames(ORG_FIXTURE)!;
    expect(names.role!("growth")).toBe("Head of Growth");
    expect(names.project!("pr-4")).toBe("Growth");
    expect(names.initiative).toBeUndefined();
    expect(names.session).toBeUndefined();
    expect(askNames(null)).toBeUndefined();
    expect(askNames(null, { projects: [{ id: "p", title: "Platform" }] })!.project!("Platform")).toBe("Platform");
  });
});

describe("decideTogether", () => {
  const changes = [
    change("routine", 1, { kind: "routine", handle: "platform", title: "Weekly", prompt: "p", every: "7d" }),
    change("adopt", 2, { kind: "adopt", handle: "platform", conversation: "jx7abcd" }),
    change("role", 3, { kind: "role", name: "Head of Platform", handle: "platform", scope: { projects: ["Platform"] } }),
    change("limit", 4, { kind: "budget", handle: "platform", caps: { wakes_per_day: 4 } }),
    change("done", 5, { kind: "trust", handle: "platform", trust: "direct" }, "applied"),
    change("failed", 6, { kind: "scope", handle: "growth", add: ["Platform"] }, "failed"),
    change("other", 7, { kind: "project_meta", project: "Ideas", priority: "p3" }),
  ];
  const run = (ids: string[], verdict: "accept" | "skip", opts?: { leave_sessions?: boolean }) => {
    const calls: [string, string, Record<string, unknown> | undefined][] = [];
    decideTogether(changes, ids, verdict, (id, v, edits) => calls.push([id, v, edits]), opts);
    return calls;
  };

  test("sends the card's waiting changes in apply order, one call each", () => {
    expect(run(["routine", "adopt", "role", "limit", "done"], "accept")).toEqual([["role", "accept", undefined], ["limit", "accept", undefined], ["adopt", "accept", undefined], ["routine", "accept", undefined]]);
  });

  test("only ids that still wait: a decided one is left alone, a failed one goes again, an unknown one is nothing", () => {
    expect(run(["done", "failed", "nope"], "accept")).toEqual([["failed", "accept", undefined]]);
    expect(run(["done"], "skip")).toEqual([]);
    expect(run([], "accept")).toEqual([]);
  });

  test("leave the sessions reaches only the rows that would take sessions over, and only on accept", () => {
    expect(run(["routine", "adopt", "role", "limit", "failed"], "accept", { leave_sessions: true })).toEqual([
      ["role", "accept", { leave_sessions: true }],
      ["failed", "accept", { leave_sessions: true }],
      ["limit", "accept", undefined],
      ["adopt", "accept", { leave_sessions: true }],
      ["routine", "accept", undefined],
    ]);
    expect(run(["role", "adopt"], "skip", { leave_sessions: true })).toEqual([["role", "skip", undefined], ["adopt", "skip", undefined]]);
  });

  test("the cards hand it their ids: a role card decides the role before what rides on it", () => {
    const card = proposalSubjects(changes, LIVE).find((c) => c.key === "role:platform")!;
    expect(run(card.change_ids, "accept").map(([id]) => id)).toEqual(["role", "limit", "adopt", "routine"]);
  });
});
