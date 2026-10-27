import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { HIRE_ATTEMPTS, hireRetryDelay, performSaveGenerated, performSetRoleIcon, performViewerRoles } from "./roleIcons";
import { performCreateRole } from "./orgRoles";
import { ROLE_ICON_EXAMPLES } from "@codecast/shared/contracts/roleIconExamples";
import type { RoleIcon } from "@codecast/shared/contracts/roleIcon";

// Role icons (org-staffing.md S13): every write is valid geometry, a concept
// no other live role in the boundary holds, and an accent.

const ME = "u".repeat(31) + "m";
const TEAM = "teams_acme" as any;
const coin = ROLE_ICON_EXAMPLES.find((e) => e.icon.concept === "coin")!.icon;
const wrench = ROLE_ICON_EXAMPLES.find((e) => e.icon.concept === "wrench")!.icon;

const role = (id: string, handle: string, extra: Record<string, any> = {}) => ({
  _id: id, short_id: `or-${id}`, scope_type: "team", team_id: TEAM, host_user_id: ME, name: `${handle} lead`, handle,
  scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", created_by: ME, created_at: 1, updated_at: 1, ...extra,
});

function fixtures(roles: any[]) {
  return makeFakeDb({ org_roles: roles });
}
const ctxOf = (db: any) => ({ db }) as any;

describe("performSetRoleIcon", () => {
  test("stores a valid icon, taking the accent its siblings use least when none is given", async () => {
    const db = fixtures([role("org_roles_fin", "finance", { icon: coin }), role("org_roles_up", "upkeep")]);
    const r = await db.get("org_roles_up");
    const icon = await performSetRoleIcon(ctxOf(db), r, { svg: `<svg viewBox="0 0 24 24"><path d="M14.5 5.5a4 4 0 0 0-5 5L4 16l4 4 5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-3-3z"/></svg>`, concept: "Wrench" });
    expect(icon.concept).toBe("Wrench");
    expect(icon.accent).not.toBe(coin.accent);
    expect((await db.get("org_roles_up")).icon).toEqual(icon);
  });

  test("refuses a concept another live role holds, naming the holder", async () => {
    const db = fixtures([role("org_roles_fin", "finance", { icon: coin }), role("org_roles_up", "upkeep")]);
    const r = await db.get("org_roles_up");
    await expect(performSetRoleIcon(ctxOf(db), r, { icon: { ...wrench, concept: "COIN" } })).rejects.toThrow(/"COIN" is already the icon of @finance/);
  });

  test("a retired role's concept is free again", async () => {
    const db = fixtures([role("org_roles_fin", "finance", { icon: coin, status: "retired" }), role("org_roles_up", "upkeep")]);
    const icon = await performSetRoleIcon(ctxOf(db), await db.get("org_roles_up"), { icon: { ...wrench, concept: "coin" } });
    expect(icon.concept).toBe("coin");
  });

  test("a role in another boundary does not hold the concept", async () => {
    const db = fixtures([role("org_roles_fin", "finance", { icon: coin, team_id: "teams_other" }), role("org_roles_up", "upkeep")]);
    await expect(performSetRoleIcon(ctxOf(db), await db.get("org_roles_up"), { icon: { ...wrench, concept: "coin" } })).resolves.toBeTruthy();
  });

  test("bad SVG says every problem at once", async () => {
    const db = fixtures([role("org_roles_up", "upkeep")]);
    const r = await db.get("org_roles_up");
    await expect(performSetRoleIcon(ctxOf(db), r, { svg: `<svg viewBox="0 0 24 24"><g transform="rotate(45)"><path d="M1 1"/></g><text>W</text></svg>`, concept: "w" }))
      .rejects.toThrow(/can't be used: .*only path.*groups may not carry transforms/);
    await expect(performSetRoleIcon(ctxOf(db), r, { svg: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="30"/></svg>`, concept: "ring" }))
      .rejects.toThrow(/radius 0..11/);
    await expect(performSetRoleIcon(ctxOf(db), r, { svg: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>`, concept: "  " }))
      .rejects.toThrow(/concept must name the metaphor/);
    expect((await db.get("org_roles_up")).icon).toBeUndefined();
  });

  test("a redraw keeps the role's accent; an explicit one wins", async () => {
    const db = fixtures([role("org_roles_up", "upkeep", { icon: { ...wrench, accent: "cyan" } as RoleIcon })]);
    const kept = await performSetRoleIcon(ctxOf(db), await db.get("org_roles_up"), { svg: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>`, concept: "ring" });
    expect(kept.accent).toBe("cyan");
    const set = await performSetRoleIcon(ctxOf(db), await db.get("org_roles_up"), { svg: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>`, concept: "ring", accent: "red" });
    expect(set.accent).toBe("red");
  });

  test("a retired role takes no icon", async () => {
    const db = fixtures([role("org_roles_up", "upkeep", { status: "retired" })]);
    await expect(performSetRoleIcon(ctxOf(db), await db.get("org_roles_up"), { icon: wrench })).rejects.toThrow("That role is retired");
  });
});

describe("hiring schedules a drawing", () => {
  test("performCreateRole asks for the role's icon once the row exists", async () => {
    const db = makeFakeDb({
      users: [{ _id: ME, name: "Me" }],
      team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 }],
      teams: [{ _id: TEAM, name: "Acme", features: { org: true } }],
      counters: [], org_roles: [], conversations: [], session_owners: [], anchors: [],
    });
    const scheduled: any[] = [];
    const ctx = { db, scheduler: { runAfter: async (ms: number, _fn: unknown, args: any) => { scheduled.push({ ms, args }); } } } as any;
    const created = await performCreateRole(ctx, ME as any, { name: "Upkeep lead", handle: "upkeep", team_id: TEAM });
    expect(scheduled.some((s) => String(s.args.role_id) === String(created._id))).toBe(true);
  });
});

