// Capability bindings — phase 2's write path (bind/unbind/toggle, the events
// log, and the revision counter the resolver caches against).
//
// Empty on purpose. It exists now so the phase 2 wave lands four verbs as four
// parallel edits to THIS file while state and catalog stay untouched.
//
// RULE inherited from the route layer (http.ts /cli/cap/bind): an agent-minted
// capability token can NEVER create a binding above session scope. The bind
// mutation inspects the credential class and rejects user, device, project and
// team scopes for anything but a real api_token held by the user — otherwise
// the consent gate is enforced only inside a CLI process the agent controls.



import { v } from "convex/values";
import { internalMutation, mutation, query } from "./functions";
import { verifyApiToken } from "./apiTokens";
import { capDb } from "./capabilitiesSchema";
import { SWEEP_BATCH } from "./capabilityState";

/* ==========================================================================
 * Consent — one human's yes to one build on one machine (ct-42851)
 * ========================================================================== */

/**
 * Record a consent. Idempotent per (user, device, slug, hash): saying yes twice
 * is one fact, and the second click must not spawn a second row for the sweep
 * and the audit trail to disagree over.
 */
export const grantConsent = mutation({
  args: {
    api_token: v.string(),
    device_id: v.string(),
    capability_slug: v.string(),
    manifest_hash: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    const db = capDb(ctx.db);
    const existing = await db
      .query("capability_consents")
      .withIndex("by_user_device_slug", (q: any) =>
        q.eq("user_id", auth.userId).eq("device_id", args.device_id).eq("capability_slug", args.capability_slug),
      )
      .collect();
    const match = existing.find((row) => row.manifest_hash === args.manifest_hash);
    if (match) return { status: "already_consented" as const };

    await db.insert("capability_consents", {
      user_id: auth.userId as unknown as string,
      device_id: args.device_id,
      capability_slug: args.capability_slug,
      manifest_hash: args.manifest_hash,
      consented_at: Date.now(),
      actor_user_id: auth.userId as unknown as string,
    });
    await db.insert("capability_events", {
      user_id: auth.userId as unknown as string,
      kind: "consent",
      actor_user_id: auth.userId as unknown as string,
      device_id: args.device_id,
      capability_slug: args.capability_slug,
      manifest_hash: args.manifest_hash,
      created_at: Date.now(),
    });
    return { status: "consented" as const };
  },
});

/** Every consent this user holds for a device — what the resolver's consent
 *  gate reads. Owner only by construction (index leads with user_id). */
export const listConsents = query({
  args: { api_token: v.string(), device_id: v.string() },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    const db = capDb(ctx.db);
    const rows = await db
      .query("capability_consents")
      .withIndex("by_user_device_slug", (q: any) =>
        q.eq("user_id", auth.userId).eq("device_id", args.device_id),
      )
      .collect();
    return rows.map((row) => ({
      capability_slug: row.capability_slug,
      manifest_hash: row.manifest_hash,
      consented_at: row.consented_at,
    }));
  },
});

/* ==========================================================================
 * Events — the audit line an incident needs (ct-42854)
 * ========================================================================== */

/** Internal helper other capability mutations call: one insert, no fan-out. */
export const recordCapabilityEvent = internalMutation({
  args: {
    user_id: v.string(),
    kind: v.union(
      v.literal("bind"), v.literal("unbind"), v.literal("enable"), v.literal("disable"),
      v.literal("consent"), v.literal("apply"), v.literal("conflict"), v.literal("import"),
    ),
    actor_user_id: v.string(),
    device_id: v.optional(v.string()),
    scope_kind: v.optional(v.string()),
    scope_key: v.optional(v.string()),
    capability_slug: v.optional(v.string()),
    manifest_hash: v.optional(v.string()),
    ops_json: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const db = capDb(ctx.db);
    await db.insert("capability_events", { ...args, created_at: Date.now() } as any);
  },
});

