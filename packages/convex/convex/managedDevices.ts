// Managed devices: a company deploys codecast through an MDM.
//
// A team admin sets the team's policy (teams.policy), mints enrollment tokens
// (cc_enr_..., only the hash is stored) and downloads a configuration profile
// carrying one. A Mac with the profile installed announces itself on
// POST /cli/enroll (a pending device_enrollment), then signs its person in
// through the ordinary browser `cast auth` with `&enroll=<id>`; the authorize
// page calls completeEnrollment instead of apiTokens.createToken, which checks
// the person, seats them on the team (the admin's token is the invite), marks
// the enrollment active and records the team on the device row. From then on
// the heartbeat carries the team's policy to that device and the policy guard
// (lib/teamPolicyGuard.ts) enforces it for requests from it.
//
// Keys, merge rules, wire types and messages: shared/contracts/managedPolicy.ts.
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { accessError, createApiTokenDefinitions } from "@platform/auth/convex";
import {
  ENROLLMENT_TOKEN_PREFIX,
  buildMobileconfig,
  isEnrollmentToken,
  parseTeamPolicy,
  type AccessibilityGrant,
  type EnrollRequest,
  type EnrollResponse,
  type TeamPolicy,
} from "@codecast/shared/contracts";
import { internalMutation, internalQuery, mutation, query } from "./functions";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { apiTokenEvents, hashToken } from "./apiTokens";
import { requireTeamAdmin } from "./lib/access";
import { addTeamMember } from "./teams";
import { teamPolicyRefusal } from "./lib/teamPolicyGuard";
import { MDM_VENDORS, mdmEmailVariable } from "./lib/mdmVendors";

/**
 * The desktop app, pre-approved for Accessibility (cast computer) by the
 * profile. Its designated requirement, as `codesign -dr - /Applications/Codecast.app`
 * prints it for the Developer ID build (team WRG9THCK9Q).
 */
export const CODECAST_DESKTOP_ACCESSIBILITY: AccessibilityGrant = {
  identifier: "sh.codecast.desktop",
  identifierType: "bundleID",
  codeRequirement:
    'identifier "sh.codecast.desktop" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = WRG9THCK9Q',
};

/** The profile's identifier: stable per team, so installing a newer one replaces the old. */
export const profileIdentifier = (teamId: string) => `sh.codecast.team.${teamId}`;

/** Characters of the secret shown in the token list (after the cc_enr_ prefix). */
const TOKEN_PREFIX_CHARS = 6;

function newEnrollmentToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return ENROLLMENT_TOKEN_PREFIX + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const createTokenDef = createApiTokenDefinitions({ onEvent: apiTokenEvents }).mutations.createToken;

async function requireUser(ctx: any): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Not authenticated");
  return userId;
}

async function liveTeam(ctx: any, teamId: Id<"teams">): Promise<Doc<"teams">> {
  const team = await ctx.db.get(teamId);
  if (!team || team.deleted_at) throw new Error("No such team");
  return team;
}

async function tokenByPlaintext(ctx: any, token: string): Promise<Doc<"team_enrollment_tokens"> | null> {
  if (!isEnrollmentToken(token)) return null;
  const hash = await hashToken(token);
  return await ctx.db
    .query("team_enrollment_tokens")
    .withIndex("by_token_hash", (q: any) => q.eq("token_hash", hash))
    .first();
}

/** Admin-only: replace the team's policy. Unknown keys and mistyped values are dropped. */
export const setTeamPolicy = mutation({
  args: { team_id: v.id("teams"), policy: v.any() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await requireTeamAdmin(ctx, userId, args.team_id);
    await liveTeam(ctx, args.team_id);
    const policy = parseTeamPolicy(args.policy);
    await ctx.db.patch(args.team_id, { policy: Object.keys(policy).length ? policy : undefined });
    return { policy };
  },
});

