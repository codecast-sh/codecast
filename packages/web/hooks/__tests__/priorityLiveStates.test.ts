// A milestone's session marks are the marks its inbox draws (store/inboxMark
// inboxMarkOf; lib/priorityList buildModels states the rule). Each case fixes
// the store, then asserts both the inbox's mark for the session and the state
// the milestone it is linked to reads: Needs You, the old-session fold, a
// pinned wait, a hosted stop on the sidebar and the phone, Team scope, a
// dismissed session behind its header, a parent lifted into Questions by its
// child's ask, a role's session riding its lead, a Done row's check, the
// focused session held in place, a session the store does not hold, and a
// workflow run asking through its parent's question, an error filed in Needs
// You, a role's lead asking, and a heartbeat that places nothing.
// Run: cd packages/web && bun test --isolate hooks/__tests__/priorityLiveStates.test.ts
import { afterEach, expect, test } from "bun:test";
import { fixtureId, installDom, installMissingBackend, seedViewer, TEAM_ID, VIEWER_ID } from "../../test-helpers/missingBackend";

const { mountSurface } = installDom("https://app.test/priorities");
await installMissingBackend({ answers: {} });
await seedViewer();

const React = await import("react");
const { useInboxStore, placedInboxVersion } = await import("../../store/inboxStore");
const { inboxMarkOf } = await import("../../store/inboxMark");
const { liveMarkOf, usePriorityLiveStates } = await import("../usePriorityModels");
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
const drawn = (id = ID, inbox: "sidebar" | "phone" = "sidebar") => inboxMarkOf(st(), id, { inbox, now: NOW, focusedId: st().currentSessionId ?? null });
const mark = (id = ID, inbox: "sidebar" | "phone" = "sidebar") => drawn(id, inbox)?.mark ?? null;
/** The milestone whose one link is `id` (the server saying `server`, the link `mine` or not), as `inbox` draws it. */
const model = (id = ID, { inbox = "sidebar", server = "needs_you", mine = true }: { inbox?: "sidebar" | "phone"; server?: string; mine?: boolean } = {}) => {
  const r = row(70, "Linked", 1, [step("s1", "The milestone", "critical")], { links: [links("s1", [{ ...sess("linked1", "Linked", server, 1, { mine }), conversation_id: id }])] });
  return buildModels([r as any], undefined, (cid) => liveMarkOf(st(), cid, NOW, inbox), lastDays(10, NOW))[0].milestones[0];
};
const milestone = (id = ID, opts: Parameters<typeof model>[1] = {}) => model(id, opts).state.kind;

test("asking in Needs You: Needs you", () => {
  put({ [ID]: asking() });
  expect(mark()).toBe("needs_you");
  expect(milestone()).toBe("needs_you");
});

