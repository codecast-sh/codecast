// A proposal's goal changes over the initiative fixture and the org fixture
// (docs/architecture/org-staffing.md S36): one of each kind the Goals lens
// draws. Read by the layout and mount tests, the dev preview and the rig.
import type { InitiativeRow, InitiativeUpdateRow } from "@codecast/shared/contracts/initiative";
import { FIXTURE_INITIATIVES, FIXTURE_PROJECTS } from "../initiatives/initiativeFixture";
import type { GoalProject } from "./goalsLayout";
import { ORG_FIXTURE } from "./orgFixture";
import type { OrgTree } from "./orgTypes";
import type { OrgHealth, OrgProposalChange, OrgProposalRow } from "./orgStaffingTypes";
import { ORG_STAFFING_FIXTURE_HEALTH } from "./orgStaffingFixture";

// A fixture change's reason reads as one: a placeholder like the key itself would print on the card.
const change = (id: string, seq: number, c: OrgProposalChange["change"], status: OrgProposalChange["status"] = "proposed", proposal_id = "fixture-goals-proposal", rationale = "The work already points at this; the record does not hold it yet."): OrgProposalChange =>
  ({ _id: id, proposal_id, seq, change: c, rationale, evidence: [], status });

export const GOALS_FIXTURE_DATA: { initiatives: typeof FIXTURE_INITIATIVES; projects: GoalProject[] } = {
  initiatives: FIXTURE_INITIATIVES,
  projects: FIXTURE_PROJECTS.map((p) => ({ _id: p._id, title: p.title, status: p.status, owner_role_id: (p as { owner_role_id?: string }).owner_role_id })),
};

export const GOALS_FIXTURE_CHANGES: OrgProposalChange[] = [
  change("g-new", 1, { kind: "initiative", title: "Every team runs a head of people", description: "A new team has a head of people reviewing its org within its first week.", projects: ["Agent org"], owner: "@growth", parent: "in-1", metrics: [{ name: "Teams with a head of people", target: "40" }] }),
  change("g-place", 2, { kind: "initiative_shape", initiative: "in-2", parent: "in-3" }),
  change("g-projects", 3, { kind: "initiative_projects", initiative: "in-3", projects: ["Agent org"] }),
  change("g-owner", 4, { kind: "initiative_owner", initiative: "in-4", owner: "Samvit Jain" }),
  change("g-measure", 5, { kind: "initiative_shape", initiative: "in-3", metrics: [{ name: "Paying teams", target: "25" }] }),
];

/** The same changes as a proposal row, for the dev preview (`/org?preview=1&proposal=op-8&lens=goals`). */
export const ORG_GOALS_FIXTURE_PROPOSAL: OrgProposalRow = {
  _id: "fixture-goals-proposal",
  short_id: "op-8",
  team_id: "fixture-team",
  author: { kind: "role", id: "fixture-role-head", name: "Head of People", short_id: "or-9" },
  title: "Name the goals the work already serves",
  summary_md: "The projects point at two goals nobody wrote down, one goal has no owner, and one is not read against a number.",
  mode: "review",
  status: "open",
  created_at: Date.UTC(2026, 8, 18, 10),
  changes: GOALS_FIXTURE_CHANGES,
};

// ---------------------------------------------------------------- a company's first goals
// The shape of a real head of people's first goals proposal (Union's op-54,
// 2026-10-04): one purpose set at the top over every project, seven goals
// under it, each with its owner and a number, and three goals that already
// exist moved under the purpose, one of them measured and given a project.
// The lens must read at first open with this much on it.

const UNION_TEAM = "fixture-union";
const ME = ORG_FIXTURE.people[0].user_id;
const SAM = "fixture-user-samvit";
const HEAD = "fixture-role-head-of-people";
const QUALITY = "fixture-role-agent-quality";
const T0 = ORG_FIXTURE.generated_at;
const growth = ORG_FIXTURE.roles[0];

