// The company document's joins (components/company/companyModel.ts), on the
// Union shaped fixture: the outline's order, the line of how the company
// stands, the goal it opens on, the projects no goal carries, who leads and
// owns what, the people and roles in reporting order, and where a proposal's
// changes land and are answered.
// Run: cd packages/web && bun test components/company/companyModel.test.ts
import { describe, expect, test } from "bun:test";
import { companyDoc, defaultOpenGoal, firstSentence, flatGoals, goalProjects, goalPurpose, stateClauses, stateLine } from "./companyModel";
import { COMPANY_FIXTURE_CHANGES, COMPANY_FIXTURE_INITIATIVES, COMPANY_FIXTURE_PROJECTS, COMPANY_FIXTURE_PROPOSALS, COMPANY_FIXTURE_ROSTER, COMPANY_FIXTURE_TASKS, COMPANY_FIXTURE_TREE, COMPANY_STAFF_PROPOSAL } from "./companyFixture";
import { UNION_GOALS_CHANGES } from "../org/goalsFixture";

const base = { tree: COMPANY_FIXTURE_TREE, initiatives: COMPANY_FIXTURE_INITIATIVES, projects: COMPANY_FIXTURE_PROJECTS, roster: COMPANY_FIXTURE_ROSTER, tasks: COMPANY_FIXTURE_TASKS, proposals: COMPANY_FIXTURE_PROPOSALS };
const titles = (goals: { title: string }[]) => goals.map((g) => g.title);

