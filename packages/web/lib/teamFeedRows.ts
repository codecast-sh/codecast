// The team feed's own rows: what the viewer shares with the team and what they
// keep. The server feed carries only the rows the team can see, so the viewer's
// private sessions come from the inbox cache (store.sessions), which already
// holds team_id and is_private for every session of theirs, and the two sets
// are merged here into one list the feed renders. Pure, so it is testable
// without a store or a DOM.
import type { Conversation } from "../components/ConversationList";
import {
  effectiveMembershipVisibility,
  isVisibilityShareable,
  type MembershipVisibilityFacts,
} from "./teamVisibility";

/** What the team sees of one of the viewer's sessions. `gated` means the
 *  member's own level for the team (Hidden or Activity only) keeps every
 *  session out of the feed, so the per-session choice cannot change it. */
export type TeamShareMode = "private" | "summary" | "full";
export type TeamShareState = { mode: TeamShareMode; gated: boolean };

export function teamShareState(
  conv: { is_private?: boolean; team_visibility?: string | null; started_at?: number | null },
  membership: MembershipVisibilityFacts | null | undefined,
): TeamShareState {
  const level = effectiveMembershipVisibility(membership, conv.started_at);
  const gated = !isVisibilityShareable(level);
  if (gated || conv.is_private !== false) return { mode: "private", gated };
  const own = conv.team_visibility;
  if (own === "summary" || own === "full") return { mode: own, gated: false };
  // No per-session level: the member's level for the team decides, and the
  // gate above already ruled out the two levels below summary.
  return { mode: level === "full" ? "full" : "summary", gated: false };
}

export const TEAM_SHARE_MODE_LABEL: Record<TeamShareMode, string> = {
  private: "Only you",
  summary: "Summary",
  full: "Full",
};

export type OwnSessionRow = {
  _id: string;
  user_id?: string | null;
  team_id?: string | null;
  is_private?: boolean;
  team_visibility?: string | null;
};

export function visibleTeamFeedRows<T extends { user_id?: string | null; acting_user_id?: string | null }>(
  rows: T[],
  memberIds: ReadonlySet<string> | undefined,
  orgEnabled: boolean,
): T[] {
  if (!memberIds) return [];
  return rows.filter((row) =>
    !!row.user_id && memberIds.has(row.user_id) &&
    (!row.acting_user_id || (orgEnabled && memberIds.has(row.acting_user_id))),
  );
}

/** One list for the team feed: the server's rows, with the viewer's own rows
 *  read at the inbox cache's privacy (that cache is live for the viewer's
 *  sessions; the feed cache keeps a row the server stopped serving once it was
 *  hidden), plus the viewer's sessions the server never sends because they are
 *  private, or not yet in the fetched pages. A row present in both sets keeps
 *  the server's richer shape. */
export function mergeOwnSessionsIntoTeamFeed<S extends OwnSessionRow>(opts: {
  feedRows: Conversation[];
  sessions: Record<string, S>;
  teamId: string;
  viewerId: string | null | undefined;
  /** Whether an own session that the feed does not hold belongs in it. */
  keep: (session: S) => boolean;
  toConv: (session: S) => Conversation;
}): Conversation[] {
  const { feedRows, sessions, teamId, viewerId, keep, toConv } = opts;
  const out: Conversation[] = [];
  const inFeed = new Set<string>();
  for (const row of feedRows) {
    inFeed.add(row._id);
    const own = row.is_own ? sessions[row._id] : undefined;
    if (!own || own.is_private === undefined) { out.push(row); continue; }
    const teamVisibility = own.team_visibility === undefined ? row.team_visibility : own.team_visibility;
    if (own.is_private === (row.is_private ?? false) && teamVisibility === row.team_visibility) { out.push(row); continue; }
    out.push({ ...row, is_private: own.is_private, team_visibility: teamVisibility });
  }
  for (const id in sessions) {
    const s = sessions[id];
    if (!s || inFeed.has(s._id)) continue;
    if (String(s.team_id ?? "") !== teamId) continue;
    // A teammate's session injected into the cache (a deep link, a search
    // result) is not the viewer's to list here.
    if (s.user_id && viewerId && String(s.user_id) !== String(viewerId)) continue;
    if (!keep(s)) continue;
    out.push(toConv(s));
  }
  return out;
}
