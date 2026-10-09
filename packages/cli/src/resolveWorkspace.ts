// The ONE place the CLI decides which workspace a command operates in.
//
// Before this, every subcommand guessed: pass `--team` through if given,
// otherwise send nothing and let the server resolve `users.active_team_id`.
// That is two sources of truth for one question, and they disagree. It was
// reproduced live — `cast chat new` with no `--team` created a channel in team
// Union while the shell context said codecast, because the server read a
// pointer the user had last moved in the web app.
//
// The rule (matching web and mobile):
//   • The CANONICAL pointer is `users.active_team_id`. Unset means the PERSONAL
//     workspace — a real answer, not a missing one.
//   • An explicit `--team` always wins; `--team personal` names the personal
//     workspace while the pointer is a team.
//   • READS may resolve and default. WRITES must send an explicit workspace,
//     so the server never has to guess where a created row belongs.
//
// The pointer is fetched once per process (short TTL, so a long-lived daemon
// notices a team switch) and shared by every subcommand.

import { workspaceFeatureEnabled, type TeamFeatureKey, type TeamFeatures } from "@codecast/shared/contracts";
import { shq } from "./remote/session-move.js";

export type Workspace =
  | { kind: "team"; teamId: string; name?: string }
  | { kind: "personal" };

export type WorkspaceRoster = {
  teams: Array<{ _id: string; name: string; role?: string; features?: TeamFeatures }>;
  activeTeamId: string | null;
  userId?: string;
};

/** How long a fetched pointer stays fresh. Short: a `cast ws`-style long-lived
 *  process must see a team switch made in the web app within a few seconds. */
export const WORKSPACE_TTL_MS = 15_000;

type Cache = { at: number; roster: WorkspaceRoster };
let cache: Cache | null = null;

/** Test seam and switch-away reset. */
export function clearWorkspaceCache(): void {
  cache = null;
}

/**
 * The caller's teams plus the canonical active pointer, cached for TTL.
 * `fetchRoster` is injected so this file stays free of transport concerns
 * (the CLI passes its authenticated cliPost).
 */
export async function loadWorkspaceRoster(
  fetchRoster: () => Promise<{ teams?: any[]; active_team_id?: string | null; user_id?: string }>,
  now: number = Date.now(),
): Promise<WorkspaceRoster> {
  if (cache && now - cache.at < WORKSPACE_TTL_MS) return cache.roster;
  const raw = await fetchRoster();
  const roster: WorkspaceRoster = {
    teams: (raw?.teams ?? []).filter(Boolean).map((t: any) => ({
      _id: String(t._id), name: String(t.name ?? ""), role: t.role, features: t.features,
    })),
    activeTeamId: raw?.active_team_id ? String(raw.active_team_id) : null,
    userId: raw?.user_id ? String(raw.user_id) : undefined,
  };
  cache = { at: now, roster };
  return roster;
}

/** The words `--team` accepts for the personal workspace, so a command can
 *  name it while the active pointer is a team. A real team of the same name
 *  still wins: the roster is matched first. */
export const PERSONAL_WORKSPACE_WORDS = ["personal", "me"] as const;

export function namesPersonalWorkspace(wanted: string): boolean {
  return (PERSONAL_WORKSPACE_WORDS as readonly string[]).includes(wanted.trim().toLowerCase());
}

/** Match a `--team` value against the roster by id, exact name, or slug-ish
 *  name — a person types the name they see, not the id. */
export function matchTeam(
  roster: WorkspaceRoster,
  wanted: string,
): { _id: string; name: string } | null {
  const w = wanted.trim().toLowerCase();
  if (!w) return null;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return (
    roster.teams.find((t) => t._id.toLowerCase() === w) ??
    roster.teams.find((t) => t.name.toLowerCase() === w) ??
    roster.teams.find((t) => norm(t.name) === norm(w)) ??
    null
  );
}

/**
 * Resolve the workspace for a READ. An explicit team wins; otherwise the
 * canonical pointer; otherwise personal. Never throws — a read that lands in
 * the wrong place costs a re-run.
 */
