// Cast machines (sd-3042): a person with no CLI starts a session and it runs
// on a cloud machine of their own, in codecast's AWS account, with pi on our
// model key. This backend launches the machine (RunInstances from a fixed
// launch template), its first boot signs its daemon in with a one-hour setup
// token minted here, and the session starts on it like on any remote device.
// Waking a stopped machine goes through cloudWake.ts like any server-woken host;
// the machine stops itself when idle (the image's idle watchdog).
//
// Guard rails, from the decision: one region (us-west-2) away from prod
// Convex (us-east-1), a hard cap on machines running at once checked against
// AWS before every launch or wake, AWS keys that can only touch instances
// carrying CAST_MACHINE_TAG, and a model proxy (castMachineProxy) so our model
// key never sits on a machine a person controls.
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, query } from "./functions";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { mintSetupToken } from "@platform/auth/convex";
import { sha256Hex } from "./lib/awsSigV4";
import { CAST_MACHINE_LAUNCH_TEMPLATE, CAST_MACHINE_REGION, CAST_MACHINE_TAG, castMachineCapacityLeft, ec2, Ec2Error } from "./lib/castMachineAws";
import { enqueueStartSession } from "./devices";
import { CAST_MODEL_PROXY_PATH } from "./castMachineProxy";
import { DEVICE_ONLINE_MS } from "./deviceRouting";

const LAUNCH_RETRY_MS = 60_000;
const MAX_LAUNCH_ATTEMPTS = 30;
const refs = () => (internal as any).castMachines;

/** Who may start a cast machine: CAST_MACHINES_USERS, comma-separated user
 *  ids, or "*" for everyone. Unset is nobody. */
