// The /priorities list's test fixtures, shared by components/priorities/PrioritiesPage.mount.test.tsx and
// PrioritiesLines.mount.test.tsx: rows shaped like priorities.list's contract, its history, and the views
// and helpers over them. A test file installs the DOM and the backend (missingBackend.tsx) first, then
// imports this with `await import`, so the app modules below load against them.
import React from "react";
import { MemoryRouter } from "react-router";
import { useInboxStore } from "../store/inboxStore";
import { PrioritiesView } from "../components/priorities/PrioritiesPage";
import { lastDays } from "../lib/priorityList";
import { fixtureId, mountSurface, TEAM_ID, VIEWER_ID } from "./missingBackend";


export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const NOW = Date.now();
export const days = lastDays(10, NOW);

export const step = (key: string, title: string, tier: "critical" | "polish", done = false, extra: Record<string, unknown> = {}) => ({ key, title, tier, tier_set_by: "pass", refs: [], done, ...extra });
export const sess = (tag: string, title: string, state: string, ageHours: number, extra: Record<string, unknown> = {}) => ({
  short_id: `jx7${tag}`.slice(0, 7), conversation_id: fixtureId(tag), title, state, mine: true, workflow: false, why: ["mapped"], last_active_at: NOW - ageHours * HOUR, ...extra,
});
export const links = (key: string, sessions: unknown[], extra: Record<string, unknown> = {}) => ({ key, sessions, sessions_more: 0, plan: null, part_of: [], looks_done: false, correction_pending: false, ...extra });
export const PL_1075 = { short_id: "pl-1075", title: "Every change merges green through one flow", done: 24, total: 37, size: 37 };
export const PL_619 = { short_id: "pl-619", title: "The whole platform program", done: 80, total: 140, size: 140 };
export const base = { summary: "", person_pos: null, rank_source: "ai", serves: null, workspace: `team:${TEAM_ID}`, user_id: VIEWER_ID, owner: "Dana Viewer", owner_image: null, mine: true, first_seen_at: NOW - 3 * DAY, last_active_at: NOW, done_at: null, session_count: 0, session_count_more: false, sessions: [] as any[], status: "active", status_set_by: "pass", correction_pending: false };
export const counts = (steps: any[]) => ({ critical_done: steps.filter((s) => s.tier === "critical" && s.done).length, critical_total: steps.filter((s) => s.tier === "critical").length });
export const row = (id: number, title: string, rank: number | null, steps: any[], extra: Record<string, unknown> = {}) => ({ ...base, _id: `p${id}`, short_id: `pri-${id}`, title, rank, ai_rank: rank, steps, counts: counts(steps), ...extra });

/**
 * Puts the conversations `tags` name in the store as the sidebar files them
 * under Needs You (blocked on the viewer, theirs): only such a row makes a
 * milestone read Needs you. A linked session the store does not hold sleeps,
 * whatever the server says. Returns the cleanup.
 */
export function seedNeedsYou(...tags: string[]): () => void {
  const asking = { message_count: 4, status: "completed", updated_at: NOW - 10 * 60_000, last_turn_at: NOW - 11 * 60_000, user_id: VIEWER_ID, thread_state_status: "blocked", thread_state_at: NOW - 10 * 60_000 };
  useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, ...Object.fromEntries(tags.map((t) => [fixtureId(t), { _id: fixtureId(t), title: t, ...asking }])) } }));
  return () => useInboxStore.setState((s: any) => {
    const rest = { ...s.sessions };
    for (const t of tags) delete rest[fixtureId(t)];
    return { sessions: rest };
  });
}

