// The machine that runs each workflow run, by its name, for the CLI's run read (workflow_runs.listRunsFromCli).
import type { Id } from "../_generated/dataModel";
import { deviceDisplayName } from "@codecast/shared/contracts";

/**
 * The machine that runs each, by its name (`cast workflow show`): a machine of the run's owner, else only its id. The
 * CLI's alone: a device row's heartbeat would re-run every web subscription of the list.
 */
export async function withRunnerNames<R extends { user_id: Id<"users">; runner_device?: string }>(ctx: { db: any }, runs: R[]): Promise<Array<R & { runner_device_name?: string }>> {
  const names = new Map<string, string | null>();
  const out = [];
  for (const run of runs) {
    const key = `${run.user_id}:${run.runner_device}`;
    if (run.runner_device && !names.has(key)) {
      const d = await ctx.db.query("devices").withIndex("by_user_device", (q: any) => q.eq("user_id", run.user_id).eq("device_id", run.runner_device)).first();
      names.set(key, d ? deviceDisplayName(d as any) : null);
    }
    out.push({ ...run, runner_device_name: names.get(key) ?? undefined });
  }
  return out;
}
