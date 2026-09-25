import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performCreateRole, performSetAuthority } from "./orgRoles";

// Authority outside codecast (org-hire.md H4): a person grants and revokes it,
// the list replaces whole, and expiry comes from the grant's cadence. Same
// human only gate as trust and caps.

const ME = ("u".repeat(31) + "m") as any;
const TEAM = "teams_acme" as any;
function fixture() {
  const db = makeFakeDb({
    users: [{ _id: ME, name: "Me", email: "me@x.ai" }],
    team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 }],
    teams: [{ _id: TEAM, name: "Acme", features: { org: true } }],
    counters: [], org_roles: [], org_role_history: [], org_changes: [], anchors: [], session_owners: [], managed_sessions: [], tasks: [], projects: [], plans: [], docs: [],
    conversations: [{ _id: "conversations_s", short_id: "jx7ssss", user_id: ME, team_id: TEAM, status: "active", title: "CMO", agent_type: "claude_code", updated_at: 1 }],
  });
  // A signed in person: the human only gate reads a browser identity (refuseUnlessHuman).
  return { db, ctx: { db, auth: { getUserIdentity: async () => ({ subject: ME }) } } as any };
}
const DAY = 86_400_000;

describe("role authority", () => {
  test("a person grants, the list is stored with expiry and provenance, a revoke removes one, an agent session is refused", async () => {
    const { db, ctx } = fixture();
    const role = await performCreateRole(ctx, ME, { name: "CMO", handle: "acme-cmo", team_id: TEAM });
    // Seated the way provisioning seats it, so a change reaches its rail.
    db._tables.anchors.push({ _id: "anchors_cmo", bot_user_id: ME, org_role_id: role._id, conversation_id: "conversations_s", status: "active" });
    await db.patch(role._id, { anchor_id: "anchors_cmo" });
    await db.patch("conversations_s", { standing_role_id: role._id, anchor_id: "anchors_cmo" });
    await expect(performSetAuthority(ctx, ME, { role_id: role._id, authority: [{ id: "ads-spend", kind: "spend", label: "Paid search" }], from_session: "jx7agent" })).rejects.toThrow(/human only/);
    const before = Date.now();
    const granted = await performSetAuthority(ctx, ME, { role_id: role._id, authority: [
      { id: "ads-spend", kind: "spend", label: "Paid search on the configured campaign", limit: { usd_per_month: 300 }, expires: "90d" },
      { id: "site-write", kind: "write", label: "Ship pages into the working tree" },
    ], decision_id: "sd-9" });
    expect(granted.authority).toHaveLength(2);
    expect(granted.authority[0]).toMatchObject({ id: "ads-spend", kind: "spend", limit: { usd_per_month: 300 }, granted_by: ME, decision_id: "sd-9" });
    expect(granted.authority[0].expires_at).toBeGreaterThanOrEqual(before + 90 * DAY);
    expect(granted.authority[1].expires_at).toBeUndefined();
    const stored = (await db.get(role._id)).authority;
    expect(stored.map((g: any) => g.id)).toEqual(["ads-spend", "site-write"]);
    // A regrant keeps the first grant date; a revoke drops one and keeps the other.
    const again = await performSetAuthority(ctx, ME, { role_id: role._id, authority: [{ id: "ads-spend", kind: "spend", label: "Paid search", limit: { usd_per_month: 500 } }], revoke: ["site-write"] });
    expect(again.authority).toHaveLength(1);
    expect(again.authority[0]).toMatchObject({ id: "ads-spend", limit: { usd_per_month: 500 }, granted_at: granted.authority[0].granted_at });
    // Bad grants are refused before any write.
    await expect(performSetAuthority(ctx, ME, { role_id: role._id, authority: [{ id: "Bad Id", kind: "spend", label: "x" }] })).rejects.toThrow(/not a slug/);
    await expect(performSetAuthority(ctx, ME, { role_id: role._id, authority: [{ id: "x", kind: "delete" as any, label: "x" }] })).rejects.toThrow(/one of spend, publish, write, connect/);
    await expect(performSetAuthority(ctx, ME, { role_id: role._id, authority: [{ id: "x", kind: "spend", label: "x", limit: { usd_per_day: -1 } }] })).rejects.toThrow(/non negative/);
    // A change log row records it.
    expect(db._tables.org_changes.some((r: any) => r.kind === "authority" || "authority" in (r.kinds ?? {}))).toBe(true);
  });
});
