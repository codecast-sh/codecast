// Agent definitions and chains: list, upsert, remove, resolve.
//
// One handler set serves the web (session auth) and the CLI (api_token) the
// way orgRoles does: every public function takes an optional api_token and
// getAuthenticatedUserId answers either. Rows are workspace scoped; reads are
// one equality per held key (heldKeysFor) and a write stamps `workspace` from
// the caller's choice of team or personal. `resolveDefinition` is the launch
// side's entry point: spawn, triggers and the daemon ask for a definition by
// name inside the viewer's workspaces and get the row back, never the whole
// table.

import { v } from "convex/values";
import { mutation, query } from "./functions";
import type { Id } from "./_generated/dataModel";
import { getAuthenticatedUserId } from "./pendingMessages";
import { heldKeysFor, requireTeamMembership, workspaceKey } from "./lib/access";
import { agentChainStepValidator, agentDefinitionFields } from "./agentSchema";
import {
  validateAgentChain,
  validateAgentDefinition,
  type AgentChainSpec,
  type AgentDefinitionSpec,
} from "@codecast/shared/contracts";

type Table = "agent_definitions" | "agent_chains";

async function requireCaller(ctx: any, apiToken?: string): Promise<Id<"users">> {
  const userId = await getAuthenticatedUserId(ctx, apiToken);
  if (!userId) throw new Error("Authentication failed: invalid token or session");
  return userId;
}

