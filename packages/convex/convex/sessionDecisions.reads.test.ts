import { describe, expect, test } from "bun:test";
import schema from "./schema";
import { makeFakeDb, schemaIndexes } from "./testDb";
import { listForUserCore } from "./sessionDecisions";

// listForUser runs on every open window, so what it reads is paid per
// subscriber on every write to those rows. It must read a person's pending
// decisions and the last day's resolved ones, never every decision they were
// ever asked: a team that piles up thousands of answered line decisions made
// the whole history 12 MB a call and timed the query out.

const ME = "users_me" as any;
const OTHER = "users_other" as any;
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const HISTORY = 3000;

// Counts every document a read hands back: a get, or the rows of a collect,
// take, first or unique. Convex bills reads the same way.
function countingDb(db: any) {
  let docs = 0;
  const count = (v: any) => {
    if (Array.isArray(v)) docs += v.length;
    else if (v && typeof v === "object") docs += Array.isArray(v.page) ? v.page.length : 1;
    return v;
  };
  const wrap = (q: any): any => new Proxy(q, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== "function") return value;
      return (...args: any[]) => {
        const out = value.apply(target, args);
        if (out && typeof out.then === "function") return out.then(count);
        return out && typeof out === "object" ? wrap(out) : out;
      };
    },
  });
  return { db: wrap(db), reads: () => docs };
}

function fixture() {
  const session_decisions: any[] = [];
  const decision_inbox: any[] = [];
  const decision = (id: string, extra: any) => session_decisions.push({
    _id: id, conversation_id: "conversations_c", session_id: "s", user_id: OTHER, question: "q",
    options: [{ label: "A" }, { label: "B" }], blocking: true, created_at: NOW - 10 * DAY, ...extra,
  });
  // History: answered long ago, through the inbox and through the legacy owner index.
  for (let i = 0; i < HISTORY; i++) {
    const at = NOW - 3 * DAY - i * 1000;
    decision(`session_decisions_inbox_${i}`, { status: "answered", asked_user_ids: [ME], resolved_at: at });
    decision_inbox.push({ _id: `decision_inbox_${i}`, decision_id: `session_decisions_inbox_${i}`, user_id: ME, status: "done", created_at: at - DAY, status_at: at });
    decision(`session_decisions_owned_${i}`, { user_id: ME, status: i % 2 ? "dismissed" : "answered", resolved_at: at });
  }
  // What the query returns: pending and resolved inside the day, both paths.
  decision("session_decisions_pending", { status: "pending", asked_user_ids: [ME] });
  decision_inbox.push({ _id: "decision_inbox_pending", decision_id: "session_decisions_pending", user_id: ME, status: "pending", created_at: NOW - DAY });
  decision("session_decisions_recent", { status: "answered", asked_user_ids: [ME], resolved_at: NOW - 1000 });
  decision_inbox.push({ _id: "decision_inbox_recent", decision_id: "session_decisions_recent", user_id: ME, status: "done", created_at: NOW - DAY, status_at: NOW - 1000 });
  decision("session_decisions_owned_pending", { user_id: ME, status: "pending" });
  decision("session_decisions_owned_recent", { user_id: ME, status: "withdrawn", resolved_at: NOW - 2000 });
  return { session_decisions, decision_inbox };
}

describe("listForUser reads", () => {
  test("reads what it returns, not the person's whole decision history", async () => {
    const { db, reads } = countingDb(makeFakeDb(fixture(), { indexes: schemaIndexes(schema as any) }));
    const rows = await listForUserCore({ db } as any, ME, NOW);
    expect(rows.map((r) => r._id).sort()).toEqual([
      "session_decisions_owned_pending",
      "session_decisions_owned_recent",
      "session_decisions_pending",
      "session_decisions_recent",
    ]);
    // Two inbox rows plus their decisions, two owner rows. The whole history
    // would be 3 * HISTORY = 9000 documents.
    expect(reads()).toBeLessThanOrEqual(6);
  });
});
