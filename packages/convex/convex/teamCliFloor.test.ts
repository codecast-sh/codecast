// A team's CLI floor (ct-102483): a team admin or the team's Release Captain
// raises it, it never lowers the global floor, every path that serves a
// device its floor serves the highest that applies, and the fleet read says
// which of the team's machines took a release.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { allModules } from "./testModules.testkit";
import { hashToken } from "./apiTokens";
import { api } from "./_generated/api";

setDefaultTimeout(30_000);

const DAY = 24 * 3600_000;

async function setup() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx: any) => {
    const ana = await ctx.db.insert("users", { name: "Ana" });
    const bo = await ctx.db.insert("users", { name: "Bo" });
    const out = await ctx.db.insert("users", { name: "Outsider" });
    const team = await ctx.db.insert("teams", { name: "Acme", invite_code: "ACME1234", created_at: 1 });
    const other = await ctx.db.insert("teams", { name: "Other", invite_code: "OTHR1234", created_at: 1 });
    await ctx.db.insert("team_memberships", { user_id: ana, team_id: team, role: "admin", joined_at: 1 });
    await ctx.db.insert("team_memberships", { user_id: bo, team_id: team, role: "member", joined_at: 1 });
    await ctx.db.insert("team_memberships", { user_id: out, team_id: other, role: "admin", joined_at: 1 });
    return { ana, bo, out, team, other };
  });
  const tokens: Record<string, string> = {};
  for (const [name, user] of [["ana", ids.ana], ["bo", ids.bo], ["out", ids.out]] as const) {
    tokens[name] = `token_${name}`;
    await t.run(async (ctx: any) => ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken(tokens[name]!), name: "cli", created_at: 1, last_used_at: 1 }));
  }
  return { t, ...ids, tokens };
}

async function setGlobal(t: any, version: string) {
  await t.run(async (ctx: any) => ctx.db.insert("system_config", { key: "min_cli_version", value: version, updated_at: 1 }));
}

/** A role session of `user` in `team`, holding a deploy grant unless `grant` is false. */
async function roleSession(t: any, user: Id<"users">, team: Id<"teams">, grant = true) {
  return await t.run(async (ctx: any) => {
    const role = await ctx.db.insert("org_roles", {
      short_id: `or-${Math.random().toString(36).slice(2, 6)}`, scope_type: "team", team_id: team, host_user_id: user, name: "Release Captain", handle: "release",
      scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: user }, status: "active", trust: "direct",
      caps: { hands_per_day: 10, wakes_per_day: 10, tokens_per_day: 1_000_000, line_on: true },
      authority: grant ? [{ id: "deploy", kind: "publish", label: "Deploy", limit: { per_day: 5 } }] : [],
      created_by: user, created_at: 1, updated_at: 1,
    } as any);
    const session_id = crypto.randomUUID();
    await ctx.db.insert("conversations", {
      user_id: user, agent_type: "claude_code", session_id, short_id: `jx7${Math.random().toString(36).slice(2, 6)}`, started_at: 1, updated_at: 1,
      message_count: 0, is_private: false, team_id: team, team_visibility: "full", status: "active", standing_role_id: role,
    } as any);
    return session_id;
  });
}

