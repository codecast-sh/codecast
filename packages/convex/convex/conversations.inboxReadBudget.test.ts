import { beforeEach, describe, expect, test } from "bun:test";
import schema from "./schema";
import { makeFakeDb, schemaIndexes } from "./testDb";
import { _resetChildAuqProbeCacheForTests, computeInboxSessions } from "./conversations";
import { INBOX_WINDOW_CAPS, shouldShowInInbox } from "../../shared/contracts/inboxProjection";

// ct-73243: listInboxSessions timed out on heavy accounts ("Function execution
// timed out (maximum duration: 3s)" and "Your request timed out performing too
// many system operations"). Each capped window is fine alone, but with every
// window full about 1,200 candidate rows go through computeInboxSessions and
// each pays its own enrichment reads, so the reads grow with rows x reads per
// row. Convex caps a query at 4,096 db calls; both the web's live subscription
// and the CLI's call must stay at half that on an account where every window
// is full, without dropping rows silently (whatever is left out is named in
// `truncated`).

const ME = "users_me";
const OTHER = "users_other";
const MIN = 60 * 1000;
const READ_BUDGET = 2048;
const CHILDREN_PER_ROW = 3;
// Pending blocking `cast decide` questions asked of the viewer: each costs the
// CLI about one read. A busy owners-model account (the flag-on case) runs at
// twice the default.
const PENDING_DECISIONS = 50;
const BUSY_PENDING_DECISIONS = 100;

type Window = keyof typeof INBOX_WINDOW_CAPS;
// The nested and escalated windows exist only under the owners model (the flag-on case below).
const WINDOWS = (Object.keys(INBOX_WINDOW_CAPS) as Window[]).filter((w) => w !== "nested" && w !== "escalated");
const MODEL_WINDOWS = Object.keys(INBOX_WINDOW_CAPS) as Window[];
const TEAM = "teams_union";

// The web live subscription's call: include_liveness:false,
// fast_fields_in_overlay:true, split:true.
const WEB = { includeLiveness: false, fastFieldsInOverlay: true, splitHot: true };
// inboxForCLI's call: liveness on (the default) and the projection stamped.
const CLI = { includeLiveness: true, projection: true };

// One db call is one get or one query execution (collect, take, first,
// unique, a page or an iterator step). Convex counts its limits the same way.
// Calls are also counted per queried table, so a test can pin one read path.
function countingDb(db: any) {
  let calls = 0;
  const byTable = new Map<string, number>();
  const getsById = new Map<string, number>();
  const wrap = (q: any, table: string | null): any => new Proxy(q, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== "function") return value;
      return (...args: any[]) => {
        const out = value.apply(target, args);
        const t = prop === "query" ? String(args[0]) : table;
        if (prop === "get" && table === null) getsById.set(String(args[0]), (getsById.get(String(args[0])) ?? 0) + 1);
        if (out && typeof out.then === "function") {
          return out.then((v: any) => {
            calls++;
            if (t) byTable.set(t, (byTable.get(t) ?? 0) + 1);
            return v;
          });
        }
        return out && typeof out === "object" ? wrap(out, t) : out;
      };
    },
  });
  return {
    db: wrap(db, null),
    calls: () => calls,
    queriesOf: (table: string) => byTable.get(table) ?? 0,
    // Ids one execution got more than once: each duplicate is a read a shared memo saves.
    regets: () => [...getsById].filter(([, n]) => n > 1).map(([id]) => id),
  };
}

