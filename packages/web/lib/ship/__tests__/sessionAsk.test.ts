import { describe, expect, test } from "bun:test";
import { blockedWaitOf, runAskOf, sessionAskOf, type AskRow } from "../sessionAsk";

const ME = "u1";
const row = (over: Partial<AskRow>): AskRow => ({ _id: "d", conversation_id: "conv1", question: "q", status: "pending", blocking: true, user_id: ME, created_at: 10, ...over });
const wait = { conversation_id: "conv1", since: 100 };

describe("sessionAskOf: the card a blocked session waits on (ct-99051)", () => {
  test("the session's newest open card, one it parked on before an advisory one", () => {
    const rows = [
      row({ _id: "old", question: "Old?", created_at: 5 }),
      row({ _id: "new", short_id: "sd-9", question: "Keep the flag?", created_at: 50 }),
      row({ _id: "advisory", question: "FYI", blocking: false, created_at: 90 }),
      row({ _id: "other", conversation_id: "conv2", created_at: 99 }),
    ];
    expect(sessionAskOf(rows, wait, ME)).toEqual({ id: "new", short_id: "sd-9", question: "Keep the flag?", mine: true, open: true });
  });
  test("mine only when the viewer may answer it", () => {
    expect(sessionAskOf([row({ _id: "d1", user_id: "u2", asked_user_ids: ["u2"] })], wait, ME)?.mine).toBe(false);
    expect(sessionAskOf([row({ _id: "d1", holder: { kind: "role", id: "r1" } })], wait, ME)?.mine).toBe(false);
    expect(sessionAskOf([row({ _id: "d1" })], wait, null)?.mine).toBe(false);
  });
  test("only an answer ends the wait on a person: a dismissed or withdrawn card leaves the session waiting", () => {
    expect(sessionAskOf([row({ _id: "a", status: "answered", resolved_at: 120 })], wait, ME)).toMatchObject({ id: "a", open: false });
    expect(sessionAskOf([row({ _id: "a", status: "dismissed", resolved_at: 120 })], wait, ME)).toBeNull();
    expect(sessionAskOf([row({ _id: "a", status: "withdrawn", resolved_at: 120 })], wait, ME)).toBeNull();
    // Answered before the wait began: the session pinned blocked after it, on something else.
    expect(sessionAskOf([row({ _id: "a", status: "answered", resolved_at: 80 })], wait, ME)).toBeNull();
    // An open card wins over one just answered: the session asks again.
    expect(sessionAskOf([row({ _id: "a", status: "answered", resolved_at: 120 }), row({ _id: "b", created_at: 130 })], wait, ME)).toMatchObject({ id: "b", open: true });
  });
  test("never a run's own gate card, a pointer card or a trial's card", () => {
    expect(sessionAskOf([row({ _id: "gate", workflow_run_id: "run9" })], wait, ME)).toBeNull();
    expect(sessionAskOf([row({ _id: "pointer", silent: true })], wait, ME)).toBeNull();
    expect(sessionAskOf([row({ _id: "t", trial: true })], wait, ME)).toBeNull();
    expect(sessionAskOf([row({ _id: "gate", workflow_run_id: "run9", status: "answered", resolved_at: 120 })], wait, ME)).toBeNull();
  });
  test("a card left open from before the station's brief does not stand in for this ask", () => {
    const at = 1_000_000;
    const stale = row({ _id: "stale", question: "Last week's question?", created_at: at - 3_600_000 });
    expect(sessionAskOf([stale], { ...wait, since: at + 5_000, after: at }, ME)).toBeNull();
    // A card asked just before the brief by the runner's clock still counts (the two clocks differ).
    expect(sessionAskOf([stale, row({ _id: "now", created_at: at - 30_000 })], { ...wait, since: at + 5_000, after: at }, ME)).toMatchObject({ id: "now" });
  });
  test("a session that asked in words only, or no session, has no card", () => {
    expect(sessionAskOf([], wait, ME)).toBeNull();
    expect(sessionAskOf([row({})], { since: 0 }, ME)).toBeNull();
    expect(sessionAskOf([row({})], null, ME)).toBeNull();
  });
});

describe("blockedWaitOf / runAskOf", () => {
  const run = (over: Record<string, unknown> = {}) => ({ status: "running", waiting_on_session: { node_id: "brief", conversation_id: "conv1", since: 2_000_000, blocked: true }, node_statuses: [{ node_id: "brief", started_at: 1_000 }, { node_id: "brief", started_at: 1_900_000 }, { node_id: "ci", started_at: 1_950_000 }], ...over }) as any;
  test("a live run's blocked wait, bounded by its station's latest brief", () => {
    expect(blockedWaitOf(run())).toEqual({ conversation_id: "conv1", since: 2_000_000, after: 1_900_000 });
    expect(blockedWaitOf(run({ status: "failed" }))).toBeNull();
    expect(blockedWaitOf(run({ waiting_on_session: { node_id: "brief", conversation_id: "conv1", since: 1 } }))).toBeNull();
  });
  test("reads the store's rows for that wait", () => {
    const rows = { d1: row({ _id: "d1", created_at: 1_950_000 }), d0: row({ _id: "d0", created_at: 500 }) };
    expect(runAskOf(run(), rows, ME)).toMatchObject({ id: "d1", open: true, mine: true });
    expect(runAskOf(run({ status: "completed" }), rows, ME)).toBeNull();
  });
});
