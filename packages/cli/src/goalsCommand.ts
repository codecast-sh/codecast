// `cast goals`: the workspace's goals as one document the ground node reads
// (docs/architecture/the-line-end-to-end.md LE5), and the ground fields
// `cast task update` writes back. The rows come from /cli/goals/brief
// (convex/goals.ts); the rendering is shared/contracts/goalsBrief. With a
// project (--project, else the repo profile's `[line] project`) the brief is
// that project's charter and the initiatives that carry it (line-profile.md
// LP1). With --task the brief is the one that cause is grounded against
// (convex/goals.ts causeBrief): its own project in its own workspace, else
// that workspace's whole brief, never the profile's default. Principles are
// the shared set plus the profile's own files (LP5).
//
//   cast goals [--brief] [--json] [--project <ref> | --task <ct>] [--team <name|id|personal>]
import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { renderGoalsBrief, type GoalsBrief } from "@codecast/shared/contracts/goalsBrief";
// The shared set ships inside the CLI, so every project reads the same one.
import SHARED_PRINCIPLES from "../../../docs/principles.md" with { type: "text" };
import { apiPost, type PublishDeps } from "./castApi.js";
import { callerUserId, taskWorkspaceScope } from "./cardCommand.js";
import { commandGroup } from "./commandGroups.js";
import { lineProjectFor, scopeFor } from "./signalCommand.js";
import { CODECAST_PRINCIPLES, loadLineProfile } from "./lineProfile.js";

/**
 * The principles a project's line reads: the shared set, then each of the
 * profile's principles files (paths relative to the repository root) that
 * exists and is not a copy of the shared set. `from` names each part read.
 */
export function readPrinciples(root: string | null, paths: string[] = [], shared: string = SHARED_PRINCIPLES): { text: string; from: string[] } | null {
  const parts = shared.trim() ? [{ from: CODECAST_PRINCIPLES, text: shared }] : [];
  for (const rel of root ? [...new Set(paths)] : []) {
    try {
      const text = fs.readFileSync(path.join(root!, rel), "utf8");
      if (text !== shared) parts.push({ from: rel, text });
    } catch {}
  }
  return parts.length ? { text: parts.map((p) => p.text).join("\n"), from: parts.map((p) => p.from) } : null;
}

export function registerGoalsCommand(program: Command, deps: PublishDeps): void {
  program
    .command("goals")
    .description(commandGroup("goals").description)
    .option("--brief", "The compact shape a prompt reads: no descriptions")
    .option("--json", "The raw rows and the principles text")
    .option("--project <ref>", "One project's charter and the initiatives carrying it: id, short id or title (default: the repo profile's [line] project, else the whole workspace)")
    .option("--task <ct>", "The brief this cause is grounded against: its own project's, else its workspace's (replaces --project and --team)")
    .option("--team <name|id|personal>", "Workspace to read (default: the repo profile's [line] team, else the session's team, else the directory's mapping)")
    .action(async (options: { brief?: boolean; json?: boolean; project?: string; task?: string; team?: string }) => {
      const cwd = process.env.CODECAST_CWD || process.cwd();
      const task = options.task ? await apiPost(deps, "/cli/work/get", { short_id: options.task }, { read: true }) : null;
      if (options.task && !task?.workspace) {
        console.error(`Task not found: ${options.task}`);
        process.exit(1);
      }
      const scope = task ? taskWorkspaceScope(task, await callerUserId(deps)) : await scopeFor(deps, options.team, false, lineProjectFor(options.team, options.project));
      const data: GoalsBrief = await apiPost(deps, "/cli/goals/brief", scope, { read: true });
      const { repoRootOf } = await import("./reviewCommand.js");
      const root = repoRootOf(cwd);
      const principles = readPrinciples(root, root ? loadLineProfile(cwd).profile.principles : []);
      if (options.json) {
        console.log(JSON.stringify({ ...data, principles: principles?.text ?? null }, null, 2));
        return;
      }
      process.stdout.write(renderGoalsBrief(data, { brief: options.brief, principles: principles?.text, principlesFrom: principles?.from }));
    });
}
