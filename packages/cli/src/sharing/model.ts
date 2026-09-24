// `cast sharing`: what a person (or an agent working for them) needs in order
// to decide what syncs to codecast and what each team sees, folded into one
// row per folder. No network: the command module fetches, this decides.
//
// Two separate settings govern a folder, and the rows keep them apart:
//   - SYNC is whether its sessions upload at all (users.sync_mode and
//     sync_projects; the daemon reads them on its heartbeat).
//   - SHARING is who can open what uploaded: a folder rule sends it to a team
//     (from a start date, or all of it), a lock keeps it from every team, and
//     no rule leaves it private to the owner.

import * as path from "node:path";
import { startOfDay, type PathShareSummary } from "@codecast/shared/team";
import { matchDirectoryMapping } from "@codecast/shared/team/directoryRules";
import { isProjectAllowedToSync } from "../syncScope.js";
import type { Config } from "../config/types.js";

export type SyncSettings = { sync_mode: "all" | "selected"; sync_projects: string[] };

export type TeamRow = {
  _id: string;
  name: string;
  role?: string;
  visibility?: string;
  visibility_history?: { before: number; visibility: string }[] | null;
  member_count?: number;
  shared_project_count?: number;
};

/** users.getRecentProjectsWithGitInfo: a folder with synced sessions. */
export type ServerFolder = {
  path: string;
  repository?: string;
  session_count: number;
  first_active?: number;
  last_active: number;
};

/** users.getDirectoryTeamMappings: one folder rule. */
export type FolderRule = {
  path_prefix: string;
  team_id: string | null;
  team_name: string | null;
  private?: boolean;
  share_since?: number | null;
  repository?: string;
};

/** fs/localSessions: what this machine holds per folder. */
export type LocalFolderFacts = {
  path: string;
  repository?: string;
  sessions: number;
  first: number;
  last: number;
  exists: boolean;
};

export type Overview = { settings: SyncSettings; teams: TeamRow[]; folders: ServerFolder[]; rules: FolderRule[] };

export type Sharing =
  | { kind: "team"; teamId: string; teamName: string; since: number | null; rulePath: string; inherited: boolean }
  | { kind: "lock"; rulePath: string; inherited: boolean }
  | { kind: "private" };

export type FolderRow = {
  path: string;
  repository?: string;
  /** Sessions on this machine's disk; null when this machine has none there. */
  onMachine: number | null;
  /** Sessions on codecast. */
  synced: number;
  /** The synced count hit the server's scan cap: read it as "N+". */
  truncated: boolean;
  first: number | null;
  last: number | null;
  /** Still a folder on this machine; null when this machine never saw it. */
  exists: boolean | null;
  syncing: boolean;
  sharing: Sharing;
};

/** Whether a folder's sessions upload: the daemon's own scope rule, read
 *  against the server's settings. */
export function isSyncing(settings: SyncSettings, folder: string): boolean {
  return isProjectAllowedToSync(folder, settings as Config);
}

/** The rule a folder is under, the way the server resolves it. */
export function sharingOf(rules: FolderRule[], folder: string, repository: string | undefined): Sharing {
  const rule = matchDirectoryMapping(rules, folder, repository);
  if (!rule) return { kind: "private" };
  const inherited = rule.path_prefix !== folder;
  if (rule.private) return { kind: "lock", rulePath: rule.path_prefix, inherited };
  if (!rule.team_id) return { kind: "private" };
  return {
    kind: "team",
    teamId: rule.team_id,
    teamName: rule.team_name ?? "a team",
    since: rule.share_since ?? null,
    rulePath: rule.path_prefix,
    inherited,
  };
}

/** Every folder the person could decide about: the ones with synced
 *  sessions, the ones on this machine, the ones a rule or the chosen list
 *  names. Newest activity first. */
export function buildFolderRows(
  overview: Overview,
  local: LocalFolderFacts[] | null,
  exact: Record<string, PathShareSummary> = {},
): FolderRow[] {
  const server = new Map(overview.folders.map((f) => [f.path, f]));
  const onDisk = new Map((local ?? []).map((f) => [f.path, f]));
  const paths = new Set<string>([
    ...server.keys(),
    ...onDisk.keys(),
    ...overview.rules.map((r) => r.path_prefix),
    ...(overview.settings.sync_mode === "selected" ? overview.settings.sync_projects : []),
  ]);
  const rows: FolderRow[] = [];
  for (const folder of paths) {
    const s = server.get(folder);
    const l = onDisk.get(folder);
    const e = exact[folder];
    const repository = s?.repository ?? l?.repository ?? overview.rules.find((r) => r.path_prefix === folder)?.repository;
    const span = (a: number | null | undefined, b: number | null | undefined) => (a != null && Number.isFinite(a) ? a : null) ?? (b != null && Number.isFinite(b) ? b : null);
    rows.push({
      path: folder,
      ...(repository ? { repository } : {}),
      onMachine: l ? l.sessions : null,
      synced: e ? e.count : s?.session_count ?? 0,
      truncated: e?.truncated ?? false,
      first: span(e?.first_started_at, s?.first_active ?? s?.last_active) ?? l?.first ?? null,
      last: span(e?.last_started_at, s?.last_active) ?? l?.last ?? null,
      exists: l ? l.exists : null,
      syncing: isSyncing(overview.settings, folder),
      sharing: sharingOf(overview.rules, folder, repository),
    });
  }
  return rows.sort((a, b) => (b.last ?? 0) - (a.last ?? 0));
}

