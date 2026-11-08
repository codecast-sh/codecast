/**
 * `cast land`: find the work every worktree and cloud host holds that main
 * does not, and release the finished trees that hold nothing worth landing.
 *
 * `scan` reads; `prune` archives and removes (scan.ts has the verdicts,
 * prune.ts the archive). The /deploy command reads `scan --json`, lands the
 * `ready` trees' files topic by topic, then runs `prune --yes`. `hold` and
 * `release` mark a tree that must stay on its branch (hold.ts).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Command } from "commander";
import { fmt } from "../colors.js";
import { commandGroup } from "../commandGroups.js";
import { execFileAsync } from "../proc.js";
import { formatAgeShort } from "../publishCommand.js";
import { PRUNABLE, processCwds, scanRepo, type FileVerdict, type RepoScan, type RosterRow, type TreeReport, type TreeVerdict } from "./scan.js";
import { archiveDir, pruneTree, treePatch, type PruneResult } from "./prune.js";
import { clearHold, readHold, writeHold } from "./hold.js";

interface ScanOpts { repo?: string[]; allRepos?: boolean; hosts?: boolean; json?: boolean; verbose?: boolean; fetch?: boolean; only?: string[] }

interface HostScan { id: string; label: string; error?: string; result?: LandScan }

export interface LandScan {
  scannedAt: string;
  machine: string;
  /** "ok…" (with where it came from), or why the session roster could not be read. */
  roster: string;
  repos: RepoScan[];
  hosts?: HostScan[];
}

/** The main checkout of the repo holding `dir`. */
async function repoRootOf(dir: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf-8" });
  return path.dirname(String(stdout).trim());
}

/** Every main checkout directly under ~/work on a cloud host, ~/src elsewhere. */
function allRepoRoots(): string[] {
  const home = process.env.CODECAST_CLOUD === "1" ? path.join(os.homedir(), "work") : path.join(os.homedir(), "src");
  let names: string[] = [];
  try { names = fs.readdirSync(home); } catch { return []; }
  return names
    .map((n) => path.join(home, n))
    .filter((d) => { try { return fs.statSync(path.join(d, ".git")).isDirectory(); } catch { return false; } });
}

/**
 * The sessions this device runs. cloud:hostSessions reads every row the
 * device ever owned, which times out on a laptop with a long history; then
 * the inbox listing (`cast sessions`) stands in. It omits subagent rows, whose
 * trees are still caught by a running process or recent edits.
 */
export async function readRoster(): Promise<{ rows: RosterRow[] | null; status: string }> {
  // The Convex client logs (slow-query warnings) to stdout, which would corrupt --json.
  const log = console.log;
  console.log = console.error;
  let first: string;
  try {
    const { convexClient } = await import("../remote/convexClient.js");
    const { deviceId } = await import("../remote/device.js");
    const convex = await convexClient({ timeoutMs: 30_000 });
    const rows = await convex.client.query(convex.api.cloud.hostSessions, { api_token: convex.token, device_id: deviceId() });
    return { rows: (rows ?? []) as RosterRow[], status: "ok" };
  } catch (err) {
    first = String((err as Error)?.message ?? err).split("\n").filter(Boolean).pop() ?? "failed";
  } finally {
    console.log = log;
  }
  try {
    return { rows: await inboxRoster(), status: `ok (inbox listing; hostSessions failed: ${first})` };
  } catch (err) {
    return { rows: null, status: `hostSessions failed (${first}); inbox listing failed (${String((err as Error)?.message ?? err).split("\n")[0]})` };
  }
}

/** The runs live on this machine (workflow/liveRuns.ts), or null when the server cannot say: every run tree is then kept. */
async function liveRunIds(): Promise<Set<string> | null> {
  const log = console.log;
  console.log = console.error;
  try {
    const { convexClient } = await import("../remote/convexClient.js");
    const { deviceId } = await import("../remote/device.js");
    const { liveRunIdsOf } = await import("../workflow/liveRuns.js");
    const convex = await convexClient({ timeoutMs: 30_000 });
    const data = await convex.client.mutation(convex.api.workflow_runs.liveRunsForDevice, { api_token: convex.token, device: deviceId() });
    return liveRunIdsOf(data && !("error" in data) ? data : null);
  } catch {
    return null;
  } finally {
    console.log = log;
  }
}