export const UNION_GOALS_TREE: OrgTree = {
  ...ORG_FIXTURE,
  workspace: { kind: "team", id: UNION_TEAM, name: "Union" },
  people: [
    { ...ORG_FIXTURE.people[0], name: "Ashot Petrosian" },
    { ...ORG_FIXTURE.people[1], user_id: SAM, name: "Samvit Ramadurgam", sessions: ORG_FIXTURE.people[1].sessions.map((s) => ({ ...s, owner_user_id: SAM })) },
  ],
  roles: [
    { ...growth, _id: HEAD, short_id: "or-35", team_id: UNION_TEAM, name: "Head of People", handle: "head-of-people", avatar: "snail", scope: { project_ids: [], plan_ids: [] }, scope_names: { projects: [], plans: [] }, charter: "Keeps every project led and every goal owned.", standing: { ...growth.standing!, state_line: "Reading the week's calls for goals nobody wrote down" } },
    { ...growth, sessions: growth.sessions.map((x) => ({ ...x, _id: `${x._id}-q`, short_id: `${x.short_id}q`, org_role_id: QUALITY })), _id: QUALITY, short_id: "or-36", team_id: UNION_TEAM, name: "Agent Quality", handle: "agent-quality", avatar: "otter", scope: { project_ids: ["union-proj-quality"], plan_ids: [] }, scope_names: { projects: [{ id: "union-proj-quality", title: "Agent Quality", short_id: "pr-12" }], plans: [] }, charter: "Every conversation an agent runs is one we would be proud of.", standing: { ...growth.standing!, state: "dormant", state_status: "dormant", state_line: "AgentWatch queue at 3; nothing trust breaking this week" } },
  ],
  anchors: [],
};

const UNION_PROJECTS: GoalProject[] = [
  { _id: "union-proj-matching", title: "Matching Engine & Funnel", short_id: "pr-1", status: "active" },
  { _id: "union-proj-callers", title: "Callers & Call Management", short_id: "pr-2", status: "active" },
  { _id: "union-proj-cameron", title: "camerons ideas", short_id: "pr-3", status: "active" },
  { _id: "union-proj-infra", title: "Infrastructure", short_id: "pr-4", status: "active" },
  { _id: "union-proj-quality", title: "Agent Quality", short_id: "pr-12", status: "active", owner_role_id: QUALITY },
  { _id: "union-proj-network", title: "Broker / Private Network", short_id: "pr-6", status: "active" },
  { _id: "union-proj-outreach", title: "Broker Outreach", short_id: "pr-7", status: "active" },
  { _id: "union-proj-launch", title: "Public Launch & Fundraise", short_id: "pr-8", status: "planned" },
  { _id: "union-proj-people", title: "People & Deals", short_id: "pr-9", status: "active" },
];

const DAY = 86_400_000;
const goal = (r: Partial<InitiativeRow> & Pick<InitiativeRow, "_id" | "short_id" | "title" | "status">): InitiativeRow => ({
  project_ids: [], health: "none", workspace: `team:${UNION_TEAM}`, team_id: UNION_TEAM, user_id: ME, created_at: T0 - 30 * DAY, updated_at: T0 - DAY, ...r,
});

const UNION_INITIATIVES: InitiativeRow[] = [
  goal({
    _id: "union-in-2", short_id: "in-2", title: "Win the private network", status: "active", owner: { kind: "user", user_id: ME }, priority: "p1", project_ids: ["union-proj-network", "union-proj-outreach"],
    description: "Brokers bring the deals the open market never sees. Sign the ones who place most of them, then make Union where they look first.",
    health: "on_track", health_at: T0 - 4 * DAY, latest_update_id: "union-upd-1",
    metrics: [{ key: "brokers", name: "Brokers onboarded", target: "40" }, { key: "deals", name: "Deals from brokers", target: "most deals by year end" }],
    scoreboard: { brokers: { value: "17", observed_at: T0 - 3 * DAY, source: "admin home" } },
    score_history: { brokers: [6, 9, 11, 14, 17].map((n, i) => ({ value: String(n), observed_at: T0 - (31 - i * 7) * DAY, source: "admin home" })) },
    milestones: [{ key: "first-ten", title: "Ten brokers signed", date: T0 - 20 * DAY, done_at: T0 - 22 * DAY }, { key: "exclusive", title: "First exclusive listing", date: T0 + 12 * DAY }],
  }),
  goal({ _id: "union-in-4", short_id: "in-4", title: "Every relationship the agents run is one we'd be proud of", status: "proposed", owner: { kind: "role", role_id: QUALITY }, health: "at_risk", health_at: T0 - 2 * DAY, latest_update_id: "union-upd-2" }),
  goal({ _id: "union-in-1", short_id: "in-1", title: "Every project has a lead and every goal an owner", status: "proposed", owner: { kind: "role", role_id: HEAD }, project_ids: ["union-proj-quality"] }),
];

