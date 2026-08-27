// Pure projections the people window's roster needs, kept React-free so they
// are unit-testable under bun (same split as memberPresence.ts / PresenceBadge).
//
// The panel is ALWAYS mounted in its own window, so nothing here may subscribe
// to a churny collection: rosterSig is what the list wakes on, and the two maps
// are built once per list render from data the store already holds.
import { type ChatChannelView } from "../chat/chatTypes";
import { memberPresenceState } from "../presence/memberPresence";

/** One teammate's DM, as the roster row needs it. */
export interface DmBadge {
  channelId: string;
  unread: number;
  mentions: number;
  muted: boolean;
}

/**
 * The fields a roster row DRAWS, and nothing else.
 *
 * `s.teamMembers` re-pushes every few seconds on teammates' heartbeat counters.
 * A window that shows the roster forever would re-render on every one of them,
 * so it subscribes to this string instead and reads the array itself out of
 * getState(). Modelled on TeamAvatarBar's barSig — the same fields, plus the
 * timezone the row can print.
 *
 * Deliberately absent: presence_input_at and daemon_last_seen. They feed the
 * "idle 12m" / "last seen 3h ago" durations, and they move constantly. Their
 * TEXT still ticks, because the list holds a coarse clock; what must not tick
 * is the identity of the roster array.
 */
export function rosterSig(members: any[] | null | undefined): string {
  let sig = "";
  for (const m of members ?? []) {
    if (!m?._id) continue;
    sig += `${m._id}|${memberPresenceState(m)}|${m.status ?? ""}|${m.image ?? ""}|${m.github_avatar_url ?? ""}|${m.name ?? ""}|${m.email ?? ""}|${m.in_room_key ?? ""}|${m.in_huddle ? 1 : 0}|${m.timezone ?? ""}\n`;
  }
  return sig;
}

/**
 * Each teammate's one-to-one DM, keyed by their user id.
 *
 * Only rooms with exactly one other person: a group DM has no single owner, and
 * hanging its unread count on three separate rows would triple-count it. Muted
 * rooms keep their number — the row dims it rather than dropping it, because
 * muting a room is not the same as having read it.
 */
export function dmBadgesByMember(rail: ChatChannelView[]): Map<string, DmBadge> {
  const out = new Map<string, DmBadge>();
  for (const ch of rail) {
    if (ch?.kind !== "dm") continue;
    const others = ch.dmMemberIds ?? [];
    if (others.length !== 1) continue;
    out.set(String(others[0]), {
      channelId: String(ch.id),
      unread: ch.unreadCount ?? 0,
      mentions: ch.mentionCount ?? 0,
      muted: !!ch.muted,
    });
  }
  return out;
}

/**
 * The huddle each person is sitting in, keyed by user id — the list's one pass
 * over the live rooms, so twenty rows share it instead of each calling
 * useLiveRoomOfMember and scanning the same array again.
 */
export function roomsByMember<T extends { members: { user_id: string }[] }>(
  rooms: T[],
): Map<string, T> {
  const out = new Map<string, T>();
  for (const room of rooms) {
    for (const m of room.members ?? []) {
      const id = String(m?.user_id ?? "");
      // First room wins: a person is in one huddle, and the rooms list is
      // already ordered, so a stale duplicate must not displace the live one.
      if (id && !out.has(id)) out.set(id, room);
    }
  }
  return out;
}

/** The unread number a badge prints. Past 99 the exact count stops meaning
 *  anything and only costs width, which a 320px window does not have. */
export function unreadBadgeText(unread: number): string {
  return unread > 99 ? "99+" : String(unread);
}

/**
 * The active workspace pointer names a team the viewer is not in.
 *
 * `teams.getTeamMembers` answers a non-member with an empty list rather than an
 * error, so a stale `active_team_id` — a pointer at a workspace they have left,
 * which outlives the leaving in a browser origin's cache — produces exactly the
 * silence of a team of one. These are worth telling apart, because only one of
 * them is the viewer's to fix.
 *
 * False until the real team list has arrived. An empty `teams` means "I have
 * not been told yet", never "you belong to none", and reporting a stray pointer
 * on the strength of not knowing would fire on every cold boot.
 */
export function isStrayWorkspace(
  teams: Array<{ _id?: unknown }> | null | undefined,
  activeTeamId: unknown,
): boolean {
  const rows = teams ?? [];
  if (!activeTeamId || rows.length === 0) return false;
  return !rows.some((t) => t?._id != null && String(t._id) === String(activeTeamId));
}

/**
 * What to TELL them, said once so two surfaces cannot phrase it two ways.
 *
 * Only the fix differs, because it genuinely does: the people window cannot
 * switch a workspace (it writes no shared tab state), so it points at the
 * window that can. It reads as the plain fact rather than as the mechanism —
 * "pointed at a workspace" is a pointer's word, and nobody thinks of their own
 * window as pointing anywhere.
 */
export const STRAY_WORKSPACE = "You are not in this workspace.";

/** The empty roster, said once for every shape of the window. `short` drops
 *  the fix-it sentence for a surface (the strip) with one line to spend. */
export function emptyRosterText(stray: boolean, short = false): string {
  if (!stray) return "No teammates yet.";
  return short ? STRAY_WORKSPACE : `${STRAY_WORKSPACE} Switch workspace in the main window.`;
}
