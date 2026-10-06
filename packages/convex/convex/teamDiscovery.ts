// Finding your team by work email (decision sd-432 / sd-453).
//
// Teams on codecast form on day one or not at all: nobody has ever invited a
// second person into a one-person team, and coworkers kept signing up alone
// (seven littlebird.ai accounts outside the Littlebird team on 2026-10-06).
// So a team admin can let people at the company's email domain find the team
// and ask to join; an admin approves each request.
//
// Three rules carry the privacy:
// - Opt-in per team. Nothing about a team is revealed until one of its admins
//   turns this on, and the domain is the admin's own verified one.
// - Proven addresses only. The person asking must have proven they hold an
//   address at the domain: a GitHub, Google or Apple sign-in, or a code sent
//   to that address here (password sign-up does not verify email).
// - Free mail never matches. Nobody can open a team to "gmail.com".
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query, internalAction } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { isTeamAdmin } from "./privacy";
import { addTeamMember } from "./teams";
import { bumpWindow } from "./ipRateLimit";
import { deliver } from "./emails/send";
import { verifyEmail } from "./emails/templates";

// Consumer mailbox providers: an address here says nothing about an employer.
const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "yahoo.com", "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com",
  "proton.me", "protonmail.com", "pm.me", "passmail.com", "gmx.com", "gmx.de", "web.de",
  "mail.com", "zoho.com", "yandex.com", "yandex.ru", "qq.com", "163.com", "126.com",
  "naver.com", "hanmail.net", "privaterelay.appleid.com", "fastmail.com", "hey.com",
  "outlook.in", "rediffmail.com", "tutanota.com", "duck.com",
]);
// Providers that only hand us an email they have verified.
const VERIFYING_PROVIDERS = new Set(["github", "google", "apple", "apple-native"]);
const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;

/** The company domain of an address, or null for free mail and malformed input. */
export function workDomain(email: string | undefined | null): string | null {
  const m = String(email ?? "").trim().toLowerCase().match(/^[^\s@]+@([a-z0-9.-]+\.[a-z]{2,})$/);
  if (!m) return null;
  return FREE_MAIL.has(m[1]) ? null : m[1];
}

/** True when the user has proven they hold their account email. */
export async function emailProven(ctx: any, user: Doc<"users">): Promise<boolean> {
  if (user.emailVerificationTime) return true;
  const accounts = await ctx.db
    .query("authAccounts")
    .withIndex("userIdAndProvider", (q: any) => q.eq("userId", user._id))
    .collect();
  return accounts.some((a: any) => VERIFYING_PROVIDERS.has(a.provider));
}

async function me(ctx: any): Promise<Doc<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Not authenticated");
  const user = await ctx.db.get(userId);
  if (!user) throw new Error("Not authenticated");
  return user;
}

async function requireAdmin(ctx: any, userId: Id<"users">, teamId: Id<"teams">) {
  if (!(await isTeamAdmin(ctx, userId, teamId))) throw new Error("Only team admins can do this");
}

async function isMember(ctx: any, userId: Id<"users">, teamId: Id<"teams">) {
  return !!(await ctx.db
    .query("team_memberships")
    .withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", teamId))
    .first());
}

/** What the admin's toggle needs: the domain it would open, and whether it is on. */
export const discoverySettings = query({
  args: { team_id: v.id("teams") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId || !(await isTeamAdmin(ctx, userId, args.team_id))) return null;
    const [user, team] = await Promise.all([ctx.db.get(userId), ctx.db.get(args.team_id)]);
    if (!user || !team) return null;
    const domain = workDomain(user.email);
    return {
      enabled_domain: team.discoverable_domain ?? null,
      admin_domain: domain,
      admin_domain_proven: domain ? await emailProven(ctx, user) : false,
    };
  },
});