describe("saving a drawing (performSaveGenerated)", () => {
  const drawn = { ...wrench, accent: "green" } as RoleIcon;
  const hand = { ...coin, concept: "hand drawn coin", accent: "red" } as RoleIcon;

  test("a hire's drawing leaves an icon a person set while it ran", async () => {
    const db = fixtures([role("org_roles_up", "upkeep", { icon: hand })]);
    const out = await performSaveGenerated(ctxOf(db), "org_roles_up" as any, drawn, "storage_new" as any, true);
    expect(out).toEqual({ status: "kept" });
    expect((await db.get("org_roles_up")).icon).toEqual(hand);
    expect((await db.get("org_roles_up")).icon_preview_id).toBeUndefined();
  });

  test("a Redraw replaces it and keeps the new preview", async () => {
    const db = fixtures([role("org_roles_up", "upkeep", { icon: hand })]);
    const out = await performSaveGenerated(ctxOf(db), "org_roles_up" as any, drawn, "storage_new" as any, false);
    expect(out).toMatchObject({ status: "saved", icon: { concept: "wrench" } });
    expect((await db.get("org_roles_up")).icon_preview_id).toBe("storage_new");
  });

  test("a concept another role took while it ran is reported, not thrown, so the hire can draw again", async () => {
    const db = fixtures([role("org_roles_fix", "fixit", { icon: { ...wrench, accent: "cyan" } }), role("org_roles_up", "upkeep")]);
    expect(await performSaveGenerated(ctxOf(db), "org_roles_up" as any, drawn, "storage_new" as any, true)).toEqual({ status: "taken", holder: "fixit" });
    expect((await db.get("org_roles_up")).icon).toBeUndefined();
  });

  test("a stored sibling icon that no longer validates does not block anyone", async () => {
    const broken = { ...coin, shapes: [{ t: "path", d: "M2 2 L4" }] } as RoleIcon;
    const db = fixtures([role("org_roles_bad", "bad", { icon: broken }), role("org_roles_up", "upkeep")]);
    expect(await performSaveGenerated(ctxOf(db), "org_roles_up" as any, { ...drawn, concept: "coin" }, "s" as any, true)).toMatchObject({ status: "saved" });
  });
});

describe("hires drawn together (hireRetryDelay)", () => {
  test("a clash draws again later, spread by role, until the attempts run out", () => {
    const first = hireRetryDelay("taken", 1, "org_roles_a")!;
    const other = hireRetryDelay("taken", 1, "org_roles_b")!;
    expect(first).toBeGreaterThanOrEqual(60_000);
    expect(first).not.toBe(other);
    expect(hireRetryDelay("taken", 2, "org_roles_a")!).toBeGreaterThan(first - 30_000 + 60_000 - 1);
    expect(hireRetryDelay("taken", HIRE_ATTEMPTS, "org_roles_a")).toBeNull();
    expect(hireRetryDelay("saved", 1, "org_roles_a")).toBeNull();
    expect(hireRetryDelay("kept", 1, "org_roles_a")).toBeNull();
  });
});

describe("viewerRoles: every role face the viewer can see, across workspaces", () => {
  const OTHER = "u".repeat(31) + "o";
  test("personal roles and each member team's live roles, in the snapshot's shape; nothing else", async () => {
    const db = makeFakeDb({
      team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "member", joined_at: 1 }],
      org_roles: [
        role("org_roles_team", "infra", { icon: coin, given_name: "Rowan", avatar: "stag" }),
        role("org_roles_paused", "paused", { status: "paused" }),
        role("org_roles_gone", "gone", { status: "retired" }),
        role("org_roles_mine", "alive", { scope_type: "user", team_id: undefined, scope_user_id: ME, tenure: { kind: "program", ends: { date: 1 }, then: "retire" } }),
        role("org_roles_theirs", "theirs", { scope_type: "user", team_id: undefined, scope_user_id: OTHER }),
        role("org_roles_foreign", "foreign", { team_id: "teams_other" }),
        role("org_roles_badicon", "bad", { icon: { ...coin, shapes: [{ t: "path", d: "M2 2 L4" }] } }),
      ],
    });
    const rows = await performViewerRoles(ctxOf(db), ME as any);
    expect(rows.map((r) => r.handle).sort()).toEqual(["alive", "bad", "infra", "paused"]);
    const infra = rows.find((r) => r.handle === "infra")!;
    expect(infra).toEqual({
      _id: "org_roles_team", short_id: "or-org_roles_team", handle: "infra", name: "infra lead", given_name: "Rowan", avatar: "stag",
      icon: coin, status: "active", tenure_kind: "standing", assistant: null, scope_type: "team", team_id: TEAM,
    });
    expect(rows.find((r) => r.handle === "alive")).toMatchObject({ team_id: null, tenure_kind: "program", icon: null });
    // A stored icon that no longer validates reads as none, so the face falls back to the monogram.
    expect(rows.find((r) => r.handle === "bad")!.icon).toBeNull();
  });
});
