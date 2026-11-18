import { v } from "convex/values";

// Which messaging policy a plan's agents follow (docs/architecture/agent-comms.md):
// `lead` reports to the plan's lead through `cast send`, `shared-log` posts typed
// entries to the plan that every agent's next `cast` command shows once. Absent
// means `lead`, so a plan that never chose keeps today's behaviour.
export const messagingPolicyValidator = v.union(v.literal("lead"), v.literal("shared-log"));
