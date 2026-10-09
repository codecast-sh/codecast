// A synthetic company in the shape of a real one (essence spec WP2): four
// people, eleven roles (one under another), a mission with two adopted goals
// and seven drafts, two projects nobody leads, latest lines of real length
// with ids in them. Every name and sentence is invented. The model tests, the
// mount test and a dev preview all draw this one world.
import type { InitiativeRow, InitiativeUpdateRow } from "@codecast/shared/contracts/initiative";
import type { BoardTask } from "../../../lib/initiatives";
import type { LineProjectRow } from "../lines/lineData";
import { EMPTY_COUNTS, type OrgPerson, type OrgRole, type OrgSession, type OrgTree } from "../orgTypes";
import type { CanvasPlanRow } from "./canvasModel";

const T0 = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const H = 3_600_000;
const TEAM = "fixture-canvas-team";
export const CANVAS_FIXTURE_WORKSPACE = `team:${TEAM}`;

export const CANVAS_ME = "fixture-canvas-maya";
const TOMAS = "fixture-canvas-tomas";
const INES = "fixture-canvas-ines";
const DEV = "fixture-canvas-dev";

const person = (user_id: string, name: string, presence: OrgPerson["presence"], is_me = false): OrgPerson => ({
  user_id, name, role: is_me ? "owner" : "member", is_me, presence, counts: { ...EMPTY_COUNTS }, sessions: [], total: 0,
});

let sessionN = 0;
const session = (role: string, title: string, state: OrgSession["state"]): OrgSession => ({
  _id: `fixture-canvas-session-${++sessionN}`, short_id: `jx7cv${sessionN}`, title, agent_type: "claude", state,
  updated_at: T0 - sessionN * 600_000, org_role_id: role, subagent_count: 0, is_anchor: false,
});

type RoleSeed = {
  id: string; n: number; name: string; handle: string; given: string;
  to: { user: string } | { role: string };
  projects?: string[]; plans?: string[];
  charter?: string;
  line?: string; state?: OrgSession["state"]; status?: string; age?: number;
  sessions?: [string, OrgSession["state"]][];
  started?: boolean;
};

const role = (s: RoleSeed): OrgRole => {
  const sessions = (s.sessions ?? []).map(([title, state]) => session(s.id, title, state));
  return {
    _id: s.id, short_id: `or-${s.n}`, scope_type: "team", team_id: TEAM, host_user_id: CANVAS_ME,
    name: s.name, handle: s.handle, given_name: s.given,
    scope: { project_ids: s.projects ?? [], plan_ids: s.plans ?? [] },
    reports_to: "user" in s.to ? { kind: "user", user_id: s.to.user } : { kind: "role", role_id: s.to.role },
    status: "active",
    ...(s.charter ? { charter: s.charter } : {}),
    created_by: CANVAS_ME, created_at: T0 - 40 * 24 * H, updated_at: T0 - H,
    counts: { ...EMPTY_COUNTS }, sessions, total: sessions.length,
    standing: s.started === false ? null : {
      conversation_id: `${s.id}-standing`, short_id: `jx7st${s.n}`,
      state: s.state ?? "dormant", state_line: s.line ?? null, state_status: s.status ?? s.state ?? "dormant", state_at: T0 - (s.age ?? 1) * H,
    },
    scope_names: { projects: [], plans: [] },
  };
};

// Projects (pj-) and plans (pl-).
const P = {
  network: "fixture-canvas-pj-network",
  partners: "fixture-canvas-pj-partners",
  deals: "fixture-canvas-pj-deals",
  infra: "fixture-canvas-pj-infra",
  callers: "fixture-canvas-pj-callers",
  inesIdeas: "fixture-canvas-pj-ideas",
  escalations: "fixture-canvas-pj-escalations",
  quality: "fixture-canvas-pj-quality",
  matching: "fixture-canvas-pj-matching",
  launch: "fixture-canvas-pj-launch",
} as const;
const PL = { watch: "fixture-canvas-pl-watch", deliver: "fixture-canvas-pl-deliver" } as const;

export const CANVAS_ROLE = {
  people: "fixture-canvas-or-people",
  growth: "fixture-canvas-or-growth",
  cold: "fixture-canvas-or-cold",
  partners: "fixture-canvas-or-partners",
  release: "fixture-canvas-or-release",
  deals: "fixture-canvas-or-deals",
  network: "fixture-canvas-or-network",
  infra: "fixture-canvas-or-infra",
  calling: "fixture-canvas-or-calling",
  escalations: "fixture-canvas-or-escalations",
  quality: "fixture-canvas-or-quality",
} as const;
const R = CANVAS_ROLE;

