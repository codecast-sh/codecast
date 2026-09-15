import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { addSessionOwner, removeSessionOwner, setSessionOwner, setSessionOwners } from "./sessionOwnership";
import { performReparentSessionToDevice } from "./devices";
import { performPushFlush, summarizePushBatch } from "./pushRouter";

const ASHOT = "u".repeat(31) + "a";
const JASON = "u".repeat(31) + "j";
const SAM = "u".repeat(31) + "s";
const CONV = "c".repeat(32);

function world(ownerIds: string[] = [SAM]) {
  const db = makeFakeDb({
    users: [
      { _id: ASHOT, name: "Ashot" },
      { _id: JASON, name: "Jason", notifications_enabled: true, push_token: "push-jason" },
      { _id: SAM, name: "Sam", notifications_enabled: true, push_token: "push-sam" },
    ],
    conversations: [{ _id: CONV, short_id: "jx7test", session_id: "session-test", user_id: JASON, owner_device_id: "jason-mac", team_id: "team", is_private: false, title: "Same-side grader eval", status: "active" }],
    team_memberships: [ASHOT, JASON, SAM].map((id) => ({ _id: `membership-${id}`, team_id: "team", user_id: id, visibility: "full" })),
    session_owners: ownerIds.map((id, i) => ({ _id: `owner-${i}`, conversation_id: CONV, user_id: id, added_at: i })),
    devices: [
      { _id: "device-jason", device_id: "jason-mac", user_id: JASON, label: "Jason’s MacBook" },
      { _id: "device-ashot", device_id: "ashot-mac", user_id: ASHOT, label: "Ashot’s MacBook" },
    ],
    notifications: [],
    push_outbox: [],
  });
  const scheduled: any[] = [];
  const ctx: any = {
    db,
    auth: { getUserIdentity: async () => ({ subject: `${ASHOT}|session`, tokenIdentifier: "test" }) },
    scheduler: { runAfter: async (_delay: number, _fn: any, args: any) => { scheduled.push(args); } },
  };
  return { db, ctx, scheduled, notifications: () => db._tables.notifications };
}

const invoke = (fn: any, ctx: any, args: any) => fn._handler(ctx, { session_id: CONV, ...args });