// An account with `perWindow(w)` rows in every window. Every top-level row
// carries what a busy account's rows carry: a plan and a task from a shared
// pool, a session_owners row (owner_user_id cached the way
// syncPrimaryOwnerCache writes it), a managed_sessions row, and, unless it is
// parked (dismissed or stashed), CHILDREN_PER_ROW subagent children. The
// newest PENDING_DECISIONS rows each hold a pending blocking `cast decide`.
// `windowOf` names the window that admits each top-level row.
function account(perWindow: (w: Window) => number, world: { model?: boolean; decisions?: number } = {}) {
  const pendingDecisions = world.decisions ?? PENDING_DECISIONS;
  const now = Date.now();
  const conversations: any[] = [];
  const session_owners: any[] = [];
  const managed_sessions: any[] = [];
  const plans: any[] = [];
  const tasks: any[] = [];
  const session_decisions: any[] = [];
  const decision_inbox: any[] = [];
  const windowOf = new Map<string, Window>();
  const users: any[] = [
    { _id: ME, name: "Me", email: "me@example.com" },
    { _id: OTHER, name: "Bot", email: "bot@example.com" },
  ];
  for (let k = 0; k < 20; k++) {
    plans.push({ _id: `plans_${k}`, short_id: `pl-${k}`, title: `Plan ${k}`, status: "active" });
    tasks.push({ _id: `tasks_${k}`, short_id: `ct-${k}`, title: `Task ${k}`, status: "in_progress" });
  }
  let n = 0;
  const conv = (window: Window | null, extra: any, opts: { parked?: boolean; owner?: { user: string; by: string; seen: boolean } } = {}) => {
    n++;
    const id = `conversations_${n}`;
    const runner = extra.user_id ?? ME;
    const owner = opts.owner ?? { user: ME, by: ME, seen: true };
    const row = {
      ...(world.model ? { team_id: TEAM } : {}),
      _id: id, user_id: runner, status: "active", is_subagent: false, session_id: `s${n}`,
      started_at: now - 60 * MIN - n, updated_at: now - n * 1000,
      message_count: 10, last_message_role: "assistant", title: `Session ${n}`,
      active_plan_id: `plans_${n % 20}`, active_task_id: `tasks_${n % 20}`,
      owner_user_id: owner.user,
      ...extra,
    };
    conversations.push(row);
    if (window) windowOf.set(id, window);
    session_owners.push({
      _id: `session_owners_${n}`, conversation_id: id, user_id: owner.user, added_by: owner.by,
      added_at: now - n * MIN, ...(owner.seen ? { seen_at: now - n * MIN } : {}),
    });
    managed_sessions.push({
      _id: `managed_sessions_${n}`, session_id: `s${n}`, conversation_id: id, user_id: runner, pid: 1000 + n,
      started_at: now - 60 * MIN, last_heartbeat: now - (n % 5) * 1000,
      agent_status: n % 3 === 0 ? "working" : "idle", agent_status_updated_at: now - n * 1000,
    });
    if (!opts.parked) {
      for (let c = 0; c < CHILDREN_PER_ROW; c++) {
        conversations.push({
          ...(world.model ? { team_id: TEAM } : {}),
          _id: `${id}_sub${c}`, user_id: runner, status: "active", is_subagent: true,
          parent_conversation_id: id, session_id: `s${n}_sub${c}`, started_at: now - n - c, updated_at: now - n * 1000 - c,
          message_count: 3, last_message_role: "assistant",
        });
      }
    }
    if (session_decisions.length < pendingDecisions && !extra.is_subagent) {
      const d = session_decisions.length;
      session_decisions.push({
        _id: `session_decisions_${d}`, conversation_id: id, session_id: `s${n}`, user_id: runner,
        question: `Decision ${d}?`, options: [{ label: "yes" }, { label: "no" }],
        status: "pending", blocking: true, asked_user_ids: [ME],
      });
      decision_inbox.push({ _id: `decision_inbox_${d}`, decision_id: `session_decisions_${d}`, user_id: ME, status: "pending", created_at: now - d * MIN });
    }
    return row;
  };
  for (let i = 0; i < perWindow("recent"); i++) conv("recent", {});
  for (let i = 0; i < perWindow("pinned"); i++) conv("pinned", { inbox_pinned_at: now - i * MIN });
  for (let i = 0; i < perWindow("dismissed"); i++) conv("dismissed", { inbox_dismissed_at: now - i * MIN }, { parked: true });
  for (let i = 0; i < perWindow("stashed"); i++) conv("stashed", { inbox_stashed_at: now - i * MIN }, { parked: true });
  for (let i = 0; i < perWindow("snoozed"); i++) conv("snoozed", { inbox_snoozed_until: now + (i + 1) * 60 * MIN });
  // An adopted child stands as a top-level row; its parent was dismissed long
  // ago, outside every window.
  for (let i = 0; i < perWindow("adopted"); i++) {
    const parent = conv(null, { inbox_dismissed_at: now - 40 * 24 * 60 * MIN }, { parked: true });
    conv("adopted", { is_subagent: true, parent_conversation_id: parent._id, inbox_adopted_at: now - i * MIN });
  }
  // Sessions run by another account and assigned to me, half not yet seen.
  for (let i = 0; i < perWindow("owned"); i++) {
    conv("owned", { user_id: OTHER, acting_user_id: OTHER }, { owner: { user: ME, by: OTHER, seen: i % 2 === 0 } });
  }
  // Under the owners model: subagents released from their parent, mine through
  // the implicit starter with no owner row, which only the nested window reads.
  if (world.model) {
    for (let i = 0; i < perWindow("nested"); i++) {
      n++;
      conversations.push({
        team_id: TEAM, _id: `conversations_${n}`, user_id: ME, status: "active", is_subagent: true, session_id: `s${n}`,
        parent_conversation_id: "conversations_1", parent_released_at: now - 1000, started_at: now - 60 * MIN - n, updated_at: now - n * 1000,
        message_count: 4, last_message_role: "assistant", title: `Released ${n}`,
      });
      windowOf.set(`conversations_${n}`, "nested");
    }
    // Waits that escalated to me on a role's runs an agent account runs: no
    // owner row, not mine to run, seated by the escalated window alone.
    for (let i = 0; i < perWindow("escalated"); i++) {
      n++;
      conversations.push({
        team_id: TEAM, _id: `conversations_${n}`, user_id: OTHER, status: "active", is_subagent: false, session_id: `s${n}`,
        org_role_id: "org_roles_r", role_started: true, wait_up_at: now - i * MIN, wait_up_count: 6, wait_up_person: ME,
        // Shared with the team in full, so the person it reached can open it.
        is_private: false,
        started_at: now - 60 * MIN - n, updated_at: now - n * 1000, message_count: 6, last_message_role: "assistant", title: `Escalated ${n}`,
      });
      windowOf.set(`conversations_${n}`, "escalated");
    }
  }
  // The owner window reads my newest owner rows first: make the assigned ones
  // the newest, so the window fills with exactly the rows it exists for.
  for (const r of session_owners) if (r.added_by === OTHER) r.added_at += 1e9;
  return {
    data: {
      users, conversations, session_owners, managed_sessions, plans, tasks, session_decisions, decision_inbox, messages: [],
      ...(world.model ? {
        teams: [{ _id: TEAM, name: "Union", features: { session_owners: true } }],
        team_memberships: [ME, OTHER].map((u, i) => ({ _id: `team_memberships_${i}`, user_id: u, team_id: TEAM, role: "member", joined_at: 1, visibility: "full" })),
      } : {}),
    },
    windowOf,
  };
}

