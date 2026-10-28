// Managed devices under convex-test: an admin sets the team's policy and
// mints an enrollment token (only its hash is stored), a device presents the
// token on POST /cli/enroll, its person finishes through the authorize page
// (completeEnrollment), and from then on the heartbeat carries the team's
// policy and the server refuses public links, publishing and cloud hosts
// for the team's workspace and for that device.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { httpRouter } from "convex/server";
import { presentToken } from "@platform/auth/convex";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { allModules } from "./testModules.testkit";
import { hashToken } from "./apiTokens";
import { ENROLL_PATH, enrollHttp, profileIdentifier } from "./managedDevices";
import { teamPolicyRefusal } from "./lib/teamPolicyGuard";

setDefaultTimeout(120_000);

const router = httpRouter();
router.route({ path: ENROLL_PATH, method: "POST", handler: enrollHttp });
const modules = { ...allModules, "./http.ts": async () => ({ default: router }) };

const DEVICE = "device-mac-1";
const LAPTOP_SECRET = "bound_laptopsecret";

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const admin = await ctx.db.insert("users", { name: "Ada", email: "ada@acme.dev" } as any);
    const member = await ctx.db.insert("users", { name: "Mo", email: "mo@acme.dev" } as any);
    const newcomer = await ctx.db.insert("users", { name: "Nia", email: "Nia@Acme.dev" } as any);
    const outsider = await ctx.db.insert("users", { name: "Oz", email: "oz@other.dev" } as any);
    const team = await ctx.db.insert("teams", { name: "Acme", invite_code: "ACME1234", created_at: 1 } as any);
    await ctx.db.insert("team_memberships", { user_id: admin, team_id: team, role: "admin", joined_at: 1 } as any);
    await ctx.db.insert("team_memberships", { user_id: member, team_id: team, role: "member", joined_at: 2 } as any);
    return { admin, member, newcomer, outsider, team };
  });
  const as = (user: Id<"users">) => t.withIdentity({ subject: `${user}|session` });
  return { t, ...ids, as };
}

async function enrollOverHttp(t: any, body: Record<string, unknown>) {
  const res = await t.fetch(ENROLL_PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

/** A conversation row, team-visible when `team` is given. */
async function conversation(t: any, user: Id<"users">, team?: Id<"teams">) {
  return await t.run(async (ctx: any) =>
    ctx.db.insert("conversations", {
      user_id: user,
      agent_type: "claude_code",
      session_id: crypto.randomUUID(),
      started_at: 1,
      updated_at: 1,
      message_count: 0,
      is_private: !team,
      status: "active",
      ...(team ? { team_id: team } : {}),
    }),
  );
}

/** A device-bound token for `user` on DEVICE, and the device row, enrolled in `team` when given. */
async function laptop(t: any, user: Id<"users">, team?: Id<"teams">) {
  await t.run(async (ctx: any) => {
    await ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken(LAPTOP_SECRET), name: "mac", created_at: 1, last_used_at: 1, device_id: DEVICE });
    await ctx.db.insert("devices", { user_id: user, device_id: DEVICE, label: "mac", platform: "darwin", last_seen: 1, ...(team ? { enrolled_team_id: team } : {}) });
  });
  return presentToken(LAPTOP_SECRET, DEVICE);
}

describe("team policy", () => {
  test("an admin sets it, parsed to the catalog's keys; a member cannot", async () => {
    const { t, team, admin, member, as } = await setup();
    const res = await as(admin).mutation(api.managedDevices.setTeamPolicy, {
      team_id: team,
      policy: { public_sharing_disabled: true, cloud_hosts_disabled: "yes", auto_update: false, excluded_paths: [" ~/secret ", ""], bogus: 1 },
    });
    expect(res.policy).toEqual({ public_sharing_disabled: true, auto_update: "off", excluded_paths: ["~/secret"] });
    expect((await t.run((ctx) => ctx.db.get(team)))!.policy).toEqual(res.policy);
    await expect(as(member).mutation(api.managedDevices.setTeamPolicy, { team_id: team, policy: {} })).rejects.toThrow();
  });
});

