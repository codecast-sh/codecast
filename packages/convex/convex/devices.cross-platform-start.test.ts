import { expect, test } from "bun:test";
import { enqueueStartSession } from "./devices";
import { DEVICE_ONLINE_MS } from "./deviceRouting";
import { makeFakeDb } from "./testDb";

test("a Codex start and its ownership queue for the offline checkout holder instead of an incompatible live runtime", async () => {
  const user = "users_1" as any;
  const conversation = "conversations_1" as any;
  const path = "/Users/ashot/src/codecast";
  const db = makeFakeDb({
    users: [{ _id: user }],
    conversations: [{ _id: conversation, user_id: user, agent_type: "codex", project_path: path }],
    devices: [
      { _id: "devices_1", user_id: user, device_id: "mac", platform: "darwin", is_remote: false, last_seen: Date.now() - DEVICE_ONLINE_MS - 1000, local_project_roots: [path] },
      { _id: "devices_2", user_id: user, device_id: "runtime", platform: "linux", is_remote: false, last_seen: Date.now(), local_project_roots: ["/home/hatch/.codex"] },
    ],
    daemon_commands: [],
  });
  await enqueueStartSession({ db }, user, { conversationId: conversation, agentType: "codex" });
  expect(db._tables.conversations[0].owner_device_id).toBe("mac");
  expect(db._tables.daemon_commands).toHaveLength(1);
  const command = db._tables.daemon_commands[0];
  expect(command.target_device_id).toBe("mac");
  expect(JSON.parse(command.args)).toMatchObject({ conversation_id: conversation, agent_type: "codex", project_path: path });
});