describe("the plain outline", () => {
  const doc = companyDoc(base);

  test("names the company and says how it stands in one line", () => {
    expect(doc.name).toBe("Union");
    expect(doc.state).toEqual({ goals: { total: 4, health: { on_track: 2, at_risk: 1, none: 1 } }, projects: { total: 9, moving: 1 }, people: 2, roles: 2, proposed: { goals: 0, projects: 0 } });
    expect(stateLine(doc.state)).toBe("4 goals: 2 on track, 1 at risk, 1 with no update · 9 projects, 1 with work moving · 2 people, 2 agent roles");
    // One of each, and nothing moving: the words agree and the empty part says nothing.
    expect(stateLine({ goals: { total: 1, health: { off_track: 1 } }, projects: { total: 1, moving: 0 }, people: 1, roles: 1 })).toBe("1 goal: 1 off track · 1 project · 1 person, 1 agent role");
    // Goals nobody has said anything about are counted without a health word.
    expect(stateLine({ goals: { total: 2, health: { none: 2 } }, projects: { total: 0, moving: 0 }, people: 3, roles: 0 })).toBe("2 goals · 3 people");
    expect(doc.waiting).toBe(0);
  });

  test("opens on the top level goal at the worst health, the nearest target breaking a tie", () => {
    expect(defaultOpenGoal(doc.goals)).toBe("union-in-4");
    const level = companyDoc({ ...base, initiatives: COMPANY_FIXTURE_INITIATIVES.map((g) => (g.short_id === "in-4" ? { ...g, health: "on_track" as const, target_date: undefined } : g)) });
    expect(defaultOpenGoal(level.goals)).toBe("union-in-2");
    expect(defaultOpenGoal([])).toBeNull();
  });

  test("each top level goal says why it matters", () => {
    expect(doc.goals[0].purpose).toMatch(/^Brokers place the deals/);
  });

  test("a goal's purpose is read one way: why it matters, else the first sentence of what it is", () => {
    expect(goalPurpose("  Because.  ", "What it is. And more.")).toBe("Because.");
    expect(goalPurpose(undefined, "What it is. And more.")).toBe("What it is.");
    expect(goalPurpose("", undefined)).toBeNull();
    // A goal with a description and no why still says a purpose on its own line.
    const described = companyDoc({ ...base, initiatives: base.initiatives.map((g) => (g.short_id === "in-2" ? { ...g, why: undefined, description: "Win the brokers who place the deals. Then the rest." } : g)) });
    expect(described.goals[0].purpose).toBe("Win the brokers who place the deals.");
  });

  test("top level goals in list order, each followed by what feeds it", () => {
    expect(titles(doc.goals)).toEqual(["Win the private network", "Every relationship the agents run is one we'd be proud of", "Every project has a lead and every goal an owner"]);
    expect(doc.goals.map((g) => g.depth)).toEqual([1, 1, 1]);
    expect(titles(doc.goals[0].goals)).toEqual(["Sign the ten brokers who place most of the deals"]);
    expect(doc.goals[0].goals[0].depth).toBe(2);
    expect(flatGoals(doc.goals).map((g) => g.short_id)).toEqual(["in-2", "in-5", "in-4", "in-1"]);
  });

  test("a project two goals carry is listed once, under the goal nearest the work", () => {
    const [network] = doc.goals;
    expect(network.projects.map((p) => p.title)).toEqual(["Broker / Private Network"]);
    expect(network.refs.map((r) => [r.project.title, r.under])).toEqual([["Broker Outreach", "Sign the ten brokers who place most of the deals"]]);
    expect(network.goals[0].projects.map((p) => p.title)).toEqual(["Broker Outreach"]);
  });

  test("a project row carries its last change and the counts its own board shows", () => {
    const p = doc.goals[0].projects[0];
    // 21 tasks on the board, 12 done. The two dropped rows and the agent's own row are not on it.
    expect(COMPANY_FIXTURE_TASKS.filter((t) => t.project_id === "union-proj-network")).toHaveLength(24);
    expect(p).toMatchObject({ id: "union-proj-network", short_id: "pr-6", status: "active", counts: { open: 9, done: 12 } });
    expect(p.updated_at).toBe(COMPANY_FIXTURE_PROJECTS[5].updated_at);
    // No tasks counted: no counts, never "0 open".
    expect(companyDoc(base).unfiled.find((x) => x.title === "Infrastructure")!.counts).toBeNull();
    // A task closed in the store moves the count in the same read; nothing waits on the project row.
    const open = COMPANY_FIXTURE_TASKS.findIndex((t) => t.project_id === "union-proj-network" && t.status === "open" && t.source === "human");
    const closed = companyDoc({ ...base, tasks: COMPANY_FIXTURE_TASKS.map((t, i) => (i === open ? { ...t, status: "done" } : t)) });
    expect(closed.goals[0].projects[0].counts).toEqual({ open: 8, done: 13 });
    // While the task store is still filling, a count would be partial: it says so.
    expect(companyDoc({ ...base, tasksCounted: false }).goals[0].projects[0].counts).toBe("counting");
  });

  test("projects no goal carries, by name, and never a finished one", () => {
    expect(doc.unfiled.map((p) => p.title)).toEqual(["Callers & Call Management", "camerons ideas", "Infrastructure", "Matching Engine & Funnel", "People & Deals", "Public Launch & Fundraise"]);
    const done = companyDoc({ ...base, projects: COMPANY_FIXTURE_PROJECTS.map((p) => (p.title === "Infrastructure" ? { ...p, status: "done" } : p)) });
    expect(done.unfiled.map((p) => p.title)).not.toContain("Infrastructure");
  });

  test("a role with what it leads, the goals it owns and who it reports to", () => {
    expect(doc.roles.map((r) => r.role.handle)).toEqual(["head-of-people", "agent-quality"]);
    const [head, quality] = doc.roles;
    // The head of people covers every project by the rule: that is not a lead to name.
    expect(head.leads).toEqual([]);
    expect(head.goals.map((g) => g.short_id)).toEqual(["in-1"]);
    expect(head.charter).toBe("Keeps every project led and every goal owned.");
    expect(head.reportsTo).toEqual({ kind: "person", id: "fixture-user-me", name: "Ashot Petrosian", ref: "ashot" });
    expect(quality.leads.map((p) => p.title)).toEqual(["Agent Quality"]);
    expect(quality.goals.map((g) => g.short_id)).toEqual(["in-4"]);
  });

  test("a person with the roles that report to them, the goals they own, and what their line says", () => {
    const [ashot, samvit] = doc.people;
    expect(ashot).toMatchObject({ name: "Ashot Petrosian", me: true, ref: "ashot", access: "owner", presence: "online", joined_at: COMPANY_FIXTURE_ROSTER[0].joined_at });
    // The server's whole tally, not the few sessions the tree carries under them.
    expect(ashot.sessions).toEqual({ working: 5, needs_input: 4, done: 4, dormant: 5, idle: 4 });
    // A person the roster has no username for is reached by id.
    expect(companyDoc({ ...base, roster: [] }).people[0].ref).toBe("fixture-user-me");
    expect(ashot.roles.map((r) => r.handle)).toEqual(["head-of-people", "agent-quality"]);
    expect(ashot.goals.map((g) => g.short_id)).toEqual(["in-2"]);
    expect(samvit.roles).toEqual([]);
    expect(samvit.goals.map((g) => g.short_id)).toEqual(["in-5"]);
  });

  test("people and roles in reporting order: each person, then the roles under them", () => {
    expect(doc.outline.map((r) => [r.kind, r.id, r.depth])).toEqual([
      ["person", "fixture-user-me", 0],
      ["role", "fixture-role-head-of-people", 1],
      ["role", "fixture-role-agent-quality", 1],
      ["person", "fixture-user-samvit", 0],
    ]);
    // A role that reports to a role sits under it, one level in.
    const tree = { ...COMPANY_FIXTURE_TREE, roles: COMPANY_FIXTURE_TREE.roles.map((r) => (r.handle === "agent-quality" ? { ...r, reports_to: { kind: "role" as const, role_id: "fixture-role-head-of-people" } } : r)) };
    expect(companyDoc({ ...base, tree }).outline.map((r) => [r.id, r.depth])).toEqual([["fixture-user-me", 0], ["fixture-role-head-of-people", 1], ["fixture-role-agent-quality", 2], ["fixture-user-samvit", 0]]);
    // One that reports to nobody here sits under the person who hosts it; one nobody hosts comes last.
    const away = { ...COMPANY_FIXTURE_TREE, roles: COMPANY_FIXTURE_TREE.roles.map((r) => (r.handle === "agent-quality" ? { ...r, reports_to: { kind: "user" as const, user_id: "gone" }, host_user_id: "fixture-user-samvit" } : r.handle === "head-of-people" ? { ...r, reports_to: { kind: "user" as const, user_id: "gone" }, host_user_id: "gone" } : r)) };
    expect(companyDoc({ ...base, tree: away }).outline.map((r) => [r.id, r.depth])).toEqual([["fixture-user-me", 0], ["fixture-user-samvit", 0], ["fixture-role-agent-quality", 1], ["fixture-role-head-of-people", 0]]);
    // Only a role that sits under whom it reports to leaves its line's owner cell empty.
    const under = (d: ReturnType<typeof companyDoc>) => d.outline.flatMap((r) => (r.kind === "role" ? [[r.id, r.underReportsTo]] : []));
    expect(under(doc)).toEqual([["fixture-role-head-of-people", true], ["fixture-role-agent-quality", true]]);
    expect(under(companyDoc({ ...base, tree }))).toEqual([["fixture-role-head-of-people", true], ["fixture-role-agent-quality", true]]);
    expect(under(companyDoc({ ...base, tree: away }))).toEqual([["fixture-role-agent-quality", false], ["fixture-role-head-of-people", false]]);
  });

  test("the state line's clauses, each kept whole", () => {
    expect(stateClauses(doc.state)).toEqual([["4 goals: 2 on track,", "1 at risk,", "1 with no update"], ["9 projects,", "1 with work moving"], ["2 people,", "2 agent roles"]]);
    expect(stateLine(doc.state)).toBe(stateClauses(doc.state).map((c) => c.join(" ")).join(" · "));
  });

  test("the Projects filter's groups: each project under the goal it is listed under", () => {
    expect(goalProjects(doc.goals).map((g) => [g.goal.short_id, g.projects.map((p) => p.short_id)])).toEqual([["in-2", ["pr-6"]], ["in-5", ["pr-7"]], ["in-1", ["pr-12"]]]);
  });

  test("an ended goal is history: not in the outline, not on its owner", () => {
    const ended = companyDoc({ ...base, initiatives: COMPANY_FIXTURE_INITIATIVES.map((g) => (g.short_id === "in-5" ? { ...g, status: "completed" as const } : g)) });
    expect(flatGoals(ended.goals).map((g) => g.short_id)).toEqual(["in-2", "in-4", "in-1"]);
    expect(ended.people[1].goals).toEqual([]);
    expect(ended.state.goals.total).toBe(3);
  });
});