describe("enrollment tokens", () => {
  test("the plaintext comes back once; only its hash and a short prefix are stored", async () => {
    const { t, team, admin, as } = await setup();
    const created = await as(admin).mutation(api.managedDevices.createEnrollmentToken, { team_id: team, name: "Jamf" });
    expect(created.token.startsWith("cc_enr_")).toBe(true);
    const row = (await t.run((ctx) => ctx.db.get(created.token_id)))!;
    expect(row.token_hash).toBe(await hashToken(created.token));
    expect(JSON.stringify(row)).not.toContain(created.token);
    expect(created.token.startsWith(row.prefix)).toBe(true);
    const overview = await as(admin).query(api.managedDevices.adminOverview, { team_id: team });
    expect(overview!.tokens.map((x) => x.name)).toEqual(["Jamf"]);
  });

  test("members can neither mint nor list; revoking stamps the row", async () => {
    const { t, team, admin, member, as } = await setup();
    await expect(as(member).mutation(api.managedDevices.createEnrollmentToken, { team_id: team, name: "x" })).rejects.toThrow();
    expect(await as(member).query(api.managedDevices.adminOverview, { team_id: team })).toBeNull();
    const created = await as(admin).mutation(api.managedDevices.createEnrollmentToken, { team_id: team, name: "Jamf" });
    await expect(as(member).mutation(api.managedDevices.revokeEnrollmentToken, { token_id: created.token_id })).rejects.toThrow();
    await as(admin).mutation(api.managedDevices.revokeEnrollmentToken, { token_id: created.token_id });
    expect((await t.run((ctx) => ctx.db.get(created.token_id)))!.revoked_at).toBeNumber();
  });

  test("the profile carries the token, the policy, the MDM's email variable and the desktop app's Accessibility grant", async () => {
    const { team, admin, as } = await setup();
    await as(admin).mutation(api.managedDevices.setTeamPolicy, { team_id: team, policy: { cloud_hosts_disabled: true } });
    const { token } = await as(admin).mutation(api.managedDevices.createEnrollmentToken, { team_id: team, name: "Jamf" });
    const { mobileconfig, filename } = await as(admin).mutation(api.managedDevices.buildEnrollmentProfile, { team_id: team, token });
    expect(filename).toBe("codecast-acme.mobileconfig");
    expect(mobileconfig).toContain(`<string>${token}</string>`);
    expect(mobileconfig).toContain("<key>CloudHostsDisabled</key>");
    expect(mobileconfig).toContain("<string>$EMAIL</string>");
    expect(mobileconfig).toContain("<string>sh.codecast.desktop</string>");
    expect(mobileconfig).toContain(`<string>${profileIdentifier(String(team))}</string>`);
    const intune = await as(admin).mutation(api.managedDevices.buildEnrollmentProfile, { team_id: team, token, mdm: "intune" });
    expect(intune.mobileconfig).toContain("<string>{{mail}}</string>");
    const mosyle = await as(admin).mutation(api.managedDevices.buildEnrollmentProfile, { team_id: team, token, mdm: "mosyle" });
    expect(mosyle.mobileconfig).toContain("<string>%Email%</string>");
    await expect(as(admin).mutation(api.managedDevices.buildEnrollmentProfile, { team_id: team, token: "cc_enr_000000000000000000000000" })).rejects.toThrow();
  });
});

describe("POST /cli/enroll", () => {
  test("refuses a malformed, unknown or revoked token", async () => {
    const { team, admin, as, t } = await setup();
    expect((await enrollOverHttp(t, { device_id: DEVICE })).status).toBe(400);
    const unknown = await enrollOverHttp(t, { enrollment_token: "cc_enr_ffffffffffffffffffffffffffff", device_id: DEVICE });
    expect(unknown).toMatchObject({ status: 403, body: { ok: false } });
    const created = await as(admin).mutation(api.managedDevices.createEnrollmentToken, { team_id: team, name: "Jamf" });
    await as(admin).mutation(api.managedDevices.revokeEnrollmentToken, { token_id: created.token_id });
    const revoked = await enrollOverHttp(t, { enrollment_token: created.token, device_id: DEVICE });
    expect(revoked.status).toBe(403);
    expect(revoked.body.error).toContain("revoked");
  });

  test("a good token upserts one pending enrollment and answers with the team's policy", async () => {
    const { team, admin, as, t } = await setup();
    await as(admin).mutation(api.managedDevices.setTeamPolicy, { team_id: team, policy: { public_sharing_disabled: true } });
    const { token } = await as(admin).mutation(api.managedDevices.createEnrollmentToken, { team_id: team, name: "Jamf" });
    const first = await enrollOverHttp(t, { enrollment_token: token, device_id: DEVICE, email: "Nia@acme.dev", hostname: "nia-mbp", platform: "darwin" });
    expect(first).toMatchObject({ status: 200, body: { ok: true, team_id: String(team), team_name: "Acme", policy: { public_sharing_disabled: true } } });
    const again = await enrollOverHttp(t, { enrollment_token: token, device_id: DEVICE, hostname: "nia-mbp-2" });
    expect(again.body.enrollment_id).toBe(first.body.enrollment_id);
    const rows = await t.run((ctx) => ctx.db.query("device_enrollments").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "pending", email: "nia@acme.dev", hostname: "nia-mbp-2", device_id: DEVICE });
  });
});

