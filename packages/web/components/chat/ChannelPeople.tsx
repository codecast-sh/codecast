import { useMemo, useState } from "react";
import { Check, LogOut, Plus, Search, UserPlus, Users, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { CommentAvatar } from "../comments/CommentAvatar";
import { useInboxStore } from "../../store/inboxStore";
import { useRouter } from "next/navigation";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import {
  PRESENCE_META,
  memberPresenceState,
  presenceLine,
} from "../presence/memberPresence";
import { channelDisplayName, memberName, type ChatMember } from "../../lib/chatViews";
import type { ChatRailChannel } from "../../store/chatSlice";
import "./chat.css";

// The people layer of a chat room: who a DM is with, who is inside a private
// channel, and how someone new gets in. Three surfaces, one file, because they
// share the same row (face, name, presence) and the same picker.

type Member = ChatMember & {
  role?: string;
  presence_state?: string;
  presence_input_at?: number;
  daemon_last_seen?: number;
  status?: string;
};

function memberAvatar(m: Member | undefined, size: number) {
  return (
    <CommentAvatar
      name={memberName(m)}
      image={m?.image || m?.github_avatar_url}
      isAgent={m?.is_bot}
      size={size}
      letters={1}
    />
  );
}

/** The DM header: faces, live names, and — for a 1:1 — the other side's
 *  presence, the same line the avatar bar shows. A DM's header answers "am I
 *  talking to someone who is there?", which a hash never had to. */
export function DmHeadline({ channel }: { channel: ChatRailChannel }) {
  const teamMembers = useInboxStore((s) => s.teamMembers) as Member[];
  const now = useCoarseNow(30_000);
  const others = useMemo(
    () =>
      (channel.dmMemberIds ?? [])
        .map((id) => teamMembers?.find((m) => String(m._id) === String(id)))
        .filter(Boolean) as Member[],
    [channel.dmMemberIds, teamMembers],
  );
  const one = others.length === 1 ? others[0] : undefined;
  const state = one ? memberPresenceState(one as any) : undefined;
  return (
    <span className="ch-head-name ch-head-dm">
      <span className="ch-dm-faces" aria-hidden="true">
        {(others.length ? others : [undefined]).slice(0, 3).map((m, i) => (
          <span className="ch-dm-face" key={m ? String(m._id) : i}>
            {memberAvatar(m, 20)}
          </span>
        ))}
      </span>
      <span className="truncate">{channelDisplayName(channel, teamMembers)}</span>
      {one && state && (
        <span className="ch-dm-presence" title={presenceLine(one as any, now)}>
          <span className={`ch-dm-dot ${PRESENCE_META[state].dot}`} />
          <span className="ch-dm-presence-line">{presenceLine(one as any, now)}</span>
        </span>
      )}
    </span>
  );
}

/** The roster affordance in a restricted room's header: a facepile that opens
 *  the member list. Private channels can grow from here; a DM's roster is
 *  read-only — its member set is its identity. */
export function ChannelMembersButton({ channel }: { channel: ChatRailChannel }) {
  const teamMembers = useInboxStore((s) => s.teamMembers) as Member[];
  const viewer = useInboxStore((s) => (s as any).currentUser?._id ?? "");
  const channelRow = useInboxStore((s) => s.chatChannels[channel.id]);
  const addMembers = useInboxStore((s) => s.addChatChannelMembers);
  const removeMember = useInboxStore((s) => s.removeChatChannelMember);
  const router = useRouter();
  const now = useCoarseNow(30_000);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  // Optimistic adds: the rail's member_ids refresh on the server echo; until
  // then the people you just picked stay visible in the list you picked them
  // into. Ephemeral by design — gone the moment the popover closes.
  const [justAdded, setJustAdded] = useState<string[]>([]);

  const ids = useMemo(() => {
    const base = channel.memberIds ?? [];
    return [...base, ...justAdded.filter((id) => !base.includes(id))];
  }, [channel.memberIds, justAdded]);
  const byId = useMemo(
    () => new Map((teamMembers ?? []).map((m) => [String(m._id), m])),
    [teamMembers],
  );
  const isDm = channel.kind === "dm";
  const viewerRole = (teamMembers ?? []).find((m) => String(m._id) === viewer)?.role;
  const mayRemove = (id: string) =>
    !isDm && (id === viewer || channelRow?.created_by === viewer || viewerRole === "admin");

  if (!ids.length) return null;
  const faces = ids.slice(0, 3).map((id) => byId.get(String(id)));

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setAdding(false); setJustAdded([]); } }}>
      <PopoverTrigger asChild>
        <button type="button" className="ch-tool ch-members-btn" title={`${ids.length} ${ids.length === 1 ? "member" : "members"}`}>
          <span className="ch-dm-faces" aria-hidden="true">
            {faces.map((m, i) => (
              <span className="ch-dm-face" key={m ? String(m._id) : i}>{memberAvatar(m, 16)}</span>
            ))}
          </span>
          <span className="ch-members-count">{ids.length}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="ch-people-pop">
        <div className="ch-people-title">
          <Users className="w-3 h-3 opacity-60" />
          {isDm ? "In this conversation" : "Members"}
        </div>
        <div className="ch-people-list">
          {ids.map((id) => {
            const m = byId.get(String(id));
            const state = m ? memberPresenceState(m as any) : "offline";
            return (
              <div className="ch-people-row" key={String(id)}>
                {memberAvatar(m, 22)}
                <span className="ch-people-name truncate">
                  {memberName(m)}
                  {String(id) === viewer && <span className="ch-people-you"> (you)</span>}
                </span>
                <span className={`ch-dm-dot ${PRESENCE_META[state as keyof typeof PRESENCE_META]?.dot ?? ""}`} title={m ? presenceLine(m as any, now) : undefined} />
                {mayRemove(String(id)) && (
                  <button
                    type="button"
                    className="ch-people-remove"
                    title={String(id) === viewer ? "Leave channel" : `Remove ${memberName(m)}`}
                    onClick={() => {
                      removeMember(channel.id, String(id));
                      if (String(id) === viewer) {
                        setOpen(false);
                        router.replace("/chat");
                      }
                    }}
                  >
                    {String(id) === viewer ? <LogOut className="w-3 h-3" /> : <X className="w-3 h-3" />}
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {!isDm && !adding && (
          <button type="button" className="ch-people-add" onClick={() => setAdding(true)}>
            <UserPlus className="w-3 h-3" /> Add people
          </button>
        )}
        {!isDm && adding && (
          <MemberPicker
            exclude={ids.map(String)}
            submitLabel="Add"
            onPick={(picked) => {
              addMembers(channel.id, picked);
              setJustAdded((prev) => [...prev, ...picked]);
              setAdding(false);
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The teammate multi-picker: search, click to toggle, one primary action.
 *  Shared by "Add people" and the new-message flow so choosing a person is the
 *  same gesture everywhere. */
export function MemberPicker({
  exclude,
  submitLabel,
  onPick,
  onChange,
  autoFocus = true,
}: {
  exclude: string[];
  submitLabel?: string;
  /** Commit mode: one primary action hands over the picked set. */
  onPick?: (ids: string[]) => void;
  /** Selection mode: every toggle reports the whole set; no button of its own
   *  (the surrounding surface owns the commit). */
  onChange?: (ids: string[]) => void;
  autoFocus?: boolean;
}) {
  const teamMembers = useInboxStore((s) => s.teamMembers) as Member[];
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const candidates = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (teamMembers ?? [])
      .filter((m) => !m.is_bot && !exclude.includes(String(m._id)))
      .filter((m) => !needle || memberName(m).toLowerCase().includes(needle) || m.github_username?.toLowerCase().includes(needle))
      .slice(0, 12);
  }, [teamMembers, exclude, q]);

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      onChange?.(next);
      return next;
    });

  return (
    <div className="ch-picker">
      <div className="ch-picker-search">
        <Search className="w-3 h-3 opacity-50" />
        <input
          value={q}
          autoFocus={autoFocus}
          placeholder="Search teammates"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && picked.length && onPick) {
              e.preventDefault();
              onPick(picked);
            }
          }}
        />
      </div>
      <div className="ch-picker-list">
        {candidates.map((m) => {
          const id = String(m._id);
          const on = picked.includes(id);
          return (
            <button
              type="button"
              key={id}
              className={`ch-people-row ch-picker-row ${on ? "ch-picker-on" : ""}`}
              onClick={() => toggle(id)}
            >
              {memberAvatar(m, 22)}
              <span className="ch-people-name truncate">{memberName(m)}</span>
              {on && <Check className="w-3.5 h-3.5 text-sol-cyan" />}
            </button>
          );
        })}
        {candidates.length === 0 && <div className="ch-picker-empty">Nobody matches</div>}
      </div>
      {onPick && (
        <button
          type="button"
          className="ch-picker-go"
          disabled={picked.length === 0}
          onClick={() => picked.length && onPick(picked)}
        >
          <Plus className="w-3 h-3" />
          {submitLabel}
          {picked.length > 1 ? ` (${picked.length})` : ""}
        </button>
      )}
    </div>
  );
}

