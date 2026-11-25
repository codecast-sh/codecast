import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { addSessionOwner, removeSessionOwner, setSessionOwners } from "./sessionOwnership";
import { isSessionOwner, listSessionPartyIds, ownerRowsForUser, sessionOwnerRow } from "./sessionOwners";
import { deliverSessionNotificationToParties } from "./lib/sessionNotify";
import { accessStampFor, authorizedFor } from "./lib/accessKeys";
import { scopesForChange, teamScopeKey } from "./syncLog";

const ASHOT = "u".repeat(31) + "a";
const JASON = "u".repeat(31) + "j";
const SAM = "u".repeat(31) + "s";
const BOT = "u".repeat(31) + "b";
const NEWBIE = "u".repeat(31) + "n";
const OUTSIDER = "u".repeat(31) + "o";
const CONV = "c".repeat(32);

function world() {
  const db = makeFakeDb({
    users: [
      { _id: ASHOT, name: "Ashot" },
      { _id: JASON, name: "Jason", notifications_enabled: true },
      { _id: SAM, name: "Sam", notifications_enabled: true },
      { _id: BOT, name: "Mr Bot", is_bot: true },
      { _id: NEWBIE, name: "Newbie", notifications_enabled: true },
      { _id: OUTSIDER, name: "Outsider" },
    ],
    teams: [{ _id: "team", name: "Union", features: { team_sessions: true } }],
    conversations: [{ _id: CONV, short_id: "jx7test", session_id: "session-test", user_id: JASON, team_id: "team", is_private: false, title: "Prompt quality guardrails", status: "active" }],
    team_memberships: [ASHOT, JASON, SAM, BOT].map((id) => ({ _id: `membership-${id}`, team_id: "team", user_id: id, role: "member" })),
    session_owners: [{ _id: "owner-0", conversation_id: CONV, user_id: JASON, added_by: JASON, added_at: 1, seen_at: 1 }],
    session_team_owners: [],
    notifications: [],
    push_outbox: [],
  });
  const ctx: any = {
    db,
    auth: { getUserIdentity: async () => ({ subject: `${ASHOT}|session`, tokenIdentifier: "test" }) },
    scheduler: { runAfter: async () => {} },
  };
  return { db, ctx, notifications: () => db._tables.notifications as any[] };
}

const invoke = (fn: any, ctx: any, args: any) => fn._handler(ctx, { session_id: CONV, ...args });

describe("a session handed to everyone on its team", () => {
  test("every person on the team owns it, hears about it once, and the actor and agents are left out", async () => {
    const { ctx, db, notifications } = world();
    const result = await invoke(addSessionOwner, ctx, { owner: "everyone", note: "Anyone free?" });
    expect(result.team).toMatchObject({ team_id: "team", name: "Union", note: "Anyone free?" });
    expect(db._tables.session_team_owners).toHaveLength(1);
    // Jason already owned it; Sam is the one newly reached. Ashot acted; the bot is no person.
    expect([...result.shared_with].sort()).toEqual([ASHOT, SAM].sort());
    const assigned = notifications().filter((n) => n.message.includes("assigned you"));
    expect(assigned.map((n) => n.recipient_user_id)).toEqual([SAM]);
    expect(assigned[0].message).toContain('"Prompt quality guardrails"');
    expect(assigned[0].message).toContain("Anyone free?");

    for (const id of [ASHOT, JASON, SAM]) expect(await isSessionOwner(ctx, CONV as any, id as any)).toBe(true);
    expect(await isSessionOwner(ctx, CONV as any, BOT as any)).toBe(false); // an agent account owns nothing a team owns
    expect(await isSessionOwner(ctx, CONV as any, OUTSIDER as any)).toBe(false);
    expect((await listSessionPartyIds(ctx, CONV as any)).map(String).sort()).toEqual([JASON, ASHOT, SAM].sort());
    // Read as Sam's own row, acknowledged: a team share draws no per-person banner.
    const samRow = await sessionOwnerRow(ctx, CONV as any, SAM as any);
    expect(samRow).toMatchObject({ user_id: SAM, added_by: ASHOT, team_id: "team" });
    expect(samRow.seen_at).toBeTruthy();
  });

  test("a member who joins later is an owner with no write, and one who leaves is not", async () => {
    const { ctx, db } = world();
    await invoke(addSessionOwner, ctx, { owner: "everyone" });
    db._tables.team_memberships.push({ _id: "membership-new", team_id: "team", user_id: NEWBIE, role: "member" });
    expect(await isSessionOwner(ctx, CONV as any, NEWBIE as any)).toBe(true);
    expect((await ownerRowsForUser(ctx, NEWBIE as any, 50)).rows.map((r) => String(r.conversation_id))).toEqual([CONV]);
    db._tables.team_memberships = db._tables.team_memberships.filter((m: any) => m.user_id !== SAM);
    expect(await isSessionOwner(ctx, CONV as any, SAM as any)).toBe(false);
  });

  test("needs-input notifications reach every person on the team", async () => {
    const { ctx, notifications } = world();
    await invoke(addSessionOwner, ctx, { owner: "everyone" });
    const before = notifications().length;
    const conversation = await ctx.db.get(CONV);
    await deliverSessionNotificationToParties(ctx, conversation, "session_idle", "Needs input", "Waiting on you");
    const rung = notifications().slice(before).map((n) => n.recipient_user_id).sort();
    expect(rung).toEqual([ASHOT, JASON, SAM].sort());
  });

  test("the access stamp grants the team key and the change fans to the team scope", async () => {
    const { ctx } = world();
    await invoke(addSessionOwner, ctx, { owner: "everyone" });
    const stamp = await accessStampFor(ctx, "conversations", await ctx.db.get(CONV));
    expect(stamp?.access_grants).toContain("team:team");
    expect(authorizedFor(stamp, SAM, new Set([`user:${SAM}`, "team:team"]))).toBe(true);
    expect(authorizedFor(stamp, OUTSIDER, new Set([`user:${OUTSIDER}`]))).toBe(false);
    const scopes = scopesForChange("conversations", { owner_user_id: JASON, grants: stamp?.access_grants } as any);
    expect(scopes).toContain(teamScopeKey("team"));
  });

  test("setting the owners without everyone, or removing everyone, takes the share off", async () => {
    const { ctx, db } = world();
    await invoke(addSessionOwner, ctx, { owner: "everyone" });
    await invoke(setSessionOwners, ctx, { owners: [JASON] });
    expect(db._tables.session_team_owners).toHaveLength(0);
    expect(await isSessionOwner(ctx, CONV as any, SAM as any)).toBe(false);

    // The team and people never own it together: everyone wins, the people come off.
    await invoke(setSessionOwners, ctx, { owners: [JASON, "everyone"] });
    expect(db._tables.session_team_owners).toHaveLength(1);
    expect(db._tables.session_owners).toHaveLength(0);
    await invoke(removeSessionOwner, ctx, { owner: "everyone" });
    expect(db._tables.session_team_owners).toHaveLength(0);
  });

  test("a session with no team cannot be shared with everyone", async () => {
    const { ctx, db } = world();
    db._tables.conversations[0].team_id = undefined;
    db._tables.conversations[0].user_id = ASHOT;
    await expect(invoke(addSessionOwner, ctx, { owner: "everyone" })).rejects.toThrow(/no team/);
  });
});