/** Rows of one table across every workspace the viewer holds a key for. */
async function listFor(ctx: any, userId: Id<"users">, table: Table) {
  const keys = await heldKeysFor(ctx, userId);
  const rows: any[] = [];
  for (const key of keys) {
    rows.push(...(await ctx.db.query(table).withIndex("by_workspace", (q: any) => q.eq("workspace", key)).collect()));
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

async function requireRow(ctx: any, userId: Id<"users">, table: Table, id: string) {
  const row = await ctx.db.get(id as Id<Table>);
  if (!row) throw new Error("Not found");
  if (String(row.user_id) === String(userId)) return row;
  const keys = await heldKeysFor(ctx, userId);
  if (!keys.has(row.workspace)) throw new Error("Forbidden: row is in another workspace");
  return row;
}

/** The workspace key a write lands in: the named team (membership checked)
 *  or the caller's personal workspace. */
async function writeKey(ctx: any, userId: Id<"users">, teamId?: Id<"teams">): Promise<{ workspace: string; team_id?: Id<"teams"> }> {
  if (teamId) {
    await requireTeamMembership(ctx, userId, teamId);
    return { workspace: workspaceKey({ type: "team", teamId }), team_id: teamId };
  }
  return { workspace: workspaceKey({ type: "personal", userId }) };
}

/** Find a row by name inside the viewer's held keys. The personal workspace
 *  wins over a team when both define the name, so a person can shadow a
 *  shared definition without editing it. */
async function findByName(ctx: any, userId: Id<"users">, table: Table, name: string, preferKey?: string) {
  const keys = await heldKeysFor(ctx, userId);
  const ordered = [
    ...(preferKey && keys.has(preferKey) ? [preferKey] : []),
    workspaceKey({ type: "personal", userId }),
    ...[...keys].filter((k) => k !== workspaceKey({ type: "personal", userId }) && k !== preferKey),
  ];
  for (const key of ordered) {
    const row = await ctx.db
      .query(table)
      .withIndex("by_workspace_name", (q: any) => q.eq("workspace", key).eq("name", name))
      .first();
    if (row) return row;
  }
  return null;
}

function definitionSpec(row: any): AgentDefinitionSpec {
  const spec: AgentDefinitionSpec = { name: row.name, description: row.description };
  for (const k of ["agent", "model", "effort", "tools", "disallowed_tools", "system_prompt", "prompt_mode", "mode", "isolated"] as const) {
    if (row[k] !== undefined && row[k] !== null) (spec as any)[k] = row[k];
  }
  return spec;
}

/** Launch surfaces call this with a user id they already hold. */
export async function resolveDefinitionFor(ctx: any, userId: Id<"users">, name: string, preferKey?: string): Promise<AgentDefinitionSpec | null> {
  const row = await findByName(ctx, userId, "agent_definitions", name, preferKey);
  return row ? definitionSpec(row) : null;
}

const upsertShared = {
  api_token: v.optional(v.string()),
  id: v.optional(v.string()),
  client_key: v.optional(v.string()),
  team_id: v.optional(v.id("teams")),
  name: v.string(),
  description: v.string(),
};

async function upsertRow(
  ctx: any,
  userId: Id<"users">,
  table: Table,
  prefix: string,
  args: { id?: string; client_key?: string; team_id?: Id<"teams">; name: string; description: string },
  fields: Record<string, unknown>,
) {
  const now = Date.now();
  const clean: Record<string, unknown> = { name: args.name.trim(), description: args.description.trim(), updated_at: now };
  for (const [k, val] of Object.entries(fields)) {
    if (val === undefined) continue;
    if (val === null || (Array.isArray(val) && val.length === 0) || val === "") clean[k] = undefined;
    else clean[k] = val;
  }

  let existing: any = null;
  if (args.id) existing = await requireRow(ctx, userId, table, args.id);
  else if (args.client_key) {
    const byKey = await ctx.db.query(table).withIndex("by_client_key", (q: any) => q.eq("client_key", args.client_key)).first();
    if (byKey && String(byKey.user_id) === String(userId)) existing = byKey;
  }

  if (existing) {
    const twin = await ctx.db
      .query(table)
      .withIndex("by_workspace_name", (q: any) => q.eq("workspace", existing.workspace).eq("name", clean.name))
      .first();
    if (twin && String(twin._id) !== String(existing._id)) throw new Error(`A ${table === "agent_chains" ? "chain" : "definition"} named "${clean.name}" already exists here`);
    await ctx.db.patch(existing._id, clean);
    return await ctx.db.get(existing._id);
  }

  const { workspace, team_id } = await writeKey(ctx, userId, args.team_id);
  const twin = await ctx.db
    .query(table)
    .withIndex("by_workspace_name", (q: any) => q.eq("workspace", workspace).eq("name", clean.name))
    .first();
  if (twin) {
    // Same name in the same workspace: an import or a retried create means
    // "update", never a duplicate.
    await ctx.db.patch(twin._id, clean);
    return await ctx.db.get(twin._id);
  }
  const id = await ctx.db.insert(table, {
    user_id: userId,
    team_id,
    workspace,
    short_id: `${prefix}-${now.toString(36)}`,
    client_key: args.client_key,
    created_at: now,
    ...clean,
  } as any);
  return await ctx.db.get(id);
}

// ── Definitions ──────────────────────────────────────────────────────────────

export const list = query({
  args: { api_token: v.optional(v.string()) },
  handler: async (ctx, args) => listFor(ctx, await requireCaller(ctx, args.api_token), "agent_definitions"),
});

export const get = query({
  args: { api_token: v.optional(v.string()), name: v.string() },
  handler: async (ctx, args) => findByName(ctx, await requireCaller(ctx, args.api_token), "agent_definitions", args.name),
});

/** The launch view: the spec for `--as <name>`, or null. */
export const resolve = query({
  args: { api_token: v.optional(v.string()), name: v.string(), team_id: v.optional(v.id("teams")) },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    return resolveDefinitionFor(ctx, userId, args.name, args.team_id ? workspaceKey({ type: "team", teamId: args.team_id }) : undefined);
  },
});

export const upsert = mutation({
  args: { ...upsertShared, ...agentDefinitionFields },
  handler: async (ctx, { api_token, id, client_key, team_id, name, description, ...fields }) => {
    const userId = await requireCaller(ctx, api_token);
    const spec: AgentDefinitionSpec = { name: name.trim(), description: description.trim(), ...(fields as any) };
    const problems = validateAgentDefinition(spec);
    if (problems.length) throw new Error(problems.join("; "));
    return upsertRow(ctx, userId, "agent_definitions", "ad", { id, client_key, team_id, name, description }, fields);
  },
});

export const remove = mutation({
  args: { api_token: v.optional(v.string()), id: v.optional(v.string()), name: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const row = args.id
      ? await requireRow(ctx, userId, "agent_definitions", args.id)
      : args.name
        ? await findByName(ctx, userId, "agent_definitions", args.name)
        : null;
    if (!row) throw new Error("Not found");
    await ctx.db.delete(row._id);
    return { removed: row.name };
  },
});

// ── Chains ───────────────────────────────────────────────────────────────────

export const listChains = query({
  args: { api_token: v.optional(v.string()) },
  handler: async (ctx, args) => listFor(ctx, await requireCaller(ctx, args.api_token), "agent_chains"),
});

export const getChain = query({
  args: { api_token: v.optional(v.string()), name: v.string() },
  handler: async (ctx, args) => findByName(ctx, await requireCaller(ctx, args.api_token), "agent_chains", args.name),
});

/** A chain plus every definition its steps name, resolved in one read so a
 *  runner never sees a chain whose steps point nowhere. */
export const resolveChain = query({
  args: { api_token: v.optional(v.string()), name: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const chain = await findByName(ctx, userId, "agent_chains", args.name);
    if (!chain) return null;
    const definitions: Record<string, AgentDefinitionSpec> = {};
    const missing: string[] = [];
    for (const step of chain.steps as Array<{ agent: string }>) {
      if (definitions[step.agent]) continue;
      const def = await resolveDefinitionFor(ctx, userId, step.agent, chain.workspace);
      if (def) definitions[step.agent] = def;
      else missing.push(step.agent);
    }
    const spec: AgentChainSpec = { name: chain.name, description: chain.description, steps: chain.steps };
    return { chain: spec, definitions, missing };
  },
});

export const upsertChain = mutation({
  args: { ...upsertShared, steps: v.array(agentChainStepValidator) },
  handler: async (ctx, { api_token, id, client_key, team_id, name, description, steps }) => {
    const userId = await requireCaller(ctx, api_token);
    const spec: AgentChainSpec = { name: name.trim(), description: description.trim(), steps };
    const problems = validateAgentChain(spec);
    if (problems.length) throw new Error(problems.join("; "));
    return upsertRow(ctx, userId, "agent_chains", "ac", { id, client_key, team_id, name, description }, { steps });
  },
});

export const removeChain = mutation({
  args: { api_token: v.optional(v.string()), id: v.optional(v.string()), name: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const row = args.id
      ? await requireRow(ctx, userId, "agent_chains", args.id)
      : args.name
        ? await findByName(ctx, userId, "agent_chains", args.name)
        : null;
    if (!row) throw new Error("Not found");
    await ctx.db.delete(row._id);
    return { removed: row.name };
  },
});
