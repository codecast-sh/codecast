// An invented company (essence spec WP2): Spokeworks, a bike repair co-op
// with four people, eleven roles (one under another), a mission with two
// adopted goals and seven drafts, two projects nobody leads, and latest lines
// of real length with ids in them. Every name, number and sentence is made
// up. The model tests, the mount test and a dev preview all draw this world.
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
  workshop: "fixture-canvas-pj-workshop",
  partners: "fixture-canvas-pj-partners",
  parts: "fixture-canvas-pj-parts",
  booking: "fixture-canvas-pj-booking",
  repairs: "fixture-canvas-pj-repairs",
  wheels: "fixture-canvas-pj-wheels",
  warranty: "fixture-canvas-pj-warranty",
  training: "fixture-canvas-pj-training",
  tuneups: "fixture-canvas-pj-tuneups",
  market: "fixture-canvas-pj-market",
} as const;
const PL = { signups: "fixture-canvas-pl-signups", newsletter: "fixture-canvas-pl-newsletter" } as const;

export const CANVAS_ROLE = {
  people: "fixture-canvas-or-people",
  membership: "fixture-canvas-or-membership",
  newsletter: "fixture-canvas-or-newsletter",
  partners: "fixture-canvas-or-partners",
  scheduling: "fixture-canvas-or-scheduling",
  parts: "fixture-canvas-or-parts",
  workshops: "fixture-canvas-or-workshops",
  booking: "fixture-canvas-or-booking",
  repairs: "fixture-canvas-or-repairs",
  warranty: "fixture-canvas-or-warranty",
  training: "fixture-canvas-or-training",
} as const;
const R = CANVAS_ROLE;

const ROLES: OrgRole[] = [
  role({ id: R.people, n: 1, name: "Head of People", handle: "head-of-people", given: "Fennel", to: { user: CANVAS_ME }, age: 2,
    charter: "Keeps the co-op's roles clear and fair. Reviews every role once a week.",
    line: "Posted this week's review op-71. Three changes to roles wait on Maya; the Warranty lead's change is with Ines." }),
  role({ id: R.membership, n: 2, name: "Membership lead", handle: "membership", given: "Pip", to: { user: CANVAS_ME }, plans: [PL.signups], age: 4,
    line: "Sign-ups are at 4.1 a week (9 last Saturday). Saturday's dip was the payment page outage, now closed with the Newsletter lead. Flyers moved to the university." }),
  role({ id: R.newsletter, n: 3, name: "Newsletter lead", handle: "newsletter", given: "Wren", to: { user: CANVAS_ME }, plans: [PL.newsletter], age: 10,
    line: "Fixed the mail provider outage ct-9101 and restored 85 bounced addresses. The next issue goes out around 9am ct-9102. A broken unsubscribe link ct-9103 waits on Tomas." }),
  role({ id: R.partners, n: 4, name: "Shop Partners lead", handle: "shop-partners", given: "Bramble", to: { user: CANVAS_ME }, projects: [P.partners], age: 48,
    line: "Two cafes asked to host a drop-off rack and heard nothing for a week; fixed ct-9110. One still waits for a reply ct-9111." }),
  role({ id: R.scheduling, n: 5, name: "Scheduling lead", handle: "scheduling", given: "Quill", to: { user: CANVAS_ME }, age: 6,
    charter: "Books every repair slot across the workshops. Keeps the waitlist short.",
    line: "Saturday slots are full through November. 14 bikes are on the waitlist and the oldest has waited six days. Opening Sunday hours waits on Maya's word." }),
  role({ id: R.parts, n: 6, name: "Parts lead", handle: "parts", given: "Moss", to: { user: TOMAS }, projects: [P.parts], age: 1,
    line: "Brake pads are short: the main supplier missed two deliveries this month and 18 of 40 orders are late. Tomas has it." }),
  role({ id: R.workshops, n: 7, name: "Workshop lead", handle: "workshops", given: "Juniper", to: { user: TOMAS }, projects: [P.workshop], age: 9, state: "working",
    line: "Getting the second workshop ready to open in spring. Signing stays on hold until two wiring problems are fixed: ct-9120 and ct-9121.",
    sessions: [["Wiring quote comparison", "working"], ["Lease checklist review", "working"], ["Old floor plans", "done"]] }),
  role({ id: R.booking, n: 8, name: "Booking System lead", handle: "booking", given: "Cog", to: { user: TOMAS }, projects: [P.booking], age: 3, status: "blocked",
    line: "Reminder texts are live; no-shows fell from 11 to 4 a week. Three PRs await merge, waiting on Tomas for the last one.",
    sessions: [["Reminder texts rollout", "working"], ["Double-booked slots", "needs_input"]] }),
  role({ id: R.repairs, n: 9, name: "Repairs lead", handle: "repairs", given: "Rivet", to: { user: INES }, projects: [P.repairs, P.wheels], age: 1,
    line: "Nothing waits on Ines. About one bike in eight misses its promised day, mostly wheel rebuilds." }),
  role({ id: R.warranty, n: 10, name: "Warranty lead", handle: "warranty", given: "Thimble", to: { role: R.repairs }, projects: [P.warranty], age: 1,
    line: "Ines approved refunds up to 60 dollars; it waits on Maya's sign-off. My recount puts the open claims at 12, not 21.",
    sessions: [["Warranty claim sweep", "working"]] }),
  role({ id: R.training, n: 11, name: "Training lead", handle: "training", given: "Hazel", to: { user: DEV }, projects: [P.training], age: 5,
    line: "All four new safety checklists are written. None is in use yet; that waits on Dev." }),
];

