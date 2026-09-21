import { describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { getMyCalls, invite, joinRoom, leaveRoom, respondInvite } from "./calls";
import { makeFakeDb } from "./testDb";

const call = (fn: any, ctx: any, args: any = {}) => fn._handler(ctx, args);

function setup(kind = "public", count = 3) {
  const users = Array.from({ length: count }, (_, i) => ({
    _id: `u${i}`, name: `Member ${i}`, push_token: `push-${i}`, notifications_enabled: true,
  }));
  const db = makeFakeDb({
    teams: [{ _id: "team", features: { calls: true, chat: true } }],
    users: [...users, { _id: "bot", is_bot: true }, { _id: "outsider" }],
    team_memberships: [...users, { _id: "bot" }].map((u, i) => ({ _id: `tm${i}`, team_id: "team", user_id: u._id })),
    chat_channels: [{ _id: "channel", team_id: "team", name: "design", kind }],
    chat_channel_members: users.slice(0, 2).map((u, i) => ({ _id: `cm${i}`, channel_id: "channel", user_id: u._id })),
  });
  const scheduled: { name: string; args: any }[] = [];
  const as = (userId: string) => ({
    db,
    auth: { getUserIdentity: async () => ({ subject: `${userId}|session`, tokenIdentifier: userId }) },
    scheduler: { runAfter: async (_ms: number, fn: any, args: any) => { scheduled.push({ name: getFunctionName(fn), args }); } },
  });
  const ring = () => call(invite, as("u0"), { room_key: "channel:channel", ring_channel: true });
  return { db, scheduled, as, ring };
}

describe("channel huddle lifecycle", () => {
  test("rings the channel, reaches incoming calls and push, accepts, and cancels unanswered rings on hangup", async () => {
    const s = setup();
    await call(joinRoom, s.as("u0"), { room_key: "channel:channel", muted: false });
    await s.ring();
    expect(s.db._tables.call_invites.map((i: any) => i.to_user).sort()).toEqual(["u1", "u2"]);
    expect(s.scheduled.filter((s) => s.name === "notifications:sendPushNotification").map((s) => s.args.user_id).sort()).toEqual(["u1", "u2"]);
    const incoming = (await call(getMyCalls, s.as("u1"))).incoming;
    expect(incoming).toHaveLength(1);
    expect(incoming[0]).toMatchObject({ anchor_title: "#design", from_name: "Member 0", room_key: "channel:channel" });
    await call(respondInvite, s.as("u1"), { invite_id: incoming[0]._id, accept: true });
    await call(joinRoom, s.as("u1"), { room_key: "channel:channel", muted: true });
    expect((await call(getMyCalls, s.as("u1"))).incoming).toHaveLength(0);
    expect((await call(getMyCalls, s.as("u1"))).membership.room_key).toBe("channel:channel");
    await call(leaveRoom, s.as("u0"), { room_key: "channel:channel" });
    expect((await call(getMyCalls, s.as("u2"))).incoming).toHaveLength(0);
  });

  test("private channels ring only current human members", async () => {
    const s = setup("private");
    s.db._tables.chat_channel_members.push({ _id: "old", channel_id: "channel", user_id: "outsider" });
    await s.ring();
    expect(s.db._tables.call_invites.map((i: any) => i.to_user)).toEqual(["u1"]);
    await expect(call(invite, s.as("u2"), { room_key: "channel:channel", ring_channel: true })).rejects.toThrow("Cannot invite");
  });

  test("channels larger than the direct-message limit ring every member", async () => {
    const s = setup("public", 15);
    await s.ring();
    expect(s.db._tables.call_invites).toHaveLength(14);
    await s.ring();
    expect(s.db._tables.call_invites).toHaveLength(14);
    expect(s.scheduled.filter((s) => s.name === "notifications:sendPushNotification")).toHaveLength(14);
  });

  test("busy members ring quietly and members already seated are skipped", async () => {
    const s = setup();
    await s.db.patch("u1", { status: "busy" });
    await call(joinRoom, s.as("u2"), { room_key: "channel:channel", muted: true });
    const result = await s.ring();
    expect(result.results).toEqual([
      { to_user: "u1", busy: true, cooldown: false },
      { to_user: "u2", busy: false, cooldown: false, in_room: true },
    ]);
    expect(s.scheduled.filter((s) => s.name === "notifications:sendPushNotification")).toHaveLength(0);
  });

  test("a one-person channel starts without an invite and channel fan-out cannot target a DM", async () => {
    const s = setup("public", 1);
    expect((await s.ring()).results).toEqual([]);
    await expect(call(invite, setup().as("u0"), { room_key: "dm:u0:u1", ring_channel: true })).rejects.toThrow("Only channel");
  });

  test("archived channels and outsiders cannot ring the channel", async () => {
    const s = setup();
    await expect(call(invite, s.as("outsider"), { room_key: "channel:channel", ring_channel: true })).rejects.toThrow("Cannot invite");
    await s.db.patch("channel", { archived_at: Date.now() });
    await expect(s.ring()).rejects.toThrow();
    expect(s.db._tables.call_invites ?? []).toHaveLength(0);
  });
});
