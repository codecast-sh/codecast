// `cast ship run`: the One Ship control from a terminal (docs/architecture/ship.md).
// It calls the same server action as the web's Ship buttons, so the plan it
// prints is the popover's, and the ship session it starts is the same kind.
//
// `cast ship mark`: say that a surface just shipped.
//
// GitHub sees tags and pushes but never a deploy, so a surface that goes out
// on its own clock reports itself: packages/convex/deploy.sh runs
// `cast ship mark --surface backend` after a successful deploy. The marker
// lands on the repository's team as a `deploy` event, where the Changes page's
// live strip reads which commits are live and which are still waiting
// (docs/proposals/changes-page.md 7.3).
//
// Same deps pattern as prCommand.ts: index.ts hands in config access, this
// module stays importable by tests.

import type { Command } from "commander";
import { apiPost, type PublishDeps } from "./castApi.js";
import { commandGroup } from "./commandGroups.js";
import { gitTry } from "./gitPlane.js";
import { locate, readLocalGitContext } from "./prCommand.js";
import type { ShipPlan } from "@codecast/shared/contracts/shipPlan";
import { loadWorkspaceRoster, matchTeam, unknownTeamMessage } from "./resolveWorkspace.js";
import { c } from "./colors.js";

export type MarkOptions = {
  surface: string;
  sha?: string;
  version?: string;
  repo?: string;
  team?: string;
  dryRun?: boolean;
  json?: boolean;
};

/** The checkout the command stands in: its GitHub repository and HEAD. */
export type LocalCheckout = { repository: string | null; head: string | null };

async function readCheckout(cwd: string = process.cwd()): Promise<LocalCheckout> {
  return { repository: readLocalGitContext(cwd).repository, head: (await gitTry(cwd, ["rev-parse", "HEAD"])) ?? null };
}

/** The body `/cli/changes/mark-deploy` takes; flags win over the checkout. */
export function markBody(options: MarkOptions, local: LocalCheckout): { repository: string; surface: string; sha: string; version?: string } {
  const repository = options.repo ?? local.repository;
  if (!repository) throw new Error("No GitHub repository here: run inside a checkout with a GitHub origin, or pass --repo <owner/name>.");
  const sha = options.sha ?? local.head;
  if (!sha) throw new Error("No commit to mark: run inside a git checkout, or pass --sha <sha>.");
  return { repository, surface: options.surface, sha, ...(options.version ? { version: options.version } : {}) };
}

/** The plan as the popover says it: what, where, then each step. */
export function formatShipPlan(plan: ShipPlan): string {
  const out = [`Ship ${plan.label}`];
  if (plan.branch) out.push(`  ${plan.branch} -> ${plan.base}${plan.newBranch ? " (new branch)" : ""}`);
  out.push(...plan.steps.map((step, i) => `  ${i + 1}. ${step}`));
  out.push(`  ${plan.merge.why}`);
  if (plan.blocked) out.push(`  blocked: ${plan.blocked}`);
  return out.join("\n");
}

export type RunOptions = { task?: string; session?: string; pr?: string | boolean; repo?: string; dryRun?: boolean; json?: boolean };

export function registerShipCommand(program: Command, deps: PublishDeps & { checkout?: () => Promise<LocalCheckout> }): void {
  const ship = program.command("ship").description(commandGroup("ship").description);

  ship.command("run")
    .description("Ship a change: run the checks, open or shepherd its pull request, merge only from a PR or when the line profile says merge.auto")
    .option("--task <ct-N>", "The task whose change ships")
    .option("--session <id>", "The session whose diff ships")
    .option("--pr [ref]", "The pull request to ship (this checkout's branch when no ref); Ship on a PR merges once green")
    .option("--repo <owner/name>", "Repository to resolve --pr in")
    .option("--dry-run", "Print the plan without starting it")
    .option("--json", "Machine-readable output")
    .action(async (options: RunOptions) => {
      const named = [options.task, options.session, options.pr].filter((x) => x !== undefined);
      if (named.length !== 1) {
        console.error("Name one thing to ship: --task ct-N, --session <id>, or --pr [ref].");
        process.exit(1);
      }
      const pr_locator = options.pr !== undefined
        ? await locate(deps, typeof options.pr === "string" ? options.pr : undefined, { repo: options.repo })
        : undefined;
      const result = await apiPost(deps, "/cli/ship/run", {
        task: options.task,
        session: options.session,
        pr_locator,
        requester_session: deps.detectCurrentSessionId() ?? undefined,
        dry_run: options.dryRun || undefined,
      });
      if (result?.error) {
        console.error(result.error);
        process.exit(1);
      }
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(formatShipPlan(result.plan));
      if (options.dryRun) return;
      console.log(result.answered_card
        ? `${c.green}✓${c.reset} Answered Ship on the change card; the line's ship station lands it`
        : `${c.green}✓${c.reset} Ship session ${result.short_id} started (cast read ${result.short_id})`);
    });

  ship.command("mark")
    .description("Record that a surface just shipped this commit (a deploy marker on the repository's team)")
    .requiredOption("--surface <name>", "What shipped: backend, web, cli, desktop, or any name your team uses")
    .option("--sha <sha>", "The commit that shipped (default: HEAD)")
    .option("--version <version>", "The version it shipped as, when it has one")
    .option("--repo <owner/name>", "The repository (default: this checkout's GitHub origin)")
    .option("--team <name|id>", "The team, when more than one of yours works on the repository")
    .option("--dry-run", "Print the marker without recording it")
    .option("--json", "Machine-readable output")
    .action(async (options: MarkOptions) => {
      const body = markBody(options, await (deps.checkout ?? readCheckout)());
      const label = `${body.surface}${body.version ? ` ${body.version}` : ""} at ${body.sha.slice(0, 7)} on ${body.repository}`;
      if (options.dryRun) {
        console.log(options.json ? JSON.stringify({ dry_run: true, ...body }, null, 2) : `Would mark ${label}`);
        return;
      }
      let team_id: string | undefined;
      if (options.team) {
        const roster = await loadWorkspaceRoster(() => apiPost(deps, "/cli/teams", {}, { read: true }));
        const hit = matchTeam(roster, options.team);
        if (!hit) throw new Error(unknownTeamMessage(roster, options.team));
        team_id = hit._id;
      }
      const result = await apiPost(deps, "/cli/changes/mark-deploy", { ...body, ...(team_id ? { team_id } : {}) });
      console.log(options.json ? JSON.stringify(result, null, 2) : `${c.green}✓${c.reset} Marked ${label}`);
    });
}
