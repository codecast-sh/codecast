import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { createSessionFromCli } from "./spawn";
import { nestParentIdOf, isSubagentConversation, isAgentTeamWorker } from "./ccAccountsShared";
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
    expect(isAgentTeamWorker(lead)).toBe(false);
    expect(nestParentIdOf(lead)).toBeNull();
    expect(rollupParentIdOf(lead)).toBeNull();
    const teammate = { ...lead, agent_name: "reviewer" };
    expect(isAgentTeamWorker(teammate)).toBe(true);
    expect(nestParentIdOf(teammate)).toBe(PARENT._id);
    expect(rollupParentIdOf(teammate)).toBe(PARENT._id);
  });

  test("isAgentTeamWorker does not need the lead link", () => {
    expect(isAgentTeamWorker({ agent_team_name: "t", agent_name: "reviewer" })).toBe(true);
    expect(isAgentTeamWorker({ agent_team_name: "t", agent_name: "team-lead" })).toBe(false);
    expect(isAgentTeamWorker({})).toBe(false);
  });
});

describe("a shared cloud park from the CLI", () => {
  const park = async (devices: any[], cloud_device_id = "box") => {
    const db = makeFakeDb({
      users: [{ _id: OWNER }],
      conversations: [],
      devices,
    });
    const ctx = { db, auth: { getUserIdentity: async () => ({ subject: `${OWNER}|session` }) } };
    return await (createSessionFromCli as any)._handler(ctx, {
      agent_type: "codex",
      project_path: "/home/ubuntu/work/codecast",
      cloud_workspace: "shared",
      cloud_device_id,
      cloud_checkout_path: "/home/ubuntu/work/codecast",
    });
  };
  const host = { _id: "dev_box", user_id: OWNER, device_id: "box", is_remote: true, platform: "linux", last_seen: Date.now() };

  test("the row parks on the caller's own cloud host", async () => {
    const r = await park([host]);
    expect(r.conversation_id).toBeTruthy();
  });

  test("a device that is not the caller's wake-on-use host is refused, so no row claims the checkout", async () => {
    // Somebody else's host, a laptop of the caller's, and an id of nothing.
    await expect(park([{ ...host, user_id: "someone-else" }])).rejects.toThrow("Not a cloud host you own");
    await expect(park([{ ...host, is_remote: false }])).rejects.toThrow("Not a cloud host you own");
    await expect(park([host], "not-a-device")).rejects.toThrow("Not a cloud host you own");
  });
});
