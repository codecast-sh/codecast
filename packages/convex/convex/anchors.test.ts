import { describe, expect, test } from "bun:test";
import { userCanAccessAnchor, userCanAdminAnchor, visibleAnchorsForUser } from "./anchors";
import { makeFakeDb } from "./testDb";

// These guard the multi-tenant boundary: a regression here re-opens the
// run-as-host / cross-team authorization holes the adversarial review caught.

const ME = "users_me" as any;
const STRANGER = "users_stranger" as any;
const TEAMMATE = "users_teammate" as any;
const TEAM = "teams_acme" as any;

function ctxWith(tables: Record<string, any[]>) {
  return { db: makeFakeDb(tables) } as any;
}

describe("userCanAdminAnchor", () => {
  test("the host can admin", async () => {
    const ctx = ctxWith({ team_memberships: [] });
    expect(await userCanAdminAnchor(ctx, ME, { host_user_id: ME } as any)).toBe(true);
  });
  test("the personal-anchor owner can admin", async () => {
    const ctx = ctxWith({ team_memberships: [] });
    expect(await userCanAdminAnchor(ctx, ME, { host_user_id: STRANGER, scope_user_id: ME } as any)).toBe(true);
  });
  test("a team ADMIN can admin", async () => {
    const ctx = ctxWith({ team_memberships: [{ _id: "m1", user_id: TEAMMATE, team_id: TEAM, role: "admin" }] });
    expect(await userCanAdminAnchor(ctx, TEAMMATE, { host_user_id: ME, team_id: TEAM } as any)).toBe(true);
  });
  test("a plain team MEMBER cannot admin (can only use)", async () => {
    const ctx = ctxWith({ team_memberships: [{ _id: "m1", user_id: TEAMMATE, team_id: TEAM, role: "member" }] });
    const anchor = { host_user_id: ME, team_id: TEAM } as any;
    expect(await userCanAccessAnchor(ctx, TEAMMATE, anchor)).toBe(true); // may use
    expect(await userCanAdminAnchor(ctx, TEAMMATE, anchor)).toBe(false); // may not retire/rename
  });
  test("a stranger cannot admin", async () => {
    const ctx = ctxWith({ team_memberships: [{ _id: "m1", user_id: TEAMMATE, team_id: TEAM, role: "admin" }] });
    expect(await userCanAdminAnchor(ctx, STRANGER, { host_user_id: ME, team_id: TEAM } as any)).toBe(false);
  });
});

describe("userCanAccessAnchor", () => {
  test("the host can access", async () => {
    const ctx = ctxWith({ team_memberships: [] });
    const anchor = { host_user_id: ME } as any;
    expect(await userCanAccessAnchor(ctx, ME, anchor)).toBe(true);
  });

  test("the user a personal anchor belongs to can access", async () => {
    const ctx = ctxWith({ team_memberships: [] });
    const anchor = { host_user_id: STRANGER, scope_user_id: ME } as any;
    expect(await userCanAccessAnchor(ctx, ME, anchor)).toBe(true);
  });

  test("a member of the anchor's team can access", async () => {
    const ctx = ctxWith({
      team_memberships: [{ _id: "m1", user_id: TEAMMATE, team_id: TEAM }],
    });
    const anchor = { host_user_id: ME, team_id: TEAM } as any;
    expect(await userCanAccessAnchor(ctx, TEAMMATE, anchor)).toBe(true);
  });

  test("a stranger (not host, not scope user, not team member) is denied", async () => {
    const ctx = ctxWith({
      team_memberships: [{ _id: "m1", user_id: TEAMMATE, team_id: TEAM }],
    });
    const anchor = { host_user_id: ME, team_id: TEAM } as any;
    expect(await userCanAccessAnchor(ctx, STRANGER, anchor)).toBe(false);
  });

  test("a personal (no-team) anchor denies everyone but its owner/host", async () => {
    const ctx = ctxWith({ team_memberships: [] });
    const anchor = { host_user_id: ME, scope_user_id: ME } as any;
    expect(await userCanAccessAnchor(ctx, STRANGER, anchor)).toBe(false);
  });

  test("a null anchor is denied", async () => {
    const ctx = ctxWith({ team_memberships: [] });
    expect(await userCanAccessAnchor(ctx, ME, null)).toBe(false);
  });
});

describe("visibleAnchorsForUser", () => {
  test("returns the caller's personal anchor plus their teams', dedup + excluding decommissioned", async () => {
    const ctx = ctxWith({
      anchors: [
        { _id: "a_personal", scope_user_id: ME, status: "active" },
        { _id: "a_team", team_id: TEAM, status: "active" },
        { _id: "a_dead", team_id: TEAM, status: "decommissioned" },
      ],
      team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM }],
    });
    const out = await visibleAnchorsForUser(ctx, ME);
    const ids = out.map((a: any) => a._id).sort();
    expect(ids).toEqual(["a_personal", "a_team"]);
  });

  test("excludes anchors of teams the caller does not belong to", async () => {
    const ctx = ctxWith({
      anchors: [{ _id: "a_other", team_id: "teams_other", status: "active" }],
      team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM }],
    });
    const out = await visibleAnchorsForUser(ctx, ME);
    expect(out).toEqual([]);
  });
});
