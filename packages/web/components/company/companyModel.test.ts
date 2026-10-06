// The company document's joins (components/company/companyModel.ts), on the
// Union shaped fixture: the outline's order, the projects no goal carries,
// who leads and owns what, and where a proposal's changes land.
// Run: cd packages/web && bun test components/company/companyModel.test.ts
import { describe, expect, test } from "bun:test";
import { changeAnchor, companyDoc, firstSentence, flatGoals, goalAnchor, goalPurpose, tallyLine } from "./companyModel";
import { COMPANY_FIXTURE_CHANGES, COMPANY_FIXTURE_INITIATIVES, COMPANY_FIXTURE_PROJECTS, COMPANY_FIXTURE_PROPOSALS, COMPANY_FIXTURE_ROSTER, COMPANY_FIXTURE_TASKS, COMPANY_FIXTURE_TREE, COMPANY_STAFF_PROPOSAL } from "./companyFixture";
import { UNION_GOALS_CHANGES } from "../org/goalsFixture";

const base = { tree: COMPANY_FIXTURE_TREE, initiatives: COMPANY_FIXTURE_INITIATIVES, projects: COMPANY_FIXTURE_PROJECTS, roster: COMPANY_FIXTURE_ROSTER, tasks: COMPANY_FIXTURE_TASKS, proposals: COMPANY_FIXTURE_PROPOSALS };
const titles = (goals: { title: string }[]) => goals.map((g) => g.title);