export type SyncChange = { all: true } | { sync: string[] } | { unsync: string[] };

export type SyncPlan = {
  /** The write, or null when the settings already say so. */
  next: Partial<SyncSettings> | null;
  /** Folders a change leaves syncing anyway: a chosen parent folder covers them. */
  stillCovered: { folder: string; by: string }[];
  /** The change turned "sync everything" into a chosen list, so a folder
   *  first used later will not sync until it is added. */
  leftSyncAll: boolean;
};

/**
 * The sync settings a change leads to, the way the settings page writes them.
 * Stopping one folder while everything syncs switches to a chosen list of
 * every folder known now except that one, since the chosen list has no
 * exclusions.
 */
export function planSyncChange(settings: SyncSettings, change: SyncChange, known: string[]): SyncPlan {
  const none: SyncPlan = { next: null, stillCovered: [], leftSyncAll: false };
  if ("all" in change) return settings.sync_mode === "all" ? none : { ...none, next: { sync_mode: "all" } };
  if ("sync" in change) {
    const missing = change.sync.filter((f) => !isSyncing(settings, f));
    if (missing.length === 0) return none;
    return { ...none, next: { sync_mode: "selected", sync_projects: [...settings.sync_projects, ...missing] } };
  }
  const drop = new Set(change.unsync);
  const base = settings.sync_mode === "all" ? [...new Set(known)] : settings.sync_projects;
  const kept = base.filter((f) => !drop.has(f));
  const after: SyncSettings = { sync_mode: "selected", sync_projects: kept };
  const stillCovered = change.unsync
    .filter((f) => isSyncing(after, f))
    .map((f) => ({ folder: f, by: kept.find((k) => f.startsWith(k.replace(/\/+$/, "") + "/")) ?? f }));
  const changed = settings.sync_mode === "all" || kept.length !== settings.sync_projects.length;
  return { next: changed ? after : null, stillCovered, leftSyncAll: settings.sync_mode === "all" };
}

/** "~/src/app" for a folder under the home directory. */
export function prettyPath(folder: string, home: string): string {
  const h = home.replace(/\/+$/, "");
  return folder === h ? "~" : folder.startsWith(h + "/") ? "~" + folder.slice(h.length) : folder;
}

export type Resolved<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * A folder the way a person names it: a path (absolute, ~ or relative), a
 * repository ("owner/name"), or a folder name ("codecast"). A path is taken
 * as given, since a rule can be written before a folder has sessions; a name
 * must match exactly one known folder.
 */
export function resolveFolder(ref: string, rows: FolderRow[], home: string, cwd: string): Resolved<string> {
  const raw = ref.trim().replace(/\/+$/, "") || ref.trim();
  if (!raw) return { ok: false, error: "empty folder" };
  const looksLikePath = raw.startsWith("/") || raw.startsWith("~") || raw.startsWith(".") || (raw.includes("/") && !rows.some((r) => r.repository === raw));
  if (looksLikePath) {
    const expanded = raw === "~" ? home : raw.startsWith("~/") ? path.join(home, raw.slice(2)) : path.resolve(cwd, raw);
    return { ok: true, value: expanded.replace(/\/+$/, "") || "/" };
  }
  const lower = raw.toLowerCase();
  const byRepo = rows.filter((r) => r.repository?.toLowerCase() === lower);
  const byName = byRepo.length > 0 ? byRepo : rows.filter((r) => path.basename(r.path).toLowerCase() === lower);
  if (byName.length === 1) return { ok: true, value: byName[0].path };
  if (byName.length === 0) return { ok: false, error: `no folder named "${ref}". Run \`cast sharing\` to list them, or pass the full path.` };
  const choices = byName.slice(0, 6).map((r) => `  ${prettyPath(r.path, home)}`).join("\n");
  return { ok: false, error: `"${ref}" names ${byName.length} folders. Pass one path:\n${choices}` };
}

/** A team by id, name or unique name prefix, case aside. */
export function resolveTeam(ref: string, teams: TeamRow[]): Resolved<TeamRow> {
  const lower = ref.trim().toLowerCase();
  const exact = teams.filter((t) => t._id === ref || t.name.toLowerCase() === lower);
  const matches = exact.length > 0 ? exact : teams.filter((t) => t.name.toLowerCase().startsWith(lower));
  if (matches.length === 1) return { ok: true, value: matches[0] };
  const names = teams.map((t) => t.name).join(", ") || "none";
  if (matches.length === 0) return { ok: false, error: `no team "${ref}". Your teams: ${names}.` };
  return { ok: false, error: `"${ref}" matches ${matches.map((t) => t.name).join(", ")}. Pass the full name.` };
}

/** A share start: "today", "yesterday", "7d" (days back) or a date. Local midnight. */
export function parseSince(value: string, now: number = Date.now()): number | null {
  const v = value.trim().toLowerCase();
  if (v === "today" || v === "now") return startOfDay(now);
  if (v === "yesterday") return startOfDay(now - 86_400_000);
  const days = v.match(/^(\d+)d$/);
  if (days) return startOfDay(now - Number(days[1]) * 86_400_000);
  const date = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (date) {
    const d = new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }
  return null;
}