test("asking but folded below the old-session fold: not drawn, so it reads idle; shown again with old sessions on: Needs you", () => {
  const old = NOW - 3 * 86_400_000;
  put({ [ID]: asking(old), [fixtureId("fresh1")]: { ...asking(NOW - MIN), thread_state_status: "dormant" } });
  ui({ inbox_show_old: false });
  expect(mark()).toBeNull();
  expect(milestone()).toBe("idle");
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
  expect(milestone()).toBe("idle");
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

test("a parent the inbox lifts into Questions because its child asks: Needs you, as the Questions card draws it", () => {
  const parent = fixtureId("liftedparent");
  const child = fixtureId("askingchild");
  put({
    [parent]: { ...asking(), thread_state_status: "working", agent_status: "working", agent_status_updated_at: NOW - 5000, last_heartbeat: NOW - 1000, daemon_alive_until: NOW + 60_000 },
    [child]: { ...asking(), parent_conversation_id: parent, is_subagent: true, is_workflow_sub: true, workflow_run_id: "run1" },
  });
  useInboxStore.setState({ sessionDecisions: { d1: { _id: "d1", conversation_id: child, status: "pending", blocking: true, in_queue: true, created_at: NOW - MIN, updated_at: NOW - MIN, question: "Ship it?", options: [] } } } as any);
  expect(mark(parent)).toBe("needs_you");
  expect(milestone(parent, { server: "working" })).toBe("needs_you");
});

test("a role's session riding its lead wears the lead's mark, never Needs you of its own", () => {
  const lead = fixtureId("rolelead");
  const ridden = fixtureId("rolesess");
  const base = { message_count: 4, status: "completed", updated_at: NOW - 10 * MIN, last_turn_at: NOW - 11 * MIN, user_id: VIEWER_ID, thread_state_at: NOW - 10 * MIN };
  put({
    [lead]: { ...base, standing_role_id: "role1", thread_state_status: "working", agent_status: "working", agent_status_updated_at: NOW - 5000, last_heartbeat: NOW - 1000, daemon_alive_until: NOW + 60_000 },
    [ridden]: { ...base, org_role_id: "role1", thread_state_status: "blocked" },
  });
  expect(mark(lead)).toBe("working");
  expect(mark(ridden)).toBe(mark(lead));
  expect(mark(ridden)).not.toBe("needs_you");
  expect(milestone(ridden)).not.toBe("needs_you");
});

test("an API error the inbox files in Needs You draws the error mark and still needs you, on the sidebar and the phone", () => {
  put({ [ID]: { ...asking(), pending_api_error: "rate limited", pending_api_error_kind: "usage_limit" } });
  for (const inbox of ["sidebar", "phone"] as const) {
    expect(drawn(ID, inbox)).toEqual({ mark: "error", asks: true, target: ID });
    const m = model(ID, { inbox });
    expect([m.state.kind, m.sessions[0].mark]).toEqual(["needs_you", "error"]);
  }
});

test("a role's lead asking: the session riding it needs you through the lead, and opens the lead's conversation", () => {
  const lead = fixtureId("askinglead");
  const ridden = fixtureId("riddensess");
  const base = { message_count: 4, status: "completed", updated_at: NOW - 10 * MIN, last_turn_at: NOW - 11 * MIN, user_id: VIEWER_ID, thread_state_at: NOW - 10 * MIN };
  put({
    [lead]: { ...base, standing_role_id: "role2", thread_state_status: "blocked" },
    [ridden]: { ...base, org_role_id: "role2", thread_state_status: "working", agent_status: "working", agent_status_updated_at: NOW - 5000, last_heartbeat: NOW - 1000, daemon_alive_until: NOW + 60_000 },
  });
  expect(drawn(ridden)).toEqual({ mark: "needs_you", asks: true, target: lead });
  const m = model(ridden, { server: "working" });
  expect(m.state.kind).toBe("needs_you");
  expect(m.state.session!.href).toBe(`/conversation/${lead}`);
  expect(m.sessions[0].href).toBe(`/conversation/${lead}`);
  expect([m.state.session!.target, m.sessions[0].target]).toEqual([lead, lead]);
});

test("a session the sidebar draws under Done keeps its Done check on its row, while the milestone reads it as idle", () => {
  put({ [ID]: { ...asking(), thread_state_status: "done" } });
  expect(mark()).toBe("done");
  const m = model(ID, { server: "done" });
  expect(m.state.kind).toBe("idle");
  expect([m.sessions[0].state, m.sessions[0].mark]).toEqual(["idle", "done"]);
});

test("stashed: its row draws the stash tray, and the milestone has nobody on it (New session for its owner)", () => {
  put({ [ID]: { ...asking(), inbox_stashed_at: NOW - MIN } });
  expect(drawn()).toEqual({ mark: "stashed", asks: false, target: ID });
  const m = model(ID, { server: "idle" });
  expect(m.state.kind).toBe("start");
  expect(m.sessions[0].mark).toBe("stashed");
});

test("an ask queued for the viewer in Decisions needs you wherever its session sits: stashed, snoozed, dismissed, or not in the store, on both inboxes", () => {
  const decide = (conversation_id: string) => useInboxStore.setState({ sessionDecisions: { dq: { _id: "dq", conversation_id, status: "pending", blocking: true, in_queue: true, created_at: NOW - MIN, updated_at: NOW - MIN, question: "Which one?", options: [] } } } as any);
  const quiet = { ...asking(), thread_state_status: "dormant" };
  for (const [name, row] of [["stashed", { ...quiet, inbox_stashed_at: NOW - MIN }], ["snoozed", { ...quiet, inbox_snoozed_until: NOW + 60 * MIN }], ["dismissed", { ...quiet, inbox_dismissed_at: NOW - MIN }]] as const) {
    const id = fixtureId(`dq${name}`);
    put({ [id]: row });
    decide(id);
    expect([name, drawn(id)]).toEqual([name, { mark: "needs_you", asks: true, target: id }]);
    expect([name, milestone(id, { server: "idle" })]).toEqual([name, "needs_you"]);
    // Without the ask, the same row does not need you.
    useInboxStore.setState({ sessionDecisions: {} } as any);
    expect([name, milestone(id, { server: "idle" })]).not.toEqual([name, "needs_you"]);
  }
  const absent = fixtureId("dqabsent");
  decide(absent);
  // The phone's Decisions badge and screen read the same queue.
  for (const inbox of ["sidebar", "phone"] as const) {
    expect([inbox, drawn(absent, inbox)]).toEqual([inbox, { mark: "needs_you", asks: true, target: absent }]);
    expect([inbox, milestone(absent, { inbox, server: "idle" })]).toEqual([inbox, "needs_you"]);
  }
});

test("a priority card sitting in a session is its person's, not the session's question: it never makes the milestone need you", () => {
  const card = fixtureId("dqcard");
  useInboxStore.setState({ sessionDecisions: { pc: { _id: "pc", conversation_id: card, status: "pending", blocking: true, in_queue: true, priority_card: { kind: "merges" }, created_at: NOW - MIN, updated_at: NOW - MIN, question: "Merge these?", options: [] } } } as any);
  for (const inbox of ["sidebar", "phone"] as const) expect([inbox, drawn(card, inbox)]).toEqual([inbox, null]);
  useInboxStore.setState({ sessionDecisions: {} } as any);
});

test("a stashed session the inbox lifts into Decisions (its own question, or a decide) asks on the phone too, never New session", () => {
  const auq = fixtureId("stashauq");
  const dq = fixtureId("stashdq");
  put({
    [auq]: { ...asking(), thread_state_status: undefined, awaiting_input: true, inbox_stashed_at: NOW - 5 * MIN },
    [dq]: { ...asking(), thread_state_status: "dormant", inbox_stashed_at: NOW - 5 * MIN },
  });
  useInboxStore.setState({ sessionDecisions: { ds: { _id: "ds", conversation_id: dq, status: "pending", blocking: true, in_queue: true, created_at: NOW - MIN, updated_at: NOW - MIN, question: "?", options: [] } } } as any);
  for (const id of [auq, dq]) for (const inbox of ["phone", "sidebar"] as const) {
    expect([inbox, drawn(id, inbox)]).toEqual([inbox, { mark: "needs_you", asks: true, target: id }]);
    expect([inbox, milestone(id, { inbox, server: "idle" })]).toEqual([inbox, "needs_you"]);
  }
});

test("a role's session with an ask of its own in Decisions asks, answered in itself, on both inboxes", () => {
  const lead = fixtureId("rqlead");
  const ridden = fixtureId("rqsess");
  const base = { message_count: 4, status: "completed", updated_at: NOW - 10 * MIN, last_turn_at: NOW - 11 * MIN, user_id: VIEWER_ID, thread_state_at: NOW - 10 * MIN };
  const working = { thread_state_status: "working", agent_status: "working", agent_status_updated_at: NOW - 5000, last_heartbeat: NOW - 1000, daemon_alive_until: NOW + 60_000 };
  // A decide asked of the viewer, then the session's own question.
  for (const own of [{}, { awaiting_input: true }]) {
    put({ [lead]: { ...base, standing_role_id: "rq", ...working }, [ridden]: { ...base, org_role_id: "rq", thread_state_status: "dormant", ...own } });
    useInboxStore.setState({ sessionDecisions: "awaiting_input" in own ? {} : { dq: { _id: "dq", conversation_id: ridden, status: "pending", blocking: true, in_queue: true, created_at: NOW - MIN, updated_at: NOW - MIN, question: "Ship it?", options: [] } } } as any);
    for (const inbox of ["sidebar", "phone"] as const) {
      expect([inbox, drawn(ridden, inbox)]).toEqual([inbox, { mark: "needs_you", asks: true, target: ridden }]);
      const m = model(ridden, { inbox, server: "idle" });
      expect([inbox, m.state.kind, m.sessions[0].target]).toEqual([inbox, "needs_you", ridden]);
    }
  }
  // Without an ask of its own, it shows its lead on both.
  put({ [lead]: { ...base, standing_role_id: "rq", ...working }, [ridden]: { ...base, org_role_id: "rq", thread_state_status: "dormant" } });
  useInboxStore.setState({ sessionDecisions: {} } as any);
  for (const inbox of ["sidebar", "phone"] as const) expect([inbox, drawn(ridden, inbox)]).toEqual([inbox, { mark: "working", asks: false, target: lead }]);
});

test("not in the store: no mark; the server's needs_you reads idle, never sleeping, whoever owns it", () => {
  const absent = fixtureId("absent1");
  expect(mark(absent)).toBeNull();
  expect(milestone(absent)).toBe("idle");
  expect(milestone(absent, { mine: false })).toBe("idle");
  // Its row says Idle, never the Sleeping moon.
  expect(model(absent).sessions[0].state).toBe("idle");
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

test("a heartbeat that moves nothing placement reads places nothing: no new answer, no render, no placed-inbox bump", async () => {
  put({ [ID]: asking() });
  const answers: unknown[] = [];
  function Probe() {
    const live = usePriorityLiveStates([ID], NOW);
    answers.push(live);
    return React.createElement("span", { "data-mark": live(ID)?.mark ?? "" });
  }
  const page = await mountSurface(React.createElement(Probe));
  try {
    expect(page.container.querySelector("[data-mark]")!.getAttribute("data-mark")).toBe("needs_you");
    const renders = answers.length;
    const version = placedInboxVersion();
    // A liveness heartbeat: the sessions ref and the row flip, every structural field the same.
    await (React as any).act(async () => {
      useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, [ID]: { ...s.sessions[ID], last_heartbeat: NOW + 1000, updated_at: s.sessions[ID].updated_at } } }));
    });
    expect(answers.length).toBe(renders);
    expect(placedInboxVersion()).toBe(version);
    // A change of the row's own facts answers anew, with what the inbox draws for it now.
    await (React as any).act(async () => {
      useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, [ID]: { ...s.sessions[ID], thread_state_status: "dormant" } } }));
    });
    expect(answers.length).toBeGreaterThan(renders);
    expect(page.container.querySelector("[data-mark]")!.getAttribute("data-mark")).toBe(mark() ?? "");
    // And a structural change places again.
    await (React as any).act(async () => {
      useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, [ID]: { ...s.sessions[ID], inbox_dismissed_at: NOW } } }));
    });
    expect(page.container.querySelector("[data-mark]")!.getAttribute("data-mark")).toBe("killed");
  } finally {
    await page.unmount();
  }
}, 60_000);