export function resolveWorkspaceForRead(
  roster: WorkspaceRoster,
  explicitTeam?: string,
): Workspace {
  if (explicitTeam) {
    const hit = matchTeam(roster, explicitTeam);
    if (hit) return { kind: "team", teamId: hit._id, name: hit.name };
    if (namesPersonalWorkspace(explicitTeam)) return { kind: "personal" };
    return { kind: "team", teamId: explicitTeam };
  }
  if (roster.activeTeamId) {
    const hit = roster.teams.find((t) => t._id === roster.activeTeamId);
    return { kind: "team", teamId: roster.activeTeamId, name: hit?.name };
  }
  return { kind: "personal" };
}

export class WorkspaceUnresolved extends Error {}

/**
 * Resolve the workspace for a WRITE. Same inputs, but the answer must be
 * something the caller can be told: an unknown `--team`, or no team at all
 * when the command needs one, raises with the list of real choices rather
 * than letting the server pick.
 */
export function resolveWorkspaceForWrite(
  roster: WorkspaceRoster,
  explicitTeam: string | undefined,
  opts: { teamRequired?: boolean } = {},
): Workspace {
  if (explicitTeam) {
    const hit = matchTeam(roster, explicitTeam);
    if (hit) return { kind: "team", teamId: hit._id, name: hit.name };
    if (namesPersonalWorkspace(explicitTeam)) {
      if (opts.teamRequired) throw new WorkspaceUnresolved(noTeamMessage(roster));
      return { kind: "personal" };
    }
    throw new WorkspaceUnresolved(unknownTeamMessage(roster, explicitTeam));
  }
  if (roster.activeTeamId) {
    const hit = roster.teams.find((t) => t._id === roster.activeTeamId);
    // Membership can lapse while the pointer still names the team.
    if (!hit) throw new WorkspaceUnresolved(stalePointerMessage(roster));
    return { kind: "team", teamId: hit._id, name: hit.name };
  }
  if (opts.teamRequired) throw new WorkspaceUnresolved(noTeamMessage(roster));
  return { kind: "personal" };
}

function teamList(roster: WorkspaceRoster): string {
  if (roster.teams.length === 0) return "  (you are not a member of any team)";
  return roster.teams.map((t) => `  ${t.name}  ${t._id}`).join("\n");
}

export function unknownTeamMessage(roster: WorkspaceRoster, wanted: string): string {
  return `No team matching "${wanted}". Your teams:\n${teamList(roster)}\n  personal  your own workspace`;
}

export function noTeamMessage(roster: WorkspaceRoster): string {
  return `This command writes to a team, and no team is active. Pass --team <name|id>:\n${teamList(roster)}`;
}

export function stalePointerMessage(roster: WorkspaceRoster): string {
  return `Your active team is no longer one you belong to. Pass --team <name|id>:\n${teamList(roster)}`;
}

/** The wire argument for a resolved workspace: a team id, or nothing for the
 *  personal workspace (which every chat endpoint treats as "no team"). */
export function workspaceArgs(ws: Workspace): { team_id?: string } {
  return ws.kind === "team" ? { team_id: ws.teamId } : {};
}

/** The workspace as a positive value for the work routes (tasks, plans,
 *  projects): a named team, or the personal workspace said outright, so a
 *  shell whose active team is a team can still list and file personal work.
 *  Nothing is sent when the person named no workspace: the route's own
 *  default (the directory rule, the session's team) stays in force. */
export function workspaceScope(ws: Workspace): { workspace: "team"; team_id: string } | { workspace: "personal" } {
  return ws.kind === "team" ? { workspace: "team", team_id: ws.teamId } : { workspace: "personal" };
}

/** How to name the resolved workspace in output. */
export function workspaceLabel(ws: Workspace): string {
  return ws.kind === "team" ? (ws.name || ws.teamId) : "personal";
}

/** A row's stored access key (`team:<id>`, `user:<id>`) as a workspace — the
 *  ONE place the CLI reads one, so a new key variant is understood everywhere
 *  or nowhere. `null` for a key it cannot read (a row from an older server, a
 *  future `restricted:`): an unknown key names nothing, the way it grants
 *  nothing. */
