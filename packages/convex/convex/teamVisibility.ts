// A member's team visibility: how much of their sessions the rest of a team
// sees. One level per membership, applied live to every session the member
// shares with that team. A conversation's own `team_visibility` overrides it
// for that one session (privacy.ts resolveVisibilityMode).
//
// "Share in full going forward" splits that one level by time. The membership
// keeps a short history: sessions STARTED before a segment's boundary are read
// at that segment's level, and everything after the last boundary at the
// current level. The split is one patch on the membership row, so the switch is
// atomic and past sessions are never rewritten.
//
// Invariant: the current level is the highest of all segments. Lowering applies
// to everything (each segment drops to at most the new level), raising can be
// for everything (history cleared) or going forward (a segment pins the past).
// Member-level gates that read only the current level ("is this member hidden")
// therefore stay correct: a hidden member has no segment that shows more.
//
// Pure, no convex imports: the web store applies the same transition
// optimistically and the server applies it for real.

export type TeamVisibilityLevel = "hidden" | "activity" | "summary" | "full";

export type VisibilitySegment = { before: number; visibility: TeamVisibilityLevel };

export type MembershipVisibilityFacts = {
  visibility?: string | null;
  visibility_history?: VisibilitySegment[] | null;
};

export type VisibilityChangeMode = "everything" | "going_forward";

export const DEFAULT_TEAM_VISIBILITY: TeamVisibilityLevel = "summary";

export const TEAM_VISIBILITY_RANK: Record<TeamVisibilityLevel, number> = {
  hidden: 0,
  activity: 1,
  summary: 2,
  full: 3,
};

export const TEAM_VISIBILITY_LEVELS: TeamVisibilityLevel[] = ["hidden", "activity", "summary", "full"];

export function isTeamVisibilityLevel(value: unknown): value is TeamVisibilityLevel {
  return typeof value === "string" && value in TEAM_VISIBILITY_RANK;
}

function levelOf(value: string | null | undefined): TeamVisibilityLevel {
  return isTeamVisibilityLevel(value) ? value : DEFAULT_TEAM_VISIBILITY;
}

function lower(a: TeamVisibilityLevel, b: TeamVisibilityLevel): TeamVisibilityLevel {
  return TEAM_VISIBILITY_RANK[a] <= TEAM_VISIBILITY_RANK[b] ? a : b;
}

/** The member's current level: what sessions started from now on are read at. */
/** Whether a member at this level lets any session through to the team feed.
 *  Hidden and activity-only members show nothing session by session, whatever
 *  the session's own sharing says. */
export function isVisibilityShareable(visibility: string): boolean {
  return visibility !== "hidden" && visibility !== "activity";
}

export function currentMembershipVisibility(m: MembershipVisibilityFacts | null | undefined): TeamVisibilityLevel {
  return levelOf(m?.visibility);
}

/** The level a teammate reads one session at, given when that session started.
 *  A session with no start time (a legacy row, a stub) reads at the current level. */
export function effectiveMembershipVisibility(
  m: MembershipVisibilityFacts | null | undefined,
  startedAt: number | null | undefined,
): TeamVisibilityLevel {
  const current = currentMembershipVisibility(m);
  const history = m?.visibility_history;
  if (!history || history.length === 0 || startedAt == null) return current;
  for (const segment of history) {
    if (startedAt < segment.before) return segment.visibility;
  }
  return current;
}

/** Drop segments that say nothing: a segment equal to the one after it, and a
 *  trailing segment equal to the current level. Returns undefined for an empty
 *  history so the stored field disappears rather than lingering as []. */
function normalizeHistory(
  history: VisibilitySegment[],
  current: TeamVisibilityLevel,
): VisibilitySegment[] | undefined {
  const sorted = [...history].sort((a, b) => a.before - b.before);
  const out: VisibilitySegment[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const next = sorted[i + 1];
    const nextLevel = next ? next.visibility : current;
    if (sorted[i].visibility === nextLevel) continue;
    out.push(sorted[i]);
  }
  return out.length > 0 ? out : undefined;
}

/** The membership fields after the member picks `target`.
 *
 *  Lowering applies to everything: every segment drops to at most the new
 *  level, so nothing older shows more than the member now allows. Raising for
 *  everything forgets the history, and so does picking the current level for
 *  everything ("include past sessions"). Raising going forward pins the
 *  sessions started before `now` at the level they had, then moves on. */
export function nextMembershipVisibility(
  m: MembershipVisibilityFacts | null | undefined,
  target: TeamVisibilityLevel,
  mode: VisibilityChangeMode,
  now: number,
): { visibility: TeamVisibilityLevel; visibility_history: VisibilitySegment[] | undefined } {
  const current = currentMembershipVisibility(m);
  const history = m?.visibility_history ?? [];
  if (target === current) {
    return { visibility: target, visibility_history: mode === "everything" ? undefined : normalizeHistory(history, target) };
  }
  if (TEAM_VISIBILITY_RANK[target] < TEAM_VISIBILITY_RANK[current]) {
    const capped = history.map((segment) => ({ ...segment, visibility: lower(segment.visibility, target) }));
    return { visibility: target, visibility_history: normalizeHistory(capped, target) };
  }
  if (mode === "everything") {
    return { visibility: target, visibility_history: undefined };
  }
  return {
    visibility: target,
    visibility_history: normalizeHistory([...history, { before: now, visibility: current }], target),
  };
}

/** True when some past sessions are read at a lower level than the current one. */
export function hasPinnedPast(m: MembershipVisibilityFacts | null | undefined): boolean {
  return (m?.visibility_history?.length ?? 0) > 0;
}