describe("finishing an enrollment on the authorize page", () => {
  async function pending() {
    const s = await setup();
    const { token } = await s.as(s.admin).mutation(api.managedDevices.createEnrollmentToken, { team_id: s.team, name: "Jamf" });
    const res = await enrollOverHttp(s.t, { enrollment_token: token, device_id: DEVICE, email: "nia@acme.dev", hostname: "nia-mbp" });
    return { ...s, enrollmentId: res.body.enrollment_id as string };
  }

  test("someone else's account is refused and nothing is minted", async () => {
    const { t, outsider, enrollmentId, as } = await pending();
    await expect(
      as(outsider).mutation(api.managedDevices.completeEnrollment, { enrollment_id: enrollmentId, name: "nia-mbp", device_id: DEVICE }),
    ).rejects.toThrow(/enrolled for nia@acme.dev/);
    expect(await t.run((ctx) => ctx.db.query("api_tokens").collect())).toHaveLength(0);
  });

  test("the profile's person (any case) joins the team, the enrollment goes active, and the token binds to the device", async () => {
    const { t, team, newcomer, enrollmentId, as } = await pending();
    const preview = await as(newcomer).query(api.managedDevices.enrollmentPreview, { enrollment_id: enrollmentId });
    expect(preview).toEqual({ team_name: "Acme", email: "nia@acme.dev" });
    const res = await as(newcomer).mutation(api.managedDevices.completeEnrollment, { enrollment_id: enrollmentId, name: "nia-mbp", device_id: DEVICE });
    expect(res.token.startsWith("bound_")).toBe(true);
    expect(res.team_name).toBe("Acme");
    const state = await t.run(async (ctx) => ({
      membership: await ctx.db.query("team_memberships").withIndex("by_user_team", (q) => q.eq("user_id", newcomer).eq("team_id", team)).first(),
      enrollment: await ctx.db.get(enrollmentId as Id<"device_enrollments">),
      tokens: await ctx.db.query("api_tokens").collect(),
    }));
    expect(state.membership?.role).toBe("member");
    expect(state.enrollment).toMatchObject({ status: "active", user_id: newcomer });
    expect(state.tokens.map((x) => x.device_id)).toEqual([DEVICE]);
  });

  test("a profile that names nobody lets any account finish", async () => {
    const { t, team, admin, outsider, as } = await setup();
    const { token } = await as(admin).mutation(api.managedDevices.createEnrollmentToken, { team_id: team, name: "Jamf" });
    const res = await enrollOverHttp(t, { enrollment_token: token, device_id: DEVICE });
    const done = await as(outsider).mutation(api.managedDevices.completeEnrollment, { enrollment_id: res.body.enrollment_id, name: "mac", device_id: DEVICE });
    expect(done.team_name).toBe("Acme");
  });

  test("the device's first heartbeat records the team and carries its policy; revoking signs the device out", async () => {
    const { t, team, admin, newcomer, enrollmentId, as } = await pending();
    await as(admin).mutation(api.managedDevices.setTeamPolicy, { team_id: team, policy: { browser_control_disabled: true } });
    const { token } = await as(newcomer).mutation(api.managedDevices.completeEnrollment, { enrollment_id: enrollmentId, name: "nia-mbp", device_id: DEVICE });
    const beat = (await t.mutation(api.users.daemonHeartbeat, { api_token: presentToken(token, DEVICE), version: "1.1.198", platform: "darwin", pid: 1, device_id: DEVICE })) as any;
    expect(beat.team_policy).toEqual({ team_id: String(team), team_name: "Acme", policy: { browser_control_disabled: true }, enrolled: true });
    const device = await t.run((ctx) => ctx.db.query("devices").withIndex("by_user_device", (q) => q.eq("user_id", newcomer).eq("device_id", DEVICE)).first());
    expect(device?.enrolled_team_id).toBe(team);

    await as(admin).mutation(api.managedDevices.revokeDeviceEnrollment, { enrollment_id: enrollmentId as Id<"device_enrollments"> });
    const after = await t.run(async (ctx) => ({
      device: await ctx.db.get(device!._id),
      tokens: await ctx.db.query("api_tokens").collect(),
    }));
    expect(after.device?.enrolled_team_id).toBeUndefined();
    expect(after.tokens).toHaveLength(0);
    const reenroll = await t.run(async (ctx) => ctx.db.get(enrollmentId as Id<"device_enrollments">));
    expect(reenroll?.status).toBe("revoked");
  });

  test("an unmanaged device's heartbeat carries no team policy", async () => {
    const { t, member } = await setup();
    const apiToken = await laptop(t, member);
    const beat = (await t.mutation(api.users.daemonHeartbeat, { api_token: apiToken, version: "1.1.198", platform: "darwin", pid: 1, device_id: DEVICE })) as any;
    expect(beat.team_policy).toBeNull();
  });
});