/** Admin-only: everything Team settings > Managed devices shows. Null for anyone else. */
export const adminOverview = query({
  args: { team_id: v.id("teams") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const membership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", userId).eq("team_id", args.team_id))
      .first();
    if (membership?.role !== "admin") return null;
    const [tokens, enrollments] = await Promise.all([
      ctx.db.query("team_enrollment_tokens").withIndex("by_team", (q) => q.eq("team_id", args.team_id)).collect(),
      ctx.db.query("device_enrollments").withIndex("by_team", (q) => q.eq("team_id", args.team_id)).collect(),
    ]);
    const people = new Map<string, Doc<"users"> | null>();
    for (const id of new Set(enrollments.map((e) => e.user_id).filter(Boolean).map(String))) {
      people.set(id, await ctx.db.get(id as Id<"users">));
    }
    const tokenNames = new Map(tokens.map((t) => [String(t._id), t.name]));
    // When each enrolled Mac last checked in, from the device row its sign-in made.
    const lastSeen = new Map<string, number>();
    for (const e of enrollments) {
      if (!e.user_id || e.status !== "active") continue;
      const device = await ctx.db
        .query("devices")
        .withIndex("by_user_device", (q) => q.eq("user_id", e.user_id!).eq("device_id", e.device_id))
        .first();
      if (device) lastSeen.set(String(e._id), device.last_seen);
    }
    return {
      tokens: tokens
        .sort((a, b) => b.created_at - a.created_at)
        .map((t) => ({
          _id: t._id,
          name: t.name,
          prefix: t.prefix,
          created_at: t.created_at,
          revoked_at: t.revoked_at ?? null,
          last_used_at: t.last_used_at ?? null,
          devices: enrollments.filter((e) => e.token_id === t._id && e.status !== "revoked").length,
        })),
      devices: enrollments
        .sort((a, b) => (b.enrolled_at ?? b.created_at) - (a.enrolled_at ?? a.created_at))
        .map((e) => {
          const person = e.user_id ? people.get(String(e.user_id)) : null;
          return {
            _id: e._id,
            device_id: e.device_id,
            hostname: e.hostname ?? null,
            platform: e.platform ?? null,
            email: person?.email ?? e.email ?? null,
            person_name: person?.name ?? null,
            status: e.status,
            token_name: tokenNames.get(String(e.token_id)) ?? null,
            created_at: e.created_at,
            enrolled_at: e.enrolled_at ?? null,
            // Bucketed to the minute: the device row moves on every heartbeat.
            last_seen: lastSeen.has(String(e._id)) ? Math.floor(lastSeen.get(String(e._id))! / 60_000) * 60_000 : null,
          };
        }),
    };
  },
});

/** Admin-only: mint an enrollment token. The plaintext comes back once and is never stored. */
export const createEnrollmentToken = mutation({
  args: { team_id: v.id("teams"), name: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await requireTeamAdmin(ctx, userId, args.team_id);
    await liveTeam(ctx, args.team_id);
    const token = newEnrollmentToken();
    const prefix = token.slice(0, ENROLLMENT_TOKEN_PREFIX.length + TOKEN_PREFIX_CHARS);
    const name = args.name.trim().slice(0, 80) || "Enrollment token";
    const tokenId = await ctx.db.insert("team_enrollment_tokens", {
      team_id: args.team_id,
      created_by: userId,
      name,
      token_hash: await hashToken(token),
      prefix,
      created_at: Date.now(),
    });
    return { token_id: tokenId, token, prefix, name };
  },
});

/** Admin-only: stop a token enrolling new devices. Devices it already enrolled stay enrolled. */
export const revokeEnrollmentToken = mutation({
  args: { token_id: v.id("team_enrollment_tokens") },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const row = await ctx.db.get(args.token_id);
    if (!row) throw new Error("No such token");
    await requireTeamAdmin(ctx, userId, row.team_id);
    if (!row.revoked_at) await ctx.db.patch(row._id, { revoked_at: Date.now() });
  },
});

/**
 * Admin-only: take a device out of the team. The enrollment is revoked (its
 * token can no longer re-enroll it), the device row stops answering to the
 * team's policy, and the sign-in the enrollment made on that machine is
 * revoked, so the device is signed out on its next request.
 */
export const revokeDeviceEnrollment = mutation({
  args: { enrollment_id: v.id("device_enrollments") },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const row = await ctx.db.get(args.enrollment_id);
    if (!row) throw new Error("No such device");
    await requireTeamAdmin(ctx, userId, row.team_id);
    if (row.status === "revoked") return;
    await ctx.db.patch(row._id, { status: "revoked", revoked_at: Date.now() });
    if (!row.user_id) return;
    const device = await ctx.db
      .query("devices")
      .withIndex("by_user_device", (q) => q.eq("user_id", row.user_id!).eq("device_id", row.device_id))
      .first();
    if (device && device.enrolled_team_id === row.team_id) await ctx.db.patch(device._id, { enrolled_team_id: undefined });
    const tokens = await ctx.db.query("api_tokens").withIndex("by_user_id", (q) => q.eq("user_id", row.user_id!)).collect();
    for (const t of tokens) if (t.device_id === row.device_id) await ctx.db.delete(t._id);
  },
});