/** The goals' latest updates, as the store would hold them for a goal on screen (the close card's update line). */
export const UNION_GOALS_UPDATES: InitiativeUpdateRow[] = [
  { _id: "union-upd-1", initiative_id: "union-in-2", body: "Three more brokers signed this week; the outreach sequence now books a call from one reply in five.", health: "on_track", by: { kind: "user", user_id: ME }, at: T0 - 4 * DAY, workspace: `team:${UNION_TEAM}`, user_id: ME },
  { _id: "union-upd-2", initiative_id: "union-in-4", body: "Two conversations broke trust on Tuesday, both from a stale profile. The fix is in review.", health: "at_risk", by: { kind: "role", role_id: QUALITY }, at: T0 - 2 * DAY, workspace: `team:${UNION_TEAM}`, user_id: ME },
];

export const UNION_GOALS_DATA: { initiatives: readonly InitiativeRow[]; projects: readonly GoalProject[] } = { initiatives: UNION_INITIATIVES, projects: UNION_PROJECTS };

const PURPOSE = "Broker high-value introductions that become real transactions";
const EVERY_PROJECT = UNION_PROJECTS.map((p) => p.title);
const u = (id: string, seq: number, c: OrgProposalChange["change"], why: string) => change(`union-${id}`, seq, c, "proposed", "fixture-union-goals-proposal", why);

export const UNION_GOALS_CHANGES: OrgProposalChange[] = [
  u("purpose", 1, { kind: "initiative", title: PURPOSE, description: "Union is a curated relationship network that brokers high-value introductions. The business earns its fee when an introduction becomes a real transaction. Every goal below serves this.", owner: "Ashot Petrosian", projects: EVERY_PROJECT }, "Every call and the #team thread say this is what Union is for; nothing on the initiatives page does."),
  u("revenue", 2, { kind: "initiative", title: "Make revenue", description: "First on the list of core focuses; the fee paperwork for the first paying client is the work in flight.", owner: "Samvit Ramadurgam", parent: PURPOSE, projects: ["People & Deals"], metrics: [{ name: "Fees collected", target: "The first dollar" }] }, "First on the list of core focuses in the Monday call; the fee paperwork for the first paying client is in flight."),
  u("funnel", 3, { kind: "initiative", title: "Increase top of funnel", description: "Measured by the north star on the admin home page: cold emails delivered per day, about 90 today.", owner: "Ashot Petrosian", parent: PURPOSE, projects: ["Matching Engine & Funnel", "Infrastructure"], metrics: [{ name: "Cold emails per day", target: "10,000" }] }, "The admin home page calls cold emails per day the north star; no goal carries it."),
  u("conversion", 4, { kind: "initiative", title: "Improve funnel conversion rate", description: "The share of first-emailed people who reach a delivered introduction.", owner: "Ashot Petrosian", parent: PURPOSE, projects: ["Matching Engine & Funnel", "Callers & Call Management", "camerons ideas"], metrics: [{ name: "Email to intro rate", target: "0.20%" }, { name: "Cold email reply rate", target: "1% higher" }] }, "Three projects measure the same rate from different ends; one goal gives them a shared target."),
  u("cost", 5, { kind: "initiative", title: "Decrease cost per match", description: "What one delivered introduction costs in sending, enrichment and model spend.", owner: "Ashot Petrosian", parent: PURPOSE, projects: ["Matching Engine & Funnel"], metrics: [{ name: "Dollars per intro", target: "$250" }] }, "Spend per intro came up in two calls this week without a number anyone owns."),
  u("network", 6, { kind: "initiative_shape", initiative: "in-2", parent: PURPOSE }, "The private network goal exists but hangs off nothing; it serves the purpose like the rest."),
  u("launch", 7, { kind: "initiative", title: "Fundraise and then public launch", description: "The raise closes before the public launch, not after.", owner: "Ashot Petrosian", parent: PURPOSE, projects: ["Public Launch & Fundraise"] }, "The raise and the launch were ordered in the Thursday call; neither has a goal yet."),
  u("team", 8, { kind: "initiative", title: "Build a team of intense and aligned people", description: "Hiring, onboarding and the weekly cadence that keeps the team pointed one way.", owner: "Samvit Ramadurgam", parent: PURPOSE, projects: ["People & Deals"] }, "Hiring threads name alignment as the bar; the goal makes it a thing the team reads back."),
  u("quality-shape", 9, { kind: "initiative_shape", initiative: "in-4", parent: PURPOSE, metrics: [{ name: "Trust breaking issues per day", target: "0" }, { name: "Average comms score per conversation", target: "0.9 or higher" }] }, "AgentWatch already reports both numbers daily; the goal only writes down the targets."),
  u("quality-projects", 10, { kind: "initiative_projects", initiative: "in-4", projects: ["Agent Quality"] }, "The Agent Quality project does this goal's work and is carried by no goal."),
  u("leads", 11, { kind: "initiative_shape", initiative: "in-1", parent: PURPOSE }, "The leads goal exists but hangs off nothing; it serves the purpose like the rest."),
];

