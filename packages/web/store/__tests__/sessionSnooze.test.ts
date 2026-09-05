import { afterEach, beforeEach, expect, test } from "bun:test";
import { useInboxStore, sessionsWakeSig, type InboxSession } from "../inboxStore";
import { placeSections } from "./placeTestHarness";
import { SESSION_SNOOZE_CHOICES, sessionSnoozeUntil } from "@codecast/shared/contracts";

const now = Math.floor(Date.now() / 60_000) * 60_000;
const id = "s".repeat(32);
const owner = {};
const row: InboxSession = { _id: id, session_id: "snooze-test", user_id: "me", status: "active", updated_at: now - 60_000, message_count: 5, is_idle: true, agent_status: "done", title: "Snooze test" };
beforeEach(() => useInboxStore.getState()._setDispatch(async () => {}, { owner }));
afterEach(() => useInboxStore.getState()._clearDispatch(owner));

test("all duration actions move immediately, dispatch an unopened row, and survive stale sync", () => {
  for (const choice of SESSION_SNOOZE_CHOICES) {
    useInboxStore.setState({ sessions: { [id]: { ...row } }, conversations: {}, currentUser: { _id: "me" }, pending: {}, currentSessionId: null, clientState: { ui: {} } } as any);
    const patches: any[] = [];
    useInboxStore.getState()._setDispatch(async (_action, _args, patch) => { patches.push(patch); }, { owner });
    const until = sessionSnoozeUntil(choice.key, now);
    useInboxStore.getState().snoozeSession(id, until);
    const state = useInboxStore.getState();
    expect(state.sessions[id].inbox_snoozed_until).toBe(until);
    expect(patches.some((patch) => patch.conversations?.[id]?.inbox_snoozed_until === until)).toBe(true);
    expect(placeSections(state.sessions, new Set(), new Set(), { now }).snoozed.map((s) => s._id)).toContain(id);
    expect(sessionsWakeSig(state.sessions)).not.toBe(sessionsWakeSig({ [id]: row }));
    state.syncTable("sessions", [{ ...row, inbox_snoozed_until: null }]);
    expect(useInboxStore.getState().sessions[id].inbox_snoozed_until).toBe(until);
  }
});

test("expiry and wake now enter Needs Input, including old and asking sessions", () => {
  const future = { ...row, inbox_snoozed_until: now + 60_000, awaiting_input: true, updated_at: now - 40 * 86400_000 };
  expect(placeSections({ [id]: future }, new Set(), new Set(), { now }).questions).toHaveLength(0);
  const due = placeSections({ [id]: future }, new Set(), new Set(), { now: now + 60_000, showOld: false });
  expect(due.snoozed).toHaveLength(0);
  expect(due.needsInput.map((s) => s._id)).toEqual([id]);
  useInboxStore.setState({ sessions: { [id]: future }, conversations: {}, currentUser: { _id: "me" }, pending: {} } as any);
  useInboxStore.getState().wakeSnoozedSession(id);
  expect(placeSections(useInboxStore.getState().sessions).needsInput.map((s) => s._id)).toEqual([id]);
});

test("snooze does not alter a foreign, killed, or local draft session", () => {
  for (const patch of [{ user_id: "other" }, { inbox_killed_at: now }, { _id: "local-draft" }]) {
    const target = { ...row, ...patch };
    useInboxStore.setState({ sessions: { [target._id]: target }, conversations: {}, currentUser: { _id: "me" }, pending: {} } as any);
    useInboxStore.getState().snoozeSession(target._id, now + 86400_000);
    expect(useInboxStore.getState().sessions[target._id].inbox_snoozed_until).toBeUndefined();
  }
});


test("snoozing and waking a parent carries its nested sessions", () => {
  const childId = "c".repeat(32);
  const child = { ...row, _id: childId, is_subagent: true, parent_conversation_id: id };
  useInboxStore.setState({ sessions: { [id]: { ...row }, [childId]: child }, conversations: {}, currentUser: { _id: "me" }, pending: {} } as any);
  const until = now + 86400_000;
  useInboxStore.getState().snoozeSession(id, until);
  expect(useInboxStore.getState().sessions[childId].inbox_snoozed_until).toBe(until);
  useInboxStore.getState().wakeSnoozedSession(id);
  expect(useInboxStore.getState().sessions[childId].inbox_snoozed_until).toBeLessThanOrEqual(Date.now());
});

test("triaging an expired reminder clears it so it does not resurface again", () => {
  for (const rest of ["done", "dormant"] as const) {
    useInboxStore.setState({ sessions: { [id]: { ...row, inbox_snoozed_until: now } }, conversations: {}, currentUser: { _id: "me" }, pending: {} } as any);
    useInboxStore.getState().setSessionRest(id, rest);
    expect(useInboxStore.getState().sessions[id].inbox_snoozed_until).toBeNull();
    expect(placeSections(useInboxStore.getState().sessions)[rest].map((s) => s._id)).toContain(id);
  }
});


test("scheduled work cannot suppress an expired snooze reminder", () => {
  const session = { ...row, has_pending: true, inbox_snoozed_until: now };
  const placed = placeSections({ [id]: session }, new Set([id]), new Set(), { now });
  expect(placed.needsInput.map((s) => s._id)).toEqual([id]);
  expect(placed.working).toHaveLength(0);
});