/**
 * Admin-only: let a removed device back in. The enrollment returns to
 * pending, so the device's next `cast mdm enroll` (at login, or run by hand)
 * signs its person in again and the enrollment completes as it did the first time.
 */
export const restoreDeviceEnrollment = mutation({
  args: { enrollment_id: v.id("device_enrollments") },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const row = await ctx.db.get(args.enrollment_id);
    if (!row) throw new Error("No such device");
    await requireTeamAdmin(ctx, userId, row.team_id);
    if (row.status !== "revoked") return;
    await ctx.db.patch(row._id, { status: "pending", revoked_at: undefined });
  },
});

/**
 * Admin-only: the configuration profile for one token, with the team's
 * current policy and the chosen MDM's email variable as the person
 * (lib/mdmVendors: $EMAIL for Jamf and Kandji, {{mail}} for Intune, %Email%
 * for Mosyle). A mutation because each
 * profile gets fresh payload UUIDs.
 */
export const buildEnrollmentProfile = mutation({
  args: {
    team_id: v.id("teams"),
    token: v.string(),
    mdm: v.optional(v.union(...(MDM_VENDORS.map((m) => v.literal(m.id)) as [any, ...any[]]))),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await requireTeamAdmin(ctx, userId, args.team_id);
    const team = await liveTeam(ctx, args.team_id);
    const row = await tokenByPlaintext(ctx, args.token);
    if (!row || row.team_id !== args.team_id || row.revoked_at) throw new Error("That enrollment token is not active for this team");
    const policy: TeamPolicy = parseTeamPolicy(team.policy);
    const mobileconfig = buildMobileconfig({
      teamName: team.name,
      identifier: profileIdentifier(String(team._id)),
      uuids: [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()],
      policy: { ...policy, enrollment_token: args.token, user_email: mdmEmailVariable(args.mdm) },
      accessibility: [CODECAST_DESKTOP_ACCESSIBILITY],
    });
    const slug = team.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "team";
    return { filename: `codecast-${slug}.mobileconfig`, mobileconfig };
  },
});

/**
 * POST /cli/enroll: a device with the profile installed presents its token.
 * Upserts its pending enrollment and answers with the team and its policy.
 * The token is a secret: never logged, only hashed.
 */
