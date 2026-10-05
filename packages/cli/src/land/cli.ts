/**
 * `cast land`: find the work every worktree and cloud host holds that main
 * does not, and release the finished trees that hold nothing worth landing.
 *
 * `scan` reads; `prune` archives and removes (scan.ts has the verdicts,
 * prune.ts the archive). The /deploy command reads `scan --json`, lands the
 * `ready` trees' files topic by topic, then runs `prune --yes`.
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

interface ScanOpts { repo?: string[]; allRepos?: boolean; hosts?: boolean; json?: boolean; verbose?: boolean; fetch?: boolean }

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
async function readRoster(): Promise<{ rows: RosterRow[] | null; status: string }> {
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
    const { stdout } = await execFileAsync("cast", ["sessions", "--json", "-n", "1000"], { encoding: "utf-8", timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
    const json = JSON.parse(String(stdout).slice(String(stdout).indexOf("{")));
    const rows = Object.values(json).filter(Array.isArray).flat()
      .filter((r: any) => r && typeof r === "object" && "work_state" in r)
      .map((r: any): RosterRow => ({ short_id: r.id, title: r.title ?? null, work_state: r.work_state, project_path: r.project_path ?? null, updated_at: r.updated_at ?? null }));
    return { rows, status: `ok (inbox listing; hostSessions failed: ${first})` };
  } catch (err) {
    return { rows: null, status: `hostSessions failed (${first}); inbox listing failed (${String((err as Error)?.message ?? err).split("\n")[0]})` };
  }
}

async function scanLocal(opts: ScanOpts): Promise<LandScan> {
  const roots = opts.repo?.length
    ? await Promise.all(opts.repo.map(repoRootOf))
    : opts.allRepos ? allRepoRoots() : [await repoRootOf(process.cwd())];
  const [roster, cwds] = await Promise.all([readRoster(), processCwds()]);
  const repos: RepoScan[] = [];
  for (const root of [...new Set(roots)]) {
    repos.push(await scanRepo(root, { roster: roster.rows, processCwds: cwds, fetch: opts.fetch }));
  }
  return { scannedAt: new Date().toISOString(), machine: os.hostname(), roster: roster.status, repos };
}

/** Run a `cast land` subcommand on every registered cloud host and parse its JSON. */
async function onHosts(args: string): Promise<HostScan[]> {
  const { readHosts, toRemoteHost } = await import("../browser/cloudHost.js");
  const { ssh } = await import("../remote/session-move.js");
  return Promise.all(readHosts().map(async (h) => {
    const label = `${h.user}@${h.address ?? "?"}`;
    try {
      const out = ssh(toRemoteHost(h), `bash -lc 'cast land ${args} --json'`, 15 * 60_000);
      return { id: h.id, label, result: JSON.parse(out.slice(out.indexOf("{"))) as LandScan };
    } catch (err: any) {
      const text = String(err?.stderr || err?.message || err);
      const reason = /unknown command|no command group named "land"/.test(text) ? "the host's cast has no `land` yet (update its CLI)" : text.split("\n").filter(Boolean).pop() ?? "ssh failed";
      return { id: h.id, label, error: reason.slice(0, 200) };
    }
  }));
}

const ORDER: TreeVerdict[] = ["ready", "review", "stale", "landed", "empty", "live", "primary"];
const TONE: Record<TreeVerdict, (s: string) => string> = {
  ready: fmt.success, review: fmt.warning, stale: fmt.muted, landed: fmt.muted, empty: fmt.muted, live: fmt.accent, primary: fmt.label,
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
      const show = verbose || v === "ready" || v === "review" || v === "primary" ? trees : [];
      for (const t of show) console.log(treeLine(t, now));
      if (trees.length > show.length) console.log(`  ${TONE[v](v.padEnd(10))} ${fmt.muted(`${trees.length} trees (--verbose lists them)`)}`);
    }
    for (const e of r.errors) console.log(`  ${fmt.error("error".padEnd(10))} ${fmt.path(e.path)} ${fmt.muted(e.error)}`);
  }
}

/**
 * The trees prune may remove: prunable verdicts only, never with an unread
 * roster, and never one that holds a worktree that is itself staying.
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
    go.push(t);
  }
  // Inner trees first, so an outer tree's move never carries one still to be archived.
  go.sort((a, b) => b.path.length - a.path.length);
  return { go, held };
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
  cast land diff <tree> --only       the files only that tree changed, as a patch
  cast land prune --yes              archive and release stale, landed and empty trees

Pruned work stays recoverable: ${archiveDir()}/<date>-<repo>-<tree>.patch, and the
branch as refs/codecast/land-archive/<branch>.`);

  addScanOptions(land.command("scan").description("Classify every worktree's own work against main"))
    .option("-v, --verbose", "list every tree, not just ready and review")
    .action(async (opts: ScanOpts) => {
      const scan = await scanLocal(opts);
      if (opts.hosts) scan.hosts = await onHosts(`scan --all-repos${opts.fetch === false ? " --no-fetch" : ""}`);
      if (opts.json) { console.log(JSON.stringify(scan, null, 2)); return; }
      printScan(scan, !!opts.verbose);
      for (const h of scan.hosts ?? []) {
        console.log(`\n${fmt.highlight(h.label)} ${fmt.muted(h.id)}`);
        if (h.error) console.log(`  ${fmt.error(h.error)}`);
        else if (h.result) printScan(h.result, !!opts.verbose, "  ");
      }
    });

  land
    .command("diff <tree>")
    .description("Print a tree's own change as a patch against its base")
    .option("--only", "just the files only this tree changed (they apply cleanly to main)")
    .option("--both", "just the files main also changed")
    .action(async (tree: string, opts: { only?: boolean; both?: boolean }) => {
      const dir = path.resolve(tree);
      const scan = await scanRepo(await repoRootOf(dir), { roster: null, processCwds: [], fetch: false });
      const report = scan.trees.find((t) => t.path === dir);
      if (!report) { console.error(`no worktree at ${dir}`); process.exit(1); }
      const only: FileVerdict[] | undefined = opts.only || opts.both ? [...(opts.only ? ["only" as const] : []), ...(opts.both ? ["both" as const] : [])] : undefined;
      process.stdout.write(await treePatch(report, only));
    });

  addScanOptions(land.command("prune").description("Archive and release the stale, landed and empty trees"))
    .option("--yes", "do it (without it, prune lists what it would remove)")
    .action(async (opts: ScanOpts & { yes?: boolean }) => {
      const scan = await scanLocal(opts);
      const { go, held } = pruneTargets(scan);
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