/** Turn finding by domain on (the admin's own proven work domain) or off. */
export const setDiscoverable = mutation({
  args: { team_id: v.id("teams"), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const user = await me(ctx);
    await requireAdmin(ctx, user._id, args.team_id);
    if (!args.enabled) {
      await ctx.db.patch(args.team_id, { discoverable_domain: undefined });
      return { domain: null };
    }
    const domain = workDomain(user.email);
    if (!domain) throw new Error("Your account email is not a work address, so there is no company domain to open");
    if (!(await emailProven(ctx, user))) throw new Error(`Confirm you hold ${user.email} first`);
    await ctx.db.patch(args.team_id, { discoverable_domain: domain });
    return { domain };
  },
});

/**
 * Teams the caller could join by their work domain, plus where they stand:
 * `needs_proof` when their address is a work one they have not proven yet
 * (the card offers the code), and each team's request state.
 */
export const teamsForMyDomain = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const user = await ctx.db.get(userId);
    const domain = workDomain(user?.email);
    if (!user || !domain) return null;
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_discoverable_domain", (q) => q.eq("discoverable_domain", domain))
      .collect();
    const open: Array<{ _id: Id<"teams">; name: string; icon?: string; icon_color?: string; member_count: number; request: "none" | "pending" | "declined" }> = [];
    for (const team of teams) {
      if (team.deleted_at || (await isMember(ctx, userId, team._id))) continue;
      const members = await ctx.db.query("team_memberships").withIndex("by_team_id", (q) => q.eq("team_id", team._id)).collect();
      const request = await ctx.db
        .query("team_join_requests")
        .withIndex("by_user_team", (q) => q.eq("user_id", userId).eq("team_id", team._id))
        .first();
      open.push({
        _id: team._id,
        name: team.name,
        icon: team.icon,
        icon_color: team.icon_color,
        member_count: members.length,
        request: request?.status === "pending" ? "pending" : request?.status === "declined" ? "declined" : "none",
      });
    }
    if (open.length === 0) return null;
    const proven = await emailProven(ctx, user);
    // An unproven address learns nothing beyond "a team may be waiting":
    // the names show only once the address is proven.
    return proven ? { domain, needs_proof: false, teams: open } : { domain, needs_proof: true, teams: [] };
  },
});

/** Send a six digit code to the caller's own account email. */
export const sendWorkEmailCode = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await me(ctx);
    if (!workDomain(user.email)) throw new Error("Only work addresses can be confirmed here");
    const limit = await bumpWindow(ctx.db, `work-email-code:${user._id}`, 5, 60 * 60 * 1000);
    if (!limit.ok) throw new Error("Too many codes this hour, try again later");
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const existing = await ctx.db.query("work_email_codes").withIndex("by_user", (q) => q.eq("user_id", user._id)).first();
    const row = { user_id: user._id, email: user.email!, code_hash: await sha256(code), expires_at: Date.now() + CODE_TTL_MS, attempts: 0 };
    if (existing) await ctx.db.patch(existing._id, row);
    else await ctx.db.insert("work_email_codes", row);
    await ctx.scheduler.runAfter(0, internal.teamDiscovery.deliverWorkEmailCode, { email: user.email!, code });
    return { sent_to: user.email };
  },
});

export const deliverWorkEmailCode = internalAction({
  args: { email: v.string(), code: v.string() },
  handler: async (_ctx, args) => {
    await deliver(args.email, verifyEmail({ code: args.code, email: args.email }), "verify-email");
  },
});

/** Prove the account email with the code it was sent. */
export const confirmWorkEmailCode = mutation({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    const user = await me(ctx);
    const row = await ctx.db.query("work_email_codes").withIndex("by_user", (q) => q.eq("user_id", user._id)).first();
    if (!row || row.email !== user.email || Date.now() > row.expires_at) throw new Error("That code expired, send a new one");
    if (row.attempts >= MAX_CODE_ATTEMPTS) throw new Error("Too many tries, send a new code");
    if (row.code_hash !== (await sha256(args.code.trim()))) {
      await ctx.db.patch(row._id, { attempts: row.attempts + 1 });
      throw new Error("That code is not right");
    }
    await ctx.db.delete(row._id);
    await ctx.db.patch(user._id, { emailVerificationTime: Date.now() });
    return { proven: true };
  },
});

