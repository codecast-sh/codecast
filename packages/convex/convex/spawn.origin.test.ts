import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { createSessionFromCli } from "./spawn";
import { nestParentIdOf, isSubagentConversation } from "./ccAccountsShared";
import { rollupParentIdOf } from "@codecast/shared/contracts";

const OWNER = "spawn-owner";
const PARENT = { _id: "parent-conversation", user_id: OWNER, session_id: "parent-uuid", short_id: "parent-" };
const FOREIGN = { _id: "foreign-conversation", user_id: "someone-else", session_id: "foreign-uuid" };

async function spawn(args: Record<string, unknown>) {
  const db = makeFakeDb({
    users: [{ _id: OWNER }],
    conversations: [PARENT, FOREIGN],
    managed_sessions: [{ _id: "managed-codex", user_id: OWNER, session_id: "codex-uuid", conversation_id: PARENT._id }],
  });
  const ctx = { db, auth: { getUserIdentity: async () => ({ subject: `${OWNER}|session` }) } };
  const result = await (createSessionFromCli as any)._handler(ctx, { agent_type: "codex", ...args });
  return { db, result, row: await db.get(result.conversation_id) };
}

describe("plain spawn origin", () => {
  test.each([PARENT.session_id, PARENT.short_id, PARENT._id, "codex-uuid"])("persists caller %s without nesting", async (spawner_session) => {
    const { row, result, db } = await spawn({ spawner_session });
    expect(row.spawned_by_conversation_id).toBe(PARENT._id);
    expect(isSubagentConversation(row)).toBe(false);
    expect(nestParentIdOf(row)).toBeNull();
    expect(rollupParentIdOf(row)).toBeNull();
    expect(result.parent_short_id).toBeUndefined();
    expect(db._inserted.some((entry: any) => entry.table === "daemon_commands")).toBe(true);
  });

  test.each([undefined, "unknown-session", FOREIGN.session_id])("does not invent an origin for %s", async (spawner_session) => {
    const { row } = await spawn({ spawner_session });
    expect(row.spawned_by_conversation_id).toBeUndefined();
    expect(nestParentIdOf(row)).toBeNull();
  });

  test("explicit subagent parent still owns nesting", async () => {
    const { row } = await spawn({ spawner_session: "codex-uuid", parent_session: PARENT.session_id });
    expect(row.spawned_by_conversation_id).toBe(PARENT._id);
    expect(isSubagentConversation(row)).toBe(true);
    expect(nestParentIdOf(row)).toBe(PARENT._id);
    expect(rollupParentIdOf(row)).toBe(PARENT._id);
  });

  test("a spawned session leading its own team stays independent", async () => {
    const { row } = await spawn({ spawner_session: PARENT.session_id });
    const lead = { ...row, agent_team_name: "worker-team", agent_name: "team-lead" };
    expect(nestParentIdOf(lead)).toBeNull();
    expect(rollupParentIdOf(lead)).toBeNull();
    const teammate = { ...lead, agent_name: "reviewer" };
    expect(nestParentIdOf(teammate)).toBe(PARENT._id);
    expect(rollupParentIdOf(teammate)).toBe(PARENT._id);
  });
});
