// The scope args every external data function takes. A leaf with no imports
// but the validator library: modules spread it into their args when they
// load, so it must never sit on an import cycle (lib/ingestScope.ts does).
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";

// Which workspace a call reads or writes: the same choice signals and tasks
// take (createWorkContext). The web passes team_id or workspace "personal";
// the CLI passes what its session resolves.
export const scopeArgs = {
  api_token: v.optional(v.string()),
  workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
  team_id: v.optional(v.id("teams")),
  project_path: v.optional(v.string()),
  conversation_id: v.optional(v.string()),
};
export type ScopeArgs = { api_token?: string; workspace?: "personal" | "team"; team_id?: Id<"teams">; project_path?: string; conversation_id?: string };
