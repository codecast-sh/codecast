// Sign-in requests filled from a person's own Chrome with no press per site
// (docs/architecture/vault.md "Saved sign-ins"). A person turns it on once, on
// the web, for one workspace and one of their laptops. From then on every open
// sign-in request there goes to that laptop as the same vault_capture_signin
// the Vault page's Save sign-in sends, a few at a time; the laptop reads its
// Chrome and fills the request with its own token (secrets.captureAskedFor
// vouches for it while the command is pending). A site Chrome is not signed in
// to stays asked for and is tried again after AUTOFILL_RETRY_MS.
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, mutation, query } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { DAEMON_COMMAND_TTL_MS } from "@codecast/shared/contracts";
import { cleanSecretSites, keepsOwnLogin, siteProblem } from "@codecast/shared/contracts/secrets";
import { requireTeamMembership, workspaceKey } from "./lib/access";
import { pickOnlineLocalDevice } from "./cloud";

/** Captures one laptop runs at a time: each holds a Keychain read and a Chrome cookie copy, and expires unclaimed after DAEMON_COMMAND_TTL_MS. */
export const AUTOFILL_PARALLEL = 4;
/** A site tried and not filled (Chrome signed out there, the laptop asleep) is tried again after this. */
export const AUTOFILL_RETRY_MS = 6 * 60 * 60 * 1000;
/** While sites are left, the next batch goes this long after the last. */
const NEXT_BATCH_MS = 30_000;

const workspaceArgs = { team_id: v.optional(v.id("teams")), personal: v.optional(v.boolean()) };

/** The person's workspace key for a grant: a team they belong to, or their own. */
async function grantWorkspace(ctx: any, userId: Id<"users">, args: { team_id?: Id<"teams">; personal?: boolean }) {
  if (args.team_id) {
    await requireTeamMembership(ctx, userId, args.team_id);
    return { workspace: workspaceKey({ type: "team", teamId: args.team_id }), team_id: args.team_id };
  }
  return { workspace: workspaceKey({ type: "personal", userId }) };
}

async function grantOf(ctx: any, userId: Id<"users">, workspace: string): Promise<Doc<"signin_autofill"> | null> {
  return await ctx.db.query("signin_autofill").withIndex("by_user_workspace", (q: any) => q.eq("user_id", userId).eq("workspace", workspace)).first();
}

/** The viewer's grant for this workspace: which laptop fills its sign-in requests, or null. A person's read only. */
export const mine = query({
  args: workspaceArgs,
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const where = await grantWorkspace(ctx, userId, args);
    const grant = await grantOf(ctx, userId, where.workspace);
    return grant ? { device_id: grant.device_id, created_at: grant.created_at } : null;
  },
});

/**
 * Turn it on for one laptop (device_id) or off (none). Only a person signed in
 * to the app sets it, never an api token: it hands agents the person's
 * sign-ins on every site they ask for.
 */
export const set = mutation({
  args: { ...workspaceArgs, device_id: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { error: "Sign in to codecast to change this" };
    const where = await grantWorkspace(ctx, userId, args);
    const old = await grantOf(ctx, userId, where.workspace);
    if (old) await ctx.db.delete(old._id);
    if (!args.device_id) return { ok: true };
    const device = await ctx.db.query("devices").withIndex("by_user_id", (q: any) => q.eq("user_id", userId)).filter((q: any) => q.eq(q.field("device_id"), args.device_id)).first();
    if (!device || device.is_remote) return { error: "Pick one of your laptops: a cloud host has no Chrome of yours" };
    const id = await ctx.db.insert("signin_autofill", { user_id: userId, workspace: where.workspace, team_id: where.team_id, device_id: args.device_id, created_at: Date.now() });
    await ctx.scheduler.runAfter(0, internal.signinAutofill.fillGrant, { grant_id: id });
    return { ok: true };
  },
});

