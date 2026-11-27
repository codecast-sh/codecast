// A milestone's session marks are the marks its inbox draws (store/inboxMark
// inboxMarkOf; lib/priorityList buildModels states the rule). Each case fixes
// the store, then asserts both the inbox's mark for the session and the state
// the milestone it is linked to reads: Needs You, the old-session fold, a
// pinned wait, a hosted stop on the sidebar and the phone, Team scope, a
// dismissed session behind its header, the
// focused session held in place, a session the store does not hold, and a
// workflow run asking through its parent's question.
// Run: cd packages/web && bun test --isolate hooks/__tests__/priorityLiveStates.test.ts
import { afterEach, expect, test } from "bun:test";
import { fixtureId, installDom, installMissingBackend, seedViewer, TEAM_ID, VIEWER_ID } from "../../test-helpers/missingBackend";

installDom("https://app.test/priorities");
await installMissingBackend({ answers: {} });
await seedViewer();

const { useInboxStore } = await import("../../store/inboxStore");
const { inboxMarkOf } = await import("../../store/inboxMark");
const { liveStateOf } = await import("../usePriorityModels");
const { buildModels, lastDays } = await import("../../lib/priorityList");
const { NOW, links, row, sess, step } = await import("../../test-helpers/prioritiesList");

const ID = fixtureId("linked1");
const MIN = 60_000;
/** Blocked on the viewer, theirs: the sidebar files it under Needs You. */
const asking = (at = NOW - 10 * MIN) => ({ message_count: 4, status: "completed", updated_at: at, last_turn_at: at - MIN, user_id: VIEWER_ID, thread_state_status: "blocked", thread_state_at: at });
const put = (rows: Record<string, Record<string, unknown>>) =>
  useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, ...Object.fromEntries(Object.entries(rows).map(([id, r]) => [id, { _id: id, title: id, ...r }])) } }));
const ui = (patch: Record<string, unknown>) => useInboxStore.setState((s: any) => ({ clientState: { ...s.clientState, ui: { ...s.clientState.ui, ...patch } } }));
const initial = { sessions: useInboxStore.getState().sessions, sessionDecisions: (useInboxStore.getState() as any).sessionDecisions, ui: useInboxStore.getState().clientState.ui };
afterEach(() => useInboxStore.setState((s: any) => ({
  sessions: initial.sessions, sessionDecisions: initial.sessionDecisions, currentSessionId: null,
  teamInboxIds: new Set(), teamInboxIdSnapshot: null, clientState: { ...s.clientState, ui: initial.ui },
} as any)));

const st = () => useInboxStore.getState() as any;
const mark = (id = ID, inbox: "sidebar" | "phone" = "sidebar") => inboxMarkOf(st(), id, { inbox, now: NOW });
/** The state of a milestone whose one link is `id` (the server saying `server`, the link `mine` or not), as `inbox` draws it. */
const milestone = (id = ID, { inbox = "sidebar", server = "needs_you", mine = true }: { inbox?: "sidebar" | "phone"; server?: string; mine?: boolean } = {}) => {
  const r = row(70, "Linked", 1, [step("s1", "The milestone", "critical")], { links: [links("s1", [{ ...sess("linked1", "Linked", server, 1, { mine }), conversation_id: id }])] });
  return buildModels([r as any], undefined, (cid) => liveStateOf(st(), cid, NOW, inbox), lastDays(10, NOW))[0].milestones[0].state.kind;
};

test("asking in Needs You: Needs you", () => {
  put({ [ID]: asking() });
  expect(mark()).toBe("needs_you");
  expect(milestone()).toBe("needs_you");
});

test("asking but folded below the old-session fold: not drawn, so it sleeps; shown again with old sessions on: Needs you", () => {
  const old = NOW - 3 * 86_400_000;
  put({ [ID]: asking(old), [fixtureId("fresh1")]: { ...asking(NOW - MIN), thread_state_status: "dormant" } });
  ui({ inbox_show_old: false });
  expect(mark()).toBeNull();
  expect(milestone()).toBe("dormant");
  ui({ inbox_show_old: true });
  expect(mark()).toBe("needs_you");
  expect(milestone()).toBe("needs_you");
});

test("pinned and waiting on you: the pinned card draws Needs you, and so does the milestone", () => {
  put({ [ID]: { ...asking(), inbox_pinned_at: NOW - 60 * MIN } });
  expect(mark()).toBe("needs_you");
  expect(milestone()).toBe("needs_you");
});

test("a hosted conversation that ended on a stop: the sidebar draws its error under Couldn't finish (idle here); the phone keeps it under Needs You", () => {
  put({ [ID]: { ...asking(), agent_type: "codecast", hosted_stop: "error" } });
  expect(mark(ID, "sidebar")).toBe("error");
  expect(milestone(ID, { inbox: "sidebar" })).toBe("idle");
  expect(mark(ID, "phone")).toBe("needs_you");
  expect(milestone(ID, { inbox: "phone" })).toBe("needs_you");
});

test("Team scope, the session not in the team inbox: not drawn, not Needs you", () => {
  put({ [ID]: asking() });
  ui({ inbox_scope: "team" });
  useInboxStore.setState({ teamInboxIds: new Set([fixtureId("someoneelse")]), teamInboxIdSnapshot: { team_id: TEAM_ID } } as any);
  expect(mark()).toBeNull();
  expect(milestone()).toBe("dormant");
});

test("the focused session is held in place: its card keeps drawing Needs you while it is open", () => {
  put({ [ID]: asking() });
  useInboxStore.setState({ currentSessionId: ID } as any);
  expect(mark()).toBe("needs_you");
  expect(milestone()).toBe("needs_you");
});

test("dismissed: drawn behind the Dismissed header as closed, so the milestone has nobody on it", () => {
  put({ [ID]: { ...asking(), inbox_dismissed_at: NOW - MIN } });
  expect(mark()).toBe("killed");
  expect(milestone()).toBe("start");
});

test("not in the store: no mark; the server's needs_you falls back to sleeping if yours, idle if someone else's", () => {
  const absent = fixtureId("absent1");
  expect(mark(absent)).toBeNull();
  expect(milestone(absent)).toBe("dormant");
  expect(milestone(absent, { mine: false })).toBe("idle");
});

test("a workflow run asking through its parent's question: Needs you", () => {
  const parent = fixtureId("wfparent");
  put({
    [parent]: { ...asking(), thread_state_status: "working" },
    [ID]: { ...asking(), parent_conversation_id: parent, is_subagent: true, is_workflow_sub: true, workflow_run_id: "run1" },
  });
  useInboxStore.setState({ sessionDecisions: { d1: { _id: "d1", conversation_id: ID, status: "pending", blocking: true, in_queue: true, created_at: NOW - MIN, updated_at: NOW - MIN, question: "Ship it?", options: [] } } } as any);
  expect(mark()).toBe("needs_you");
  expect(milestone()).toBe("needs_you");
});