export const DRIVER = sess("drive1", "Deploy redesign", "dormant", 1);
export const ROWS = [
  row(1, "Cam's eval requests flow", 1, [step("s1", "Work the open eval requests", "critical"), step("s2", "Change request flow design", "critical"), step("p1", "Old polish", "polish", true, { done_at: NOW - DAY })], {
    links: [links("s1", [sess("evalrq", "Eval Requests", "dormant", 5)], { sessions_more: 3 }), links("s2", [sess("crflow", "Change requests flow design", "needs_you", 1)]), links("p1", [])],
    plan: null,
  }),
  row(2, "One simple ship flow", 2, [step("s1", "Auto-deploy from main", "critical"), step("s2", "Red main reaches the Release Captain", "critical"), step("s3", "Direct pushes move onto change flow", "critical"), step("s4", "Web app deploys with the backend", "critical")], {
    plan: PL_1075,
    links: [
      links("s1", [DRIVER]),
      links("s2", [DRIVER, sess("review1", "Review · ct-9001 red main", "killed", 21, { workflow: true }), sess("review2", "Review · ct-9002 red main", "idle", 30, { workflow: true })]),
      links("s3", []),
      links("s4", [DRIVER, sess("review3", "Review · ct-9003 web deploys", "idle", 2, { workflow: true })]),
    ],
  }),
  row(3, "Cut eval spend", 3, [step("s1", "Deploy drops the eval job", "critical"), step("s2", "Grader budget", "polish")], {
    plan: null,
    links: [links("s1", [sess("evalcost", "Eval cost reduction", "working", 0)], { plan: PL_1075 }), links("s2", [], { part_of: [PL_619] })],
  }),
  // The server says these two ask; only the ones a test seeds into the sidebar's Needs You (seedNeedsYou) read Needs you.
  row(4, "Priorities for Union", 4, [step("s1", "Calibrate goal finding", "critical"), step("s2", "Session mapping reaches 0.75", "critical")], {
    plan: null,
    links: [links("s1", [sess("calib1", "Priorities feature build", "needs_you", 3)]), links("s2", [sess("mapping", "Session mapping", "needs_you", 7)])],
  }),
  // A row from a server that predates the links: no links, no plan.
  row(5, "Trustworthy eval suite", 5, [step("s1", "Get grader faults under 10%", "critical"), step("s2", "Re-measure grader faults", "critical", true, { done_at: NOW - 2 * DAY })], { first_seen_at: NOW - 20 * DAY }),
  row(6, "An old finished thing", null, [step("s1", "Done long ago", "critical", true)], { status: "done", done_at: NOW - 3 * DAY }),
];
export const at = (n: number) => days.map((_, i) => (i === days.length - 1 ? n : 0));
export const HISTORY = {
  days,
  lanes: [
    { key: "pri-1", short_id: "pri-1", title: "Cam's eval requests flow", status: "active", counts: at(4), total: 4 },
    { key: "pri-2", short_id: "pri-2", title: "One simple ship flow", status: "active", counts: at(1), total: 1 },
    { key: "pri-4", short_id: "pri-4", title: "Priorities for Union", status: "active", counts: at(1), total: 1 },
    { key: "unassigned", short_id: null, title: "Unassigned", status: null, counts: at(4), total: 4 },
  ],
  sessions: { jx7crflo: at(4) },
  unassigned_today: [
    { short_id: "jx7jamie", conversation_id: fixtureId("jamie"), title: "Jamie's workflow review", last_active_at: NOW - 60_000, count: 3 },
    { short_id: "jx7ship", conversation_id: fixtureId("shiprules"), title: "Shipping rules design", last_active_at: NOW - 2 * 60_000, count: 1 },
  ],
};

export const listOf = (priorities: unknown[], timing: { next_pass_at?: number | null; behind_by_ms?: number | null } = {}) =>
  ({ priorities, own_truncated: false, teammates_truncated: false, next_pass_at: null, behind_by_ms: null, ...timing });
export const mount = (node: React.ReactNode, path = "/priorities") => mountSurface(<MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>);
export const order = (el: HTMLElement) => [...el.querySelectorAll("li[data-priority]")].map((n) => n.getAttribute("data-priority"));
export const view = (over: Record<string, unknown> = {}) => <PrioritiesView rows={ROWS as any} history={HISTORY as any} now={NOW} layout="wide" {...over} />;
export const block = (el: HTMLElement, id: string) => el.querySelector(`li[data-priority="${id}"]`) as HTMLElement;
/** Each milestone line's state, by key. */
export const states = (b: HTMLElement) => Object.fromEntries([...b.querySelectorAll("li[data-milestone]")].map((li) => [li.getAttribute("data-milestone"), li.getAttribute("data-state")]));


export const KINDS = row(9, "Every kind of link", 1, [
  step("s1", "Wire every link", "critical", false, { refs: [{ kind: "task", id: "ct-8001" }, { kind: "pr", id: "codecast-sh/codecast#4580" }] }),
  step("s2", "Second milestone", "critical"),
], {
  links: [links("s1", [sess("kinds1", "Kinds driver", "dormant", 2), sess("kinds2", "Kinds helper", "dormant", 3)], { plan: PL_1075 }), links("s2", [sess("kinds3", "Second milestone work", "working", 0)])],
});
export function seedKinds() {
  useInboxStore.setState({ tasks: { tk8001: { _id: "tk8001", short_id: "ct-8001", title: "Write the wiring", status: "open" } } } as any);
  useInboxStore.getState().syncTable("sessions", [{ _id: fixtureId("kinds2"), title: "Kinds helper", worktree_branch: "feat/every-link", updated_at: NOW - 3 * HOUR }] as any, { isDelta: true });
  useInboxStore.getState().syncTable("teamDeploys", [{ _id: "dep8001", workspace: `team:${TEAM_ID}`, target: "web", status: "live", live_at: NOW - HOUR, created_at: NOW - 2 * HOUR, sessions: [], tasks: [{ short_id: "ct-8001" }] }] as any, { isDelta: true });
}