export const enroll = internalMutation({
  args: {
    enrollment_token: v.string(),
    device_id: v.string(),
    email: v.optional(v.string()),
    hostname: v.optional(v.string()),
    platform: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<EnrollResponse> => {
    const row = await tokenByPlaintext(ctx, args.enrollment_token);
    if (!row) return { ok: false, error: "This enrollment token is not valid. Ask your IT admin for a new configuration profile." };
    if (row.revoked_at) return { ok: false, error: "This enrollment token was revoked. Ask your IT admin for a new configuration profile." };
    const team = await ctx.db.get(row.team_id);
    if (!team || team.deleted_at) return { ok: false, error: "The team this device enrolls into no longer exists." };
    const deviceId = args.device_id.trim();
    if (!deviceId || deviceId.length > 200) return { ok: false, error: "Missing device_id" };
    const email = args.email?.trim().toLowerCase() || undefined;
    const now = Date.now();
    await ctx.db.patch(row._id, { last_used_at: now });
    const existing = await ctx.db
      .query("device_enrollments")
      .withIndex("by_team_device", (q) => q.eq("team_id", row.team_id).eq("device_id", deviceId))
      .first();
    if (existing?.status === "revoked") {
      return { ok: false, error: `${team.name}'s admins removed this device. Ask them to allow it again.`, removed_by: team.name };
    }
    const facts = {
      token_id: row._id,
      ...(email ? { email } : {}),
      ...(args.hostname ? { hostname: args.hostname.slice(0, 200) } : {}),
      ...(args.platform ? { platform: args.platform.slice(0, 40) } : {}),
    };
    let enrollmentId: Id<"device_enrollments">;
    if (existing) {
      await ctx.db.patch(existing._id, facts);
      enrollmentId = existing._id;
    } else {
      enrollmentId = await ctx.db.insert("device_enrollments", {
        team_id: row.team_id,
        device_id: deviceId,
        status: "pending",
        created_at: now,
        ...facts,
      });
    }
    return { ok: true, enrollment_id: String(enrollmentId), team_id: String(team._id), team_name: team.name, policy: parseTeamPolicy(team.policy) };
  },
});

export const ENROLL_PATH = "/cli/enroll";

/** POST /cli/enroll (EnrollRequest → EnrollResponse). No api token yet: the
 *  enrollment token is the credential, so neither it nor the body is logged. */
export const enrollHttp = httpAction(async (ctx, request) => {
  const respond = (body: EnrollResponse, status: number) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  let body: Partial<EnrollRequest>;
  try {
    body = await request.json();
  } catch {
    return respond({ ok: false, error: "Invalid JSON" }, 400);
  }
  const str = (x: unknown) => (typeof x === "string" ? x : undefined);
  const token = str(body?.enrollment_token);
  const deviceId = str(body?.device_id);
  if (!token || !deviceId) return respond({ ok: false, error: "Missing enrollment_token or device_id" }, 400);
  const result: EnrollResponse = await ctx.runMutation(internal.managedDevices.enroll, {
    enrollment_token: token,
    device_id: deviceId,
    email: str(body.email),
    hostname: str(body.hostname),
    platform: str(body.platform),
  });
  return respond(result, result.ok ? 200 : 403);
});

/** The authorize page's line for an enrolling device: which team, and whose device. */
export const enrollmentPreview = query({
  args: { enrollment_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const id = ctx.db.normalizeId("device_enrollments", args.enrollment_id);
    const row = id ? await ctx.db.get(id) : null;
    if (!row || row.status === "revoked") return null;
    const team = await ctx.db.get(row.team_id);
    if (!team || team.deleted_at) return null;
    return { team_name: team.name, email: row.email ?? null };
  },
});

/** Does the signed-in person match the person the profile names? */
export function enrollmentEmailMatches(expected: string | undefined, actual: string | undefined): boolean {
  if (!expected) return true;
  return !!actual && actual.trim().toLowerCase() === expected.trim().toLowerCase();
}

/**
 * The authorize page's Authorize for an enrolling device, in place of
 * apiTokens.createToken: the same device-bound token, minted only once the
 * enrollment holds. One transaction, so a refusal leaves no token behind.
 */
export const completeEnrollment = mutation({
  args: { enrollment_id: v.string(), name: v.string(), device_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const id = ctx.db.normalizeId("device_enrollments", args.enrollment_id);
    const row = id ? await ctx.db.get(id) : null;
    if (!row) throw accessError("NOT_FOUND", "This enrollment was not found. Run the sign-in from the device again.");
    if (row.status === "revoked") throw accessError("FORBIDDEN", "This device's enrollment was revoked by its team's admins.");
    if (row.device_id !== args.device_id) throw accessError("FORBIDDEN", "This enrollment belongs to a different device.");
    const team = await liveTeam(ctx, row.team_id);
    const token = await ctx.db.get(row.token_id);
    if (!token || token.revoked_at) throw accessError("FORBIDDEN", "This device's enrollment token was revoked. Ask your IT admin for a new profile.");
    const user = await ctx.db.get(userId);
    if (!enrollmentEmailMatches(row.email, user?.email)) {
      throw accessError("FORBIDDEN", `This device is enrolled for ${row.email}. Sign in as ${row.email} to finish (you are signed in as ${user?.email ?? "another account"}).`);
    }
    await addTeamMember(ctx, userId, team, "Enrolled a managed device", token.created_by);
    const now = Date.now();
    await ctx.db.patch(row._id, { status: "active", user_id: userId, enrolled_at: row.enrolled_at ?? now });
    const device = await ctx.db
      .query("devices")
      .withIndex("by_user_device", (q) => q.eq("user_id", userId).eq("device_id", row.device_id))
      .first();
    if (device && device.enrolled_team_id !== row.team_id) await ctx.db.patch(device._id, { enrolled_team_id: row.team_id });
    const minted = await createTokenDef.handler(ctx, { name: args.name, device_id: args.device_id });
    return { ...minted, team_id: team._id, team_name: team.name };
  },
});

/**
 * Publishing (`cast publish`) from a device enrolled in a team that turned
 * public sharing off. A published page belongs to its publisher, not to a
 * workspace, so the device is the only side of the rule that applies.
 */
export const publishRefusal = internalQuery({
  args: { api_token: v.string() },
  handler: async (ctx, args) => teamPolicyRefusal(ctx, { apiToken: args.api_token }, "public_sharing_disabled"),
});
