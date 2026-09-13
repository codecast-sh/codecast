// Agent definitions and chains (docs: @codecast/shared/contracts/agentDefinitions).
//
// A definition is the one named object binding a client, model, effort, tool
// policy and system prompt; `cast exec/spawn --as <name>`, triggers, workflow
// nodes and the compose flow resolve it by name inside the viewer's
// workspace. A chain is an ordered list of steps naming definitions with
// prompt templates. Both are small workspace rows: `workspace` is the ACCESS
// key (one equality per read), `team_id` is routing, exactly as
// issue_sync_sources carries them. Neither table rides the sync log: the web
// feeds from a snapshot query and the store keeps the rows local first.

import { defineTable } from "convex/server";
import { v } from "convex/values";

const envelope = {
  user_id: v.id("users"),
  team_id: v.optional(v.id("teams")),
  workspace: v.string(),
  short_id: v.string(),
  // Idempotent create: the optimistic stub supersedes onto the row that
  // answers to its client_key (registry altKey).
  client_key: v.optional(v.string()),
  name: v.string(),
  description: v.string(),
  created_at: v.number(),
  updated_at: v.number(),
};

export const agentDefinitionFields = {
  agent: v.optional(v.string()),
  model: v.optional(v.string()),
  effort: v.optional(v.string()),
  tools: v.optional(v.array(v.string())),
  disallowed_tools: v.optional(v.array(v.string())),
  system_prompt: v.optional(v.string()),
  prompt_mode: v.optional(v.union(v.literal("append"), v.literal("replace"))),
  mode: v.optional(v.union(v.literal("apply"), v.literal("propose"))),
  isolated: v.optional(v.boolean()),
};

export const agentChainStepValidator = v.object({
  agent: v.string(),
  prompt: v.string(),
});

export const agentChainFields = {
  steps: v.array(agentChainStepValidator),
};

export const agentTables = {
  agent_definitions: defineTable({ ...envelope, ...agentDefinitionFields })
    .index("by_user_id", ["user_id"])
    .index("by_team_id", ["team_id"])
    .index("by_workspace", ["workspace"])
    .index("by_workspace_name", ["workspace", "name"])
    .index("by_short_id", ["short_id"])
    .index("by_client_key", ["client_key"]),
  agent_chains: defineTable({ ...envelope, ...agentChainFields })
    .index("by_user_id", ["user_id"])
    .index("by_team_id", ["team_id"])
    .index("by_workspace", ["workspace"])
    .index("by_workspace_name", ["workspace", "name"])
    .index("by_short_id", ["short_id"])
    .index("by_client_key", ["client_key"]),
};