export function parseWorkspaceKey(key: string | null | undefined): Workspace | null {
  if (key?.startsWith("team:")) return { kind: "team", teamId: key.slice(5) };
  if (key?.startsWith("user:")) return { kind: "personal" };
  return null;
}

/** The same key with the team's name from the roster, for output that says
 *  where a row lives. */
export function workspaceFromKey(roster: WorkspaceRoster, key: string | null | undefined): Workspace | null {
  const ws = parseWorkspaceKey(key);
  if (ws?.kind !== "team") return ws;
  const hit = roster.teams.find((t) => t._id === ws.teamId);
  return hit ? { ...ws, name: hit.name } : ws;
}

/** A `--team` value as one shell word: a bare word stands as it is, anything
 *  else is quoted the one way the CLI quotes a shell argument (`shq`). */
function teamArg(value: string): string {
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : shq(value);
}

/** The ` --team …` that names one workspace, however a command prints it: the
 *  team's name when the roster holds it, else its id, and the positive word for
 *  personal. Empty for a workspace this CLI cannot name, where no flag beats a
 *  wrong one. Every printed `--team` is worded here. A printed WRITE takes this
 *  one and keeps it (a write names its workspace); a printed READ takes
 *  `scopeFlagFor`, which drops it where it would say nothing. */
export function teamFlagFor(ws: Workspace | null): string {
  if (!ws) return "";
  return ws.kind === "personal" ? " --team personal" : ` --team ${teamArg(ws.name || ws.teamId)}`;
}

/**
 * The ` --team …` a printed next step needs so its READ lands where the work
 * was WRITTEN. A write takes an explicit workspace or the session's team; a
 * read defaults to the directory's mapping, and on a checkout mapped
 * elsewhere the two differ — the read then answers nothing, which an agent
 * reads as "no work" rather than "not here". Empty when they already agree.
 * A null `here` is a read whose workspace is not known yet: the flag stays,
 * since naming the workspace outright reads right from anywhere.
 */
export function scopeFlagFor(filed: Workspace | null, here: Workspace | null): string {
  if (!filed) return "";
  if (here?.kind === "personal" && filed.kind === "personal") return "";
  if (here?.kind === "team" && filed.kind === "team" && here.teamId === filed.teamId) return "";
  return teamFlagFor(filed);
}

/**
 * Why a read answered nothing about `ref`: it is filed in another workspace.
 * An empty list names no scope, so "no ready tasks" and "no tasks found" read
 * as "there is no work" when the truth is "not in the workspace this
 * directory reads". Null when the two agree, which is when the empty answer
 * is the honest one.
 */
export function filedElsewhereLine(ref: string, filed: Workspace | null, here: Workspace): string | null {
  const flag = scopeFlagFor(filed, here);
  if (!flag || !filed) return null;
  return `${ref} is in the ${workspaceLabel(filed)} workspace, and this directory reads ${workspaceLabel(here)}: add${flag} to read it.`;
}

/** The inverse of `workspaceScope`: what a route's workspace argument (or a
 *  create's `base`) names, as a workspace. Null when it names neither, which
 *  leaves the route's own default in force. */
export function workspaceOfScope(scope: { workspace?: string; team_id?: string } | null | undefined): Workspace | null {
  if (scope?.workspace === "team" && scope.team_id) return { kind: "team", teamId: String(scope.team_id) };
  return scope?.workspace === "personal" ? { kind: "personal" } : null;
}

/**
 * Is `key` on for the workspace? A team reads its own flag; the personal
 * workspace is off unless the catalog marks the feature `personal`, in which
 * case any of the person's teams having it on counts (shared rule:
 * workspaceFeatureEnabled). Unknown team in the roster = off, never everything.
 */
export function workspaceHasFeature(roster: WorkspaceRoster, ws: Workspace, key: TeamFeatureKey): boolean {
  return workspaceFeatureEnabled(roster.teams, ws.kind === "team" ? ws.teamId : null, key);
}
