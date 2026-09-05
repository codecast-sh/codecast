import { expect, test } from "bun:test";
import { computeInboxSessions } from "./conversations";
import { makeFakeDb } from "./testDb";

for (const fastFieldsInOverlay of [false, true]) {
  test(`nested cloud location survives inbox projection (overlay=${fastFieldsInOverlay})`, async () => {
    const now = Date.now();
    const common = { user_id: "users_me", status: "active", updated_at: now, started_at: now, message_count: 2, last_message_role: "assistant" };
    const db = makeFakeDb({
      users: [{ _id: "users_me", name: "Me", email: "me@example.com" }],
      conversations: [
        { ...common, _id: "conversations_parent" },
        { ...common, _id: "conversations_child", is_subagent: true, parent_conversation_id: "conversations_parent", owner_device_id: "cloud-device", worktree_name: "cloud-a", worktree_branch: "codecast/cloud-a", cloud_placement: "pending" },
        { ...common, _id: "conversations_local", is_subagent: true, parent_conversation_id: "conversations_parent" },
      ],
      session_owners: [], managed_sessions: [], messages: [],
    });
    const { sessions } = await computeInboxSessions({ db }, "users_me" as any, { show_all: false, includeLiveness: !fastFieldsInOverlay, fastFieldsInOverlay });
    const child = sessions.find((s: any) => s._id === "conversations_child");
    expect(child?.parent_conversation_id).toBe("conversations_parent");
    expect(child?.owner_device_id).toBe("cloud-device");
    expect(child?.cloud_placement).toBe("pending");
    expect(child?.worktree_name).toBe("cloud-a");
    expect(child?.worktree_branch).toBe("codecast/cloud-a");
    const local = sessions.find((s: any) => s._id === "conversations_local");
    expect(local?.owner_device_id).toBeNull();
    expect(local?.cloud_placement).toBeNull();
  });
}
