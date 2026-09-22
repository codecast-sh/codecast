// What each team visibility level means, in the words the settings page, the
// per-session share popover and the share-in-full nudge all use. The rules
// (rank, the time split, the transition) live in the convex module so the
// server and the store apply the same ones.
import {
  TEAM_VISIBILITY_RANK,
  currentMembershipVisibility,
  hasPinnedPast,
  type MembershipVisibilityFacts,
  type TeamVisibilityLevel,
} from "@codecast/convex/convex/teamVisibility";

export type { TeamVisibilityLevel, VisibilityChangeMode } from "@codecast/convex/convex/teamVisibility";
export { TEAM_VISIBILITY_RANK, currentMembershipVisibility, hasPinnedPast, nextMembershipVisibility } from "@codecast/convex/convex/teamVisibility";

export type TeamVisibilityOption = {
  value: TeamVisibilityLevel;
  label: string;
  /** What teammates see, as a noun phrase: "titles and short summaries". */
  sees: string;
  /** One sentence for a menu item or a dialog. */
  detail: string;
};

export const TEAM_VISIBILITY_OPTIONS: TeamVisibilityOption[] = [
  {
    value: "hidden",
    label: "Hidden",
    sees: "nothing",
    detail: "Your sessions never appear to this team.",
  },
  {
    value: "activity",
    label: "Activity only",
    sees: "project names and session counts",
    detail: "Teammates see that you are working and where, with no titles or content.",
  },
  {
    value: "summary",
    label: "Summary",
    sees: "titles and short summaries",
    detail: "Teammates see what each session was about, not the conversation itself.",
  },
  {
    value: "full",
    label: "Full",
    sees: "the whole conversation",
    detail: "Teammates can open and read every session you share with this team.",
  },
];

export function teamVisibilityOption(level: string | null | undefined): TeamVisibilityOption {
  return TEAM_VISIBILITY_OPTIONS.find((o) => o.value === level) ?? TEAM_VISIBILITY_OPTIONS[2];
}

/** A team row as getUserTeams returns it, with the two counts sharing needs. */
export type TeamSharingFacts = MembershipVisibilityFacts & {
  _id: string;
  name: string;
  member_count?: number;
  shared_project_count?: number;
};

/** Who else is on the team, in plain words: "just you", "1 teammate", "4 teammates". */
export function describeTeamSharing(team: TeamSharingFacts): string {
  const others = Math.max(0, (team.member_count ?? 1) - 1);
  return others === 0 ? "just you" : others === 1 ? "1 teammate" : `${others} teammates`;
}

/** The team worth nudging about: someone else is on it, a project already
 *  flows to it, and the member shows less than the whole conversation. The
 *  first such team in the member's list, so the nudge names one team and
 *  stays the same between renders. */
export function pickTeamSharingNudge<T extends TeamSharingFacts>(teams: T[] | null | undefined): T | null {
  if (!teams) return null;
  for (const team of teams) {
    if (!team || (team.member_count ?? 0) < 2) continue;
    if ((team.shared_project_count ?? 0) < 1) continue;
    if (TEAM_VISIBILITY_RANK[currentMembershipVisibility(team)] >= TEAM_VISIBILITY_RANK.full) continue;
    return team;
  }
  return null;
}

/** The member's level for one team, or null when they are not on it. */
export function teamVisibilityFor<T extends TeamSharingFacts>(
  teams: T[] | null | undefined,
  teamId: string | null | undefined,
): T | null {
  if (!teams || !teamId) return null;
  return teams.find((t) => t && String(t._id) === String(teamId)) ?? null;
}

function shortDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** One line for a membership whose past is pinned lower than its present:
 *  "Sessions before Sep 22 stay at Summary." Empty when nothing is pinned. */
export function describePinnedPast(m: MembershipVisibilityFacts | null | undefined): string {
  const history = m?.visibility_history;
  if (!history || history.length === 0) return "";
  if (history.length === 1) {
    return `Sessions before ${shortDate(history[0].before)} stay at ${teamVisibilityOption(history[0].visibility).label}.`;
  }
  const parts = history.map((segment, i) => {
    const from = i === 0 ? "" : ` from ${shortDate(history[i - 1].before)}`;
    return `${teamVisibilityOption(segment.visibility).label}${from} until ${shortDate(segment.before)}`;
  });
  return `Older sessions stay lower: ${parts.join(", ")}.`;
}
