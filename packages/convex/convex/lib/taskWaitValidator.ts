import { v, type Infer } from "convex/values";
import { WAIT_STATES, type TaskWait, type WaitTarget } from "@codecast/shared/tasks";

// One entry of tasks.waits (task-graph.md TG2), mirroring TaskWait in
// @codecast/shared/tasks/graph.ts: a union on `kind` so a PR wait always
// carries its repository and number, a decision wait its sd-N, a time wait
// its `at`. The schema field and every mutation that writes waits use these.

export const waitStateValidator = v.union(...WAIT_STATES.map((s) => v.literal(s)));

const prTarget = {
  kind: v.union(v.literal("pr_merged"), v.literal("pr_checks_green")),
  /** normalizeRepository form, the key pull_requests is indexed by. */
  repository: v.string(),
  pr_number: v.number(),
};
const decisionTarget = { kind: v.literal("decision"), decision: v.string() };
const timeTarget = { kind: v.literal("time"), at: v.number() };

/** What a wait waits on, without its lifecycle: mutation args for adding one. */
export const waitTargetValidator = v.union(
  v.object(prTarget),
  v.object(decisionTarget),
  v.object(timeTarget),
);

const lifecycle = {
  id: v.string(),
  state: waitStateValidator,
  created_at: v.number(),
  created_by: v.optional(v.string()),
  settled_at: v.optional(v.number()),
  note: v.optional(v.string()),
};

export const taskWaitValidator = v.union(
  v.object({ ...prTarget, ...lifecycle }),
  v.object({ ...decisionTarget, ...lifecycle }),
  v.object({ ...timeTarget, ...lifecycle }),
);

// The validators and the shared types accept exactly the same shapes: the
// convex typecheck fails the moment either side gains or loses a field.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const waitShapesAgree: [
  Same<Infer<typeof taskWaitValidator>, TaskWait>,
  Same<Infer<typeof waitTargetValidator>, WaitTarget>,
] = [true, true];
