// Finding a team by work email (teamDiscovery.ts): an admin opens the team to
// their own proven company domain; a coworker with a proven address there
// sees it and asks; an admin approves and they become a member. Nothing is
// revealed to free mail, to unproven addresses, or for teams not opened.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import {
  confirmWorkEmailCode,
  decideRequest,
  discoverySettings,
  pendingRequests,
  requestToJoin,
  sendWorkEmailCode,
  setDiscoverable,
  teamsForMyDomain,
  workDomain,
} from "./teamDiscovery";

const ADMIN = "user-admin" as any;   // github sign-in at acme.dev
const COWORKER = "user-cow" as any;  // github sign-in at acme.dev
const UNPROVEN = "user-pw" as any;   // password sign-in at acme.dev
const GMAIL = "user-gmail" as any;   // github sign-in at gmail.com
const MEMBER = "user-member" as any; // already on the team
const TEAM = "team-acme" as any;

function seed() {
  return makeFakeDb({
    users: [
      { _id: ADMIN, name: "Ada", email: "ada@acme.dev", team_id: TEAM, role: "admin" },
      { _id: COWORKER, name: "Cy", email: "cy@acme.dev" },
      { _id: UNPROVEN, name: "Pat", email: "pat@acme.dev" },
      { _id: GMAIL, name: "Gus", email: "gus@gmail.com" },
      { _id: MEMBER, name: "Mo", email: "mo@acme.dev", team_id: TEAM, role: "member" },
    ],
    authAccounts: [
      { _id: "acc-admin", userId: ADMIN, provider: "github", providerAccountId: "1" },
      { _id: "acc-cow", userId: COWORKER, provider: "github", providerAccountId: "2" },
      { _id: "acc-pw", userId: UNPROVEN, provider: "password", providerAccountId: "pat@acme.dev" },
      { _id: "acc-gmail", userId: GMAIL, provider: "github", providerAccountId: "3" },
      { _id: "acc-member", userId: MEMBER, provider: "github", providerAccountId: "4" },
    ],
    teams: [{ _id: TEAM, name: "Acme", invite_code: "ACME1234", created_at: 1 }],
    team_memberships: [
      { _id: "m-admin", user_id: ADMIN, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m-member", user_id: MEMBER, team_id: TEAM, role: "member", joined_at: 2 },
    ],
    team_join_requests: [], work_email_codes: [], rate_limits: [], authority_events: [], notifications: [],
  });
}

function ctxFor(db: any, user: string | null, scheduled: any[] = []) {
  return {
    db,
    auth: { async getUserIdentity() { return user ? { subject: `${user}|session` } : null; } },
    scheduler: { async runAfter(_ms: number, fn: any, args: any) { scheduled.push(args); return undefined; } },
  } as any;
}
const call = (fn: any, db: any, user: string | null, args: any = {}, scheduled: any[] = []) => fn._handler(ctxFor(db, user, scheduled), args);

describe("workDomain", () => {
  test("company domains only", () => {
    expect(workDomain("Ada@Acme.dev")).toBe("acme.dev");
    expect(workDomain("gus@gmail.com")).toBeNull();
    expect(workDomain("x@privaterelay.appleid.com")).toBeNull();
    expect(workDomain("nope")).toBeNull();
    expect(workDomain(undefined)).toBeNull();
  });
});

describe("opening a team to a domain", () => {
  test("an admin opens it to their own proven domain; a member cannot", async () => {
    const db = seed();
    await expect(call(setDiscoverable, db, MEMBER, { team_id: TEAM, enabled: true })).rejects.toThrow(/admins/);
    expect(await call(discoverySettings, db, ADMIN, { team_id: TEAM })).toEqual({ enabled_domain: null, admin_domain: "acme.dev", admin_domain_proven: true });
    expect(await call(setDiscoverable, db, ADMIN, { team_id: TEAM, enabled: true })).toEqual({ domain: "acme.dev" });
    expect((await db.get(TEAM)).discoverable_domain).toBe("acme.dev");
    await call(setDiscoverable, db, ADMIN, { team_id: TEAM, enabled: false });
    expect((await db.get(TEAM)).discoverable_domain).toBeUndefined();
  });

  test("an admin on free mail has no domain to open", async () => {
    const db = seed();
    await db.patch(ADMIN, { email: "ada@gmail.com" });
    await expect(call(setDiscoverable, db, ADMIN, { team_id: TEAM, enabled: true })).rejects.toThrow(/not a work address/);
  });
});

describe("finding and joining", () => {
  test("nothing shows before the team opens", async () => {
    const db = seed();
    expect(await call(teamsForMyDomain, db, COWORKER)).toBeNull();
  });

  test("a proven coworker sees the team, asks, and an admin lets them in", async () => {
    const db = seed();
    await call(setDiscoverable, db, ADMIN, { team_id: TEAM, enabled: true });
    const found = await call(teamsForMyDomain, db, COWORKER);
    expect(found.needs_proof).toBe(false);
    expect(found.teams.map((t: any) => [t.name, t.member_count, t.request])).toEqual([["Acme", 2, "none"]]);

    const scheduled: any[] = [];
    expect(await call(requestToJoin, db, COWORKER, { team_id: TEAM }, scheduled)).toEqual({ status: "pending" });
    expect(scheduled.filter((s) => s.event_type === "team_join_request").map((s) => [s.direct_recipient_id, s.message])).toEqual([[ADMIN, "Cy (cy@acme.dev) asked to join Acme."]]);
    expect((await call(teamsForMyDomain, db, COWORKER)).teams[0].request).toBe("pending");
    // Asking twice keeps one pending request.
    await call(requestToJoin, db, COWORKER, { team_id: TEAM });
    const pending = await call(pendingRequests, db, ADMIN, { team_id: TEAM });
    expect(pending.map((r: any) => r.email)).toEqual(["cy@acme.dev"]);
    expect(await call(pendingRequests, db, MEMBER, { team_id: TEAM })).toEqual([]);

    await expect(call(decideRequest, db, MEMBER, { request_id: pending[0]._id, approve: true })).rejects.toThrow(/admins/);
    const done: any[] = [];
    expect(await call(decideRequest, db, ADMIN, { request_id: pending[0]._id, approve: true }, done)).toEqual({ status: "approved" });
    const membership = await db.query("team_memberships").withIndex("by_user_team", (q: any) => q.eq("user_id", COWORKER).eq("team_id", TEAM)).first();
    expect(membership?.role).toBe("member");
    expect(done.some((s) => s.event_type === "team_join_approved" && s.direct_recipient_id === COWORKER)).toBe(true);
    // A member no longer sees the team as one to join.
    expect(await call(teamsForMyDomain, db, COWORKER)).toBeNull();
  });

  test("a declined request cannot be re-sent the same day", async () => {
    const db = seed();
    await call(setDiscoverable, db, ADMIN, { team_id: TEAM, enabled: true });
    await call(requestToJoin, db, COWORKER, { team_id: TEAM });
    const [req] = await call(pendingRequests, db, ADMIN, { team_id: TEAM });
    await call(decideRequest, db, ADMIN, { request_id: req._id, approve: false });
    expect(await call(requestToJoin, db, COWORKER, { team_id: TEAM })).toEqual({ status: "declined" });
    expect(await call(pendingRequests, db, ADMIN, { team_id: TEAM })).toEqual([]);
  });

  test("an unproven address learns only that a team may be waiting, and cannot ask", async () => {
    const db = seed();
    await call(setDiscoverable, db, ADMIN, { team_id: TEAM, enabled: true });
    expect(await call(teamsForMyDomain, db, UNPROVEN)).toEqual({ domain: "acme.dev", needs_proof: true, teams: [] });
    await expect(call(requestToJoin, db, UNPROVEN, { team_id: TEAM })).rejects.toThrow(/Confirm you hold/);
  });

  test("free mail never matches", async () => {
    const db = seed();
    await call(setDiscoverable, db, ADMIN, { team_id: TEAM, enabled: true });
    expect(await call(teamsForMyDomain, db, GMAIL)).toBeNull();
    await expect(call(requestToJoin, db, GMAIL, { team_id: TEAM })).rejects.toThrow(/not open/);
  });
});

describe("proving an address with a code", () => {
  test("the emailed code proves it; a wrong one counts against five tries", async () => {
    const db = seed();
    await call(setDiscoverable, db, ADMIN, { team_id: TEAM, enabled: true });
    const scheduled: any[] = [];
    expect(await call(sendWorkEmailCode, db, UNPROVEN, {}, scheduled)).toEqual({ sent_to: "pat@acme.dev" });
    const { code, email } = scheduled[0];
    expect(email).toBe("pat@acme.dev");
    expect(code).toMatch(/^\d{6}$/);
    // Only a hash is stored.
    const row = (await db.query("work_email_codes").withIndex("by_user", (q: any) => q.eq("user_id", UNPROVEN)).first());
    expect(JSON.stringify(row)).not.toContain(code);

    await expect(call(confirmWorkEmailCode, db, UNPROVEN, { code: code === "111111" ? "222222" : "111111" })).rejects.toThrow(/not right/);
    expect(await call(confirmWorkEmailCode, db, UNPROVEN, { code })).toEqual({ proven: true });
    expect((await db.get(UNPROVEN)).emailVerificationTime).toBeGreaterThan(0);
    expect((await call(teamsForMyDomain, db, UNPROVEN)).teams.map((t: any) => t.name)).toEqual(["Acme"]);
  });

  test("free mail cannot ask for a code", async () => {
    const db = seed();
    await expect(call(sendWorkEmailCode, db, GMAIL)).rejects.toThrow(/work addresses/);
  });
});