describe("server gates", () => {
  test("a share link in the team's workspace is refused once public sharing is off; a personal one is not", async () => {
    const { t, team, admin, member, as } = await setup();
    const teamConv = await conversation(t, member, team);
    const personalConv = await conversation(t, member);
    await as(admin).mutation(api.managedDevices.setTeamPolicy, { team_id: team, policy: { public_sharing_disabled: true } });
    await expect(as(member).mutation(api.conversations.generateShareLink, { conversation_id: teamConv })).rejects.toThrow(
      "Public sharing is turned off by Acme's admins.",
    );
    expect(await as(member).mutation(api.conversations.generateShareLink, { conversation_id: personalConv })).toBeString();
  });

  test("an enrolled device is refused a share link even for a personal conversation", async () => {
    const { t, team, admin, member, as } = await setup();
    await as(admin).mutation(api.managedDevices.setTeamPolicy, { team_id: team, policy: { public_sharing_disabled: true } });
    const personalConv = await conversation(t, member);
    const enrolled = await laptop(t, member, team);
    await expect(t.mutation(api.conversations.generateShareLink, { conversation_id: personalConv, api_token: enrolled })).rejects.toThrow(/turned off/);
  });

  test("publishing is refused from an enrolled device and allowed from an unmanaged one", async () => {
    const { t, team, admin, member, as } = await setup();
    await as(admin).mutation(api.managedDevices.setTeamPolicy, { team_id: team, policy: { public_sharing_disabled: true } });
    const unmanaged = await laptop(t, member);
    expect(await t.query(internal.managedDevices.publishRefusal, { api_token: unmanaged })).toBeNull();
    await t.run(async (ctx) => {
      const d = await ctx.db.query("devices").first();
      await ctx.db.patch(d!._id, { enrolled_team_id: team });
    });
    expect(await t.query(internal.managedDevices.publishRefusal, { api_token: unmanaged })).toContain("Acme's admins");
  });

  test("cloud placement is refused for the team's workspace and from an enrolled device", async () => {
    const { t, team, admin, member, as } = await setup();
    await as(admin).mutation(api.managedDevices.setTeamPolicy, { team_id: team, policy: { cloud_hosts_disabled: true } });
    const apiToken = await laptop(t, member, team);
    const personalConv = await conversation(t, member);
    const place = (conversation_id: Id<"conversations">, api_token?: string) =>
      (api_token ? t : as(member)).mutation(api.cloud.placeConversation, { conversation_id, device_id: DEVICE, project_path: "/w", start: false, ...(api_token ? { api_token } : {}) });
    await expect(place(personalConv, apiToken)).rejects.toThrow("Cloud hosting is turned off by Acme's admins.");
    // From the web (no device) the personal row is not the team's.
    expect(await place(personalConv)).toMatchObject({ placed: true });
    const teamConv = await conversation(t, member, team);
    await expect(place(teamConv)).rejects.toThrow(/Cloud hosts/);
  });

  test("a session move to a cloud host is refused from an enrolled device", async () => {
    const { t, team, admin, member, as } = await setup();
    await as(admin).mutation(api.managedDevices.setTeamPolicy, { team_id: team, policy: { cloud_hosts_disabled: true } });
    const apiToken = await laptop(t, member, team);
    const conv = await conversation(t, member);
    await t.run((ctx) => ctx.db.insert("devices", { user_id: member, device_id: "cloud-1", label: "Linux - host", platform: "linux", last_seen: 1, is_remote: true }));
    await expect(
      t.mutation(api.sessionMigrations.createBatch, { api_token: apiToken, conversation_ids: [String(conv)], to_device_id: "cloud-1", dry_run: true }),
    ).rejects.toThrow(/Cloud hosts/);
  });

  test("the guard names nothing when no team restricts the key", async () => {
    const { t, team } = await setup();
    expect(await t.run((ctx) => teamPolicyRefusal(ctx, { workspace: `team:${team}` }, "cloud_hosts_disabled"))).toBeNull();
  });
});
