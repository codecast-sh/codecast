import { describe, expect, test } from "bun:test";
import { collectMigrationCandidates } from "./sessionMigrations";
import { makeFakeDb } from "./testDb";

const USER = "users_me" as any;
const LAPTOP = "laptop";

describe("collectMigrationCandidates", () => {
  // A machine that spawns workers creates hundreds of conversations a day, so a
  // session started yesterday is past the per-device creation window while it is
  // still running. The resource sheet then had nothing to judge it by.
  test("a live session older than the newest 300 is still a candidate", async () => {
    const now = Date.now();
    const conversations = [
      { _id: "conversations_old", _creationTime: 1, user_id: USER, owner_device_id: LAPTOP, status: "active", agent_type: "claude_code" },
      ...Array.from({ length: 300 }, (_, i) => ({ _id: `conversations_${i}`, _creationTime: 100 + i, user_id: USER, owner_device_id: LAPTOP, status: "active" })),
    ];
    const managed_sessions = [{ _id: "managed_sessions_1", user_id: USER, conversation_id: "conversations_old", last_heartbeat: now - 30_000 }];
    const ctx = { db: makeFakeDb({ conversations, managed_sessions }) } as any;
    const ids = (await collectMigrationCandidates(ctx, USER, [{ device_id: LAPTOP }])).map((c) => String(c._id));
    expect(ids).toContain("conversations_old");
    expect(ids.filter((id) => id === "conversations_old").length).toBe(1);
  });
});
