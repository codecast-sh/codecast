// `cast deploy`: a release of this checkout's deploy targets (deployRelease.ts,
// docs/architecture/deploys.md DP15).

import type { Command } from "commander";
import { apiPost } from "./castApi.js";
import { commandGroup, type GroupDeps } from "./commandGroups.js";

export function registerDeployCommand(program: Command, deps: GroupDeps): void {
  program
    .command("deploy")
    .description(commandGroup("deploy").description)
    .argument("[targets...]", "Targets to send, whatever their policy (default: every release target main moved past)")
    .option("--files <paths>", "Only the targets these files touch, space-separated (a change flow's Deploy stage)")
    .option("--except <targets>", "Targets to leave alone, space- or comma-separated")
    .option("--sha <sha>", "The commit to make live (default: main's head on origin)")
    .option("--dry-run", "Say what the release would send and wait for, and stop")
    .option("--json", "Machine-readable output")
    .action(async (names: string[], options: { files?: string; except?: string; sha?: string; dryRun?: boolean; json?: boolean }) => {
      const { checkoutTargets, originHead, runDeployGraphAsync } = await import("./lineDeploy.js");
      const { planRelease, runRelease, formatPlan, formatResults, commitsSince, holds } = await import("./deployRelease.js");
      const { readLocalGitContext } = await import("./prCommand.js");
      const { deviceId } = await import("./remote/device.js");
      const cwd = process.env.CODECAST_CWD || process.cwd();
      const repository = readLocalGitContext(cwd).repository;
      if (!repository) { console.error("No GitHub repository here: run inside the checkout whose targets these are"); process.exit(1); }
      const declared = await checkoutTargets(cwd);
      if (!declared.length) { console.error("This checkout declares no deploy targets. Add a [[target]] to .codecast/deploy.toml (docs: deploys.md DP10)."); process.exit(1); }
      const head = originHead(cwd);
      const sha = options.sha ?? head.sha;
      if (!sha) { console.error(`Could not read origin/${head.branch} here`); process.exit(1); }
      const readTargets = async () => (await apiPost(deps, "/cli/deploys/targets", { repository }, { read: true }))?.targets ?? [];
      const carries = (deployed: string) => holds(cwd, sha, deployed);
      const plan = await planRelease({
        declared,
        server: await readTargets(),
        sha,
        named: names,
        except: (options.except ?? "").split(/[\s,]+/).filter(Boolean),
        ...(options.files !== undefined ? { files: options.files.split(/\s+/).filter(Boolean) } : {}),
        commitsSince: (from, paths) => commitsSince(cwd, from, sha, paths),
        carries,
      }).catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
      if (options.dryRun) {
        console.log(options.json ? JSON.stringify({ sha, plan }, null, 2) : formatPlan(sha, plan));
        return;
      }
      if (!options.json) console.log(formatPlan(sha, plan));
      if (!plan.some((s) => s.action !== "skip")) {
        if (options.json) console.log(JSON.stringify({ sha, plan, results: [] }, null, 2));
        return;
      }
      const here = deviceId();
      const results = await runRelease(plan, {
        request: (target, onThisMachine) => apiPost(deps, "/cli/deploys/target/request", { repository, target, action: "deploy", ...(onThisMachine ? { here: true } : {}) }, { exitOnError: false }).then((r: any) => {
          if (!r?.short_id) throw new Error(r?.error ?? `could not ask for a deploy of ${target}`);
          return r;
        }),
        // A target this machine publishes runs in the checkout it published from, which holds the env its commands need.
        run: async (deploy, target) => {
          const row = (await readTargets()).find((t: any) => t.name === target);
          return runDeployGraphAsync(deploy, row?.root && row.device_id === here ? row.root : cwd, (line) => { if (!options.json) console.log(`[${target}] ${line}`); });
        },
        read: (deploy) => apiPost(deps, "/cli/deploys/get", { ref: deploy }, { read: true }),
        targets: readTargets,
        carries,
        publishedHere: (t) => !t.device_id || t.device_id === here,
        log: (target, line) => { if (!options.json) console.log(`[${target}] ${line}`); },
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      });
      if (options.json) console.log(JSON.stringify({ sha, plan, results }, null, 2));
      else console.log(`\n${formatResults(results)}`);
      if (results.some((r) => r.status === "failed")) process.exit(1);
    });
}
