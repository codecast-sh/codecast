// A Union shaped company for the document view
// (docs/architecture/initiatives-projects-role-page.md I5): the Goals lens'
// own tree, projects and first goals proposal (components/org/goalsFixture),
// with each live goal's intent record filled in (why, done when, milestones,
// numbers over time), one goal that feeds another, and a second small
// proposal that changes the roles. Read by the model and mount tests and
// the rig.
import type { InitiativeRow, InitiativeScore } from "@codecast/shared/contracts/initiative";
import { UNION_GOALS_CHANGES, UNION_GOALS_DATA, UNION_GOALS_PROPOSAL, UNION_GOALS_TREE } from "../org/goalsFixture";
import type { OrgProposalChange, OrgProposalRow } from "../org/orgStaffingTypes";
import type { CompanyMember, CompanyProject } from "./companyModel";

const DAY = 86_400_000;
export const COMPANY_FIXTURE_NOW = UNION_GOALS_TREE.generated_at;
const T0 = COMPANY_FIXTURE_NOW;
/** Weekly reports ending `last` days ago, oldest first. */
const series = (key: string, values: string[], source: string, last = 3): Record<string, InitiativeScore[]> => ({
  [key]: values.map((value, i) => ({ value, observed_at: T0 - (last + (values.length - 1 - i) * 7) * DAY, source })),
});

const RECORD: Record<string, Partial<InitiativeRow>> = {
  "in-2": {
    why: "Brokers place the deals the open market never sees. If the ones who place most of them look at Union first, every other number on this page follows.",
    done_when: "Forty brokers send us their deals before anyone else, and most of the deals we introduce in a month came through one of them.",
    target_date: T0 + 88 * DAY,
    milestones: [
      { key: "first_ten", title: "First ten brokers signed", date: T0 - 30 * DAY, done_at: T0 - 33 * DAY },
      { key: "sequence", title: "Outreach sequence books a call from one reply in five", date: T0 - 6 * DAY, done_at: T0 - 4 * DAY },
      { key: "twenty_five", title: "Twenty five brokers onboarded", date: T0 + 19 * DAY },
      { key: "portal", title: "Broker portal open", date: T0 + 54 * DAY },
    ],
    score_history: series("brokers", ["6", "9", "11", "14", "17"], "admin home"),
    questions: [{ key: "exclusive", text: "Do we ask for exclusivity in the first year?", at: T0 - 5 * DAY, by: "Samvit Ramadurgam" }],
    decisions: [{ key: "brokers_first", text: "Sign brokers before family offices", at: T0 - 20 * DAY, by: "Ashot Petrosian", source: { kind: "call", ref: "cl-42:14" } }],
    sources: [{ kind: "call", ref: "cl-42:14", quote: "the private network is the whole game this quarter", by: "Ashot Petrosian", at: T0 - 20 * DAY }],
  },
  "in-4": {
    why: "One careless message from an agent costs a relationship that took a year to earn.",
    done_when: "A week passes with no trust breaking issue and every conversation scores 0.9 or higher.",
    metrics: [{ key: "trust_breaks", name: "Trust breaking issues per day", target: "under 1" }],
    scoreboard: { trust_breaks: { value: "2", observed_at: T0 - 2 * DAY, source: "AgentWatch" } },
    score_history: series("trust_breaks", ["5", "4", "4", "3", "2"], "AgentWatch", 2),
    milestones: [{ key: "stale_profiles", title: "Stale profile fix shipped", date: T0 - DAY }],
  },
  "in-1": {
    why: "Work nobody answers for is work nobody finishes.",
    milestones: [{ key: "all_led", title: "Every active project names a lead", date: T0 + 9 * DAY }],
  },
};

const live = UNION_GOALS_DATA.initiatives.map((g) => ({ ...g, ...RECORD[g.short_id] }));
const network = live.find((g) => g.short_id === "in-2")!;

