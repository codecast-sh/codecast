import { v } from "convex/values";

// One machine's MCP sign-in round trip (shared/contracts/mcpLogin.ts), stored
// on its device row. The web starts it pending (mcpLogin.start); the daemon
// adds the authorization URL, then the outcome. `started_at` names the flow:
// every later write and command carries it, so a report from a flow that was
// replaced never lands on the new one.
export const mcpLoginFlowValidator = v.object({
  status: v.union(v.literal("pending"), v.literal("confirmed"), v.literal("rejected")),
  client: v.union(v.literal("claude"), v.literal("codex")),
  server: v.string(),
  url: v.optional(v.string()),
  // pending: the CLI refused a pasted address and asked again (its words), and when.
  notice: v.optional(v.string()),
  notice_at: v.optional(v.number()),
  // rejected: why (the CLI's own last words, a timeout, a cancel).
  reason: v.optional(v.string()),
  started_at: v.number(),
  finished_at: v.optional(v.number()),
});