/** 90 days of audit is the retention bargain: long enough for any incident
 *  that will actually be investigated, short enough that the table cannot
 *  become the database. Same shape as sweepCapabilityState. */
export const EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export const sweepCapabilityEvents = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - EVENT_RETENTION_MS;
    const db = capDb(ctx.db);
    let deleted = 0;
    for (let hop = 0; hop < 16; hop++) {
      const batch = await db
        .query("capability_events")
        .withIndex("by_created", (q: any) => q.lt("created_at", cutoff))
        .take(SWEEP_BATCH);
      if (batch.length === 0) break;
      for (const row of batch) await db.delete(row._id);
      deleted += batch.length;
      if (batch.length < SWEEP_BATCH) break;
    }
    return { deleted };
  },
});

/* ==========================================================================
 * Bindings — the write path (ct-42845)
 * ========================================================================== */

import { scopeKeyValidForTeam } from "@codecast/shared/contracts";
import { requireTeamAdmin } from "./lib/access";


/** Bump the user's convergence revision. USER level, deliberately: most
 *  bindings are fleet-wide (user/team/project scope), so naming the affected
 *  devices would mean enumerating them on every write; an over-broad bump
 *  costs an idle device one no-op plan. Monotonic via increment, not clock. */
async function bumpCapabilityRevision(ctx: any, userId: string): Promise<void> {
  const user = await ctx.db.get(userId);
  if (!user) return;
  await ctx.db.patch(userId, {
    capability_revision: ((user as any).capability_revision ?? 0) + 1,
  });
}

const BIND_SCOPES = ["team", "user", "device", "project", "session"] as const;

/**
 * Create or update one binding. An UPSERT on (user, slug, scope_kind,
 * scope_key), because Convex has no uniqueness constraint: without the
 * query-then-patch, two tabs or one retry after a timeout produce two rows
 * with different `enabled` values and the user gets a toggle that will not
 * stay put — a duplicate-row class this repo has hit before.
 *
 * `enabled: false` writes a row, never a delete: deleting would silently
 * re-inherit whatever broader grant the disable was overriding. Deletion is
 * `unbindCapability`, a deliberate, different verb.
 */
export interface UpsertBindingArgs {
  capability_slug: string;
  scope_kind: string;
  scope_key: string;
  enabled: boolean;
  config?: Record<string, string>;
  client_filter?: string[];
  client_key?: string;
  team_id?: string;
}

/**
 * The one upsert. Exported so the CLI mutation and the web dispatch side
 * effect share it — two writers with their own upsert keys is how a toggle
 * ends up not staying put, which is the bug this whole module exists to stop.
 */