describe("ownership changes notify the people affected", () => {
  test("grouped takeover pushes do not claim the sessions were assigned to the recipient", () => {
    const batch = summarizePushBatch([1, 2].map(() => ({ type: "session_assigned", title: "Session ownership changed", body: "Ashot took ownership" })));
    expect(batch.body).toContain("session ownership updates");
    expect(batch.body).not.toContain("assigned to you");
  });
  test("teammate self-claim tells the runner and existing owners, with one mobile push each", async () => {
    const { ctx, db, notifications, scheduled } = world([SAM, JASON]);
    await invoke(addSessionOwner, ctx, {});
    expect(notifications().map((n: any) => n.recipient_user_id).sort()).toEqual([JASON, SAM].sort());
    const runnerNotice = notifications().find((n: any) => n.recipient_user_id === JASON);
    expect(runnerNotice.message).toContain('Ashot took ownership of "Same-side grader eval".');
    expect(runnerNotice.message).toContain("It still runs on your account and machine.");
    expect(notifications().find((n: any) => n.recipient_user_id === SAM).message).toContain("You remain an owner.");
    expect(db._tables.conversations[0].user_id).toBe(JASON);
    expect(db._tables.conversations[0].owner_device_id).toBe("jason-mac");
    await performPushFlush(ctx, JASON);
    await performPushFlush(ctx, SAM);
    const pushes = scheduled.filter((s) => s.push_token);
    expect(pushes.map((p) => p.push_token).sort()).toEqual(["push-jason", "push-sam"]);
    expect(pushes.every((p) => p.body.includes("Ashot took ownership"))).toBe(true);
    expect(pushes.every((p) => p.data.conversationId === CONV)).toBe(true);
    await invoke(addSessionOwner, ctx, {});
    expect(notifications()).toHaveLength(2);
  });

  test("replacement tells the removed owner exactly what changed", async () => {
    const { ctx, notifications } = world([JASON]);
    await invoke(setSessionOwners, ctx, { owners: [ASHOT] });
    expect(notifications()).toHaveLength(1);
    expect(notifications()[0].recipient_user_id).toBe(JASON);
    expect(notifications()[0].message).toContain("You were removed as an owner.");
    expect(notifications()[0].message).toContain("Owners: Ashot.");
  });

  test("single-owner compatibility API also notifies the previous owner", async () => {
    const { ctx, notifications } = world([SAM]);
    await invoke(setSessionOwner, ctx, { owner: "me" });
    expect(notifications().find((n: any) => n.recipient_user_id === SAM).message).toContain("You were removed as an owner.");
  });

  test("removal through the checkbox notifies once and never pings the actor", async () => {
    const { ctx, notifications } = world([SAM, ASHOT]);
    await invoke(removeSessionOwner, ctx, { owner: SAM });
    expect(notifications().find((n: any) => n.recipient_user_id === SAM).message).toContain("You were removed as an owner.");
    expect(notifications().some((n: any) => n.recipient_user_id === ASHOT)).toBe(false);
    const count = notifications().length;
    await invoke(removeSessionOwner, ctx, { owner: SAM });
    expect(notifications()).toHaveLength(count);
  });

  test("assigning another person preserves their existing assigned-to-you notification", async () => {
    const { ctx, notifications } = world([]);
    await invoke(addSessionOwner, ctx, { owner: SAM, note: "Please review" });
    const sam = notifications().filter((n: any) => n.recipient_user_id === SAM);
    expect(sam).toHaveLength(1);
    expect(sam[0].message).toContain("Ashot assigned you");
    expect(sam[0].message).toContain("Please review");
    expect(notifications().find((n: any) => n.recipient_user_id === JASON).message).toContain("Ashot added Sam as an owner");
  });

  test("notification preferences are honored", async () => {
    const { ctx, db, notifications } = world([]);
    db._tables.users.find((u: any) => u._id === JASON).notification_preferences = { session_assigned: false };
    await invoke(addSessionOwner, ctx, {});
    expect(notifications()).toHaveLength(0);
    expect(db._tables.push_outbox).toHaveLength(0);
  });

  test("a share-link viewer cannot claim or generate takeover notifications", async () => {
    const { ctx, db, notifications } = world([]);
    db._tables.conversations[0].is_private = true;
    db._tables.conversations[0].share_token = "shared";
    db._tables.share_redemptions = [{ _id: "redemption", conversation_id: CONV, user_id: ASHOT, share_token: "shared" }];
    await expect(invoke(addSessionOwner, ctx, {})).rejects.toThrow(/No session found/);
    expect(notifications()).toHaveLength(0);
    expect(db._tables.session_owners).toHaveLength(0);
  });

  test("moving execution tells the previous runner where it went and whose account pays", async () => {
    const { ctx, db, notifications } = world([ASHOT, SAM, JASON]);
    await performReparentSessionToDevice(ctx, ASHOT as any, { session_id: CONV, device_id: "ashot-mac" });
    expect(notifications().map((n: any) => n.recipient_user_id).sort()).toEqual([JASON, SAM].sort());
    const message = notifications()[0].message;
    expect(message).toContain("Ashot took over execution");
    expect(message).toContain("from Jason’s MacBook to Ashot’s MacBook");
    expect(message).toContain("under Ashot's account and billing");
    expect(message).toContain("has been told to stop its copy");
    expect(message).toContain("Assigned owners are unchanged");
    expect(db._tables.conversations[0].user_id).toBe(ASHOT);
    expect(db._tables.session_owners).toHaveLength(3);
    await performReparentSessionToDevice(ctx, ASHOT as any, { session_id: CONV, device_id: "ashot-mac" });
    expect(notifications()).toHaveLength(2);
  });
});
