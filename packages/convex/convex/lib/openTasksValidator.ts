import { v } from "convex/values";
import { OPEN_TASK_KINDS } from "@codecast/shared/contracts";

// One background task the daemon reports as still open on a session — the
// validator twin of shared/contracts OpenTaskReport (kinds derive from the same
// array so the two cannot drift). Shared by the schema and the mutation that
// accepts the report.
export const openTaskValidator = v.object({
  id: v.string(),
  kind: v.union(...OPEN_TASK_KINDS.map((k) => v.literal(k))),
  description: v.optional(v.string()),
  command: v.optional(v.string()),
  started_at: v.optional(v.number()),
  tool_use_id: v.optional(v.string()),
});