const ROLES: OrgRole[] = [
  role({ id: R.people, n: 1, name: "Head of People", handle: "head-of-people", given: "Tarn", to: { user: CANVAS_ME }, age: 2,
    charter: "Keeps the structure of the whole company honest. Reviews every role weekly.",
    line: "Posted this week's review op-71. Three changes to records and structure wait on Maya; the Escalations lead's change is with Ines." }),
  role({ id: R.growth, n: 2, name: "Market Growth lead", handle: "growth", given: "Dune", to: { user: CANVAS_ME }, plans: [PL.watch], age: 4,
    line: "Intros are at 3.4 a day (11 on Tuesday). Tuesday's first-touch dip was the mail provider's outage, now closed with the Cold Email lead. Buyer lists re-aimed on first purchases." }),
  role({ id: R.cold, n: 3, name: "Cold Email lead", handle: "cold-email", given: "Sorrel", to: { user: CANVAS_ME }, plans: [PL.deliver], age: 10,
    line: "Fixed the provider outage ct-9101 and released 120 burned contacts. Cold sending resumes around 8am ct-9102. A dead-login inbox in the pool ct-9103 waits on Tomas." }),
  role({ id: R.partners, n: 4, name: "Partner Outreach lead", handle: "partner-outreach", given: "Sprout", to: { user: CANVAS_ME }, projects: [P.partners], age: 48,
    line: "Three warm repliers went unanswered after the attachment fix; fixed ct-9110. One still waits for the catch-up ct-9111." }),
  role({ id: R.release, n: 5, name: "Release Captain", handle: "release", given: "Juno", to: { user: CANVAS_ME }, age: 6,
    charter: "Approved pull requests from every area. Merges them in rounds and keeps main shippable.",
    line: "Round four of the merge train shipped. 12 PRs are open and main is one commit ahead of production. Round five starts on Maya's word." }),
  role({ id: R.deals, n: 6, name: "Deals lead", handle: "deals", given: "Ziggy", to: { user: TOMAS }, projects: [P.deals], age: 1,
    line: "The matcher is mostly down: the model provider ran out of credit at 00:57 UTC and 610 of 640 runs in the last two hours failed. Tomas has it." }),
  role({ id: R.network, n: 7, name: "Private Network lead", handle: "private-network", given: "Spiral", to: { user: TOMAS }, projects: [P.network], age: 9, state: "working",
    line: "Getting the bot and the matching agent ready so friendly funds can join. Funds stay on hold until two defects are fixed: ct-9120 and ct-9121.",
    sessions: [["Accreditation gate defect", "working"], ["Fund price leak fix", "working"], ["Old research notes", "done"]] }),
  role({ id: R.infra, n: 8, name: "Mail Infra lead", handle: "mail-infra", given: "Chestnut", to: { user: TOMAS }, projects: [P.infra], age: 3, status: "blocked",
    line: "Raised bounce-gate floors are live; 1,200 inboxes carry cold since Tuesday. Three PRs await merge, waiting on Tomas for the last one.",
    sessions: [["Bounce-gate floors rollout", "working"], ["Dead-login inbox in the pool", "needs_input"]] }),
  role({ id: R.calling, n: 9, name: "Calling lead", handle: "calling", given: "Chirp", to: { user: INES }, projects: [P.callers, P.inesIdeas], age: 1,
    line: "Nothing waits on Ines. Must-reach misses are about 15%, mostly the uncovered overnight hours." }),
  role({ id: R.escalations, n: 10, name: "Escalations lead", handle: "escalations", given: "Tux", to: { role: R.calling }, projects: [P.escalations], age: 1,
    line: "Ines granted the close authority; it waits on Maya's safety review. My re-check puts the closeable class at 29, not 79.",
    sessions: [["Escalation close sweep", "working"]] }),
  role({ id: R.quality, n: 11, name: "Agent Quality lead", handle: "agent-quality", given: "Honey", to: { user: DEV }, projects: [P.quality], age: 5,
    line: "All four approved fixes are on main. None is deployed yet; that waits on Dev." }),
];

export const CANVAS_FIXTURE_TREE: OrgTree = {
  workspace: { kind: "team", id: TEAM, name: "Lantern" },
  people: [person(DEV, "Dev Arora", "away"), person(INES, "Ines Park", "online"), person(TOMAS, "Tomas Reyes", "online"), person(CANVAS_ME, "Maya Okafor", "online", true)],
  roles: ROLES,
  anchors: [],
  generated_at: T0,
};

