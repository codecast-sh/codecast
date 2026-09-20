import { expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { takeOverSessions } from "./orgInit";
import { performCreateRole } from "./orgRoles";

// REVIEW (W7). Left untracked by the adversarial reviewer. Counts the index
// range reads (every db.get and every db.query is one) of ONE takeover inside
// the apply mutation, at the size the brief names: one project with 860 tasks
// that other people filed, and 440 sessions on its path, 100 of them movable.
// The backend refuses a function past 4,096.

const ME = "u".repeat(31) + "m";
const MATE = "u".repeat(31) + "t";
const TEAM = "teams_acme" as any;
const WS = `team:${TEAM}`;
const NOW = Date.now();
const P = "projects_p";

test("one takeover on a Union sized scope stays under the 4,096 read limit", async () => {
  const tasks = Array.from({ length: 860 }, (_, i) => ({ _id: `tasks_${i}`, short_id: `ct-${i}`, user_id: MATE, team_id: TEAM, workspace: WS, project_id: P, title: `t${i}`, status: "open", created_at: 1, updated_at: NOW }));
  const conversations = Array.from({ length: 440 }, (_, i) => ({
    _id: `conversations_${i}`, short_id: `jx7${String(i).padStart(4, "0")}`, user_id: ME, team_id: TEAM, status: "active", agent_type: "claude_code",
    title: `s${i}`, project_path: "/repo/growth", message_count: 3, last_message_role: "assistant", updated_at: NOW - 60_000 - i, created_at: 1,
  }));
  const db: any = makeFakeDb({
    users: [{ _id: ME, name: "Me", email: "me@x.ai" }, { _id: MATE, name: "Mate", email: "mate@x.ai" }],
    team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 }, { _id: "m2", user_id: MATE, team_id: TEAM, role: "member", joined_at: 1 }],
    teams: [{ _id: TEAM, name: "Acme" }], counters: [], org_roles: [], org_role_history: [], role_wakes: [], role_wake_outbox: [], anchors: [],
    projects: [{ _id: P, user_id: ME, team_id: TEAM, workspace: WS, short_id: "pr-1", title: "Growth", status: "active", project_path: "/repo/growth", created_at: 1, updated_at: NOW }],
    plans: [], tasks, docs: [], conversations, session_owners: [], session_decisions: [], managed_sessions: [], messages: [], user_presence: [], pending_messages: [], devices: [],
  });
  const role = await performCreateRole({ db } as any, ME as any, { name: "Growth", handle: "growth", team_id: TEAM, scope: { project_ids: [P as any], plan_ids: [] } });
  let reads = 0;
  const counted = new Proxy(db, { get: (t, k) => (k === "get" || k === "query" ? (...a: any[]) => { reads++; return t[k](...a); } : t[k]) });
  const dryStart = reads;
  await takeOverSessions({ db: counted } as any, ME as any, role._id, { dry: true });
  const dry = reads - dryStart;
  const took = await takeOverSessions({ db: counted } as any, ME as any, role._id);
  const apply = reads - dry;
  console.log(`takeoverPreview (query): ${dry} reads; takeover inside the apply: ${apply} reads; moved ${took?.sessions.length}, over cap ${took?.over_cap}`);
  expect(dry).toBeLessThan(4096);
  expect(apply).toBeLessThan(4096);
  // orgProposals.acceptAll applies ACCEPT_ALL_CHUNK (12) changes through
  // ctx.runMutation inside ONE parent transaction, and a nested mutation
  // spends its parent's budget. Two role or scope changes on scopes this size
  // in one accept all are already past the limit; the chunk allows twelve.
  expect(apply * 2).toBeLessThan(4096);
});