describe("before the org tree arrives", () => {
  const doc = companyDoc({ ...base, tree: null, workspaceName: "Union", changes: COMPANY_FIXTURE_CHANGES });

  test("the plain outline, the team's name, the roster's people, and no ghosts", () => {
    expect(doc.name).toBe("Union");
    expect(flatGoals(doc.goals).map((g) => g.short_id)).toEqual(["in-2", "in-5", "in-4", "in-1"]);
    expect(flatGoals(doc.goals).every((g) => !g.proposed && g.changes.length === 0)).toBe(true);
    expect(doc.people.map((p) => p.name)).toEqual(["Ashot Petrosian", "Samvit Ramadurgam"]);
    expect(doc.roles).toEqual([]);
    expect(doc.staffing).toEqual([]);
    expect(doc.waiting).toBe(0);
  });

  test("every owner is a face: a person or a role", () => {
    const doc = companyDoc(base);
    const byId = Object.fromEntries(flatGoals(doc.goals).map((g) => [g.short_id, g.owner && `${g.owner.kind}:${g.owner.name}`]));
    expect(byId).toEqual({ "in-2": "person:Ashot Petrosian", "in-5": "person:Samvit Ramadurgam", "in-4": "role:Agent Quality", "in-1": "role:Head of People" });
  });

  test("a workspace with no name anywhere is the personal one", () => {
    expect(companyDoc({ tree: null, initiatives: [], projects: [] }).name).toBe("Personal");
  });
});