/** Ask to join a team that is open to the caller's proven work domain. */
export const requestToJoin = mutation({
  args: { team_id: v.id("teams") },
  handler: async (ctx, args) => {
    const user = await me(ctx);
    const team = await ctx.db.get(args.team_id);
    const domain = workDomain(user.email);
    if (!team || team.deleted_at || !domain || team.discoverable_domain !== domain) throw new Error("This team is not open to your email domain");
    if (!(await emailProven(ctx, user))) throw new Error(`Confirm you hold ${user.email} first`);
    if (await isMember(ctx, user._id, team._id)) return { status: "member" as const };
    const existing = await ctx.db
      .query("team_join_requests")
      .withIndex("by_user_team", (q) => q.eq("user_id", user._id).eq("team_id", team._id))
      .first();
    if (existing?.status === "pending") return { status: "pending" as const };
    // A declined request may be asked again, once a day at most.
    if (existing?.status === "declined" && Date.now() - (existing.decided_at ?? 0) < 24 * 60 * 60 * 1000) {
      return { status: "declined" as const };
    }
    if (existing) await ctx.db.patch(existing._id, { status: "pending", created_at: Date.now(), decided_at: undefined, decided_by: undefined });
    else await ctx.db.insert("team_join_requests", { team_id: team._id, user_id: user._id, status: "pending", created_at: Date.now() });
    const admins = (await ctx.db.query("team_memberships").withIndex("by_team_id", (q) => q.eq("team_id", team._id)).collect()).filter((m) => m.role === "admin");
    const who = user.name && user.email ? `${user.name} (${user.email})` : user.name || user.email || "Someone";
    for (const admin of admins) {
      await ctx.scheduler.runAfter(0, internal.notificationRouter.emit, {
        event_type: "team_join_request" as const,
        actor_user_id: user._id,
        entity_type: "team" as const,
        entity_id: team._id,
        direct_recipient_id: admin.user_id,
        message: `${who} asked to join ${team.name}.`,
      });
    }
    return { status: "pending" as const };
  },
});

/** Pending requests for a team, for its admins. */
export const pendingRequests = query({
  args: { team_id: v.id("teams") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId || !(await isTeamAdmin(ctx, userId, args.team_id))) return [];
    const rows = await ctx.db
      .query("team_join_requests")
      .withIndex("by_team_status", (q) => q.eq("team_id", args.team_id).eq("status", "pending"))
      .collect();
    const out = [];
    for (const r of rows) {
      const u = await ctx.db.get(r.user_id);
      if (u) out.push({ _id: r._id, user_id: u._id, name: u.name ?? null, email: u.email ?? null, image: u.github_avatar_url ?? u.image ?? null, created_at: r.created_at });
    }
    return out;
  },
});

/** Approve (adds them as a member) or decline a request. */
export const decideRequest = mutation({
  args: { request_id: v.id("team_join_requests"), approve: v.boolean() },
  handler: async (ctx, args) => {
    const user = await me(ctx);
    const req = await ctx.db.get(args.request_id);
    if (!req) throw new Error("That request is gone");
    await requireAdmin(ctx, user._id, req.team_id);
    if (req.status !== "pending") return { status: req.status };
    const team = await ctx.db.get(req.team_id);
    if (!team || team.deleted_at) throw new Error("That team is gone");
    await ctx.db.patch(req._id, { status: args.approve ? "approved" : "declined", decided_at: Date.now(), decided_by: user._id });
    if (args.approve) {
      await addTeamMember(ctx, req.user_id, team, `Approved by ${user.name || user.email || "an admin"} (found by work email)`, user._id);
      await ctx.scheduler.runAfter(0, internal.notificationRouter.emit, {
        event_type: "team_join_approved" as const,
        actor_user_id: user._id,
        entity_type: "team" as const,
        entity_id: team._id,
        direct_recipient_id: req.user_id,
        message: `You're in ${team.name}. Its feed shows what everyone's agents are doing.`,
      });
    }
    return { status: args.approve ? "approved" : "declined" };
  },
});

async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