test("the wake reads a digest of what a mark reads: streamed messages on a working session wake nothing; its own state, and its role lead's, do", async () => {
  const lead = fixtureId("digestlead");
  const rider = fixtureId("digestrider");
  const base = { message_count: 4, status: "completed", updated_at: NOW - 10 * MIN, last_turn_at: NOW - 11 * MIN, user_id: VIEWER_ID, thread_state_at: NOW - 10 * MIN };
  put({
    [ID]: { ...asking(), thread_state_status: "working", agent_status: "working", agent_status_updated_at: NOW - 5000, last_heartbeat: NOW - 1000, daemon_alive_until: NOW + 60_000 },
    [lead]: { ...base, standing_role_id: "role9", thread_state_status: "working", agent_status: "working", agent_status_updated_at: NOW - 5000, last_heartbeat: NOW - 1000, daemon_alive_until: NOW + 60_000 },
    [rider]: { ...base, org_role_id: "role9", thread_state_status: "working" },
  });
  let renders = 0;
  function Probe() {
    usePriorityLiveStates([ID, rider], NOW);
    renders++;
    return null;
  }
  const page = await mountSurface(React.createElement(Probe));
  const write = (id: string, patch: Record<string, unknown>) => (React as any).act(async () => {
    useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, [id]: { ...s.sessions[id], ...patch } } }));
  });
  try {
    const before = renders;
    // The agent streams five messages: counts and stamps move, nothing a mark reads.
    for (let i = 5; i < 10; i++) await write(ID, { message_count: i, last_message_at: NOW + i, updated_at: NOW + i });
    expect(renders).toBe(before);
    // A field the mark reads wakes it.
    await write(ID, { pending_api_error: "rate limited", pending_api_error_kind: "usage_limit" });
    expect(renders).toBeGreaterThan(before);
    // So does the rider's lead's own state: the rider wears its mark.
    const afterOwn = renders;
    await write(lead, { session_error: "boom" });
    expect(renders).toBeGreaterThan(afterOwn);
  } finally {
    await page.unmount();
  }
}, 60_000);