/** The proposal row, for the dev preview (`/org?preview=1&proposal=op-54&lens=goals`) and the rig. */
export const UNION_GOALS_PROPOSAL: OrgProposalRow = {
  _id: "fixture-union-goals-proposal",
  short_id: "op-54",
  team_id: UNION_TEAM,
  author: { kind: "role", id: HEAD, name: "Head of People", short_id: "or-35", handle: "head-of-people", avatar: "snail" },
  title: "Name the goals the work already serves",
  summary_md: "The projects' own goals, and what the company said in its calls and threads, point at these goals; the initiatives page does not hold them yet.",
  asks: [{ title: "7 goals to set, and 4 changes to the goals that exist", why: "The projects' own goals, and what the company said in its calls and threads, point at these goals; the initiatives page does not hold them yet.", effect: "11 changes on the initiatives page: a goal set, a project added to one, or an owner named. No work starts or stops.", seqs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }],
  mode: "review",
  status: "open",
  created_at: Date.UTC(2026, 9, 4, 1),
  changes: UNION_GOALS_CHANGES,
};

/** The health fixture's two roles, read as Union's: what each area holds today (a role's open work at close zoom). */
export const UNION_GOALS_HEALTH: OrgHealth = {
  ...ORG_STAFFING_FIXTURE_HEALTH,
  roles: ORG_STAFFING_FIXTURE_HEALTH.roles.slice(0, 2).map((r, i) => ({ ...r, role_id: [QUALITY, HEAD][i], short_id: ["or-36", "or-35"][i], handle: ["agent-quality", "head-of-people"][i], flags: [] })),
  people: [],
};

/** What a dev preview of the chart draws for a fixture proposal: the org it belongs to, its goals and its health. */
export type GoalsPreviewFixture = { proposal: OrgProposalRow; tree: OrgTree; goalsData: { initiatives: readonly InitiativeRow[]; projects: readonly GoalProject[] }; health: OrgHealth };
export const GOALS_PREVIEW_FIXTURES: readonly GoalsPreviewFixture[] = [
  { proposal: UNION_GOALS_PROPOSAL, tree: UNION_GOALS_TREE, goalsData: UNION_GOALS_DATA, health: UNION_GOALS_HEALTH },
  { proposal: ORG_GOALS_FIXTURE_PROPOSAL, tree: ORG_FIXTURE, goalsData: GOALS_FIXTURE_DATA, health: ORG_STAFFING_FIXTURE_HEALTH },
];
