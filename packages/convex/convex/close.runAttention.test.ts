// A spawned run that completes --needs-attention asks for the person: its
// closed owner comes back, although the notice that wakes it is a machine wake
// (agentTasks wakeRunOwner). A run that only finished leaves it out.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { completeTaskRun } from "./agentTasks";
import { hashToken } from "./apiTokens";
import { makeFakeDb } from "./testDb";

const NOW = 1_800_000_000_000;
const USER = "users_owner";
const OWNER = "conversations_owner";
const RUN = "conversations_run";
const TOKEN = "run-attention-token";
const DAEMON = "daemon-1";

let time: any;
beforeEach(() => { time = spyOn(Date, "now").mockReturnValue(NOW); });
afterEach(() => time.mockRestore());

async function closedOwnerRun(needsAttention: boolean) {
  const closedAt = NOW - 60_000;
  const tables: Record<string, any[]> = {
    agent_tasks: [{ _id: "agent_tasks_owned", _creationTime: 1, user_id: USER, short_id: "tr-1", created_by_conversation_id: OWNER, title: "sweep", prompt: "sweep", schedule_type: "once", status: "running", lease_holder: DAEMON, lease_expires_at: NOW + 60_000, run_at: NOW - 1, run_count: 0, retry_count: 0, max_retries: 3, mode: "apply", created_at: 1 }],
    conversations: [
      { _id: OWNER, user_id: USER, session_id: "owner", status: "active", owner_device_id: "laptop", inbox_dismissed_at: closedAt, inbox_closed_at: closedAt },
      { _id: RUN, _creationTime: NOW - 1000, user_id: USER, session_id: "run-uuid", status: "active", short_id: "jx74v0r", agent_task_id: "agent_tasks_owned" },
    ],
    devices: [],
    api_tokens: [{ _id: "api_tokens_owner", user_id: USER, token_hash: await hashToken(TOKEN) }],
    pending_messages: [],
  };
  const ctx = { db: makeFakeDb(tables), scheduler: { runAfter: async () => {} } };
  await (completeTaskRun as any)._handler(ctx, { api_token: TOKEN, task_id: "agent_tasks_owned", summary: "One park never resumed.", needs_attention: needsAttention, run_session_uuid: "run-uuid" });
  return { owner: tables.conversations.find((c) => c._id === OWNER), wakes: tables.pending_messages.length, closedAt };
}

test("a run asking for attention brings its closed owner back", async () => {
  const { owner, wakes } = await closedOwnerRun(true);
  expect(wakes).toBe(1);
  expect(owner.inbox_dismissed_at).toBeUndefined();
  expect(owner.inbox_stashed_at).toBeUndefined();
});

test("a run that only finished leaves its closed owner out", async () => {
  const { owner, closedAt } = await closedOwnerRun(false);
  expect(owner.inbox_dismissed_at === closedAt || owner.inbox_stashed_at === closedAt).toBe(true);
});