export const CANVAS_FIXTURE_TREE: OrgTree = {
  workspace: { kind: "team", id: TEAM, name: "Spokeworks" },
  people: [person(DEV, "Dev Arora", "away"), person(INES, "Ines Park", "online"), person(TOMAS, "Tomas Reyes", "online"), person(CANVAS_ME, "Maya Okafor", "online", true)],
  roles: ROLES,
  anchors: [],
  generated_at: T0,
};

const project = (_id: string, n: number, title: string, status = "active"): LineProjectRow & { workspace: string; updated_at: number } => ({
  _id, short_id: `pj-${n}`, title, status, workspace: CANVAS_FIXTURE_WORKSPACE, updated_at: T0,
});
export const CANVAS_FIXTURE_PROJECTS = [
  project(P.workshop, 1, "Second Workshop"),
  project(P.partners, 2, "Shop Partners"),
  project(P.parts, 3, "Parts & Suppliers"),
  project(P.booking, 4, "Booking System"),
  project(P.repairs, 5, "Repair Queue"),
  project(P.wheels, 6, "Wheel Building"),
  project(P.warranty, 7, "Warranty Claims"),
  project(P.training, 8, "Mechanic Training"),
  project(P.tuneups, 9, "Cheaper Tune-ups"),
  project(P.market, 10, "Winter Pop-up Market", "planning"),
  project("fixture-canvas-pj-old", 11, "Last year's bike drive", "done"),
];

export const CANVAS_FIXTURE_PLANS: (CanvasPlanRow & { workspace: string; updated_at: number; created_at: number; source: string })[] = [
  { _id: PL.signups, short_id: "pl-1", title: "Spring sign-ups", status: "active", workspace: CANVAS_FIXTURE_WORKSPACE, updated_at: T0, created_at: T0, source: "fixture" },
  { _id: PL.newsletter, short_id: "pl-2", title: "Newsletter deliverability", status: "active", workspace: CANVAS_FIXTURE_WORKSPACE, updated_at: T0, created_at: T0, source: "fixture" },
];

/** Done, in progress and open tasks for each project. */
const COUNTS: Record<string, [number, number, number]> = {
  [P.workshop]: [38, 3, 49], [P.partners]: [6, 2, 9], [P.parts]: [12, 0, 18], [P.booking]: [41, 5, 97],
  [P.repairs]: [88, 3, 64], [P.wheels]: [52, 1, 19], [P.warranty]: [2, 0, 3], [P.training]: [140, 6, 310],
  [P.tuneups]: [61, 4, 133], [P.market]: [9, 0, 14],
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
  goal(1, "Keep every bike in the valley on the road", { owner: { kind: "user", user_id: CANVAS_ME }, priority: "p0" }),
  goal(3, "Lower the cost of a tune-up", { parent_initiative_id: MISSION, owner: { kind: "user", user_id: CANVAS_ME }, priority: "p1", project_ids: [P.tuneups] }),
  goal(2, "Open the second workshop", {
    parent_initiative_id: MISSION, owner: { kind: "user", user_id: CANVAS_ME }, priority: "p0", project_ids: [P.workshop, P.partners],
    health: "at_risk", health_at: T0 - 20 * H, latest_update_id: "fixture-canvas-update-1",
  }),
  ...["Hire a second mechanic", "Add e-bike repairs", "Publish member prices", "Sell parts online", "Monthly member newsletter", "Bring-a-friend discount", "Halve the repair wait"].map((title, i) =>
    goal(10 + i, title, { status: "proposed", parent_initiative_id: MISSION })),
  goal(30, "Old spring goal", { status: "completed" }),
];

export const CANVAS_FIXTURE_UPDATES: (InitiativeUpdateRow & { updated_at: number })[] = [
  {
    _id: "fixture-canvas-update-1", initiative_id: "fixture-canvas-in-2",
    body: "The landlord's walkthrough on Tuesday found two wiring problems before we can sign. Nothing is lost yet. Signing waits until both are fixed.",
    health: "at_risk", by: { kind: "user", user_id: CANVAS_ME }, at: T0 - 20 * H, workspace: CANVAS_FIXTURE_WORKSPACE, user_id: CANVAS_ME, updated_at: T0,
  },
];

/** The two roles with a row in Maya's Waits on you list. */
export const CANVAS_FIXTURE_WAITING: ReadonlySet<string> = new Set([R.people, R.warranty]);