describe("with the open proposals", () => {
  const doc = companyDoc({ ...base, changes: COMPANY_FIXTURE_CHANGES });
  const purpose = doc.goals.find((g) => !g.row)!;

  test("the company as it is stays the base: live goals in their live places, the proposal's new goals beside them", () => {
    // The live goals keep their order and their parents; the purpose a proposal sets is a goal of its own after them.
    expect(titles(doc.goals)).toEqual([
      "Win the private network", "Every relationship the agents run is one we'd be proud of", "Every project has a lead and every goal an owner",
      "Broker high-value introductions that become real transactions",
    ]);
    expect(doc.goals.slice(0, 3).every((g) => !!g.row)).toBe(true);
    expect(purpose.row).toBeUndefined();
    expect(purpose.proposed).toMatchObject({ proposal_id: "fixture-union-goals-proposal", row: { change_id: "union-purpose", kind: "initiative", status: "proposed", tag: "new" } });
    expect(purpose.owner).toMatchObject({ kind: "person", name: "Ashot Petrosian" });
    // The goals it sets sit under it; the live goals it would gather are named there, and stay where they are.
    expect(titles(purpose.goals)).toEqual([
      "Make revenue", "Increase top of funnel", "Improve funnel conversion rate", "Decrease cost per match",
      "Fundraise and then public launch", "Build a team of intense and aligned people",
    ]);
    expect(purpose.goals.every((g) => !g.row && g.depth === 2)).toBe(true);
    expect(purpose.arriving.map((a) => a.goal.short_id)).toEqual(["in-2", "in-4", "in-1"]);
  });

  test("a live goal a proposal would move keeps its place and says where it would go", () => {
    const network = doc.goals[0];
    expect(network.row?.short_id).toBe("in-2");
    expect(network.depth).toBe(1);
    expect(network.move).toMatchObject({ row: { change_id: "union-network", tag: "moves here" }, under: "Broker high-value introductions that become real transactions" });
    // The move is said on the goal's own line, never as a line under it.
    expect(network.changes).toEqual([]);
    // What fed it still does.
    expect(network.goals.map((g) => [g.short_id, g.depth])).toEqual([["in-5", 2]]);
    const quality = flatGoals(doc.goals).find((g) => g.short_id === "in-4")!;
    expect(quality.move?.row.change_id).toBe("union-quality-shape");
    // A project a change adds is a violet line under the goal; the change is said by that line.
    expect(quality.projects.map((p) => [p.title, p.ghost?.tag ?? null])).toEqual([["Agent Quality", "added"]]);
    // A move that also sets its numbers still says the numbers as a line.
    expect(quality.changes.map((c) => c.row.change_id)).toEqual(["union-quality-shape"]);
  });

  test("a proposed goal under a parent carries the loose projects it would take, as violet lines", () => {
    const revenue = purpose.goals[0];
    expect(revenue.unknown).toBe(false);
    expect(revenue.proposed!.row).toMatchObject({ change_id: "union-revenue", parent: { kind: "goal", name: "Broker high-value introductions that become real transactions" }, owner: { name: "Samvit Ramadurgam" } });
    expect(revenue.projects.map((p) => [p.title, !!p.ghost])).toEqual([["People & Deals", true]]);
    expect(revenue.measures).toEqual(["Fees collected \u2192 The first dollar"]);
    // A project a live goal carries today stays with it: the purpose names none again.
    expect(purpose.projects).toEqual([]);
  });

  test("a project only a proposal places is still loose: listed with the projects no goal carries", () => {
    expect(doc.unfiled.map((p) => p.title)).toEqual(["Callers & Call Management", "camerons ideas", "Infrastructure", "Matching Engine & Funnel", "People & Deals", "Public Launch & Fundraise"]);
    expect(doc.unfiled.every((p) => !p.ghost)).toBe(true);
    // The counts are the live ones; what the proposal would add is counted apart.
    expect(doc.state.goals.total).toBe(4);
    expect(doc.state.projects.total).toBe(9);
    expect(doc.state.proposed).toEqual({ goals: 7, projects: 0 });
    // Each live project is a live line once, under a goal or loose.
    const live = [...flatGoals(doc.goals).flatMap((g) => g.projects.filter((p) => !p.ghost)), ...doc.unfiled];
    expect(new Set(live.map((p) => p.id)).size).toBe(live.length);
    expect(live.length).toBe(9);
  });

  test("a whole workspace role is nobody's lead; a role the project names is", () => {
    const all = [...flatGoals(doc.goals).flatMap((g) => g.projects), ...companyDoc(base).unfiled];
    expect(all.find((p) => p.title === "Agent Quality")!.lead?.handle).toBe("agent-quality");
    expect(all.find((p) => p.title === "Infrastructure")!.lead).toBeNull();
  });

  test("a goal a proposal sets carries the record it would write", () => {
    const withWhy = companyDoc({ ...base, changes: UNION_GOALS_CHANGES.map((c) => (c._id === "union-purpose" ? { ...c, change: { ...c.change, why: "Introductions are the business." } } : c)) });
    const set = withWhy.goals.find((g) => !g.row)!;
    expect(set.record).toEqual({ why: "Introductions are the business.", milestones: [] });
    expect(set.purpose).toBe("Introductions are the business.");
  });

  test("a change that only writes a goal's record says so in words: its sentence and the words it writes", () => {
    const record = { ...UNION_GOALS_CHANGES[5], _id: "record-only", seq: 40, change: { kind: "initiative_shape" as const, initiative: "in-2", why: "Brokers see the deals first.", done_when: "Forty brokers send us theirs.", milestones: [{ title: "Portal open" }] } };
    const network = flatGoals(companyDoc({ ...base, changes: [record] }).goals).find((g) => g.short_id === "in-2")!;
    const [c] = network.changes;
    // The row's own words are empty (proposalTree builds the tag from the place and the numbers).
    expect([c.row.tag, c.row.detail, c.row.owner]).toEqual(["", null, null]);
    expect(c.sentence).toBe("Record on this goal: why it matters, what done looks like and the milestone Portal open");
    expect(c.record).toEqual({ why: "Brokers see the deals first.", done_when: "Forty brokers send us theirs.", milestones: ["Portal open"] });
    // A change that only places a goal is said whole by its tag: no sentence beside it.
    expect(flatGoals(doc.goals).find((g) => g.short_id === "in-2")!.move!.sentence).toBeUndefined();
    // One that places it and writes its record says the place in its tag and only the record in the sentence.
    const both = flatGoals(companyDoc({ ...base, changes: [{ ...record, change: { ...record.change, parent: "in-4" } }] }).goals).find((g) => g.short_id === "in-2")!.changes[0];
    expect([both.row.tag, both.under]).toEqual(["moves here", "Every relationship the agents run is one we'd be proud of"]);
    expect(both.sentence).toMatch(/^Record on this goal: why it matters/);
  });

  test("every change knows where it is answered: its proposal and its number there", () => {
    const network = flatGoals(doc.goals).find((g) => g.short_id === "in-2")!;
    expect(network.move!.proposal).toEqual({ short_id: "op-54", seq: 6 });
    const revenue = purpose.goals[0];
    expect(revenue.proposed!.proposal).toEqual({ short_id: "op-54", seq: 2 });
    // A project only a proposed goal would carry is answered with that goal.
    expect(revenue.projects[0].ghost!.proposal).toEqual({ short_id: "op-54", seq: 2 });
    expect(doc.staffing[0].proposal).toEqual({ short_id: "op-55", seq: 1 });
    expect(doc.roles.find((r) => r.role.handle === "agent-quality")!.changes[0].proposal).toEqual({ short_id: "op-55", seq: 2 });
    // Before the proposal's own row arrives there is nowhere to send the reader yet.
    expect(companyDoc({ ...base, proposals: [], changes: COMPANY_FIXTURE_CHANGES }).staffing[0].proposal).toBeUndefined();
  });

  test("a role a proposal would hire stands under who it would report to; a change on a role, under the role", () => {
    expect(doc.outline.map((r) => [r.kind, r.id, r.depth])).toEqual([
      ["person", "fixture-user-me", 0],
      ["role", "fixture-role-head-of-people", 1],
      ["role", "fixture-role-agent-quality", 1],
      ["ghost", "union-staff-quality-scope", 2],
      ["ghost", "union-staff-outreach", 1],
      ["person", "fixture-user-samvit", 0],
    ]);
  });

  test("role changes land on the role they change; a role to hire stands on its own", () => {
    const quality = doc.roles.find((r) => r.role.handle === "agent-quality")!;
    expect(quality.changes.map((c) => [c.row.change_id, c.proposal_id])).toEqual([["union-staff-quality-scope", COMPANY_STAFF_PROPOSAL._id]]);
    // Said from the role's own line, which already names the role.
    expect(quality.changes[0].sentence).toBe("would lead Callers & Call Management");
    expect(doc.staffing.map((c) => [c.row.change_id, c.row.tag, c.row.node.name])).toEqual([["union-staff-outreach", "new role", "Broker Outreach Lead"]]);
    expect(doc.waiting).toBe(13);
    // Nothing proposed is counted as held.
    const { proposed: _p, ...held } = doc.state;
    const { proposed: _q, ...plain } = companyDoc(base).state;
    expect(held).toEqual(plain);
  });

  test("an accepted change still draws; a skipped or applied one draws nothing", () => {
    const decided = UNION_GOALS_CHANGES.map((c) => (c._id === "union-revenue" ? { ...c, status: "accepted" as const } : c._id === "union-funnel" ? { ...c, status: "skipped" as const } : c._id === "union-quality-projects" ? { ...c, status: "applied" as const } : c));
    const after = companyDoc({ ...base, changes: decided });
    const goals = after.goals.find((g) => !g.row)!.goals;
    expect(goals.find((g) => g.title === "Make revenue")!.proposed!.row.status).toBe("accepted");
    // Accepted is not applied: the project stays loose until the store carries the goal.
    expect(after.unfiled.map((p) => p.title)).toContain("People & Deals");
    expect(titles(goals)).not.toContain("Increase top of funnel");
    const quality = flatGoals(after.goals).find((g) => g.short_id === "in-4")!;
    expect(quality.changes.map((c) => c.row.change_id)).toEqual(["union-quality-shape"]);
    expect(quality.projects.filter((p) => p.ghost)).toEqual([]);
    expect(after.waiting).toBe(8);
  });

  test("a failed change carries what the apply said", () => {
    const failed = UNION_GOALS_CHANGES.map((c) => (c._id === "union-network" ? { ...c, status: "failed" as const, applied_note: "in-2 was cancelled" } : c));
    const network = flatGoals(companyDoc({ ...base, changes: failed }).goals).find((g) => g.short_id === "in-2")!;
    expect(network.move).toMatchObject({ note: "in-2 was cancelled", row: { status: "failed" } });
  });

  test("a change that names a goal nothing answers to is drawn at the top as unknown", () => {
    const stray = [{ ...UNION_GOALS_CHANGES[5], _id: "stray", change: { kind: "initiative_owner" as const, initiative: "in-99", owner: "me" } }];
    const g = companyDoc({ ...base, changes: stray }).goals.find((x) => x.unknown)!;
    expect(g).toMatchObject({ depth: 1, unknown: true });
    expect(g.changes.map((c) => c.row.change_id)).toEqual(["stray"]);
  });
});

test("firstSentence stops at the first end of sentence, never inside a number", () => {
  expect(firstSentence("Owns 3.5 million rows. And more.")).toBe("Owns 3.5 million rows.");
  expect(firstSentence("No full stop")).toBe("No full stop");
  expect(firstSentence("  ")).toBeNull();
  expect(firstSentence(undefined)).toBeNull();
});
