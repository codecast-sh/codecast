// `cast deploy`: a release of this checkout's deploy targets (deployRelease.ts,
// docs/architecture/deploys.md DP15).

import type { Command } from "commander";
import { canRedeploySha, type DeployTarget } from "@codecast/shared/contracts/deployTargets";
import { apiPost } from "./castApi.js";
import { commandGroup, type GroupDeps } from "./commandGroups.js";

/** What a release asks the server for, per target: a deploy, of the named commit when the release pins one. */
export function releaseRequest(repository: string, target: string, sha: string | null, here: boolean): Record<string, unknown> {
  return { repository, target, action: "deploy", ...(sha ? { sha } : {}), ...(here ? { here: true } : {}) };
}

/**
 * The commit a release asks one target's deploy to make live: the one --sha named, else the head the release was
 * planned at when the target's command takes $sha, so a push after planning never rides along. A target whose
 * command sends the tree it runs in ships what it holds, and --carrying sends main's head: neither pins.
 */
export function requestShaFor(t: Pick<DeployTarget, "command"> | undefined, mode: { pinned: string | null; planned: string | null; carrying: boolean }): string | null {
  if (mode.pinned) return mode.pinned;
  if (mode.carrying || !mode.planned || !t || !canRedeploySha(t)) return null;
  return mode.planned;
}

/** The server's refusal of a commit it has not read yet: a push GitHub has not reported (deployTargetRequest.ts). */
const NOT_READ_YET = /as codecast has read it/;

/** Ask; while the server has not read the commit yet (a head pushed seconds ago), ask again every `everyMs`, up to `waitMs`. */
export async function askUntilRead<T>(ask: () => Promise<T>, opts: { sleep: (ms: number) => Promise<void>; log?: (line: string) => void; waitMs?: number; everyMs?: number; now?: () => number }): Promise<T> {
  const now = opts.now ?? Date.now;
  const until = now() + (opts.waitMs ?? 120_000);
  for (let told = false; ; ) {
    try {
      return await ask();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!NOT_READ_YET.test(msg) || now() >= until) throw err;
      if (!told) { opts.log?.("waiting for codecast to read the commit from GitHub (a push it has not reported yet)"); told = true; }
      await opts.sleep(opts.everyMs ?? 10_000);
    }
  }
}

export function registerDeployCommand(program: Command, deps: GroupDeps): void {
  program
    .command("deploy")
    .description(commandGroup("deploy").description)
    .argument("[targets...]", "Targets to send, whatever their policy (default: every release target main moved past)")
    .option("--files <paths>", "Only the targets these files touch, space-separated (a change flow's Deploy stage)")
    .option("--except <targets>", "Targets to leave alone, space- or comma-separated")
    .option("--sha <sha>", "The commit every deploy makes live, exactly (default: origin's head as the release plans it, for each target whose command takes $sha)")
    .option("--carrying <sha>", "Send main's head to every target that does not hold this commit yet (a change flow's Deploy: its landed commit)")
    .option("--dry-run", "Say what the release would send and wait for, and stop")
    .option("--json", "Machine-readable output")
    .action(async (names: string[], options: { files?: string; except?: string; sha?: string; carrying?: string; dryRun?: boolean; json?: boolean }) => {
      const { checkoutTargets, originHead, runDeployGraphAsync, pinnedSha } = await import("./lineDeploy.js");
      const { planRelease, runRelease, formatPlan, formatResults, commitsSince, holds } = await import("./deployRelease.js");
      const { readLocalGitContext } = await import("./prCommand.js");
      const { deviceId } = await import("./remote/device.js");
      const cwd = process.env.CODECAST_CWD || process.cwd();
      const repository = readLocalGitContext(cwd).repository;
      if (!repository) { console.error("No GitHub repository here: run inside the checkout whose targets these are"); process.exit(1); }
      const declared = await checkoutTargets(cwd);
      if (!declared.length) { console.error("This checkout declares no deploy targets. Add a [[target]] to .codecast/deploy.toml (docs: deploys.md DP10)."); process.exit(1); }
      const head = originHead(cwd);
      // --sha is the commit every deploy of the release makes live. --carrying plans the release by a commit main's
      // head holds (which targets lack it) and sends the head: a target whose command sends its tree can do only that.
      if (options.sha && options.carrying) { console.error("Name the commit to make live (--sha) or the one to carry (--carrying), not both"); process.exit(1); }
      const pinned = options.sha ? pinnedSha(cwd, options.sha, head.branch) : null;
      if (pinned && "error" in pinned) { console.error(pinned.error); process.exit(1); }
      const sha = pinned?.sha ?? options.carrying ?? head.sha;
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
        request: (target, onThisMachine) => {
          const pin = requestShaFor(declared.find((t) => t.name === target), { pinned: pinned?.sha ?? null, planned: sha, carrying: !!options.carrying });
          return askUntilRead(() => apiPost(deps, "/cli/deploys/target/request", releaseRequest(repository, target, pin, onThisMachine), { exitOnError: false }).then((r: any) => {
            if (!r?.short_id) throw new Error(r?.error ?? `could not ask for a deploy of ${target}`);
            return r;
          }), { sleep: (ms) => new Promise((res) => setTimeout(res, ms)), log: (line) => { if (!options.json) console.log(`[${target}] ${line}`); } });
        },
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
      // A release pushes commits of its own (the CLI release's version bump), so
      // the checkout follows origin once its targets are done, the way the
      // daemon's sweep would a minute later ([ship] level, land/levelSweep.ts).
      const { levelOne, describeLevel } = await import("./land/levelSweep.js");
      const { gitTry } = await import("./wipSnapshot.js");
      const root = await gitTry(cwd, ["rev-parse", "--show-toplevel"]);
      const level = root ? describeLevel(await levelOne(root).catch((e) => ({ root, skipped: String((e as Error)?.message ?? e) }))) : null;
      if (options.json) console.log(JSON.stringify({ sha, plan, results, level }, null, 2));
      else console.log(`\n${formatResults(results)}${level ? `\n${level}` : ""}`);
      if (results.some((r) => r.status === "failed")) process.exit(1);
    });
}
