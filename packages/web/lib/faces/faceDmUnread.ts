// The viewer's unread DMs as the face row wears them: a count per teammate
// from the store's rail rows, honouring local read marks, and the one press
// (markFaceRead) that clears a face's lines and its DM together.
import { dmBadgesByMember } from "../../components/people/peopleRoster";
import { useInboxStore } from "../../store/inboxStore";
import { selectChannelReadMarker } from "../../store/chatSlice";
import { clearFaceUnseen } from "../chat/faceChat";

function idOf(v: unknown): string {
  return v == null ? "" : String(v);
}

/** Unread DM messages per teammate, from the store's rail rows. Only rooms
 *  with exactly one other person, the same rule the people window uses. */
export function dmUnreadByMember(st: any): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const [id, badge] of dmBadgesOf(st)) out.set(id, badge.unread);
  return out;
}

/** A rail row's unread, honouring the viewer's local read mark: a channel read
 *  here (the face clicked, the DM opened) is read now, not on the next rail push. */
function railUnreadOf(st: any): (r: any) => number {
  const readAt = new Map<string, number>();
  for (const id in st.chatReads ?? {}) {
    const row = st.chatReads[id];
    const ch = String(row?.channel_id);
    readAt.set(ch, Math.max(readAt.get(ch) ?? 0, row?.last_read_at ?? 0));
  }
  return (r) => (r.unread && (readAt.get(String(r.channel_id)) ?? 0) >= (r.sort_at ?? Infinity) ? 0 : r.unread ?? 0);
}

function dmBadgesOf(st: any) {
  const me = idOf(st.currentUser?._id);
  const rail: any[] = st.chatRail ?? [];
  const unreadOf = railUnreadOf(st);
  const views = rail.map((r) => {
    const ch = st.chatChannels?.[r.channel_id];
    return {
      id: r.channel_id,
      kind: ch?.kind,
      dmMemberIds: (r.member_ids ?? []).filter((id: unknown) => idOf(id) !== me),
      unreadCount: unreadOf(r),
      mentionCount: r.unread_mentions ?? 0,
      muted: r.notify_level === "muted",
    };
  });
  return dmBadgesByMember(views as any);
}

/** What is waiting for the viewer in their DM with one teammate: the count
 *  the face wears, and their newest line when it is theirs. Null when
 *  nothing is unread, so the card only speaks when the face is badged. */
export type DmUnread = { channelId: string; unread: number; preview: string | null; at: number | null };

/** The viewer looked at this person (clicked their face or their count): the
 *  lines the header showed and their DM's unread both clear at once. */
export function markFaceRead(memberId: string): void {
  clearFaceUnseen(memberId);
  const st: any = useInboxStore.getState();
  const dm = dmUnreadOf(st, memberId);
  if (dm) st.markChannelRead(dm.channelId, selectChannelReadMarker(st, dm.channelId)?._id);
}

export function dmUnreadOf(st: any, memberId: string): DmUnread | null {
  const badge = dmBadgesOf(st).get(memberId);
  if (!badge || badge.unread <= 0) return null;
  const last = (st.chatRail ?? []).find((r: any) => String(r.channel_id) === badge.channelId)?.last_message;
  const theirs = last && idOf(last.user_id) === memberId && !last.call;
  return {
    channelId: badge.channelId,
    unread: badge.unread,
    preview: theirs ? last.preview || null : null,
    at: theirs ? last.created_at ?? null : null,
  };
}

export function railUnreadSig(st: any): string {
  const unreadOf = railUnreadOf(st);
  let s = "";
  for (const r of st.chatRail ?? []) {
    const n = unreadOf(r);
    if (n) s += `${r.channel_id}:${n},`;
  }
  return s;
}