/**
 * The inbox listing (`cast sessions`) as roster rows. Without ids it omits
 * subagent and stashed rows; named ids answer whatever their state.
 */
export async function inboxRoster(ids: string[] = []): Promise<RosterRow[]> {
  const { stdout } = await execFileAsync("cast", ["sessions", ...ids, "--json", "-n", "1000"], { encoding: "utf-8", timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
  const json = JSON.parse(String(stdout).slice(String(stdout).indexOf("{")));
  return Object.values(json).filter(Array.isArray).flat()
    .filter((r: any) => r && typeof r === "object" && "work_state" in r)
    .map((r: any): RosterRow => ({ short_id: String(r.id).slice(0, 7), title: r.title ?? null, work_state: r.work_state, project_path: r.project_path ?? null, updated_at: r.updated_at ?? null }));
}

async function scanLocal(opts: ScanOpts): Promise<LandScan> {
  const roots = opts.repo?.length
    ? await Promise.all(opts.repo.map(repoRootOf))
    : opts.allRepos ? allRepoRoots() : [await repoRootOf(process.cwd())];
  const [roster, cwds] = await Promise.all([readRoster(), processCwds()]);
  const { runTreesInUseVia } = await import("../worktreeGc.js");
  const runTreesInUse = runTreesInUseVia(liveRunIds);
  const repos: RepoScan[] = [];
  for (const root of [...new Set(roots)]) {
    repos.push(await scanRepo(root, { roster: roster.rows, processCwds: cwds, runTreesInUse, fetch: opts.fetch, only: opts.only }));
  }
  return { scannedAt: new Date().toISOString(), machine: os.hostname(), roster: roster.status, repos };
}

/** Run a `cast land` subcommand on every registered cloud host and parse its JSON. */
/** How long one host's scan may take before it is reported as not answering. */
const HOST_SCAN_BUDGET_MS = 5 * 60_000;

async function onHosts(args: string): Promise<HostScan[]> {
  const { readHosts, toRemoteHost } = await import("../browser/cloudHost.js");
  const { sshBase } = await import("../remote/session-move.js");
  // Asynchronous ssh, so the hosts scan side by side: a synchronous one ran
  // them in turn, each allowed 15 minutes, and a caller's timeout killed the
  // whole scan before anything printed.
  return Promise.all(readHosts().map(async (h) => {
    const label = `${h.user}@${h.address ?? "?"}`;
    if (!h.address) return { id: h.id, label, error: "no address (asleep?): cast hosts wake it first" };
    const remote = toRemoteHost(h);
    try {
      const { stdout } = await execFileAsync("ssh", [...sshBase(remote), `${remote.user}@${remote.address}`, `bash -lc 'cast land ${args} --json'`], { encoding: "utf-8", timeout: HOST_SCAN_BUDGET_MS, maxBuffer: 256 * 1024 * 1024, env: process.env });
      const out = String(stdout);
      return { id: h.id, label, result: JSON.parse(out.slice(out.indexOf("{"))) as LandScan };
    } catch (err: any) {
      const text = String(err?.stderr || err?.message || err);
      const reason = err?.killed || err?.signal === "SIGTERM" ? `no answer in ${HOST_SCAN_BUDGET_MS / 60_000} min`
        : /unknown command|no command group named "land"/.test(text) ? "the host's cast has no `land` yet (update its CLI)"
          : text.split("\n").filter(Boolean).pop() ?? "ssh failed";
      return { id: h.id, label, error: reason.slice(0, 200) };
    }
  }));
}

/** The scan with only these verdicts' trees, here and on every host. */
export function keepVerdicts(scan: LandScan, verdicts: Set<string>): LandScan {
  const repos = scan.repos.map((r) => ({ ...r, trees: r.trees.filter((t) => verdicts.has(t.verdict)) }));
  const hosts = scan.hosts?.map((h) => (h.result ? { ...h, result: keepVerdicts(h.result, verdicts) } : h));
  return { ...scan, repos, ...(hosts ? { hosts } : {}) };
}

const ORDER: TreeVerdict[] = ["ready", "review", "held", "run", "stale", "landed", "empty", "live", "primary"];
const TONE: Record<TreeVerdict, (s: string) => string> = {
  ready: fmt.success, review: fmt.warning, held: fmt.warning, run: fmt.accent, stale: fmt.muted, landed: fmt.muted, empty: fmt.muted, live: fmt.accent, primary: fmt.label,
};

function treeLine(t: TreeReport, now: number): string {
  const c = t.counts;
  const owner = t.owner ? ` ${fmt.id(t.owner.short_id)}${t.owner.work_state ? ` ${t.owner.work_state}` : ""}` : "";
  const files = `${c.only} only ${c.both} both ${c.same + c.absorbed} in main`;
  return `  ${TONE[t.verdict](t.verdict.padEnd(10))} ${formatAgeShort(now - t.lastActivity).padStart(4)}  ${fmt.muted(files.padEnd(24))} ${fmt.path(t.path)}${owner}\n             ${fmt.muted(t.reason)}`;
}

function printScan(scan: LandScan, verbose: boolean, prefix = ""): void {
  const now = Date.parse(scan.scannedAt);
  if (!scan.roster.startsWith("ok")) console.log(fmt.warning(`${prefix}session roster unavailable (${scan.roster}): live trees are told apart only by recent activity and running processes`));
  for (const r of scan.repos) {
    const by = new Map<TreeVerdict, TreeReport[]>();
    for (const t of r.trees) by.set(t.verdict, [...(by.get(t.verdict) ?? []), t]);
    const summary = ORDER.filter((v) => by.has(v)).map((v) => `${by.get(v)!.length} ${v}`).join(", ");
    console.log(`${prefix}${fmt.highlight(r.repo)} ${fmt.muted(r.root)}  ${summary}`);
    for (const v of ORDER) {
      const trees = by.get(v) ?? [];
      const show = verbose || v === "ready" || v === "review" || v === "held" || v === "primary" ? trees : [];
      for (const t of show) console.log(treeLine(t, now));
      if (trees.length > show.length) console.log(`  ${TONE[v](v.padEnd(10))} ${fmt.muted(`${trees.length} trees (--verbose lists them)`)}`);
    }
    for (const e of r.errors) console.log(`  ${fmt.error("error".padEnd(10))} ${fmt.path(e.path)} ${fmt.muted(e.error)}`);
  }
}

/**
 * The trees prune may remove: prunable verdicts only, never with an unread
 * roster, never one that holds a worktree that is itself staying, and never
 * one nested inside a tree that is in use.
 */
export function pruneTargets(scan: LandScan): { go: TreeReport[]; held: Array<{ tree: TreeReport; reason: string }> } {
  const all = scan.repos.flatMap((r) => r.trees);
  const candidates = all.filter((t) => PRUNABLE.has(t.verdict));
  const going = new Set(candidates.map((t) => t.path));
  const go: TreeReport[] = [];
  const held: Array<{ tree: TreeReport; reason: string }> = [];
  for (const t of candidates) {
    if (!scan.roster.startsWith("ok")) { held.push({ tree: t, reason: "session roster unavailable" }); continue; }
    const nested = all.find((o) => o.path.startsWith(`${t.path}/`) && !going.has(o.path));
    if (nested) { held.push({ tree: t, reason: `holds ${nested.path} (${nested.verdict}), which stays` }); continue; }
    const host = all.find((o) => t.path.startsWith(`${o.path}/`) && !o.primary && (o.verdict === "live"));
    if (host) { held.push({ tree: t, reason: `inside ${host.path}, which is in use (${host.reason})` }); continue; }
    go.push(t);
  }
  // Inner trees first, so an outer tree's move never carries one still to be archived.
  go.sort((a, b) => b.path.length - a.path.length);
  return { go, held };
}

/** The worktree a hold names (default: the one holding this directory). The main checkout is where landing goes, so it is never held. */
async function heldTarget(tree: string | undefined): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", path.resolve(tree ?? "."), "rev-parse", "--show-toplevel"], { encoding: "utf-8" }).catch(() => ({ stdout: "" }));
  const dir = String(stdout).trim();
  if (!dir) { console.error(`not a git worktree: ${path.resolve(tree ?? ".")}. Pass a worktree's path; cast land scan -v lists them`); process.exit(1); }
  if (await repoRootOf(dir) === dir) { console.error(`${dir} is the repo's main checkout, where landing goes; hold a worktree instead`); process.exit(1); }
  return dir;
}

function addScanOptions(cmd: Command): Command {
  return cmd
    .option("--repo <path...>", "repos to scan (default: the one holding this directory)")
    .option("--all-repos", "every repo under ~/src (on a cloud host, ~/work)")
    .option("--hosts", "also every registered cloud host, over ssh")
    .option("--no-fetch", "judge against the origin refs already on disk")
    .option("--json", "machine-readable output");
}

export function registerLandCommand(program: Command): void {
  const land = program
    .command("land")
    .description(commandGroup("land").description)
    .addHelpText("after", `
Verdicts (a tree's own work = its base to its working tree, untracked files included):
  ready    finished recently, holds files only it changed: land them
  review   finished recently, holds changes main lacks to files main also changed
  held     a session marked it held (cast land hold): it stays on its branch,
           never landed or pruned, until cast land release
  run      a line run made it: the run ships its change after its decision, so
           it is never landed by hand (land diff refuses it)
  stale    finished and untouched for 7 days: archived and released, not landed
  landed   main already holds every change it made
  empty    no changes of its own
  live     a live session or process is in it, or it changed in the last 2 hours
  primary  the repo's main checkout

Per file: only (main never touched it: applies cleanly), both (main changed it
too and lacks this change), and in main (identical, or main already holds the
change's lines).

  cast land scan                     this repo's worktrees
  cast land scan --all-repos --hosts everything, laptop and cloud
  cast land hold [tree] -r "<why>"   keep a tree on its branch: never landed
  cast land release [tree]           let it land again
  cast land diff <tree> --only       the files only that tree changed, as a patch
  cast land prune --yes              archive and release stale, landed and empty trees

Pruned work stays recoverable: ${archiveDir()}/<date>-<repo>-<tree>.patch, and the
branch as refs/codecast/land-archive/<branch>.`);

  addScanOptions(land.command("scan").description("Classify every worktree's own work against main"))
    .option("-v, --verbose", "list every tree, not just ready, review and held")
    .option("--verdict <verdicts>", `only trees with these verdicts, comma-separated (${ORDER.join(", ")})`)
    .addHelpText("after", `
--json prints { scannedAt, machine, roster, repos[], hosts[] }:
  roster   "ok", "ok (inbox listing; ...)", or why the session roster could not be read
  repos[]  { repo, root, origin, mainRef, errors[], trees[] }
  trees[]  { path, branch, head, base, primary, verdict, reason, inUse, lastActivity (ms),
             owner: { short_id, title, work_state } | null,
             counts: { only, both, same, absorbed }, files[]: { path, verdict, status } }
  hosts[]  with --hosts: { id, label, result (the same shape) | error }
A scan that cannot run prints { "error": "..." } on stdout and exits 1.

  cast land scan --verdict ready,review --json`)
    .action(async (opts: ScanOpts & { verdict?: string }) => {
      const verdicts = opts.verdict ? new Set(opts.verdict.split(",").map((v) => v.trim()).filter(Boolean)) : null;
      const unknown = [...(verdicts ?? [])].filter((v) => !ORDER.includes(v as TreeVerdict));
      if (unknown.length) { console.error(`--verdict takes ${ORDER.join(", ")} (got ${unknown.join(", ")})`); process.exit(1); }
      let scan: LandScan;
      try {
        scan = await scanLocal(opts);
        if (opts.hosts) scan.hosts = await onHosts(`scan --all-repos${opts.fetch === false ? " --no-fetch" : ""}`);
      } catch (err) {
        // stdout carries the answer under --json, a failure included, so a caller never reads an empty file.
        const message = String((err as Error)?.message ?? err).split("\n")[0];
        if (opts.json) console.log(JSON.stringify({ error: message }));
        else console.error(`land scan failed: ${message}`);
        process.exit(1);
      }
      if (verdicts) scan = keepVerdicts(scan, verdicts);
      if (opts.json) { console.log(JSON.stringify(scan, null, 2)); return; }
      printScan(scan, !!opts.verbose || !!verdicts);
      for (const h of scan.hosts ?? []) {
        console.log(`\n${fmt.highlight(h.label)} ${fmt.muted(h.id)}`);
        if (h.error) console.log(`  ${fmt.error(h.error)}`);
        else if (h.result) printScan(h.result, !!opts.verbose, "  ");
      }
    });

  land
    .command("diff")
    .argument("<tree>", "the worktree's path, as cast land scan prints it")
    .description("Print a tree's own change as a patch against its base")
    .option("--only", "just the files only this tree changed (they apply cleanly to main)")
    .option("--both", "just the files main also changed")
    .action(async (tree: string, opts: { only?: boolean; both?: boolean }) => {
      const dir = path.resolve(tree);
      if (!fs.existsSync(dir)) { console.error(`no worktree at ${dir}. Pass a worktree's path; cast land scan -v lists every tree with its path`); process.exit(1); }
      const scan = await scanRepo(await repoRootOf(dir), { roster: null, processCwds: [], fetch: false, only: [dir] });
      const report = scan.trees.find((t) => t.path === dir);
      if (!report) { console.error(`no worktree at ${dir}. Pass a worktree's path; cast land scan -v lists every tree with its path`); process.exit(1); }
      if (report.verdict === "run" || report.verdict === "held") { console.error(`not landed by hand: ${dir} is ${report.reason}`); process.exit(1); }
      const only: FileVerdict[] | undefined = opts.only || opts.both ? [...(opts.only ? ["only" as const] : []), ...(opts.both ? ["both" as const] : [])] : undefined;
      process.stdout.write(await treePatch(report, only));
    });

  land
    .command("hold")
    .argument("[tree]", "the worktree's path (default: the one holding this directory)")
    .description("Mark a worktree held: cast land and /deploy report it and never land or prune it")
    .requiredOption("-r, --reason <why>", "why it stays on its branch, shown wherever it is listed")
    .action(async (tree: string | undefined, opts: { reason: string }) => {
      const dir = await heldTarget(tree);
      const by = process.env.CODECAST_SESSION_ID;
      writeHold(dir, opts.reason, by);
      console.log(`Held ${dir}: ${opts.reason.trim()}`);
    });

  land
    .command("release")
    .argument("[tree]", "the worktree's path (default: the one holding this directory)")
    .description("Lift a worktree's hold so it can land again")
    .action(async (tree: string | undefined) => {
      const dir = await heldTarget(tree);
      const was = readHold(dir);
      if (!clearHold(dir)) { console.log(`${dir} was not held`); return; }
      console.log(`Released ${dir} (was held: ${was?.reason ?? "?"})`);
    });

  land
    .command("level")
    .description("Move this checkout onto its upstream in place: rewrite only files nobody here changed, keep every local edit")
    .option("--to <ref>", "the commit to level onto (default: the upstream, origin/main)")
    .option("--no-fetch", "use the upstream ref already on disk")
    .option("--dry-run", "report what would be written, write nothing")
    .option("--json", "machine-readable output")
    .action(async (opts: { to?: string; fetch?: boolean; dryRun?: boolean; json?: boolean }) => {
      const { levelCheckout } = await import("./level.js");
      const { upstreamRef } = await import("./shipCheckout.js");
      const root = await repoRootOf(process.cwd());
      const target = opts.to ?? await upstreamRef(root);
      if (!opts.to && opts.fetch !== false) {
        const [remote, ...branch] = target.split("/");
        await execFileAsync("git", ["-C", root, "fetch", "--quiet", remote, branch.join("/")]).catch(() => {});
      }
      const r = await levelCheckout(root, target, { dryRun: opts.dryRun });
      if (opts.json) { console.log(JSON.stringify(r, null, 2)); if (!r.ok) process.exitCode = 1; return; }
      if (r.from === r.to) { console.log(`Already level with ${target} (${r.to.slice(0, 9)})`); return; }
      const verb = opts.dryRun ? "Would level" : r.ok ? "Levelled" : "Did not level";
      console.log(`${verb} ${r.from.slice(0, 9)} -> ${r.to.slice(0, 9)} (${target}): ${r.written.length} written, ${r.deleted.length} deleted, ${r.merged.length} merged, ${r.absorbed.length} absorbed`);
      if (!r.ok) {
        console.log(fmt.error(r.reason ?? "failed"));
        for (const c of r.conflicts) console.log(`  ${fmt.path(c)}`);
        process.exitCode = 1;
      }
    });

  addScanOptions(land.command("prune").argument("[trees...]", "worktree paths to prune (default: every stale, landed and empty tree)").description("Archive and release the stale, landed and empty trees (or just the named ones)"))
    .option("--yes", "do it (without it, prune lists what it would remove)")
    .action(async (trees: string[], opts: ScanOpts & { yes?: boolean }) => {
      const named = new Set(trees.map((t) => path.resolve(t)));
      const scan = await scanLocal({ ...opts, only: named.size ? [...named] : undefined, repo: opts.repo ?? (named.size ? [...named].slice(0, 1) : undefined) });
      const targets = pruneTargets(scan);
      const go = named.size ? targets.go.filter((t) => named.has(t.path)) : targets.go;
      const held = named.size ? targets.held.filter((h) => named.has(h.tree.path)) : targets.held;
      const results: PruneResult[] = [];
      if (opts.yes) {
        const rootOf = new Map(scan.repos.flatMap((r) => r.trees.map((t) => [t.path, r.root] as const)));
        for (const t of go) {
          results.push(await pruneTree(t, rootOf.get(t.path)!).catch((err) => ({ path: t.path, archived: null, branchRef: null, error: String(err?.message ?? err).split("\n")[0] })));
        }
      }
      const hosts = opts.hosts ? await onHosts(`prune --all-repos${opts.yes ? " --yes" : ""}`) : undefined;
      if (opts.json) {
        console.log(JSON.stringify({ ...scan, prune: { dryRun: !opts.yes, go: go.map((t) => ({ path: t.path, verdict: t.verdict, reason: t.reason })), held: held.map((h) => ({ path: h.tree.path, reason: h.reason })), results }, hosts }, null, 2));
        return;
      }
      const now = Date.parse(scan.scannedAt);
      console.log(opts.yes ? `Released ${results.filter((r) => !r.error).length} of ${go.length} trees` : `Would release ${go.length} trees (pass --yes)`);
      for (const t of go) {
        const r = results.find((x) => x.path === t.path);
        console.log(r?.error ? `  ${fmt.error("failed".padEnd(10))} ${fmt.path(t.path)} ${r.error}` : treeLine(t, now));
      }
      for (const h of held) console.log(`  ${fmt.warning("kept".padEnd(10))} ${fmt.path(h.tree.path)} ${fmt.muted(h.reason)}`);
      if (opts.yes && results.some((r) => r.archived)) console.log(fmt.muted(`Archived to ${archiveDir()}`));
      for (const h of hosts ?? []) {
        console.log(`\n${fmt.highlight(h.label)} ${h.error ? fmt.error(h.error) : ""}`);
        const p = (h.result as any)?.prune;
        if (p) console.log(`  ${p.dryRun ? "would release" : "released"} ${p.go.length}, kept ${p.held.length}`);
      }
    });
}
