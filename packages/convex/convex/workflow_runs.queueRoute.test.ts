// A run queued with no machine named goes to the machine that holds its
// checkout (queueRunOnDaemon). Union's line, 2026-10-14: a role's run on a
// laptop folder was taken by the cloud host's daemon, and every isolated
// station it spawned was parked on that host and failed to prepare.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { queueRunOnDaemon } from "./workflow_runs";

const HOST = "users_host" as any;
const RUN = "workflow_runs_run" as any;
const NOW = Date.now();

function seed(run: Record<string, any> = {}) {
  const tables: Record<string, any[]> = {
    users: [{ _id: HOST, name: "Host" }],
    devices: [
      { _id: "d1", user_id: HOST, device_id: "dev-laptop", platform: "darwin", is_remote: false, last_seen: NOW - 5_000, local_project_roots: ["/Users/ashot/src/union-mobile"] },
      { _id: "d2", user_id: HOST, device_id: "dev-cloud", platform: "darwin", is_remote: true, last_seen: NOW - 1_000, local_project_roots: ["/Users/codecast/src/union-mobile"] },
    ],
    conversations: [{ _id: "conversations_standing", user_id: HOST, project_path: "/Users/ashot/src/union-mobile/outreach", owner_device_id: "dev-laptop" }],
    daemon_commands: [],
    workflow_runs: [{ _id: RUN, user_id: HOST, status: "pending", project_path: "/Users/ashot/src/union-mobile/outreach", spawner_conversation_id: "conversations_standing", ...run }],
  };
  return { ctx: { db: makeFakeDb(tables) } as any, tables };
}

describe("queueRunOnDaemon", () => {
  test("a run with no machine named goes to the one holding its checkout, not the cloud host that polled first", async () => {
    const { ctx, tables } = seed();
    await queueRunOnDaemon(ctx, HOST, RUN, { slug: "line", now: NOW });
    expect(tables.daemon_commands.map((c) => c.target_device_id)).toEqual(["dev-laptop"]);
  });

  test("a named machine is kept", async () => {
    const { ctx, tables } = seed();
    await queueRunOnDaemon(ctx, HOST, RUN, { device: "dev-cloud", now: NOW });
    expect(tables.daemon_commands.map((c) => c.target_device_id)).toEqual(["dev-cloud"]);
  });

  test("a run with no folder is left for any daemon", async () => {
    const { ctx, tables } = seed({ project_path: undefined });
    await queueRunOnDaemon(ctx, HOST, RUN, { now: NOW });
    expect(tables.daemon_commands[0].target_device_id).toBeUndefined();
  });
});
