import { describe, expect, test } from "bun:test";
import { updateAgentStatus } from "./managedSessions";
import { makeFakeDb } from "./testDb";

// The activity line names what the agent does NOW. updateAgentStatus takes the
// stamp off the conversation row when an active status settles, and leaves it
// alone when a working session re-asserts working (the per tool call path,
// which must not pay a conversation read).
const activity = { text: "running bun test", tool: "Bash", at: 100 };

function fixture(agent_status = "working") {
  const db = makeFakeDb({
    users: [{ _id: "owner" }],
    conversations: [{ _id: "conv", user_id: "owner", session_id: "session", activity }],
    managed_sessions: [{ _id: "managed", user_id: "owner", conversation_id: "conv", session_id: "session", agent_status, agent_status_updated_at: 100, last_heartbeat: 100 }],
    pending_messages: [],
  });
  const ctx = { db, auth: { getUserIdentity: async () => ({ subject: "owner|auth-session" }) }, scheduler: { runAfter: async () => {} } };
  const write = (status: string, client_ts: number) =>
    (updateAgentStatus as any)._handler(ctx, { conversation_id: "conv", agent_status: status, client_ts });
  return { db, write, conv: () => db._tables.conversations[0] };
}

describe("updateAgentStatus and conversations.activity", () => {
  test("an active status settling clears the stamp", async () => {
    const f = fixture("working");
    expect((await f.write("done", 300)).applied).toBe(true);
    expect(f.conv().activity).toBeUndefined();
  });

  test("a working re-assertion leaves the stamp alone", async () => {
    const f = fixture("working");
    expect((await f.write("working", 300)).applied).toBe(true);
    expect(f.conv().activity).toEqual(activity);
  });

  test("moving between active statuses leaves the stamp alone", async () => {
    const f = fixture("thinking");
    expect((await f.write("working", 300)).applied).toBe(true);
    expect(f.conv().activity).toEqual(activity);
  });

  test("a settle on a row with no stamp writes nothing to the conversation", async () => {
    const f = fixture("working");
    delete f.conv().activity;
    await f.write("done", 300);
    expect(f.db._patched.filter((p: any) => p._id === "conv")).toEqual([]);
  });
});
