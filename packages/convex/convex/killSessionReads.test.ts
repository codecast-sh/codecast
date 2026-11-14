import { describe, expect, test } from "bun:test";
import { dispatch } from "./dispatch";
import { makeFakeDb } from "./testDb";

// eg-2908 / ct-91233: a web killSession timed out in dispatch:dispatch (3s) on
// every retry. Each hide teardown's kill_session dedupe collected EVERY
// unexecuted daemon_commands row the user had, once per teardown, so one kill
// read (teardowns x backlog) rows. A kill must cost the same whatever the
// user's unexecuted command backlog is.
const USER = "users_me";
const LEAD = "conversations_lead";

function fixtures(backlog: number) {
  const children = Array.from({ length: 19 }, (_, i) => ({
    _id: `conversations_c${i}`, user_id: USER, session_id: `s-c${i}`,
    status: "active", message_count: 5, parent_conversation_id: LEAD,
  }));
  const db = makeFakeDb({
    conversations: [{ _id: LEAD, user_id: USER, session_id: "s-lead", status: "active", message_count: 5 }, ...children],
    session_owners: [], messages: [], pending_messages: [], client_state: [],
    managed_sessions: [], agent_tasks: [],
    daemon_commands: Array.from({ length: backlog }, (_, i) => ({
      _id: `daemon_commands_${i}`, user_id: USER, command: "send_message",
      args: JSON.stringify({ conversation_id: `conversations_other${i}` }),
      created_at: Date.now() - 60_000 + i, _creationTime: Date.now() - 60_000 + i,
    })),
  });
  return { db, ids: [LEAD, ...children.map((c) => c._id)] };
}

function countDaemonCommandReads(db: any) {
  const counter = { rows: 0 };
  const wrap = (q: any): any => new Proxy(q, {
    get(target, prop) {
      const v = target[prop];
      if (typeof v !== "function") return v;
      return (...a: any[]) => {
        const out = v.apply(target, a);
        if (prop === "collect" || prop === "take") {
          return Promise.resolve(out).then((rows: any[]) => { counter.rows += rows.length; return rows; });
        }
        if (prop === "first" || prop === "unique") {
          return Promise.resolve(out).then((row: any) => { if (row) counter.rows += 1; return row; });
        }
        if (out && typeof out === "object" && !(out instanceof Promise)) return wrap(out);
        return out;
      };
    },
  });
  const proxied = new Proxy(db, {
    get(target, prop) {
      if (prop === "query") return (table: string) => (table === "daemon_commands" ? wrap(target.query(table)) : target.query(table));
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { proxied, counter };
}

async function killReads(backlog: number) {
  const { db, ids } = fixtures(backlog);
  const { proxied, counter } = countDaemonCommandReads(db);
  const scheduler = { runAfter: async () => {} };
  await (dispatch as any)._handler({
    auth: { getUserIdentity: async () => ({ subject: `${USER}|session` }) },
    db: proxied,
    scheduler,
  }, {
    action: "killSessions",
    args: [],
    patches: { conversations: Object.fromEntries(ids.map((id) => [id, { inbox_dismissed_at: 777 }])) },
  });
  const kills = db._tables.daemon_commands.filter((c: any) => c.command === "kill_session");
  return { reads: counter.rows, kills: kills.length };
}

describe("a kill's daemon_commands reads do not grow with the user's unexecuted backlog", () => {
  test("killing a lead and its children reads the same at 50 and 5,000 commands queued in the last minute", async () => {
    const small = await killReads(50);
    const big = await killReads(5_000);
    expect(big.kills).toBeGreaterThan(0);
    expect(big.kills).toBe(small.kills);
    expect(big.reads).toBeLessThanOrEqual(small.reads + 100);
  });
});