export function castMachinesEnabledFor(userId: string): boolean {
  const list = (process.env.CAST_MACHINES_USERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes("*") || list.includes(userId);
}

async function machineOf(ctx: { db: any }, userId: Id<"users">) {
  return await ctx.db.query("cast_machines").withIndex("by_user", (q: any) => q.eq("user_id", userId)).first();
}

/** First boot: write pi's model route (our proxy, this machine's own key),
 *  sign the daemon in as the person, start it. Runs once, as root. */
export function castMachineUserData(o: { site: string; proxyKey: string; setupToken: string }): string {
  for (const [k, val] of Object.entries(o)) if (!/^[A-Za-z0-9_:/.-]+$/.test(val)) throw new Error(`unsafe ${k}`);
  const models = JSON.stringify({ providers: { anthropic: { baseUrl: `${o.site}${CAST_MODEL_PROXY_PATH}`, apiKey: o.proxyKey } } });
  const settings = JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-sonnet-5-5" });
  return `#!/bin/bash
set -euo pipefail
H=/home/ubuntu
install -d -m 700 -o ubuntu -g ubuntu "$H/.pi" "$H/.pi/agent"
printf '%s' '${models}' > "$H/.pi/agent/models.json"
printf '%s' '${settings}' > "$H/.pi/agent/settings.json"
chown ubuntu:ubuntu "$H/.pi/agent/models.json" "$H/.pi/agent/settings.json"
chmod 600 "$H/.pi/agent/models.json" "$H/.pi/agent/settings.json"
sudo -u ubuntu -H /usr/local/bin/cast login ${o.setupToken} </dev/null || true
systemctl enable codecast-daemon
systemctl restart codecast-daemon
`;
}

function randomKey(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Starting a session
// ---------------------------------------------------------------------------

/** The machine's home: its sessions' folder. A remote daemon runs only
 *  starts that name a folder (daemon.ts start_session). */
export const CAST_MACHINE_HOME = "/home/ubuntu";

async function startPiOn(ctx: { db: any }, userId: Id<"users">, conversationId: Id<"conversations">, deviceId: string) {
  await ctx.db.patch(conversationId, { project_path: CAST_MACHINE_HOME });
  await enqueueStartSession(ctx, userId, {
    conversationId, agentType: "pi", projectPath: CAST_MACHINE_HOME, targetDeviceId: deviceId, callerUserId: userId, createdAt: Date.now(),
  });
}

/**
 * A Cast start for an enabled person: a pi session on their machine.
 * Called from dispatch.createSession's hosted branch with the conversation it
 * already made (agent pi). A machine that is signed in gets the start now (an
 * asleep one is woken by the queued message, cloudWake.ts); otherwise the
 * start is held on the machine row and runs at sign-in (bindDevice).
 */
export async function startOnCastMachine(
  ctx: { db: any; scheduler: { runAfter(delay: number, fn: any, args: any): Promise<unknown> } },
  userId: Id<"users">,
  conversationId: Id<"conversations">,
): Promise<void> {
  let row = await machineOf(ctx, userId);
  const now = Date.now();
  if (!row) {
    const id = await ctx.db.insert("cast_machines", {
      user_id: userId, region: CAST_MACHINE_REGION, status: "launching",
      held_conversation_ids: [], launch_attempts: 0, created_at: now, updated_at: now,
    });
    await ctx.scheduler.runAfter(0, refs().launch, { machine_id: id });
    row = await ctx.db.get(id);
  } else if (row.status === "failed" && !row.instance_id) {
    await ctx.db.patch(row._id, { status: "launching", launch_attempts: 0, error: undefined, updated_at: now });
    await ctx.scheduler.runAfter(0, refs().launch, { machine_id: row._id });
  }
  if (row.status === "ready" && row.device_id) {
    await startPiOn(ctx, userId, conversationId, row.device_id);
    return;
  }
  await ctx.db.patch(row._id, { held_conversation_ids: [...row.held_conversation_ids, conversationId], updated_at: now });
}

/** The person's machine as the UI shows it while it comes up. */
export const mine = query({
  args: {},
  handler: async (ctx): Promise<null | { status: string; online: boolean; error?: string; enabled: boolean; since?: number }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const enabled = castMachinesEnabledFor(userId);
    const row = await machineOf(ctx, userId);
    if (!row) return enabled ? { status: "none", online: false, enabled } : null;
    const device = row.device_id ? await ctx.db.query("devices").withIndex("by_user_device", (q: any) =>
      q.eq("user_id", userId).eq("device_id", row.device_id)).first() : null;
    const online = !!device && Date.now() - device.last_seen < DEVICE_ONLINE_MS;
    return { status: row.status, online, error: row.error, enabled, since: row.updated_at };
  },
});

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

export const getMachine = internalQuery({
  args: { machine_id: v.id("cast_machines") },
  handler: async (ctx, args) => await ctx.db.get(args.machine_id),
});

/** Mint the first boot's secrets and keep only their hashes. */
export const mintBootSecrets = internalMutation({
  args: { machine_id: v.id("cast_machines") },
  handler: async (ctx, args): Promise<{ setupToken: string; proxyKey: string }> => {
    const row = await ctx.db.get(args.machine_id);
    if (!row) throw new Error("no machine");
    const { token: setupToken } = await mintSetupToken(ctx, row.user_id);
    const proxyKey = randomKey("castm_");
    await ctx.db.patch(row._id, { voucher_hash: await sha256Hex(setupToken), proxy_key_hash: await sha256Hex(proxyKey), updated_at: Date.now() });
    return { setupToken, proxyKey };
  },
});

export const recordLaunch = internalMutation({
  args: {
    machine_id: v.id("cast_machines"),
    status: v.union(v.literal("booting"), v.literal("waiting_capacity"), v.literal("launching"), v.literal("failed")),
    instance_id: v.optional(v.string()),
    error: v.optional(v.string()),
    retry: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.machine_id);
    if (!row) return;
    const attempts = row.launch_attempts + 1;
    const giveUp = args.retry && attempts >= MAX_LAUNCH_ATTEMPTS;
    await ctx.db.patch(row._id, {
      status: giveUp ? "failed" : args.status,
      ...(args.instance_id ? { instance_id: args.instance_id } : {}),
      error: args.error, launch_attempts: attempts, updated_at: Date.now(),
    });
    if (args.retry && !giveUp) await ctx.scheduler.runAfter(LAUNCH_RETRY_MS, refs().launch, { machine_id: row._id });
  },
});