/**
 * Send the grant's laptop the next open sign-in requests in its workspace,
 * up to AUTOFILL_PARALLEL pending at once. Skips a laptop that is offline, a
 * site already on its way, and one tried within AUTOFILL_RETRY_MS. Returns
 * how many it sent.
 */
async function fill(ctx: any, grant: Doc<"signin_autofill">, now: number): Promise<number> {
  const devices = await ctx.db.query("devices").withIndex("by_user_id", (q: any) => q.eq("user_id", grant.user_id)).collect();
  const laptop = pickOnlineLocalDevice(devices, now, grant.device_id);
  if (!laptop) return 0;
  const pending: Doc<"daemon_commands">[] = (
    await ctx.db.query("daemon_commands").withIndex("by_user_pending", (q: any) => q.eq("user_id", grant.user_id).eq("executed_at", undefined)).collect()
  ).filter((c: Doc<"daemon_commands">) => c.command === "vault_capture_signin" && now - c.created_at < DAEMON_COMMAND_TTL_MS);
  let room = AUTOFILL_PARALLEL - pending.length;
  if (room <= 0) return 0;
  const onTheWay = new Set(pending.map((c) => { try { return JSON.parse(c.args ?? "{}").name as string; } catch { return ""; } }));
  const tried = { ...(grant.tried ?? {}) };
  const asked: Doc<"secrets">[] = (await ctx.db.query("secrets").withIndex("by_workspace", (q: any) => q.eq("workspace", grant.workspace)).collect())
    .filter((r: Doc<"secrets">) => r.kind === "signin" && r.status === "requested" && r.sites?.length);
  let sent = 0;
  for (const row of asked) {
    if (room <= 0) break;
    if (onTheWay.has(row.name) || now - (tried[row._id] ?? 0) < AUTOFILL_RETRY_MS) continue;
    const site = cleanSecretSites([row.sites![0]!])?.[0];
    if (!site || keepsOwnLogin(site) || siteProblem(site)) continue;
    await ctx.db.insert("daemon_commands", {
      user_id: grant.user_id,
      command: "vault_capture_signin" as const,
      args: JSON.stringify({ site, name: row.name, ...(grant.team_id ? { team_id: grant.team_id } : { personal: true }) }),
      created_at: now,
      target_device_id: laptop.device_id,
    });
    tried[row._id] = now;
    room--;
    sent++;
  }
  // Only rows still asked for keep a mark, so the record stays the size of the open requests.
  const open = new Set(asked.map((r) => String(r._id)));
  await ctx.db.patch(grant._id, { tried: Object.fromEntries(Object.entries(tried).filter(([id]) => open.has(id))) });
  return sent;
}

/** One grant's next batch, and another after NEXT_BATCH_MS while it still sends. */
export const fillGrant = internalMutation({
  args: { grant_id: v.id("signin_autofill") },
  handler: async (ctx, args) => {
    const grant = await ctx.db.get(args.grant_id);
    if (!grant) return;
    if ((await fill(ctx, grant, Date.now())) > 0) await ctx.scheduler.runAfter(NEXT_BATCH_MS, internal.signinAutofill.fillGrant, args);
  },
});

/** A sign-in was just asked for: every grant on its workspace takes it up now rather than at the next sweep. */
export const asked = internalMutation({
  args: { workspace: v.string() },
  handler: async (ctx, args) => {
    const grants = await ctx.db.query("signin_autofill").withIndex("by_workspace", (q: any) => q.eq("workspace", args.workspace)).collect();
    for (const g of grants) await ctx.scheduler.runAfter(0, internal.signinAutofill.fillGrant, { grant_id: g._id });
  },
});

/** The backstop (crons.ts): a laptop that came back online, a site whose retry came due. */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const g of await ctx.db.query("signin_autofill").collect()) await ctx.scheduler.runAfter(0, internal.signinAutofill.fillGrant, { grant_id: g._id });
  },
});
