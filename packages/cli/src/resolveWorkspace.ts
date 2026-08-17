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
//   • An explicit `--team` always wins.
//   • READS may resolve and default. WRITES must send an explicit workspace,
//     so the server never has to guess where a created row belongs.
//
// The pointer is fetched once per process (short TTL, so a long-lived daemon
// notices a team switch) and shared by every subcommand.

import { teamFeatureEnabled, type TeamFeatureKey, type TeamFeatures } from "@codecast/shared/contracts";

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
    if (!hit) throw new WorkspaceUnresolved(unknownTeamMessage(roster, explicitTeam));
    return { kind: "team", teamId: hit._id, name: hit.name };
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
  return `No team matching "${wanted}". Your teams:\n${teamList(roster)}`;
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

/** How to name the resolved workspace in output. */
export function workspaceLabel(ws: Workspace): string {
  return ws.kind === "team" ? (ws.name || ws.teamId) : "personal";
}

/**
 * Is `key` on for the workspace's team? Personal = off (team features have
 * no meaning there). Unknown team in the roster = off, never everything.
 */
export function workspaceHasFeature(roster: WorkspaceRoster, ws: Workspace, key: TeamFeatureKey): boolean {
  if (ws.kind !== "team") return false;
  const team = roster.teams.find((t) => t._id === ws.teamId);
  return teamFeatureEnabled(team, key);
}