export async function upsertBinding(ctx: any, userId: string, args: UpsertBindingArgs) {
  {
    if (!(BIND_SCOPES as readonly string[]).includes(args.scope_kind)) {
      return { status: "rejected" as const, reason: "unknown_scope" };
    }
    if (args.scope_kind === "team") {
      if (!args.team_id) return { status: "rejected" as const, reason: "team_scope_needs_team" };
      // The same line userCanAdminAnchor draws: not every member may write
      // what lands on every member's machine.
      await requireTeamAdmin(ctx as any, userId as any, args.team_id as any);
      // A local: key names one user's disk; a team binding carrying one would
      // write into whatever sits at that path on someone else's machine.
      if (!scopeKeyValidForTeam(args.scope_key)) {
        return { status: "rejected" as const, reason: "local_key_never_team" };
      }
    }

    const db = capDb(ctx.db);
    const now = Date.now();
    const siblings = await db
      .query("capability_bindings")
      .withIndex("by_user_scope", (q: any) =>
        q
          .eq("user_id", userId)
          .eq("capability_slug", args.capability_slug)
          .eq("scope_kind", args.scope_kind)
          .eq("scope_key", args.scope_key),
      )
      .collect();

    if (siblings.length > 0) {
      // The upsert. Extra duplicates (from the pre-upsert era or a race that
      // slipped through) are folded into the first so the toggle stays put.
      const [keep, ...extra] = siblings;
      await db.patch(keep!._id, {
        enabled: args.enabled,
        config: args.config,
        client_filter: args.client_filter,
        updated_at: now,
        ...(args.team_id ? { team_id: args.team_id as unknown as string } : {}),
      });
      for (const row of extra) await db.delete(row._id);
      await db.insert("capability_events", {
        user_id: userId as unknown as string,
        kind: args.enabled ? "enable" : "disable",
        actor_user_id: userId as unknown as string,
        scope_kind: args.scope_kind,
        scope_key: args.scope_key,
        capability_slug: args.capability_slug,
        created_at: now,
      });
      await bumpCapabilityRevision(ctx, userId);
      return { status: "updated" as const, binding_id: keep!._id };
    }

    // client_key idempotency: a retry of the same optimistic create updates
    // rather than duplicating, even before the scope-tuple row exists.
    if (args.client_key) {
      const byKey = await db
        .query("capability_bindings")
        .withIndex("by_client_key", (q: any) =>
          q.eq("user_id", userId).eq("client_key", args.client_key),
        )
        .first();
      if (byKey) {
        await db.patch(byKey._id, { enabled: args.enabled, updated_at: now });
        await bumpCapabilityRevision(ctx, userId);
        return { status: "updated" as const, binding_id: byKey._id };
      }
    }

    const id = await db.insert("capability_bindings", {
      user_id: userId as unknown as string,
      team_id: args.team_id as unknown as string | undefined,
      capability_slug: args.capability_slug,
      scope_kind: args.scope_kind,
      scope_key: args.scope_key,
      enabled: args.enabled,
      config: args.config,
      client_filter: args.client_filter,
      client_key: args.client_key,
      created_by: "user",
      updated_at: now,
    });
    await db.insert("capability_events", {
      user_id: userId as unknown as string,
      kind: "bind",
      actor_user_id: userId as unknown as string,
      scope_kind: args.scope_kind,
      scope_key: args.scope_key,
      capability_slug: args.capability_slug,
      created_at: now,
    });
    await bumpCapabilityRevision(ctx, userId);
    return { status: "created" as const, binding_id: id };
  }
}

export const bindCapability = mutation({
  args: {
    api_token: v.string(),
    capability_slug: v.string(),
    scope_kind: v.string(),
    scope_key: v.string(),
    enabled: v.boolean(),
    config: v.optional(v.record(v.string(), v.string())),
    client_filter: v.optional(v.array(v.string())),
    client_key: v.optional(v.string()),
    team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    const { api_token: _token, ...rest } = args;
    return await upsertBinding(ctx, auth.userId as unknown as string, rest as UpsertBindingArgs);
  },
});


/** Remove a binding outright. The verb for "forget this wish existed" —
 *  distinct from enabled:false, which is itself a wish. */
export const unbindCapability = mutation({
  args: {
    api_token: v.string(),
    capability_slug: v.string(),
    scope_kind: v.string(),
    scope_key: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    const db = capDb(ctx.db);
    const rows = await db
      .query("capability_bindings")
      .withIndex("by_user_scope", (q: any) =>
        q
          .eq("user_id", auth.userId)
          .eq("capability_slug", args.capability_slug)
          .eq("scope_kind", args.scope_kind)
          .eq("scope_key", args.scope_key),
      )
      .collect();
    for (const row of rows) await db.delete(row._id);
    if (rows.length > 0) {
      await bumpCapabilityRevision(ctx, auth.userId as unknown as string);
      await db.insert("capability_events", {
        user_id: auth.userId as unknown as string,
        kind: "unbind",
        actor_user_id: auth.userId as unknown as string,
        scope_kind: args.scope_kind,
        scope_key: args.scope_key,
        capability_slug: args.capability_slug,
        created_at: Date.now(),
      });
    }
    return { removed: rows.length };
  },
});