const full = () => account((w) => INBOX_WINDOW_CAPS[w] + 1);
const fullModel = () => account((w) => INBOX_WINDOW_CAPS[w] + 1, { model: true, decisions: BUSY_PENDING_DECISIONS });
const light = () => account(() => 20);

async function run(fixture: ReturnType<typeof account>, opts: any) {
  _resetChildAuqProbeCacheForTests();
  const { db, calls, queriesOf, regets } = countingDb(makeFakeDb(fixture.data, { indexes: schemaIndexes(schema as any) }));
  const result = await computeInboxSessions({ db } as any, ME as any, opts);
  return { result, calls: calls(), queriesOf, regets: regets() };
}

// Every row a window would admit that the result leaves out must name its
// window in `truncated`, and a window may leave out no more than what lies
// past its cap. show_all so the fold does not hide rows from the comparison
// (it counts what it hides in hidden_count either way).
function expectNoSilentDrop(fixture: ReturnType<typeof account>, result: { sessions: any[]; truncated: string[] }) {
  const returned = new Set(result.sessions.map((r) => r._id.toString()));
  const missingByWindow = new Map<Window, number>();
  const rowsByWindow = new Map<Window, number>();
  for (const c of fixture.data.conversations) {
    const w = fixture.windowOf.get(c._id);
    if (!w || !shouldShowInInbox(c)) continue;
    rowsByWindow.set(w, (rowsByWindow.get(w) ?? 0) + 1);
    if (returned.has(c._id)) continue;
    expect({ id: c._id, window: w, named: result.truncated.includes(w) }).toEqual({ id: c._id, window: w, named: true });
    missingByWindow.set(w, (missingByWindow.get(w) ?? 0) + 1);
  }
  for (const w of WINDOWS) {
    expect({ window: w, missing: missingByWindow.get(w) ?? 0 }).toEqual({
      window: w,
      missing: Math.min(missingByWindow.get(w) ?? 0, Math.max(0, (rowsByWindow.get(w) ?? 0) - INBOX_WINDOW_CAPS[w])),
    });
  }
}

beforeEach(() => _resetChildAuqProbeCacheForTests());

