// Where a task's work landed on its repository's default branch: the newest
// commit there that names the task (schema tasks.landed). Most fixes reach a
// product's main as a commit or a hand merge the line never runs, so this is
// what tells the line a fix it built and a person approved is merged.

import type { Id } from "../_generated/dataModel";
import { commitUrl } from "./gitRefs";

export type Landed = { sha: string; at: number; url: string; repository: string; branch: string };

/** Stamp each task with this commit when it is newer than what the task holds. */
export async function recordLanded(ctx: any, taskIds: ReadonlyArray<Id<"tasks">>, commit: { sha: string; at: number; repository: string; branch: string }): Promise<number> {
  let stamped = 0;
  for (const id of new Set(taskIds)) {
    const task = await ctx.db.get(id);
    if (!task || (task.landed && task.landed.at >= commit.at)) continue;
    const landed: Landed = { ...commit, url: commitUrl(commit.repository, commit.sha) };
    await ctx.db.patch(id, { landed });
    stamped++;
  }
  return stamped;
}
