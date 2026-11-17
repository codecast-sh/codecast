import { expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { getDueTasks } from "./agentTasks";

const task = (i: number, device?: string) => ({
  _id: `agent_tasks_${device ?? "none"}_${i}`,
  user_id: "users_one",
  created_device_id: device,
  title: `t${i}`,
  prompt: "p",
  short_id: `tr-${i}`,
  status: "scheduled",
  schedule_type: "recurring",
  interval_ms: 60_000,
  run_at: i,
  run_count: 0,
  retry_count: 0,
  max_retries: 3,
});

async function due(rows: any[], limit: number) {
  const tables: any = {
    agent_tasks: rows,
    users: [{ _id: "users_one" }],
    api_tokens: [{ _id: "api_tokens_one", user_id: "users_one", token_hash: await hashToken("test") }],
  };
  const ctx = { db: makeFakeDb(tables), auth: { getUserIdentity: async () => null }, scheduler: { runAfter: async () => null } } as any;
  return ((await (getDueTasks as any)._handler(ctx, { api_token: "test", limit })) as any[]).map((t) => t._id);
}

test("an offline device's backlog cannot hide another device's due triggers (ct-95422)", async () => {
  const offline = Array.from({ length: 12 }, (_, i) => task(i + 1, "dev_offline"));
  const ids = await due([...offline, task(100, "dev_mini"), task(101)], 10);
  expect(ids).toContain("agent_tasks_dev_mini_100");
  expect(ids).toContain("agent_tasks_none_101");
  expect(ids.filter((id) => id.includes("dev_offline"))).toHaveLength(10);
  expect(ids.slice(0, 10)).toEqual(offline.slice(0, 10).map((t) => t._id));
});

test("each device still gets its oldest due triggers first, up to the limit", async () => {
  const ids = await due([task(1, "a"), task(2, "b"), task(3, "a"), task(4, "a"), task(5, "b")], 2);
  expect(ids).toEqual(["agent_tasks_a_1", "agent_tasks_b_2", "agent_tasks_a_3", "agent_tasks_b_5"]);
});
