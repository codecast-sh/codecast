// `cast sharing`: read and change what syncs to codecast and what each team
// sees, without a prompt, so an agent can walk a person through it. Every
// write goes through the function the Sync & Privacy settings page calls
// (http.ts /cli/sharing/*), so the checks, the backfills and the words match.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Command } from "commander";
import {
  describeShareSpan,
  formatDateRange,
  formatSessionCount,
  startOfDay,
  summarizeShareImpact,
  describeTeammates,
  type PathShareSummary,
} from "@codecast/shared/team";
import { TEAM_VISIBILITY_OPTIONS, teamVisibilityOption } from "@codecast/shared/team/visibility";
import { apiPost, type PublishDeps } from "../castApi.js";
import { commandGroup } from "../commandGroups.js";
import { fmt, c } from "../colors.js";
import { codecastPath, homeDir } from "../codecastDir.js";
import { atomicWriteFile } from "../atomicWrite.js";
import { readLocalConfig } from "../config/readLocalConfig.js";
import { summarizeLocalSessions } from "../fs/localSessions.js";
import {
  buildFolderRows,
  isLive,
  isSyncing,
  parseSince,
  planSyncChange,
  prettyPath,
  resolveFolder,
  resolveTeam,
  type FolderRow,
  type LocalFolderFacts,
  type Overview,
  type Sharing,
  type TeamRow,
} from "./model.js";

type Deps = PublishDeps;

const LOCAL_CACHE_TTL_MS = 10 * 60_000;
/** shareImpactForPaths answers at most this many folders per call. */
const IMPACT_BATCH = 12;

function fail(message: string): never {
  console.error(`${fmt.error("Error:")} ${message}`);
  process.exit(1);
}