describe("listInboxSessions read budget on a full account", () => {
  test("the web live subscription stays inside half of Convex's 4,096 db-call limit", async () => {
    const fixture = full();
    const { result, calls } = await run(fixture, WEB);
    console.log(`web listInboxSessions on a full account: ${calls} db calls, ${result.sessions.length} rows, truncated=${JSON.stringify(result.truncated)}`);
    for (const w of WINDOWS) expect(result.truncated).toContain(w as any);
    expect(calls).toBeLessThanOrEqual(READ_BUDGET);
  });

  test("the CLI's call (include_liveness:true, the projection) stays inside the same budget", async () => {
    const fixture = full();
    const { result, calls } = await run(fixture, CLI);
    console.log(`cli listInboxSessions on a full account: ${calls} db calls, ${result.sessions.length} rows, truncated=${JSON.stringify(result.truncated)}`);
    for (const w of WINDOWS) expect(result.truncated).toContain(w as any);
    expect(calls).toBeLessThanOrEqual(READ_BUDGET);
  });

  // Under the owners model every row reads its owners (the starter's user
  // doc, a released or dead parent), and the model's nested and escalated
  // windows join the scan, on a busy account's pending decisions: the same
  // budget holds, and each window lists its cap of members.
  test("flag on: the owners model's reads and windows stay inside the same budget, every window named", async () => {
    for (const opts of [WEB, CLI]) {
      const fixture = fullModel();
      const { result, calls, queriesOf, regets } = await run(fixture, opts);
      console.log(`owners-model listInboxSessions on a full account: ${calls} db calls, ${result.sessions.length} rows, truncated=${JSON.stringify(result.truncated)}`);
      for (const w of MODEL_WINDOWS) expect(result.truncated).toContain(w as any);
      expect(result.sessions.every((r: any) => r.owners_model === true)).toBe(true);
      const listed = new Set(result.sessions.map((r: any) => String(r._id)));
      const listedIn = (w: Window) => [...fixture.windowOf].filter(([id, win]) => win === w && listed.has(id)).length;
      expect(listedIn("nested")).toBe(INBOX_WINDOW_CAPS.nested);
      // 201 standing escalations seeded: 200 listed, the window named in truncated.
      expect([...fixture.windowOf.values()].filter((win) => win === "escalated").length).toBe(201);
      expect(listedIn("escalated")).toBe(200);
      // Team membership is read once per team, not once per escalated row
      // (every escalation here lives in one team and runs on one account):
      // the viewer's teams for the flag, then the window's access check, the
      // viewer's membership and the runner's.
      expect(queriesOf("team_memberships")).toBe(3);
      // One execution reads a conversation once: the enrichment shares the
      // owners read's memo (inboxMemoGet), so a parent the owners rule read
      // for its child is not read again.
      expect(regets.filter((id: string) => id.startsWith("conversations_"))).toEqual([]);
      expect(calls).toBeLessThanOrEqual(READ_BUDGET);
    }
  });

  test("no row a window admits goes missing without its window in truncated, and the rows match the pre-change code", async () => {
    const fixture = full();
    expectNoSilentDrop(fixture, (await run(fixture, { ...WEB, show_all: true })).result);
    expectNoSilentDrop(fixture, (await run(fixture, { ...CLI, show_all: true })).result);
    // The same rows the pre-change code (798caddd8) returns on this account.
    expect(snapshot((await run(fixture, WEB)).result)).toEqual(FULL_BEFORE.web);
    expect(snapshot((await run(fixture, CLI)).result)).toEqual(FULL_BEFORE.cli);
  });

  test("a light account (20 per window) returns every row, the same as before the change", async () => {
    const fixture = light();
    const web = (await run(fixture, WEB)).result;
    const cli = (await run(fixture, CLI)).result;
    expectNoSilentDrop(fixture, (await run(fixture, { ...WEB, show_all: true })).result);
    // Recorded from the pre-change code (798caddd8) on this fixture: the
    // returned ids (sorted, hashed), hidden_count and truncated.
    expect(snapshot(web)).toEqual(LIGHT_BEFORE.web);
    expect(snapshot(cli)).toEqual(LIGHT_BEFORE.cli);
  });
});

function snapshot(result: { sessions: any[]; hidden_count: number; truncated: string[] }) {
  const ids = result.sessions.map((r) => r._id.toString()).sort();
  return { rows: ids.length, ids: Bun.hash(ids.join(",")).toString(16), hidden_count: result.hidden_count, truncated: result.truncated };
}

const LIGHT_BEFORE = {
  web: { rows: 460, ids: "ab30a457f6d70891", hidden_count: 0, truncated: [] },
  cli: { rows: 460, ids: "ab30a457f6d70891", hidden_count: 0, truncated: [] },
};

const ALL_WINDOWS_CUT = ["recent", "pinned", "dismissed", "snoozed", "stashed", "owned", "adopted"];
const FULL_BEFORE = {
  web: { rows: 3360, ids: "bbfe461714e73718", hidden_count: 0, truncated: ALL_WINDOWS_CUT },
  cli: { rows: 3360, ids: "bbfe461714e73718", hidden_count: 0, truncated: ALL_WINDOWS_CUT },
};
