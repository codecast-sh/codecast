// `cast line deploy status|pause|lift|grant` (docs/architecture/deploys.md DP17): production paused, by whom and
// why, and who lifts it. deploy.sh reads `status --json` before it sends anything.

import type { Command } from "commander";
import { cliErrorMessage } from "@codecast/shared/contracts";
import { pauseLine, type DeployPauseView } from "@codecast/shared/contracts/deployPause";
import { apiPost } from "./castApi.js";
import type { GroupDeps } from "./commandGroups.js";
import { sessionIdFromEnv } from "./sessionIdentity.js";

async function repositoryOf(options: { repository?: string }): Promise<string> {
  if (options.repository) return options.repository;
  const { readLocalGitContext } = await import("./prCommand.js");
  const repository = readLocalGitContext(process.env.CODECAST_CWD || process.cwd()).repository;
  if (!repository) { console.error("No GitHub repository here: run inside the checkout, or pass --repository owner/name"); process.exit(1); }
  return repository;
}

export function registerDeployPauseCommands(deploy: Command, deps: GroupDeps): void {
  const post = (path: string, body: Record<string, unknown>, read = false) => apiPost(deps, path, body, { read, describeError: cliErrorMessage });
  const fromSession = () => sessionIdFromEnv() ?? undefined;

  deploy
    .command("status")
    .description("Whether this repository's production is paused: who paused it, why, and what lifts it")
    .option("--repository <owner/name>", "The repository (default: this checkout's GitHub origin)")
    .option("--json", "Machine-readable output ({ paused: null } when nothing is paused)")
    .action(async (_o: any, cmd: any) => {
      const options = cmd.optsWithGlobals();
      const s = await post("/cli/deploys/pause/status", { repository: await repositoryOf(options), from_session: fromSession() }, true);
      if (options.json) return void console.log(JSON.stringify(s, null, 2));
      console.log(s.paused ? pauseLine(s.paused as DeployPauseView) : `${s.repository}: production is not paused`);
    });

  deploy
    .command("pause")
    .description("Pause production: nothing is sent to this repository's targets until it lifts. Held by founders, engineers and the Release Captain")
    .requiredOption("--reason <why>", "Why production is paused")
    .option("--repository <owner/name>", "The repository (default: this checkout's GitHub origin)")
    .option("--json", "Machine-readable output")
    .action(async (_o: any, cmd: any) => {
      const options = cmd.optsWithGlobals();
      const p = await post("/cli/deploys/pause", { repository: await repositoryOf(options), reason: options.reason, from_session: fromSession() });
      console.log(options.json ? JSON.stringify(p, null, 2) : pauseLine(p));
    });

  deploy
    .command("lift")
    .description("Lift production's pause: whoever paused it, or the Release Captain")
    .option("--repository <owner/name>", "The repository (default: this checkout's GitHub origin)")
    .action(async (_o: any, cmd: any) => {
      const options = cmd.optsWithGlobals();
      const r = await post("/cli/deploys/pause/lift", { repository: await repositoryOf(options), from_session: fromSession() });
      console.log(r.lifted ? `${r.repository}: production's pause lifted` : `${r.repository}: production was not paused`);
    });

  deploy
    .command("grant")
    .description("A team admin grants a member the production pause (pause, lift, roll back), or takes it back")
    .argument("<person>", "The member: @handle, GitHub login, name or email")
    .option("--revoke", "Take the grant back")
    .option("--repository <owner/name>", "The repository whose team it is (default: this checkout's GitHub origin)")
    .action(async (person: string, _o: any, cmd: any) => {
      const options = cmd.optsWithGlobals();
      const r = await post("/cli/deploys/pause/grant", { repository: await repositoryOf(options), person, ...(options.revoke ? { revoke: true } : {}) });
      console.log(`${r.person} ${r.holds ? "holds" : "no longer holds"} the production pause`);
    });
}
