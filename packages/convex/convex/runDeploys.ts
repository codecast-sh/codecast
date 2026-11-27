// A personal flow run's end records its deploy (lib/runDeploy.ts, deploys.md
// DP11), scheduled by the runner's last report (workflow_runs.updateProgress)
// so a failure or a write conflict here never touches that report.
import { v } from "convex/values";
import { internalMutation } from "./functions";
import { recordRunDeploy } from "./lib/runDeploy";

export const record = internalMutation({
  args: { run_id: v.id("workflow_runs") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.run_id);
    return run ? await recordRunDeploy(ctx, run) : null;
  },
});
