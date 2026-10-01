// `cast goals`: the workspace's goals as one document the ground node reads
// (docs/architecture/the-line-end-to-end.md LE5), and the ground fields
// `cast task update` writes back. The rows come from /cli/goals/brief
// (convex/goals.ts); the rendering is shared/contracts/goalsBrief.
//
//   cast goals [--brief] [--json] [--team <name|id|personal>]
import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { renderGoalsBrief, type GoalsBrief } from "@codecast/shared/contracts/goalsBrief";
import { apiPost, type PublishDeps } from "./castApi.js";
import { commandGroup } from "./commandGroups.js";
import { scopeFor } from "./signalCommand.js";

export const PRINCIPLES_PATH = "docs/principles.md";

/** docs/principles.md at the repository root, or null when the repo has none. */
export function readPrinciples(root: string | null): string | null {
  if (!root) return null;
  try {
    return fs.readFileSync(path.join(root, PRINCIPLES_PATH), "utf8");
  } catch {
    return null;
  }
}

export function registerGoalsCommand(program: Command, deps: PublishDeps): void {
  program
    .command("goals")
    .description(commandGroup("goals").description)
    .option("--brief", "The compact shape a prompt reads: no descriptions")
    .option("--json", "The raw rows and the principles text")
    .option("--team <name|id|personal>", "Workspace to read (default: the session's team, else the directory's mapping)")
    .action(async (options: { brief?: boolean; json?: boolean; team?: string }) => {
      const cwd = process.env.CODECAST_CWD || process.cwd();
      const scope = await scopeFor(deps, options.team, false);
      const data: GoalsBrief = await apiPost(deps, "/cli/goals/brief", scope, { read: true });
      const { repoRootOf } = await import("./reviewCommand.js");
      const principles = readPrinciples(repoRootOf(cwd));
      if (options.json) {
        console.log(JSON.stringify({ ...data, principles }, null, 2));
        return;
      }
      process.stdout.write(renderGoalsBrief(data, { brief: options.brief, principles }));
    });
}