/** A goal that feeds the private network, so the plain document has a sub heading. */
const TEN_BROKERS: InitiativeRow = {
  ...network,
  _id: "union-in-5", short_id: "in-5", title: "Sign the ten brokers who place most of the deals", status: "active", priority: undefined,
  description: undefined, parent_initiative_id: network._id, project_ids: ["union-proj-outreach"],
  owner: { kind: "user", user_id: "fixture-user-samvit" },
  why: "Ten names place more than half of the deals in our segment.",
  done_when: "All ten have sent us a deal.",
  health: "on_track", health_at: T0 - 6 * DAY, latest_update_id: undefined, target_date: T0 + 40 * DAY,
  metrics: [{ key: "top_ten", name: "Top ten brokers signed", target: "10" }],
  scoreboard: { top_ten: { value: "4", observed_at: T0 - 6 * DAY, source: "CRM" } },
  score_history: { top_ten: [{ value: "1", observed_at: T0 - 27 * DAY, source: "CRM" }, { value: "3", observed_at: T0 - 13 * DAY, source: "CRM" }, { value: "4", observed_at: T0 - 6 * DAY, source: "CRM" }] },
  milestones: [{ key: "fifth", title: "Fifth of the ten signed", date: T0 + 12 * DAY }],
  questions: undefined, decisions: undefined, sources: undefined,
};

export const COMPANY_FIXTURE_INITIATIVES: InitiativeRow[] = [...live, TEN_BROKERS];

/** The lens' projects as the store holds them: each with its last change and its task counts. */
export const COMPANY_FIXTURE_PROJECTS: CompanyProject[] = UNION_GOALS_DATA.projects.map((p, i) => ({
  ...p,
  updated_at: T0 - (i * 2 + 1) * DAY,
  task_counts: i % 4 === 3 ? { total: 0, done: 0, in_progress: 0 } : { total: 6 + i * 3, done: 2 + i * 2, in_progress: 1 + (i % 3) },
}));

export const COMPANY_FIXTURE_TREE = UNION_GOALS_TREE;

export const COMPANY_FIXTURE_ROSTER: CompanyMember[] = [
  { _id: "fixture-user-me", name: "Ashot Petrosian", github_username: "ashot" },
  { _id: "fixture-user-samvit", name: "Samvit Ramadurgam", github_username: "samvit" },
];

/** The head of people's first goals proposal: a purpose over every project and the goals under it. */
export const COMPANY_GOALS_PROPOSAL: OrgProposalRow = UNION_GOALS_PROPOSAL;

const STAFF_ID = "fixture-union-staff-proposal";
const staff = (id: string, seq: number, change: OrgProposalChange["change"], rationale: string): OrgProposalChange =>
  ({ _id: `union-staff-${id}`, proposal_id: STAFF_ID, seq, change, rationale, evidence: [], status: "proposed" });

/** A second proposal that changes the roles: one to hire, one to give a wider area. */
export const COMPANY_STAFF_PROPOSAL: OrgProposalRow = {
  ...UNION_GOALS_PROPOSAL,
  _id: STAFF_ID,
  short_id: "op-55",
  title: "A lead for broker outreach",
  summary_md: "Broker outreach has no lead, and the quality role already reads every caller's transcripts.",
  asks: undefined,
  created_at: UNION_GOALS_PROPOSAL.created_at - DAY,
  changes: [
    staff("outreach", 1, { kind: "role", name: "Broker Outreach Lead", handle: "broker-outreach", reports_to: "me", scope: { projects: ["Broker Outreach"] }, charter: "Books a first call with every broker on the list.", tenure: { kind: "standing" } }, "Two sessions a day touch outreach and nobody answers for it."),
    staff("quality-scope", 2, { kind: "scope", handle: "agent-quality", add: ["Callers & Call Management"] }, "The quality role already grades every call."),
  ],
};

export const COMPANY_FIXTURE_PROPOSALS: OrgProposalRow[] = [COMPANY_GOALS_PROPOSAL, COMPANY_STAFF_PROPOSAL];
export const COMPANY_FIXTURE_CHANGES: OrgProposalChange[] = [...UNION_GOALS_CHANGES, ...COMPANY_STAFF_PROPOSAL.changes];