export const launch = internalAction({
  args: { machine_id: v.id("cast_machines") },
  handler: async (ctx, args): Promise<void> => {
    const row: any = await ctx.runQuery(refs().getMachine, args);
    if (!row || row.instance_id || (row.status !== "launching" && row.status !== "waiting_capacity")) return;
    try {
      if (!(await castMachineCapacityLeft())) {
        await ctx.runMutation(refs().recordLaunch, { machine_id: row._id, status: "waiting_capacity", retry: true });
        return;
      }
      const site = (process.env.CONVEX_SITE_URL ?? "").replace(/\/$/, "");
      if (!site) throw new Ec2Error("NoSiteUrl");
      const secrets: { setupToken: string; proxyKey: string } = await ctx.runMutation(refs().mintBootSecrets, args);
      const userData = btoa(castMachineUserData({ site, ...secrets }));
      const xml = await ec2({
        Action: "RunInstances", MinCount: "1", MaxCount: "1",
        "LaunchTemplate.LaunchTemplateName": CAST_MACHINE_LAUNCH_TEMPLATE,
        UserData: userData,
        // Idempotent per machine row: a retried launch returns the same instance.
        ClientToken: `cast-${row._id}`,
        "TagSpecification.1.ResourceType": "instance",
        "TagSpecification.1.Tag.1.Key": CAST_MACHINE_TAG.Key, "TagSpecification.1.Tag.1.Value": CAST_MACHINE_TAG.Value,
        "TagSpecification.1.Tag.2.Key": "codecast-user", "TagSpecification.1.Tag.2.Value": String(row.user_id),
        "TagSpecification.1.Tag.3.Key": "Name", "TagSpecification.1.Tag.3.Value": `cast-${String(row.user_id).slice(-8)}`,
      });
      const instanceId = /<instanceId>(i-[0-9a-f]+)<\/instanceId>/.exec(xml)?.[1];
      if (!instanceId) throw new Ec2Error("NoInstanceId");
      await ctx.runMutation(refs().recordLaunch, { machine_id: row._id, status: "booting", instance_id: instanceId });
    } catch (error) {
      const code = error instanceof Ec2Error ? error.code : "LaunchFailed";
      console.warn("cast_machine_launch_failed", { machine: row._id, code });
      const fatal = ["MissingCredentials", "NoSiteUrl", "UnauthorizedOperation", "InvalidLaunchTemplateName.NotFoundException"].includes(code);
      await ctx.runMutation(refs().recordLaunch, { machine_id: row._id, status: fatal ? "failed" : "launching", error: code, retry: !fatal });
    }
  },
});

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

/**
 * The machine's first boot redeemed its setup token (http /cli/exchange-token):
 * that names its device. The held sessions start once the device exists.
 */
export const bindDevice = internalMutation({
  args: { voucher_hash: v.string(), device_id: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("cast_machines").withIndex("by_voucher_hash", (q: any) => q.eq("voucher_hash", args.voucher_hash)).first();
    if (!row) return;
    await ctx.db.patch(row._id, { device_id: args.device_id, status: "ready", voucher_hash: undefined, error: undefined, updated_at: Date.now() });
    await ctx.scheduler.runAfter(0, refs().startHeld, { machine_id: row._id, tries: 0 });
  },
});

/** Start the sessions that waited for the machine, once its daemon's first
 *  heartbeat has made its device row (a start names a device that exists). */
export const startHeld = internalMutation({
  args: { machine_id: v.id("cast_machines"), tries: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.machine_id);
    if (!row?.device_id || row.held_conversation_ids.length === 0) return;
    const device = await ctx.db.query("devices").withIndex("by_user_device", (q: any) =>
      q.eq("user_id", row.user_id).eq("device_id", row.device_id)).first();
    if (!device) {
      if (args.tries < 60) await ctx.scheduler.runAfter(5_000, refs().startHeld, { machine_id: row._id, tries: args.tries + 1 });
      return;
    }
    await ctx.db.patch(row._id, { held_conversation_ids: [], updated_at: Date.now() });
    for (const conversationId of row.held_conversation_ids) {
      const conv = await ctx.db.get(conversationId);
      if (!conv || conv.inbox_killed_at) continue;
      await startPiOn(ctx, row.user_id, conversationId, row.device_id);
    }
  },
});

/** The model proxy's key check: which machine (and person) presents this key. */
export const machineForProxyKey = internalQuery({
  args: { key_hash: v.string() },
  handler: async (ctx, args): Promise<{ user_id: Id<"users"> } | null> => {
    const row = await ctx.db.query("cast_machines").withIndex("by_proxy_key_hash", (q: any) => q.eq("proxy_key_hash", args.key_hash)).first();
    return row && castMachinesEnabledFor(row.user_id) ? { user_id: row.user_id } : null;
  },
});

/** Drop a person's machine record (staff, via run.sh): the next Cast start
 *  launches a fresh machine. Terminating the old instance is a separate,
 *  deliberate AWS step. */
export const forget = internalMutation({
  args: { user_id: v.id("users") },
  handler: async (ctx, args): Promise<{ instance_id?: string } | null> => {
    const row = await machineOf(ctx, args.user_id);
    if (!row) return null;
    await ctx.db.delete(row._id);
    return { instance_id: row.instance_id };
  },
});
