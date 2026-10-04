// The company document's joins (components/company/companyModel.ts), on the
// Union shaped fixture: the outline's order, the projects no goal carries,
// who leads and owns what, and where a proposal's changes land.
// Run: cd packages/web && bun test components/company/companyModel.test.ts
import { describe, expect, test } from "bun:test";
import { companyDoc, firstSentence, flatGoals, tallyLine } from "./companyModel";
import { COMPANY_FIXTURE_CHANGES, COMPANY_FIXTURE_INITIATIVES, COMPANY_FIXTURE_PROJECTS, COMPANY_FIXTURE_ROSTER, COMPANY_FIXTURE_TREE, COMPANY_STAFF_PROPOSAL } from "./companyFixture";
import { UNION_GOALS_CHANGES } from "../org/goalsFixture";

const base = { tree: COMPANY_FIXTURE_TREE, initiatives: COMPANY_FIXTURE_INITIATIVES, projects: COMPANY_FIXTURE_PROJECTS, roster: COMPANY_FIXTURE_ROSTER };
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
    expect(doc.purpose[0]).toMatch(/^Brokers place the deals/);
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

  test("a project row carries its last change and its open and done counts", () => {
    const p = doc.goals[0].projects[0];
    expect(p).toMatchObject({ id: "union-proj-network", short_id: "pr-6", status: "active", counts: { open: 9, done: 12 } });
    expect(p.updated_at).toBe(COMPANY_FIXTURE_PROJECTS[5].updated_at);
    // No tasks counted: no counts, never "0 open".
    expect(companyDoc(base).unfiled.find((x) => x.title === "Infrastructure")!.counts).toBeNull();
  });

  test("projects no goal carries, by name, and never a finished one", () => {
    expect(doc.unfiled.map((p) => p.title)).toEqual(["Callers & Call Management", "camerons ideas", "Infrastructure", "Matching Engine & Funnel", "People & Deals", "Public Launch & Fundraise"]);
    expect(doc.unfiled.every((p) => !p.proposedUnder)).toBe(true);
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
    expect(head.reportsTo).toBe("Ashot Petrosian");
    expect(quality.leads.map((p) => p.title)).toEqual(["Agent Quality"]);
    expect(quality.goals.map((g) => g.short_id)).toEqual(["in-4"]);
  });

  test("a person with the roles that report to them and the goals they own", () => {
    const [ashot, samvit] = doc.people;
    expect(ashot).toMatchObject({ name: "Ashot Petrosian", me: true, username: "ashot" });
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
  });

  test("a live goal keeps its row and wears each change as a line: its new place, its numbers, its projects", () => {
    const network = purpose.goals.find((g) => g.short_id === "in-2")!;
    expect(network.row?.short_id).toBe("in-2");
    expect(network.proposed).toBeUndefined();
    expect(network.changes.map((c) => [c.row.change_id, c.row.tag])).toEqual([["union-network", "moves here"]]);
    // What fed it still does.
    expect(network.goals.map((g) => [g.short_id, g.depth])).toEqual([["in-5", 3]]);
    const quality = purpose.goals.find((g) => g.short_id === "in-4")!;
    expect(quality.changes.map((c) => [c.row.change_id, c.row.kind])).toEqual([["union-quality-shape", "initiative_shape"], ["union-quality-projects", "initiative_projects"]]);
    expect(quality.changes[1].row.detail).toBe("Agent Quality");
  });

  test("a project a proposal would place stays in the unfiled list and says where it would go", () => {
    const launch = doc.unfiled.find((p) => p.title === "Public Launch & Fundraise")!;
    expect(launch.proposedUnder).toBe("Fundraise and then public launch");
    // Carried today by a live goal: filed, whatever the proposal adds on top.
    expect(doc.unfiled.map((p) => p.title)).not.toContain("Broker Outreach");
    expect(doc.unfiled.map((p) => p.title)).not.toContain("Agent Quality");
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