describe("setting a team's floor", () => {
  test("a team admin raises it; a member, an outsider and the global setter's staff rule are unchanged", async () => {
    const { t, team, tokens } = await setup();
    expect(await t.mutation(api.teamCliFloor.set, { api_token: tokens.ana, team_id: team, version: "1.1.305" })).toEqual({ team: "Acme", version: "1.1.305", changed: true });
    await expect(t.mutation(api.teamCliFloor.set, { api_token: tokens.bo, team_id: team, version: "1.1.306" })).rejects.toThrow(/held by the team's admins and its Release Captain/);
    await expect(t.mutation(api.teamCliFloor.set, { api_token: tokens.out, team_id: team, version: "1.1.306" })).rejects.toThrow(/held by/);
    // The global floor stays platform staff's alone.
    await expect(t.mutation(api.systemConfig.setMinCliVersion, { api_token: tokens.ana, version: "1.1.306" })).rejects.toThrow("Admin access required");
    expect(await t.run(async (ctx: any) => (await ctx.db.get(team)).min_cli_version)).toBe("1.1.305");
  });

  test("the team's Release Captain sets it from its session; a role without the deploy grant, or another team's, does not", async () => {
    const { t, team, other, bo, tokens } = await setup();
    const captain = await roleSession(t, bo, team);
    expect((await t.mutation(api.teamCliFloor.set, { api_token: tokens.bo, team_id: team, version: "1.1.305", from_session: captain })).changed).toBe(true);
    const ungranted = await roleSession(t, bo, team, false);
    await expect(t.mutation(api.teamCliFloor.set, { api_token: tokens.bo, team_id: team, version: "1.1.306", from_session: ungranted })).rejects.toThrow(/held by/);
    const elsewhere = await roleSession(t, bo, other);
    await expect(t.mutation(api.teamCliFloor.set, { api_token: tokens.bo, team_id: team, version: "1.1.306", from_session: elsewhere })).rejects.toThrow(/held by/);
  });

  test("never lowers: an older release's finish keeps the newer floor", async () => {
    const { t, team, tokens } = await setup();
    await t.mutation(api.teamCliFloor.set, { api_token: tokens.ana, team_id: team, version: "1.1.305" });
    expect(await t.mutation(api.teamCliFloor.set, { api_token: tokens.ana, team_id: team, version: "1.1.299" })).toEqual({ team: "Acme", version: "1.1.305", changed: false });
    await expect(t.mutation(api.teamCliFloor.set, { api_token: tokens.ana, team_id: team, version: "latest" })).rejects.toThrow(/semver/);
  });
});

describe("the floor a device is served", () => {
  test("the daemon's floor read is the highest of the global floor and its owner's teams'; a tokenless read is the global", async () => {
    const { t, team, tokens } = await setup();
    await setGlobal(t, "1.1.300");
    await t.mutation(api.teamCliFloor.set, { api_token: tokens.ana, team_id: team, version: "1.1.305" });
    expect(await t.query(api.systemConfig.getMinCliVersion, {})).toBe("1.1.300");
    expect(await t.query(api.systemConfig.getMinCliVersion, { api_token: tokens.bo })).toBe("1.1.305");
    expect(await t.query(api.systemConfig.getMinCliVersion, { api_token: tokens.out })).toBe("1.1.300");
  });

  test("a team floor below the global one never lowers it", async () => {
    const { t, team, tokens } = await setup();
    await setGlobal(t, "1.1.310");
    await t.mutation(api.teamCliFloor.set, { api_token: tokens.ana, team_id: team, version: "1.1.305" });
    expect(await t.query(api.systemConfig.getMinCliVersion, { api_token: tokens.bo })).toBe("1.1.310");
  });

  test("the heartbeat serves the same floor", async () => {
    const { t, team, tokens } = await setup();
    await setGlobal(t, "1.1.300");
    await t.mutation(api.teamCliFloor.set, { api_token: tokens.ana, team_id: team, version: "1.1.305" });
    const beat: any = await t.mutation(api.users.daemonHeartbeat, { api_token: tokens.bo, version: "1.1.301", platform: "darwin", pid: 1, device_id: "bo-mac" } as any);
    expect(beat.min_cli_version).toBe("1.1.305");
  });
});

describe("the team's fleet on a release", () => {
  test("splits the members' recent machines into took, lagging, offline and cannot update", async () => {
    const { t, team, ana, bo, out, tokens } = await setup();
    const now = Date.now();
    await t.run(async (ctx: any) => {
      const dev = (user: Id<"users">, device_id: string, cli_version: string, last_seen: number, extra: Record<string, unknown> = {}) =>
        ctx.db.insert("devices", { user_id: user, device_id, label: device_id, platform: "darwin", last_seen, cli_version, ...extra });
      await dev(ana, "ana-mac", "1.1.305", now);
      await dev(bo, "bo-mac", "1.1.301", now, { update_error: "checksum_mismatch_darwin-arm64" });
      await dev(bo, "bo-laptop", "1.1.301", now - 3 * 3600_000);
      await dev(ana, "ana-src", "1.1.290", now, { distribution: "source", can_self_update: false });
      await dev(bo, "bo-old", "1.1.200", now - 3 * DAY);
      await dev(out, "out-mac", "1.1.200", now);
    });
    const f: any = await t.query(api.teamCliFloor.fleet, { api_token: tokens.ana, team_id: team, version: "1.1.305" });
    expect(f.took.map((d: any) => d.label)).toEqual(["ana-mac"]);
    expect(f.lagging).toEqual([expect.objectContaining({ label: "bo-mac", owner: "Bo", cli_version: "1.1.301", online: true, error: "checksum_mismatch_darwin-arm64" })]);
    expect(f.offline.map((d: any) => d.label)).toEqual(["bo-laptop"]);
    expect(f.cannot_update.map((d: any) => d.label)).toEqual(["ana-src"]);
    await expect(t.query(api.teamCliFloor.fleet, { api_token: tokens.bo, team_id: team, version: "1.1.305" })).rejects.toThrow(/held by/);
  });
});
