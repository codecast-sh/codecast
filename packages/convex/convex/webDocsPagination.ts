// Pure decision logic for the docs.webListPaginated query, extracted so the two
// load-bearing performance invariants can be regression-tested without a live
// Convex backend. Both invariants exist because this subscription is hit by every
// web/mobile client and was, at one point, a backend-saturation hotspot.

// Hard cap on items per page. Convex materializes full documents (multi-MB
// content/entries) before our strip step, so a large page can blow the 64MB
// per-query memory cap (TooMuchMemoryCarryOver, observed 2026-05-13).
export const WEB_DOCS_MAX_PAGE = 12;

export type WebDocsResolveArgs = {
  workspace?: "personal" | "team";
  team_id?: string;
};

// Whether the handler must read the hot, heartbeat-churned user doc to resolve
// active_team_id. Reading it unconditionally made this subscription invalidate on
// EVERY daemon heartbeat, starving the backend. The user doc is needed ONLY when
// the caller did not pin a workspace — every real web/mobile caller pins one.
export function webDocsNeedsUserDoc(args: WebDocsResolveArgs): boolean {
  if (args.workspace === "team" && args.team_id) return false;
  if (args.workspace) return false;
  return true;
}

// Resolve the effective team id from the pinned args plus (only if needed) the
// user doc's active_team_id. Callers must pass userActiveTeamId iff
// webDocsNeedsUserDoc(args) is true.
export function resolveWebDocsTeamId(
  args: WebDocsResolveArgs,
  userActiveTeamId: string | undefined
): string | undefined {
  if (args.workspace === "team" && args.team_id) return args.team_id;
  if (!args.workspace) return userActiveTeamId;
  return undefined;
}

// Defensive clamp applied to every page request, regardless of caller.
export function clampWebDocsPageSize(numItems: number): number {
  return Math.min(numItems, WEB_DOCS_MAX_PAGE);
}