describe("the plain outline", () => {
  const doc = companyDoc(base);

  test("names the company and tallies what it holds", () => {
    expect(doc.name).toBe("Union");
    expect(doc.tally).toEqual({ goals: 4, projects: 9, people: 2, roles: 2 });
    expect(tallyLine(doc.tally)).toBe("4 goals, 9 projects, 2 people, 2 roles");
    expect(tallyLine({ goals: 1, projects: 1, people: 1, roles: 1 })).toBe("1 goal, 1 project, 1 person, 1 role");
    expect(doc.waiting).toBe(0);
  });

  test("the purpose is why each top level goal matters, in the goals' order", () => {
    expect(doc.purpose).toHaveLength(3);
    expect(doc.purpose[0].text).toMatch(/^Brokers place the deals/);
    expect(doc.purpose.every((p) => p.status === undefined)).toBe(true);
  });

  test("a goal's purpose is read one way: why it matters, else the first sentence of what it is", () => {
    expect(goalPurpose("  Because.  ", "What it is. And more.")).toBe("Because.");
    expect(goalPurpose(undefined, "What it is. And more.")).toBe("What it is.");
    expect(goalPurpose("", undefined)).toBeNull();
    // A goal with a description and no why still says a purpose, in the header and on its own line.
    const described = companyDoc({ ...base, initiatives: base.initiatives.map((g) => (g.short_id === "in-2" ? { ...g, why: undefined, description: "Win the brokers who place the deals. Then the rest." } : g)) });
    expect(described.purpose[0].text).toBe("Win the brokers who place the deals.");
    expect(described.goals[0].purpose).toBe("Win the brokers who place the deals.");
    expect(doc.goals[0].purpose).toBe(doc.purpose[0].text);
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
    expect(head.reportsTo).toEqual({ name: "Ashot Petrosian", href: "/team/ashot" });
    expect(quality.leads.map((p) => p.title)).toEqual(["Agent Quality"]);
    expect(quality.goals.map((g) => g.short_id)).toEqual(["in-4"]);
  });

  test("a person with the roles that report to them and the goals they own", () => {
    const [ashot, samvit] = doc.people;
    expect(ashot).toMatchObject({ name: "Ashot Petrosian", me: true, href: "/team/ashot" });
    // A person the roster has no username for is reached by id.
    expect(companyDoc({ ...base, roster: [] }).people[0].href).toBe("/team/fixture-user-me");
    expect(ashot.roles.map((r) => r.handle)).toEqual(["head-of-people", "agent-quality"]);
    expect(ashot.goals.map((g) => g.short_id)).toEqual(["in-2"]);
    expect(samvit.roles).toEqual([]);
    expect(samvit.goals.map((g) => g.short_id)).toEqual(["in-5"]);
  });

  test("an ended goal is history: not in the outline, not on its owner", () => {
    const ended = companyDoc({ ...base, initiatives: COMPANY_FIXTURE_INITIATIVES.map((g) => (g.short_id === "in-5" ? { ...g, status: "completed" as const } : g)) });
    expect(flatGoals(ended.goals).map((g) => g.short_id)).toEqual(["in-2", "in-4", "in-1"]);
    expect(ended.people[1].goals).toEqual([]);
    expect(ended.tally.goals).toBe(3);
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

  test("every owner leads somewhere: a person to their page, a role to its page", () => {
    const doc = companyDoc(base);
    const byId = Object.fromEntries(flatGoals(doc.goals).map((g) => [g.short_id, g.ownerHref]));
    expect(byId).toEqual({ "in-2": "/team/ashot", "in-5": "/team/samvit", "in-4": "/org/or-36", "in-1": "/org/or-35" });
  });

  test("a workspace with no name anywhere is the personal one", () => {
    expect(companyDoc({ tree: null, initiatives: [], projects: [] }).name).toBe("Personal");
  });
});

describe("with the open proposals", () => {
  const doc = companyDoc({ ...base, changes: COMPANY_FIXTURE_CHANGES });
  const [purpose] = doc.goals;

  test("a proposed goal stands where it would sit: the purpose at the top, the goals it gathers beneath", () => {
    expect(titles(doc.goals)).toEqual(["Broker high-value introductions that become real transactions"]);
    expect(purpose.row).toBeUndefined();
    expect(purpose.proposed).toMatchObject({ proposal_id: "fixture-union-goals-proposal", row: { change_id: "union-purpose", kind: "initiative", status: "proposed", tag: "new" } });
    expect(purpose.owner).toMatchObject({ kind: "person", name: "Ashot Petrosian" });
    expect(purpose.changes).toEqual([]);
    expect(titles(purpose.goals)).toEqual([
      "Make revenue", "Increase top of funnel", "Improve funnel conversion rate", "Decrease cost per match",
      "Win the private network", "Fundraise and then public launch", "Build a team of intense and aligned people",
      "Every relationship the agents run is one we'd be proud of", "Every project has a lead and every goal an owner",
    ]);
    expect(purpose.goals.every((g) => g.depth === 2)).toBe(true);
  });

  test("a proposed goal under a parent is a ghost in the parent's list", () => {
    const revenue = purpose.goals[0];
    expect(revenue.row).toBeUndefined();
    expect(revenue.unknown).toBe(false);
    expect(revenue.proposed!.row).toMatchObject({ change_id: "union-revenue", parent: { kind: "goal", name: "Broker high-value introductions that become real transactions" }, owner: { name: "Samvit Ramadurgam" } });
    expect(revenue.projects.map((p) => [p.title, !!p.ghost])).toEqual([["People & Deals", true]]);
    expect(revenue.measures).toEqual(["Fees collected \u2192 The first dollar"]);
  });

  test("a live goal keeps its row and wears each change as a line: its new place, its numbers, its projects", () => {
    const network = purpose.goals.find((g) => g.short_id === "in-2")!;
    expect(network.row?.short_id).toBe("in-2");
    expect(network.proposed).toBeUndefined();
    expect(network.changes.map((c) => [c.row.change_id, c.row.tag, c.under])).toEqual([["union-network", "moves here", "Broker high-value introductions that become real transactions"]]);
    expect(network.measures).toEqual([]);
    // What fed it still does.
    expect(network.goals.map((g) => [g.short_id, g.depth])).toEqual([["in-5", 3]]);
    const quality = purpose.goals.find((g) => g.short_id === "in-4")!;
    expect(quality.changes.map((c) => [c.row.change_id, c.row.kind])).toEqual([["union-quality-shape", "initiative_shape"], ["union-quality-projects", "initiative_projects"]]);
    expect(quality.changes[1].row.detail).toBe("Agent Quality");
  });

  test("a project an open proposal places is not listed as carried by nothing", () => {
    // op-54 puts every loose project under a goal it sets: the proposal's rows draw them there.
    expect(doc.unfiled.map((p) => p.title)).toEqual([]);
    // Once the proposal is skipped they are loose again.
    const skipped = companyDoc({ ...base, changes: UNION_GOALS_CHANGES.map((c) => ({ ...c, status: "skipped" as const })) });
    expect(skipped.unfiled.map((p) => p.title)).toContain("Public Launch & Fundraise");
  });

  test("a whole workspace role is nobody's lead; a role the project names is", () => {
    const all = [...flatGoals(doc.goals).flatMap((g) => g.projects), ...companyDoc(base).unfiled];
    expect(all.find((p) => p.title === "Agent Quality")!.lead?.handle).toBe("agent-quality");
    expect(all.find((p) => p.title === "Infrastructure")!.lead).toBeNull();
  });

  test("a top level goal a proposal sets says the purpose, in its change's status, until the store carries it", () => {
    const sentence = "Union is a curated relationship network that brokers high-value introductions.";
    expect(doc.purpose).toEqual([{ text: sentence, status: "proposed" }]);
    // Accepting it keeps the sentence in the header: it never falls back to "none written".
    const accepted = companyDoc({ ...base, changes: UNION_GOALS_CHANGES.map((c) => (c._id === "union-purpose" ? { ...c, status: "accepted" as const } : c)) });
    expect(accepted.purpose).toEqual([{ text: sentence, status: "accepted" }]);
    // Applied: the goal is in the store with its description, and the header reads the same words off it.
    const { change } = UNION_GOALS_CHANGES[0];
    const applied = companyDoc({ ...base, initiatives: [...base.initiatives.map((g) => (g.parent_initiative_id ? g : { ...g, parent_initiative_id: "union-in-9" })), { ...base.initiatives[0], _id: "union-in-9", short_id: "in-9", title: (change as { title: string }).title, description: (change as { description: string }).description, why: undefined, parent_initiative_id: undefined, project_ids: [] }] });
    expect(applied.purpose).toEqual([{ text: sentence }]);
    // A proposed goal that writes why it matters says that, before and after.
    const withWhy = companyDoc({ ...base, changes: UNION_GOALS_CHANGES.map((c) => (c._id === "union-purpose" ? { ...c, change: { ...c.change, why: "Introductions are the business." } } : c)) });
    expect(withWhy.purpose[0]).toEqual({ text: "Introductions are the business.", status: "proposed" });
    expect(withWhy.goals[0].record).toEqual({ why: "Introductions are the business.", milestones: [] });
    // Nothing proposed at the top: the written purpose stands alone.
    expect(companyDoc(base).purpose.some((p) => p.status)).toBe(false);
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
    expect(flatGoals(doc.goals).find((g) => g.short_id === "in-2")!.changes[0].sentence).toBeUndefined();
    // One that places it and writes its record says the place in its tag and only the record in the sentence.
    const both = flatGoals(companyDoc({ ...base, changes: [{ ...record, change: { ...record.change, parent: "in-4" } }] }).goals).find((g) => g.short_id === "in-2")!.changes[0];
    expect([both.row.tag, both.under]).toEqual(["moves here", "Every relationship the agents run is one we'd be proud of"]);
    expect(both.sentence).toMatch(/^Record on this goal: why it matters/);
  });

  test("every name on a change leads somewhere: a live thing to its page, a proposed one to its place on this page", () => {
    const network = flatGoals(doc.goals).find((g) => g.short_id === "in-2")!;
    expect(network.changes[0].hrefs).toEqual({ node: "/goals/in-2", parent: `#${goalAnchor("union-purpose")}`, proposal: "/org?proposal=op-54" });
    const revenue = purpose.goals[0];
    expect(revenue.ownerHref).toBe("/team/samvit");
    expect(revenue.proposed!.hrefs).toMatchObject({ owner: "/team/samvit", parent: `#${goalAnchor("union-purpose")}`, proposal: "/org?proposal=op-54" });
    expect(doc.staffing[0].hrefs).toEqual({ node: `#${changeAnchor("union-staff-outreach")}`, parent: "/team/ashot", proposal: "/org?proposal=op-55" });
    expect(doc.roles.find((r) => r.role.handle === "agent-quality")!.changes[0].hrefs.node).toBe("/org/or-36");
    // A skipped goal is not on the page: nothing links to where it would have been.
    const skipped = companyDoc({ ...base, changes: UNION_GOALS_CHANGES.map((c) => (c._id === "union-purpose" ? { ...c, status: "skipped" as const } : c)) });
    expect(flatGoals(skipped.goals).find((g) => g.short_id === "in-2")!.changes[0]?.hrefs.parent).toBeUndefined();
  });

  test("role changes land on the role they change; a role to hire stands on its own", () => {
    const quality = doc.roles.find((r) => r.role.handle === "agent-quality")!;
    expect(quality.changes.map((c) => [c.row.change_id, c.proposal_id])).toEqual([["union-staff-quality-scope", COMPANY_STAFF_PROPOSAL._id]]);
    expect(doc.staffing.map((c) => [c.row.change_id, c.row.tag, c.row.node.name])).toEqual([["union-staff-outreach", "new role", "Broker Outreach Lead"]]);
    expect(doc.waiting).toBe(13);
    // Nothing proposed is counted as held.
    expect(doc.tally).toEqual({ goals: 4, projects: 9, people: 2, roles: 2 });
  });

  test("an accepted change still draws; a skipped or applied one draws nothing", () => {
    const decided = UNION_GOALS_CHANGES.map((c) => (c._id === "union-revenue" ? { ...c, status: "accepted" as const } : c._id === "union-funnel" ? { ...c, status: "skipped" as const } : c._id === "union-quality-projects" ? { ...c, status: "applied" as const } : c));
    const after = companyDoc({ ...base, changes: decided });
    const goals = after.goals[0].goals;
    expect(goals.find((g) => g.title === "Make revenue")!.proposed!.row.status).toBe("accepted");
    // Accepted is as good as placed: its project is no longer unfiled.
    expect(after.unfiled.map((p) => p.title)).not.toContain("People & Deals");
    expect(titles(goals)).not.toContain("Increase top of funnel");
    expect(goals.find((g) => g.short_id === "in-4")!.changes.map((c) => c.row.change_id)).toEqual(["union-quality-shape"]);
    expect(after.waiting).toBe(8);
  });

  test("a failed change carries what the apply said", () => {
    const failed = UNION_GOALS_CHANGES.map((c) => (c._id === "union-network" ? { ...c, status: "failed" as const, applied_note: "in-2 was cancelled" } : c));
    const network = flatGoals(companyDoc({ ...base, changes: failed }).goals).find((g) => g.short_id === "in-2")!;
    expect(network.changes[0]).toMatchObject({ note: "in-2 was cancelled", row: { status: "failed" } });
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