function quoteArg(value: string): string {
  return /^[\w@%+=:,./~-]+$/.test(value) ? value : `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** What this machine holds per folder. The walk reads every transcript's
 *  first line, so it is cached for a few minutes between calls. */
async function localFolders(rescan: boolean): Promise<LocalFolderFacts[] | null> {
  const cacheFile = codecastPath("cache", "sharing-local-folders.json");
  if (!rescan) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      if (Date.now() - cached.scanned_at < LOCAL_CACHE_TTL_MS) return cached.folders;
    } catch {}
  }
  try {
    const summary = await summarizeLocalSessions(readLocalConfig(), homeDir());
    const folders: LocalFolderFacts[] = summary.folders.map((f) => ({
      path: f.path,
      ...(f.repository ? { repository: f.repository } : {}),
      sessions: f.sessions,
      first: f.first,
      last: f.last,
      exists: f.exists,
    }));
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      atomicWriteFile(cacheFile, JSON.stringify({ scanned_at: summary.scanned_at, folders }));
    } catch {}
    return folders;
  } catch {
    return null;
  }
}

async function exactCounts(deps: Deps, folders: string[], extra: Record<string, unknown> = {}): Promise<Record<string, PathShareSummary>> {
  const batches: string[][] = [];
  for (let i = 0; i < folders.length; i += IMPACT_BATCH) batches.push(folders.slice(i, i + IMPACT_BATCH));
  const parts = await Promise.all(
    batches.map((batch) => apiPost(deps, "/cli/sharing/impact", { path_prefixes: batch, day_start: startOfDay(), ...extra }, { read: true }).catch(() => ({}))),
  );
  return Object.assign({}, ...parts);
}

type State = { overview: Overview; rows: FolderRow[]; home: string };

async function loadState(deps: Deps, opts: { rescan?: boolean; exact?: boolean } = {}): Promise<State> {
  const [overview, local] = await Promise.all([
    apiPost(deps, "/cli/sharing/overview", {}, { read: true }) as Promise<Overview>,
    localFolders(!!opts.rescan),
  ]);
  let rows = buildFolderRows(overview, local);
  if (opts.exact) {
    const wanted = rows.filter(isLive).map((r) => r.path);
    // Counts are kept per folder on the server and built on request. Read
    // what is there; build only the ones that have never been counted (a
    // rebuild of a large folder is a real scan), then read those once more.
    const exact = await exactCounts(deps, wanted);
    const missing = wanted.filter((p) => !exact[p]);
    if (missing.length > 0) {
      await apiPost(deps, "/cli/sharing/stats", { paths: missing.slice(0, 120) }, { exitOnError: false }).catch(() => {});
      await new Promise((r) => setTimeout(r, 2500));
      Object.assign(exact, await exactCounts(deps, missing));
    }
    rows = buildFolderRows(overview, local, exact);
    // Refresh what was read for the next call, as the settings page does on
    // open; the server skips any counted in the last minute.
    const read = wanted.filter((p) => exact[p]).slice(0, 120);
    if (read.length > 0) await apiPost(deps, "/cli/sharing/stats", { paths: read }, { exitOnError: false }).catch(() => {});
  }
  return { overview, rows, home: homeDir() };
}

function folderArgs(state: State, refs: string[]): string[] {
  const out: string[] = [];
  for (const ref of refs) {
    const r = resolveFolder(ref, state.rows, state.home, process.cwd());
    if (!r.ok) fail(r.error);
    // Sessions record the real path (/private/tmp, not /tmp), and a rule
    // matches by path, so follow links for a folder that exists.
    let folder = r.value;
    try { folder = fs.realpathSync(folder); } catch {}
    if (!out.includes(folder)) out.push(folder);
  }
  if (out.length === 0) fail("name at least one folder");
  return out;
}

function teamArg(state: State, ref: string | undefined): TeamRow {
  if (!ref) fail("pass --team <name>");
  const r = resolveTeam(ref, state.overview.teams);
  if (!r.ok) fail(r.error);
  return r.value;
}

function rowFor(state: State, folder: string): FolderRow | undefined {
  return state.rows.find((r) => r.path === folder);
}

function shortDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function describeSharing(s: Sharing, home: string): string {
  const via = (rulePath: string, inherited: boolean) => (inherited ? ` (rule on ${prettyPath(rulePath, home)})` : "");
  if (s.kind === "team") return `${s.teamName}, ${s.since == null ? "all sessions" : `sessions from ${shortDate(s.since)}`}${via(s.rulePath, s.inherited)}`;
  if (s.kind === "lock") return `never shared${via(s.rulePath, s.inherited)}`;
  return "private";
}

/** The command that puts a folder back under the rule it had. */
function undoCommand(folder: string, prev: Sharing, home: string): string {
  const f = quoteArg(prettyPath(folder, home));
  if (prev.kind === "team") return `cast sharing share ${f} --team ${quoteArg(prev.teamName)}${prev.since == null ? "" : ` --from ${shortDate(prev.since)}`}`;
  if (prev.kind === "lock") return `cast sharing lock ${f}`;
  return `cast sharing private ${f}`;
}

function teamLevel(team: TeamRow) {
  return teamVisibilityOption(team.visibility ?? "summary");
}

function teamJson(team: TeamRow) {
  const level = teamLevel(team);
  return {
    id: team._id,
    name: team.name,
    role: team.role,
    teammates: Math.max(0, (team.member_count ?? 1) - 1),
    level: level.value,
    sees: level.sees,
    older_sessions_pinned: (team.visibility_history?.length ?? 0) > 0,
  };
}

const DEFAULT_ROWS = 40;

/** The rows the overview lists: every one with --all, else the live ones
 *  (synced, or still on this machine), newest first, up to a page. */
function listedRows(rows: FolderRow[], all?: boolean): { shown: FolderRow[]; hiddenDeleted: number; more: number } {
  if (all) return { shown: rows, hiddenDeleted: 0, more: 0 };
  const live = rows.filter(isLive);
  return { shown: live.slice(0, DEFAULT_ROWS), hiddenDeleted: rows.length - live.length, more: Math.max(0, live.length - DEFAULT_ROWS) };
}

function num(n: number): string {
  return n.toLocaleString("en-US");
}

function printOverview(state: State, opts: { all?: boolean }): void {
  const { overview, rows, home } = state;
  const { settings, teams } = overview;
  console.log(`${c.bold}Sync${c.reset}`);
  if (settings.sync_mode === "all") {
    console.log(`  Every folder on this machine uploads, new ones included.`);
  } else {
    const off = rows.filter((r) => !r.syncing && isLive(r)).length;
    console.log(`  Only chosen folders upload (${settings.sync_projects.length} chosen${off ? `, ${off} listed below are not syncing` : ""}). A folder used for the first time does not sync until it is added.`);
  }

  console.log(`\n${c.bold}Teams${c.reset} ${fmt.muted("what each team sees of the sessions you share with it")}`);
  if (teams.length === 0) console.log(`  None. Everything that syncs is private to you.`);
  const teamWidth = Math.max(0, ...teams.map((t) => t.name.length));
  for (const team of teams) {
    const level = teamLevel(team);
    const pinned = (team.visibility_history?.length ?? 0) > 0 ? fmt.muted(", older sessions at a lower level") : "";
    console.log(`  ${fmt.accent(team.name.padEnd(teamWidth))}  ${level.label.padEnd(13)} ${fmt.muted(`${level.sees}; ${describeTeammates(team.member_count)}`)}${pinned}`);
  }

  const { shown, hiddenDeleted, more } = listedRows(rows, opts.all);
  const notes = [
    `${rows.length} known`,
    more > 0 ? `showing the newest ${shown.length}` : null,
    hiddenDeleted > 0 ? `${hiddenDeleted} deleted folders that never synced hidden` : null,
  ].filter(Boolean).join(", ");
  console.log(`\n${c.bold}Folders${c.reset} ${fmt.muted(`${notes}${more > 0 || hiddenDeleted > 0 ? " (--all lists every one)" : ""}`)}`);
  const pathWidth = Math.min(40, Math.max(8, ...shown.map((r) => prettyPath(r.path, home).length)));
  const shareWidth = Math.min(36, Math.max(7, ...shown.map((r) => describeSharing(r.sharing, home).length)));
  for (const r of shown) {
    const name = prettyPath(r.path, home);
    const cell = name.length > pathWidth ? "…" + name.slice(-(pathWidth - 1)) : name.padEnd(pathWidth);
    const share = describeSharing(r.sharing, home);
    const shareCell = r.sharing.kind === "team" ? fmt.accent(share.padEnd(shareWidth)) : r.sharing.kind === "lock" ? fmt.warning(share.padEnd(shareWidth)) : share.padEnd(shareWidth);
    const facts = [
      r.synced > 0 ? `${num(r.synced)}${r.truncated ? "+" : ""} synced${r.nested > 0 ? ` (with ${r.nested} folder${r.nested === 1 ? "" : "s"} inside)` : ""}` : r.counted || !r.syncing ? "none synced" : "synced count pending",
      r.sharedByHand > 0 ? `${num(r.sharedByHand)} shared one by one` : null,
      r.keptPrivate > 0 ? `${num(r.keptPrivate)} kept private` : null,
      r.onMachine != null ? `${num(r.onMachine)} on this machine` : null,
      formatDateRange(r.first, r.last) || null,
      r.repository ?? null,
      r.exists === false ? "folder deleted" : null,
    ].filter(Boolean).join(", ");
    const sync = r.syncing ? "" : `${fmt.warning("not syncing")}  `;
    console.log(`  ${fmt.path(cell)}  ${shareCell}  ${sync}${fmt.muted(facts)}`);
  }
  console.log(`\n${fmt.muted("Change with cast sharing sync, unsync, share, private, lock, team or session. cast sharing --help explains each.")}`);
}

async function writeSync(deps: Deps, state: State, change: Parameters<typeof planSyncChange>[1]): Promise<ReturnType<typeof planSyncChange>> {
  const plan = planSyncChange(state.overview.settings, change, state.rows.map((r) => r.path));
  if (plan.next) await apiPost(deps, "/cli/sharing/sync", plan.next);
  return plan;
}

export function registerSharingCommand(program: Command, deps: Deps): void {
  const sharing = program
    .command("sharing")
    .description(commandGroup("sharing").description)
    .option("--json", "Machine-readable output")
    .option("--all", "List every folder, not the newest 40")
    .option("--rescan", "Scan this machine's sessions again instead of using the last scan (kept 10 minutes)")
    .addHelpText("after", `
Two settings decide what happens to a folder's sessions:
  sync     whether they upload to codecast at all. Everything uploads by default;
           after an unsync, only chosen folders do, and a new folder needs a sync.
  sharing  who can open what uploaded. A folder is private (only you), shared
           with a team (all sessions, or from a start date), or locked (never
           shared: no rule can share it, other checkouts of the repository
           included). One rule covers every checkout and worktree of a repository.
Each team also has a level for you: what teammates see of anything shared.
  ${TEAM_VISIBILITY_OPTIONS.map((o) => `${o.value.padEnd(9)}${o.detail}`).join("\n  ")}

A folder is a path (~/src/app), a repository (owner/app) or a folder name (app).

  cast sharing                                 the whole picture: teams, folders, rules
  cast sharing sessions ~/src/app [--shared]   what is in a folder, and who can open each session
  cast sharing share app --team Acme --dry-run what a share would expose, before doing it
  cast sharing share app --team Acme --from today   share new sessions only
  cast sharing share app --team Acme --keep-private <id>,<id>   share, but not those sessions
  cast sharing private app                     stop sharing, or lift a lock; only you can open it
  cast sharing lock ~/src/client-work          never share it with anyone
  cast sharing unsync ~/src/scratch --dry-run  stop uploading it (synced sessions stay but lose its own share rule; --delete removes them)
  cast sharing sync ~/src/new-app | --all      upload a folder, or everything again
  cast sharing team Acme --level full          what Acme sees of new sessions you share (--include-past for the rest)
  cast sharing session <id> --private          one session, whatever its folder's rule says

Every change prints the command that reverts it. Changes show on the Sync & Privacy
settings page at once, and the daemon applies sync changes within a minute.`)
    .action(async (opts: { json?: boolean; all?: boolean; rescan?: boolean }) => {
      const state = await loadState(deps, { rescan: opts.rescan, exact: true });
      if (opts.json) {
        console.log(JSON.stringify({
          sync: state.overview.settings,
          teams: state.overview.teams.map(teamJson),
          folders: listedRows(state.rows, opts.all).shown,
          folder_count: state.rows.length,
          ...(opts.all ? {} : { note: "Deleted folders that never synced, and folders past the newest 40, are left out. --all lists every one." }),
        }, null, 2));
        return;
      }
      printOverview(state, opts);
    });

  // `--json` and `--all` after a subcommand are read by the group first (it
  // declares both), so each subcommand takes them from either place.
  const asJson = (o: { json?: boolean }) => !!(o.json || sharing.opts().json);
  const asAll = (o: { all?: boolean }) => !!(o.all || sharing.opts().all);

  sharing
    .command("sessions")
    .description("List a folder's synced sessions with who can open each")
    .argument("<folder>", "Path, repository or folder name")
    .option("-n, --limit <n>", "How many, newest first", "25")
    .option("--shared", "Only sessions a team can open (looks through the newest 1,000)")
    .option("--json", "Machine-readable output")
    .action(async (ref: string, opts: { limit: string; shared?: boolean; json?: boolean }) => {
      const state = await loadState(deps);
      const [folder] = folderArgs(state, [ref]);
      const limit = Math.max(1, Number(opts.limit) || 25);
      const [result, counts] = await Promise.all([
        apiPost(deps, "/cli/sharing/sessions", { path_prefixes: [folder], limit: opts.shared ? 1000 : limit }, { read: true }),
        exactCounts(deps, [folder]),
      ]);
      // The list stops at the limit; the folder's own count is the total.
      const total: number = counts[folder]?.count ?? result.total ?? 0;
      const totalTruncated = counts[folder] ? counts[folder].truncated : !!result.truncated;
      type SessionRow = { _id: string; title?: string; started_at?: number; message_count?: number; is_private?: boolean; team_visibility?: string | null; auto_shared?: boolean; path?: string | null };
      const all: SessionRow[] = result.rows ?? [];
      const rows = opts.shared ? all.filter((r) => !r.is_private).slice(0, limit) : all;
      const visibility = (r: (typeof rows)[number]) =>
        r.is_private ? (r.team_visibility === "private" ? "kept private" : "private") : r.team_visibility === "summary" ? "shared, summary only" : "shared";
      if (asJson(opts)) {
        console.log(JSON.stringify({ folder, total, truncated: totalTruncated, ...(opts.shared ? { shared_only: true, looked_through: all.length } : {}), sessions: rows.map((r) => ({ ...r, visibility: visibility(r) })) }, null, 2));
        return;
      }
      const row = rowFor(state, folder);
      console.log(`${fmt.path(prettyPath(folder, state.home))}  ${formatSessionCount(Math.max(total, rows.length), totalTruncated)} on codecast${row ? `, ${describeSharing(row.sharing, state.home)}` : ""}`);
      for (const r of rows) {
        const date = r.started_at ? shortDate(r.started_at) : "          ";
        const below = r.path && r.path !== folder ? fmt.muted(`  in ${prettyPath(r.path, state.home)}`) : "";
        console.log(`  ${fmt.muted(date)}  ${visibility(r).padEnd(20)}  ${(r.title || "Untitled").slice(0, 60).padEnd(60)}  ${fmt.id(r._id)}${below}`);
      }
      if (opts.shared) {
        if (rows.length === 0) console.log(fmt.muted("  None shared."));
        console.log(fmt.muted(`  Looked through the newest ${num(all.length)}${all.length < total ? ` of ${num(total)}` : ""}.`));
      } else if (rows.length < total) console.log(fmt.muted(`  … ${num(total - rows.length)} older. -n for more, --shared for only the shared ones.`));
    });

  sharing
    .command("share")
    .description("Share folders with a team")
    .argument("<folders...>", "Paths, repositories or folder names")
    .option("--team <team>", "Team name or id")
    .option("--from <when>", "Share only sessions from this day on: today, yesterday, 7d, or YYYY-MM-DD (default: all sessions)")
    .option("--keep-private <ids>", "Comma separated session ids to keep private (from cast sharing sessions)")
    .option("--dry-run", "Say what the share would expose, change nothing")
    .option("--json", "Machine-readable output")
    .action(async (refs: string[], opts: { team?: string; from?: string; keepPrivate?: string; dryRun?: boolean; json?: boolean }) => {
      const state = await loadState(deps);
      const folders = folderArgs(state, refs);
      const team = teamArg(state, opts.team);
      const since = opts.from == null ? null : parseSince(opts.from);
      if (opts.from != null && since == null) fail(`--from takes today, yesterday, 7d or YYYY-MM-DD, not "${opts.from}"`);
      const keepPrivate = (opts.keepPrivate ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const exact = await exactCounts(deps, folders, since == null ? {} : { since });
      const level = teamLevel(team);
      const results = [];
      for (const folder of folders) {
        const prev = rowFor(state, folder)?.sharing ?? { kind: "private" as const };
        const impact = summarizeShareImpact([folder], exact, undefined);
        const span = describeShareSpan(impact, since);
        const syncing = isSyncing(state.overview.settings, folder);
        if (!opts.dryRun) {
          // A team sees only what uploads: sharing a folder that does not
          // sync turns its sync on, as the settings page does.
          if (!syncing) {
            const plan = await writeSync(deps, state, { sync: [folder] });
            if (plan.next) state.overview.settings = { ...state.overview.settings, ...plan.next };
          }
          await apiPost(deps, "/cli/sharing/rule", {
            path_prefix: folder,
            team_id: team._id,
            auto_share: true,
            include_past: since == null,
            ...(since != null ? { share_since: since } : {}),
            ...(keepPrivate.length > 0 ? { lock_private: keepPrivate } : {}),
          });
        }
        results.push({ folder, team: team.name, since, span, started_syncing: !syncing && !opts.dryRun, previous: describeSharing(prev, state.home), undo: undoCommand(folder, prev, state.home) });
      }
      if (asJson(opts)) {
        console.log(JSON.stringify({ dry_run: !!opts.dryRun, team: teamJson(team), results }, null, 2));
        return;
      }
      for (const r of results) {
        const name = prettyPath(r.folder, state.home);
        const verb = opts.dryRun ? "would see" : "now sees";
        console.log(`${opts.dryRun ? fmt.muted("dry run") : fmt.success("shared")}  ${fmt.accent(team.name)} ${verb} ${fmt.path(name)}: ${r.span}`);
        if (r.started_syncing) console.log(`  ${name} was not syncing; it syncs now so the team can see it.`);
        if (!opts.dryRun) console.log(fmt.muted(`  Was: ${r.previous}. Undo: ${r.undo}`));
      }
      if (keepPrivate.length > 0 && !opts.dryRun) console.log(`  ${keepPrivate.length} session${keepPrivate.length === 1 ? "" : "s"} kept private.`);
      console.log(fmt.muted(`${team.name}: ${describeTeammates(team.member_count)}, level ${level.label}, so they see ${level.sees} of what you share.`));
      if (level.value === "hidden") console.log(fmt.warning(`Your level in ${team.name} is Hidden, so they see nothing yet. Raise it with: cast sharing team ${quoteArg(team.name)} --level summary`));
    });

  const ruleCommand = (verb: "private" | "lock") =>
    sharing
      .command(verb)
      .description(verb === "private" ? "Stop sharing folders, or lift a lock: only you can open their sessions" : "Never share folders with any team, whatever other rules say (cast sharing private lifts it)")
      .argument("<folders...>", "Paths, repositories or folder names")
      .option("--json", "Machine-readable output")
      .action(async (refs: string[], opts: { json?: boolean }) => {
        const state = await loadState(deps);
        const folders = folderArgs(state, refs);
        const results = [];
        for (const folder of folders) {
          const prev = rowFor(state, folder)?.sharing ?? { kind: "private" as const };
          // A rule on a parent folder still covers this one after its own
          // rule goes: only a lock stops it.
          if (verb === "private" && prev.kind === "team" && prev.inherited && folder.startsWith(prev.rulePath + "/")) {
            fail(`${prettyPath(folder, state.home)} is shared through the rule on ${prettyPath(prev.rulePath, state.home)}. Make that folder private, or lock this one: cast sharing lock ${quoteArg(prettyPath(folder, state.home))}`);
          }
          await apiPost(deps, "/cli/sharing/rule", verb === "lock" ? { path_prefix: folder, private: true } : { path_prefix: folder });
          results.push({ folder, previous: describeSharing(prev, state.home), undo: undoCommand(folder, prev, state.home) });
        }
        if (asJson(opts)) {
          console.log(JSON.stringify({ results }, null, 2));
          return;
        }
        for (const r of results) {
          const name = prettyPath(r.folder, state.home);
          console.log(verb === "lock"
            ? `${fmt.success("locked")}  ${fmt.path(name)} is never shared. No rule can share it, other checkouts of its repository included.`
            : `${fmt.success("private")}  ${fmt.path(name)}: only you can open its sessions. They stay synced.`);
          console.log(fmt.muted(`  Was: ${r.previous}. Undo: ${r.undo}`));
        }
      });
  ruleCommand("private");
  ruleCommand("lock");

  sharing
    .command("sync")
    .description("Upload folders' sessions to codecast, or every folder with --all")
    .argument("[folders...]", "Paths, repositories or folder names")
    .option("--all", "Sync every folder, new ones included")
    .option("--json", "Machine-readable output")
    .action(async (refs: string[], opts: { all?: boolean; json?: boolean }) => {
      if (!asAll(opts) && refs.length === 0) fail("name folders to sync, or pass --all");
      const state = await loadState(deps);
      const folders = asAll(opts) ? [] : folderArgs(state, refs);
      const plan = await writeSync(deps, state, asAll(opts) ? { all: true } : { sync: folders });
      if (asJson(opts)) {
        console.log(JSON.stringify({ changed: !!plan.next, settings: plan.next ?? state.overview.settings }, null, 2));
        return;
      }
      if (!plan.next) console.log(`Already syncing ${asAll(opts) ? "every folder" : folders.map((f) => prettyPath(f, state.home)).join(", ")}.`);
      else if (asAll(opts)) console.log(`${fmt.success("syncing")}  every folder on this machine, new ones included. Undo: cast sharing unsync <folder> for any you want kept off.`);
      else console.log(`${fmt.success("syncing")}  ${folders.map((f) => prettyPath(f, state.home)).join(", ")}. Past sessions upload within a minute or two. Undo: cast sharing unsync ${folders.map((f) => quoteArg(prettyPath(f, state.home))).join(" ")}`);
    });

  sharing
    .command("unsync")
    .description("Stop uploading folders' sessions; --delete also removes what already synced")
    .argument("<folders...>", "Paths, repositories or folder names")
    .option("--delete", "Also delete the folders' sessions from codecast (cannot be undone)")
    .option("--dry-run", "Say what would change, change nothing")
    .option("--json", "Machine-readable output")
    .action(async (refs: string[], opts: { delete?: boolean; dryRun?: boolean; json?: boolean }) => {
      const state = await loadState(deps, { exact: !!opts.dryRun });
      const folders = folderArgs(state, refs);
      if (opts.dryRun) {
        const plan = planSyncChange(state.overview.settings, { unsync: folders }, state.rows.map((r) => r.path));
        const lines = folders.map((folder) => {
          const row = rowFor(state, folder);
          const covered = plan.stillCovered.find((c) => c.folder === folder);
          const ownRule = row && row.sharing.kind !== "private" && !row.sharing.inherited;
          const synced = row ? formatSessionCount(row.synced, row.truncated) : "no sessions";
          return {
            folder,
            still_syncing_because: covered?.by ?? null,
            synced: row?.synced ?? 0,
            rule_removed: ownRule ? describeSharing(row!.sharing, state.home) : null,
            text: covered
              ? `${prettyPath(folder, state.home)} would keep syncing: the chosen folder ${prettyPath(covered.by, state.home)} includes it.`
              : `${prettyPath(folder, state.home)} would stop uploading. ${opts.delete ? `Its ${synced} would be deleted from codecast.` : `Its ${synced} already synced would stay${ownRule ? `, private again (its rule "${describeSharing(row!.sharing, state.home)}" goes)` : ""}.`}`,
          };
        });
        if (asJson(opts)) {
          console.log(JSON.stringify({ dry_run: true, next_settings: plan.next, switches_to_chosen_folders: plan.leftSyncAll, also_stopped: plan.alsoStopped, folders: lines.map(({ text, ...rest }) => rest) }, null, 2));
          return;
        }
        for (const l of lines) console.log(`${fmt.muted("dry run")}  ${l.text}`);
        if (plan.alsoStopped.length > 0) console.log(fmt.warning(`Sessions started directly in ${plan.alsoStopped.map((f) => prettyPath(f, state.home)).join(", ")} would stop syncing too: choosing ${plan.alsoStopped.length === 1 ? "that folder" : "those folders"} would include what you are stopping. Their subfolders keep syncing.`));
        if (plan.leftSyncAll) console.log(fmt.warning(`Sync would switch from every folder to ${plan.next?.sync_projects?.length ?? 0} chosen folders: a folder used for the first time would not sync until added.`));
        return;
      }
      const plan = await writeSync(deps, state, { unsync: folders });
      // As on the settings page, a folder that stops syncing loses its own
      // rule too, so what already synced goes back to private (or, with
      // --delete, is removed in batches).
      const deleted: Record<string, number> = {};
      const unruled: string[] = [];
      for (const folder of folders) {
        if (plan.stillCovered.some((s) => s.folder === folder)) continue;
        const sharing = rowFor(state, folder)?.sharing;
        let total = 0;
        let hasMore = !!opts.delete;
        if (sharing && sharing.kind !== "private" && !sharing.inherited) {
          const res = await apiPost(deps, "/cli/sharing/rule/remove", { path_prefix: folder, delete_conversations: !!opts.delete });
          unruled.push(folder);
          total += res?.conversationsDeleted ?? 0;
          hasMore = !!opts.delete && !!res?.hasMore;
        }
        for (let guard = 0; hasMore && guard < 500; guard++) {
          const res = await apiPost(deps, "/cli/sharing/delete", { path_prefix: folder });
          total += res?.conversationsDeleted ?? 0;
          hasMore = !!res?.hasMore;
        }
        if (opts.delete) deleted[folder] = total;
      }
      if (asJson(opts)) {
        console.log(JSON.stringify({ changed: !!plan.next, settings: plan.next ?? state.overview.settings, still_syncing: plan.stillCovered, also_stopped: plan.alsoStopped, rules_removed: unruled, deleted }, null, 2));
        return;
      }
      for (const folder of folders) {
        const name = prettyPath(folder, state.home);
        const covered = plan.stillCovered.find((s) => s.folder === folder);
        if (covered) {
          console.log(`${fmt.warning("still syncing")}  ${fmt.path(name)}: the chosen folder ${prettyPath(covered.by, state.home)} includes it. Unsync that folder and sync its other folders one by one.`);
          continue;
        }
        const row = rowFor(state, folder);
        const kept = opts.delete
          ? `${formatSessionCount(deleted[folder] ?? 0)} deleted from codecast.`
          : row && row.synced > 0
            ? `The ${formatSessionCount(row.synced, row.truncated)} already synced stay${unruled.includes(folder) ? " and are private again (its sharing rule is removed)" : ""}; --delete removes them.`
            : "";
        console.log(`${fmt.success("not syncing")}  ${fmt.path(name)}. ${kept}`);
        if (unruled.includes(folder) && row) console.log(fmt.muted(`  Its rule was: ${describeSharing(row.sharing, state.home)}. Undo: ${undoCommand(folder, row.sharing, state.home)}`));
      }
      if (plan.alsoStopped.length > 0) console.log(fmt.warning(`Sessions started directly in ${plan.alsoStopped.map((f) => prettyPath(f, state.home)).join(", ")} stop syncing too, since choosing ${plan.alsoStopped.length === 1 ? "it" : "them"} would include what you stopped. Their subfolders keep syncing.`));
      if (plan.leftSyncAll) console.log(fmt.warning(`Sync switched from every folder to chosen folders (${plan.next?.sync_projects?.length ?? 0}). A folder you use for the first time will not sync until you run cast sharing sync on it.`));
      console.log(fmt.muted(`Undo: cast sharing sync ${folders.map((f) => quoteArg(prettyPath(f, state.home))).join(" ")}${plan.leftSyncAll ? " (or cast sharing sync --all)" : ""}`));
    });

  sharing
    .command("team")
    .description("Set what a team sees of the sessions you share with it")
    .argument("<team>", "Team name or id")
    .requiredOption("--level <level>", TEAM_VISIBILITY_OPTIONS.map((o) => o.value).join(" | "))
    .option("--include-past", "When raising, raise sessions already shared too (default: new sessions only)")
    .option("--json", "Machine-readable output")
    .action(async (ref: string, opts: { level: string; includePast?: boolean; json?: boolean }) => {
      const state = await loadState(deps);
      const team = teamArg(state, ref);
      const option = TEAM_VISIBILITY_OPTIONS.find((o) => o.value === opts.level.toLowerCase() || o.label.toLowerCase() === opts.level.toLowerCase());
      if (!option) fail(`--level takes ${TEAM_VISIBILITY_OPTIONS.map((o) => o.value).join(", ")}`);
      const prev = teamLevel(team);
      const pinned = (team.visibility_history?.length ?? 0) > 0;
      const unchanged = option.value === prev.value && !(opts.includePast && pinned);
      // Lowering always reaches every session (the server caps the past too);
      // raising reaches the past only when asked.
      const raising = TEAM_VISIBILITY_OPTIONS.indexOf(option) > TEAM_VISIBILITY_OPTIONS.indexOf(prev);
      if (!unchanged) await apiPost(deps, "/cli/sharing/team", { team_id: team._id, visibility: option.value, mode: opts.includePast ? "everything" : "going_forward" });
      if (asJson(opts)) {
        console.log(JSON.stringify({ team: team.name, level: option.value, previous: prev.value, changed: !unchanged, past_included: !!opts.includePast || !raising }, null, 2));
        return;
      }
      if (unchanged) {
        console.log(`${team.name} is already at ${option.label}: they see ${option.sees}.${pinned ? " Some older sessions stay at a lower level; --include-past raises them too." : ""}`);
        return;
      }
      const scope = raising && !opts.includePast ? " of new sessions; sessions shared before now keep the old level" : "";
      console.log(`${fmt.success("set")}  ${fmt.accent(team.name)} sees ${option.sees}${scope}. ${option.detail}`);
      console.log(fmt.muted(`  Was: ${prev.label}. Undo: cast sharing team ${quoteArg(team.name)} --level ${prev.value}`));
    });

  sharing
    .command("session")
    .description("Make single sessions private or shared, whatever their folder's rule says")
    .argument("<ids...>", "Session ids from cast sharing sessions")
    .option("--private", "Only you can open them")
    .option("--share", "Share them with the team their folder goes to")
    .option("--json", "Machine-readable output")
    .action(async (ids: string[], opts: { private?: boolean; share?: boolean; json?: boolean }) => {
      if (!!opts.private === !!opts.share) fail("pass exactly one of --private or --share");
      for (const id of ids) await apiPost(deps, "/cli/sharing/session", { conversation_id: id, is_private: !!opts.private });
      if (asJson(opts)) {
        console.log(JSON.stringify({ ids, private: !!opts.private }, null, 2));
        return;
      }
      const plural = ids.length === 1 ? "" : "s";
      console.log(opts.private
        ? `${fmt.success("kept private")}  ${ids.length} session${plural}: no folder rule can share ${ids.length === 1 ? "it" : "them"} now. To share again: cast sharing session ${ids.join(" ")} --share`
        : `${fmt.success("shared")}  ${ids.length} session${plural} with the team ${ids.length === 1 ? "its" : "their"} folder goes to. To keep private: cast sharing session ${ids.join(" ")} --private`);
    });
}
