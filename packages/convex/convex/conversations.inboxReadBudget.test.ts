import { describe, expect, test } from "bun:test";
import schema from "./schema";
import { makeFakeDb, schemaIndexes } from "./testDb";
import { computeInboxSessions } from "./conversations";
import { INBOX_WINDOW_CAPS } from "../../shared/contracts/inboxProjection";

// ct-73243: listInboxSessions timed out on heavy accounts ("Function execution
// timed out (maximum duration: 3s)" and "Your request timed out performing too
// many system operations"). Each capped window is fine alone, but with every
// window full about 1,200 candidate rows go through computeInboxSessions and
// each pays its own enrichment reads, so the reads grow with rows x reads per
// row. Convex caps a query at 4,096 db calls; the web's live subscription must
// stay at half that on an account where every window is full, without dropping
// rows silently (whatever is left out is named in `truncated`).

const ME = "users_me";
const OTHER = "users_other";
const MIN = 60 * 1000;
const READ_BUDGET = 2048;

// One db call is one get or one query execution (collect, take, first,
// unique, a page or an iterator step). Convex counts its limits the same way.
function countingDb(db: any) {
  let calls = 0;
  let docs = 0;
  const count = (v: any) => {
    calls++;
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
  return { db: wrap(db), calls: () => calls, docs: () => docs };
}

// Every window one row past its cap, every row distinct, each carrying the
// references a busy account's rows carry (a plan, a task, an acting bot) and
// a subagent child under its parent. Shared references are memoized, so the
// count is driven by how many rows there are, not by the references.
function fullAccount() {
  const now = Date.now();
  const conversations: any[] = [];
  const session_owners: any[] = [];
  const plans: any[] = [];
  const tasks: any[] = [];
  const users: any[] = [
    { _id: ME, name: "Me", email: "me@example.com" },
    { _id: OTHER, name: "Bot", email: "bot@example.com" },
  ];
  let n = 0;
  const conv = (extra: any) => {
    n++;
    const id = `conversations_${n}`;
    // Rows share a small pool of plans and tasks, as a real account's do.
    const k = n % 20;
    const planId = `plans_${k}`;
    const taskId = `tasks_${k}`;
    if (n <= 20) {
      plans.push({ _id: planId, short_id: `pl-${k}`, title: `Plan ${k}`, status: "active" });
      tasks.push({ _id: taskId, short_id: `ct-${k}`, title: `Task ${k}`, status: "in_progress" });
    }
    const row = {
      _id: id, user_id: ME, status: "active", is_subagent: false,
      started_at: now - 60 * MIN - n, updated_at: now - n * 1000,
      message_count: 10, last_message_role: "assistant", title: `Session ${n}`,
      active_plan_id: planId, active_task_id: taskId,
      ...extra,
    };
    conversations.push(row);
    // A subagent child of every top-level row.
    conversations.push({
      _id: `${id}_sub`, user_id: row.user_id, status: "active", is_subagent: true,
      parent_conversation_id: id, started_at: now - n, updated_at: now - n * 1000,
      message_count: 3, last_message_role: "assistant",
    });
    return row;
  };
  for (let i = 0; i <= INBOX_WINDOW_CAPS.recent; i++) conv({});
  for (let i = 0; i <= INBOX_WINDOW_CAPS.pinned; i++) conv({ inbox_pinned_at: now - i * MIN });
  for (let i = 0; i <= INBOX_WINDOW_CAPS.dismissed; i++) conv({ inbox_dismissed_at: now - i * MIN });
  for (let i = 0; i <= INBOX_WINDOW_CAPS.stashed; i++) conv({ inbox_stashed_at: now - i * MIN });
  for (let i = 0; i <= INBOX_WINDOW_CAPS.snoozed; i++) conv({ inbox_snoozed_until: now + (i + 1) * 60 * MIN });
  for (let i = 0; i <= INBOX_WINDOW_CAPS.adopted; i++) {
    const parent = conv({ inbox_dismissed_at: now - 40 * 24 * 60 * MIN });
    conv({ is_subagent: true, parent_conversation_id: parent._id, inbox_adopted_at: now - i * MIN });
  }
  // Sessions run by another account and assigned to me.
  for (let i = 0; i <= INBOX_WINDOW_CAPS.owned; i++) {
    const row = conv({ user_id: OTHER, acting_user_id: OTHER });
    session_owners.push({ _id: `session_owners_${i}`, conversation_id: row._id, user_id: ME, added_by: OTHER, created_at: now - i * MIN });
  }
  return { users, conversations, session_owners, plans, tasks, managed_sessions: [], messages: [] };
}

describe("listInboxSessions read budget on a full account", () => {
  test("the web live subscription stays inside half of Convex's 4,096 db-call limit", async () => {
    const { db, calls, docs } = countingDb(makeFakeDb(fullAccount(), { indexes: schemaIndexes(schema as any) }));
    // The web live subscription's call: include_liveness:false,
    // fast_fields_in_overlay:true, split:true.
    const result = await computeInboxSessions({ db } as any, ME as any, {
      includeLiveness: false,
      fastFieldsInOverlay: true,
      splitHot: true,
    });
    console.log(`listInboxSessions on a full account: ${calls()} db calls, ${docs()} documents, ${result.sessions.length} rows, truncated=${JSON.stringify(result.truncated)}`);
    // Every window overflowed, and the result says so.
    for (const w of ["recent", "pinned", "dismissed", "stashed", "snoozed", "owned", "adopted"]) {
      expect(result.truncated).toContain(w as any);
    }
    expect(calls()).toBeLessThanOrEqual(READ_BUDGET);
  });
});