const project = (_id: string, n: number, title: string, status = "active"): LineProjectRow & { workspace: string; updated_at: number } => ({
  _id, short_id: `pj-${n}`, title, status, workspace: CANVAS_FIXTURE_WORKSPACE, updated_at: T0,
});
export const CANVAS_FIXTURE_PROJECTS = [
  project(P.network, 1, "Private Network"),
  project(P.partners, 2, "Partner Outreach"),
  project(P.deals, 3, "People & Deals"),
  project(P.infra, 4, "Infrastructure"),
  project(P.callers, 5, "Callers & Call Management"),
  project(P.inesIdeas, 6, "Ines's ideas"),
  project(P.escalations, 7, "Escalations"),
  project(P.quality, 8, "Agent Quality"),
  project(P.matching, 9, "Matching Engine & Funnel"),
  project(P.launch, 10, "Public Launch & Fundraise", "planning"),
  project("fixture-canvas-pj-old", 11, "Last year's pilot", "done"),
];

export const CANVAS_FIXTURE_PLANS: (CanvasPlanRow & { workspace: string; updated_at: number; created_at: number; source: string })[] = [
  { _id: PL.watch, short_id: "pl-1", title: "MarketWatch", status: "active", workspace: CANVAS_FIXTURE_WORKSPACE, updated_at: T0, created_at: T0, source: "fixture" },
  { _id: PL.deliver, short_id: "pl-2", title: "Cold email deliverability", status: "active", workspace: CANVAS_FIXTURE_WORKSPACE, updated_at: T0, created_at: T0, source: "fixture" },
];

/** Done, in progress and open tasks for each project. */
const COUNTS: Record<string, [number, number, number]> = {
  [P.network]: [70, 4, 71], [P.partners]: [5, 1, 11], [P.deals]: [7, 0, 26], [P.infra]: [74, 6, 152],
  [P.callers]: [136, 2, 87], [P.inesIdeas]: [107, 1, 30], [P.escalations]: [1, 0, 1], [P.quality]: [270, 7, 622],
  [P.matching]: [125, 8, 254], [P.launch]: [24, 0, 8],
};
let taskN = 0;
export const CANVAS_FIXTURE_TASKS: (BoardTask & { _id: string; workspace: string; updated_at: number })[] = Object.entries(COUNTS).flatMap(([pid, [done, doing, open]]) =>
  [...Array(done).fill("done"), ...Array(doing).fill("in_progress"), ...Array(open).fill("open")].map((status) => ({
    _id: `fixture-canvas-task-${++taskN}`, status, project_id: pid, source: "human", workspace: CANVAS_FIXTURE_WORKSPACE, updated_at: T0,
  })),
);

const goal = (n: number, title: string, fields: Partial<InitiativeRow>): InitiativeRow => ({
  _id: `fixture-canvas-in-${n}`, short_id: `in-${n}`, title, status: "active", project_ids: [], health: "none",
  workspace: CANVAS_FIXTURE_WORKSPACE, team_id: TEAM, user_id: CANVAS_ME, created_at: T0 - (100 - n) * H, updated_at: T0, ...fields,
});
const MISSION = "fixture-canvas-in-1";
export const CANVAS_FIXTURE_GOALS: InitiativeRow[] = [
  goal(1, "Broker introductions that turn into real transactions", { owner: { kind: "user", user_id: CANVAS_ME }, priority: "p0" }),
  goal(3, "Lower the cost of each match", { parent_initiative_id: MISSION, owner: { kind: "user", user_id: CANVAS_ME }, priority: "p1", project_ids: [P.matching] }),
  goal(2, "Win the private network", {
    parent_initiative_id: MISSION, owner: { kind: "user", user_id: CANVAS_ME }, priority: "p0", project_ids: [P.network, P.partners],
    health: "at_risk", health_at: T0 - 20 * H, latest_update_id: "fixture-canvas-update-1",
  }),
  ...["Hire a second closer", "Open the Asia desk", "Publish pricing", "Ship the mobile app", "Weekly investor note", "Referral program", "Cut support time in half"].map((title, i) =>
    goal(10 + i, title, { status: "proposed", parent_initiative_id: MISSION })),
  goal(30, "Old launch goal", { status: "completed" }),
];

export const CANVAS_FIXTURE_UPDATES: (InitiativeUpdateRow & { updated_at: number })[] = [
  {
    _id: "fixture-canvas-update-1", initiative_id: "fixture-canvas-in-2",
    body: "The readiness re-check on Tuesday found two real defects before any fund joins. No names leaked. Funds stay on hold until both are fixed.",
    health: "at_risk", by: { kind: "user", user_id: CANVAS_ME }, at: T0 - 20 * H, workspace: CANVAS_FIXTURE_WORKSPACE, user_id: CANVAS_ME, updated_at: T0,
  },
];

/** The two roles with a row in Maya's Waits on you list. */
export const CANVAS_FIXTURE_WAITING: ReadonlySet<string> = new Set([R.people, R.escalations]);
