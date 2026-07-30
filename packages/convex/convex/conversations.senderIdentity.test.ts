import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { attachSenderIdentities } from "./conversations";

// A teammate's send lands in the transcript as a plain user echo; the sync path
// stamps from_user_id from the matched pending row, and read queries attach the
// sender's display identity so the UI renders the turn as the sender, not the
// conversation owner (the "teammate message shows my avatar" bug).

const OWNER = "user-owner" as any;
const TEAMMATE = "user-teammate" as any;

const db = makeFakeDb({
  users: [
    { _id: OWNER, name: "Ashot Petrosian", email: "ashot@union.app", image: "https://img/ashot.png" },
    { _id: TEAMMATE, name: "Samvit Ramadurgam", email: "samvit@union.app", github_avatar_url: "https://img/samvit.png" },
  ],
});
const ctx = { db } as any;

describe("attachSenderIdentities", () => {
  test("a teammate's user turn gets the sender's name and avatar", async () => {
    const [msg] = await attachSenderIdentities(ctx, OWNER, [
      { role: "user", from_user_id: TEAMMATE, content: "why not just contacts?" } as any,
    ]);
    expect((msg as any).sender_name).toBe("Samvit Ramadurgam");
    expect((msg as any).sender_avatar_url).toBe("https://img/samvit.png");
  });

  test("owner turns and unstamped turns stay bare", async () => {
    const msgs = await attachSenderIdentities(ctx, OWNER, [
      { role: "user", from_user_id: OWNER, content: "self send" } as any,
      { role: "user", content: "typed at the terminal" } as any,
      { role: "assistant", content: "reply" } as any,
    ]);
    for (const m of msgs) {
      expect((m as any).sender_name).toBeUndefined();
      expect((m as any).sender_avatar_url).toBeUndefined();
    }
  });

  test("a sender with no user row (deleted account) stays bare rather than mislabeled", async () => {
    const [msg] = await attachSenderIdentities(ctx, OWNER, [
      { role: "user", from_user_id: "user-gone" as any, content: "orphan" } as any,
    ]);
    expect((msg as any).sender_name).toBeUndefined();
  });
});
