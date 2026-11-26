import { describe, expect, test } from "bun:test";
import { sessionAskOf, type AskRow } from "../sessionAsk";

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
  test("a card answered since the wait began ends the wait on a person; one settled before it, or a trial card, says nothing", () => {
    expect(sessionAskOf([row({ _id: "a", status: "answered", resolved_at: 120 })], wait, ME)).toMatchObject({ id: "a", open: false });
    expect(sessionAskOf([row({ _id: "a", status: "answered", resolved_at: 80 })], wait, ME)).toBeNull();
    expect(sessionAskOf([row({ _id: "t", trial: true })], wait, ME)).toBeNull();
    // An open card wins over one just answered: the session asks again.
    expect(sessionAskOf([row({ _id: "a", status: "answered", resolved_at: 120 }), row({ _id: "b", created_at: 130 })], wait, ME)).toMatchObject({ id: "b", open: true });
  });
  test("a session that asked in words only, or no session, has no card", () => {
    expect(sessionAskOf([], wait, ME)).toBeNull();
    expect(sessionAskOf([row({})], { since: 0 }, ME)).toBeNull();
    expect(sessionAskOf([row({})], null, ME)).toBeNull();
  });
});
