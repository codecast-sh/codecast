// The one insert of a new priorities row: its pri-N, an empty session count
// and the milestone key mark its steps start from. A person's create
// (priorityWrite doCreate) writes through it; the pass's creates
// (priorityPassRun applyPlan) mirror it and should switch to it.

import type { Doc, Id } from "../_generated/dataModel";
import { nextShortId } from "../counters";
import { stepKeyMax } from "./priorityPassSteps";

export type NewPriority = Omit<Doc<"priorities">, "_id" | "_creationTime" | "short_id" | "session_count" | "step_key_max" | "created_at" | "updated_at">;

export async function insertPriority(ctx: { db: any }, row: NewPriority, now: number): Promise<{ id: Id<"priorities">; short_id: string }> {
  const short_id = await nextShortId(ctx.db, "pri");
  const id = await ctx.db.insert("priorities", {
    ...row,
    short_id,
    session_count: 0,
    step_key_max: stepKeyMax(row.steps),
    created_at: now,
    updated_at: now,
  });
  return { id, short_id };
}