test("a decision reassigned to or away from the viewer repaints the milestone at once", async () => {
  // Not in the store: only the Decisions queue says whether it asks.
  const id = fixtureId("reassigned");
  const decide = (asked: string[]) => (React as any).act(async () => {
    useInboxStore.setState({ sessionDecisions: { dr: { _id: "dr", conversation_id: id, status: "pending", blocking: true, in_queue: true, asked_user_ids: asked, created_at: NOW - MIN, updated_at: NOW - MIN, question: "Which?", options: [] } } } as any);
  });
  function Probe() {
    const live = usePriorityLiveStates([id], NOW);
    return React.createElement("span", { "data-asks": live(id)?.asks ? "1" : "0" });
  }
  await decide([VIEWER_ID]);
  const page = await mountSurface(React.createElement(Probe));
  const asks = () => page.container.querySelector("[data-asks]")!.getAttribute("data-asks");
  try {
    expect(asks()).toBe("1");
    await decide(["someone-else"]);
    expect(asks()).toBe("0");
    await decide([VIEWER_ID]);
    expect(asks()).toBe("1");
  } finally {
    await page.unmount();
  }
}, 60_000);

// Last: placeInboxRows' memo can hand a later test this row's placement (a pre-existing key gap, filed separately).
test("asleep with its own subagent running: drawn Working, as the rail's split draws it, and the milestone reads it so", () => {
  const at = NOW - 10 * MIN;
  const parked = { message_count: 4, status: "completed", agent_status: "dormant", updated_at: at, last_turn_at: at - MIN, user_id: VIEWER_ID, thread_state_status: "dormant", thread_state_at: at, last_heartbeat: NOW - 5_000, open_tasks_at: at };
  put({ [ID]: { ...parked, open_tasks: [{ id: "t1", kind: "agent", description: "Round 7 verifier: UI" }] } });
  expect(mark()).toBe("working");
});
