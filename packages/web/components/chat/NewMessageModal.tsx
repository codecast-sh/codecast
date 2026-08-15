import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Hash, Lock, Users, X } from "lucide-react";
import { CommentAvatar } from "../comments/CommentAvatar";
import { useInboxStore } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useChatRail } from "../../hooks/useChatSync";
import { matchScore } from "../../hooks/useMentionQuery";
import {
  PRESENCE_META,
  memberPresenceState,
  presenceLine,
  compareMembersByPresence,
} from "../presence/memberPresence";
import { channelDisplayName, memberHandles, memberName, type ChatMember } from "../../lib/chatViews";
import type { ChatChannelView } from "./chatTypes";
import "./chat.css";

// New message.
//
// One field answers "who do I want to talk to" — a person, several people, a
// channel, or a group conversation that already exists. Typing searches all of
// them at once; picking people accumulates chips; picking a room just goes
// there. The set of people IS the conversation's identity (dm_key), so opening
// the same trio twice lands in the same room — creation and navigation are the
// same gesture, and neither needs a confirm step.
//
// Everything commits local-first: openDmChannel returns a room id in the same
// tick (an existing room's real id, or a stub the server row supersedes), so
// the modal never waits on the network to leave the screen.

type Member = ChatMember & {
  presence_state?: string;
  presence_input_at?: number;
  daemon_last_seen?: number;
  status?: string;
};

type Candidate =
  | { type: "person"; key: string; member: Member }
  | { type: "channel"; key: string; channel: ChatChannelView }
  | { type: "group"; key: string; channel: ChatChannelView };

/** Search text a member answers to: name plus every handle. */
function personText(m: Member): string {
  return [memberName(m), ...memberHandles(m)].join(" ");
}

export function NewMessageModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const now = useCoarseNow(30_000);
  const rail = useChatRail();
  const teamMembers = useInboxStore((s) => s.teamMembers) as Member[];
  const viewer = useInboxStore((s) => (s as any).currentUser?._id ?? "");
  const teamId = useInboxStore((s) => s.clientState.ui?.active_team_id);
  const openDm = useInboxStore((s) => s.openDmChannel);
  const openCreateModal = useInboxStore((s) => s.openCreateModal);

  const [q, setQ] = useState("");
  const [chips, setChips] = useState<string[]>([]);
  const [highlight, setHighlight] = useState(0);
  // Whether the keyboard cursor was moved on purpose. With chips picked and an
  // empty field, Enter means "start" — unless the user is mid-flight through
  // the suggestion list, where Enter must mean "pick this one".
  const [navigated, setNavigated] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const byId = useMemo(
    () => new Map((teamMembers ?? []).map((m) => [String(m._id), m])),
    [teamMembers],
  );

  const candidates = useMemo<Candidate[]>(() => {
    const needle = q.trim().toLowerCase();
    const people = (teamMembers ?? [])
      .filter((m) => !m.is_bot && String(m._id) !== String(viewer) && !chips.includes(String(m._id)))
      .map((m) => ({ m, s: needle ? matchScore(personText(m), needle) : 0 }))
      .filter((x) => x.s !== Infinity)
      .sort((a, b) => a.s - b.s || compareMembersByPresence(a.m, b.m))
      .slice(0, needle ? 6 : 7)
      .map((x): Candidate => ({ type: "person", key: `p:${x.m._id}`, member: x.m }));

    // Rooms only make sense before the first chip: once a person is picked,
    // the destination is a DM by definition.
    let groups: Candidate[] = [];
    let channels: Candidate[] = [];
    if (chips.length === 0) {
      groups = rail
        .filter((c) => c.kind === "dm" && (c.dmMemberIds ?? []).length > 1)
        .map((c) => ({ c, s: needle ? matchScore(channelDisplayName(c, teamMembers), needle) : 0 }))
        .filter((x) => x.s !== Infinity)
        .sort((a, b) => a.s - b.s)
        .slice(0, 3)
        .map((x): Candidate => ({ type: "group", key: `g:${x.c.id}`, channel: x.c }));
      channels = rail
        .filter((c) => c.kind !== "dm")
        .map((c) => ({ c, s: needle ? matchScore(c.name, needle) : 0 }))
        .filter((x) => x.s !== Infinity)
        .sort((a, b) => a.s - b.s)
        .slice(0, needle ? 4 : 5)
        .map((x): Candidate => ({ type: "channel", key: `c:${x.c.id}`, channel: x.c }));
    }
    return [...people, ...groups, ...channels];
  }, [q, chips, teamMembers, viewer, rail]);

  // The keyboard cursor follows the list, never dangles past it.
  useEffect(() => {
    setHighlight((h) => Math.min(h, Math.max(candidates.length - 1, 0)));
  }, [candidates.length]);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  const start = (ids: string[]) => {
    if (!ids.length) return;
    const channelId = openDm(ids, teamId ? String(teamId) : undefined);
    onClose();
    router.push(`/chat/${channelId}`);
  };

  const choose = (cand: Candidate | undefined) => {
    if (!cand) return;
    if (cand.type === "person") {
      setChips((prev) => [...prev, String(cand.member._id)]);
      setQ("");
      setHighlight(0);
      setNavigated(false);
      inputRef.current?.focus();
    } else {
      onClose();
      router.push(`/chat/${cand.channel.id}`);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return onClose();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setNavigated(true);
      setHighlight((h) => (candidates.length ? (h + 1) % candidates.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setNavigated(true);
      setHighlight((h) => (candidates.length ? (h - 1 + candidates.length) % candidates.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Cmd+Enter always commits the chips. Plain Enter commits them too once
      // the field is empty again — unless the cursor is mid-list on purpose.
      if ((e.metaKey || e.ctrlKey) && chips.length) return start(chips);
      if (!q.trim() && chips.length && !navigated) return start(chips);
      choose(candidates[highlight]);
    } else if (e.key === "Backspace" && !q && chips.length) {
      setChips((prev) => prev.slice(0, -1));
    }
  };

  // Section headers appear where the type changes — the list itself stays one
  // flat keyboard space.
  const headerFor = (i: number): string | null => {
    const t = candidates[i].type;
    if (i > 0 && candidates[i - 1].type === t) return null;
    return t === "person" ? "People" : t === "group" ? "Group conversations" : "Channels";
  };

  return (
    <div className="ch-nm-overlay" onClick={onClose} role="presentation">
      <div
        className="ch-nm"
        role="dialog"
        aria-modal="true"
        aria-label="New message"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="ch-nm-head">
          <span className="ch-nm-title">New message</span>
          <button type="button" className="ch-nm-close" aria-label="Close" onClick={onClose}>
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="ch-nm-to" onClick={() => inputRef.current?.focus()}>
          <span className="ch-nm-to-label">To:</span>
          {chips.map((id) => {
            const m = byId.get(id);
            return (
              <span className="ch-nm-chip" key={id}>
                <CommentAvatar name={memberName(m)} image={m?.image || m?.github_avatar_url} size={14} letters={1} />
                {memberName(m)}
                <button
                  type="button"
                  aria-label={`Remove ${memberName(m)}`}
                  onClick={() => setChips((prev) => prev.filter((x) => x !== id))}
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            );
          })}
          <input
            ref={inputRef}
            value={q}
            autoFocus
            placeholder={chips.length ? "Add another person" : "A person, several people, or a channel"}
            onChange={(e) => {
              setQ(e.target.value);
              setHighlight(0);
              setNavigated(false);
            }}
          />
        </div>

        <div className="ch-nm-list" ref={listRef} role="listbox" aria-label="Suggestions">
          {candidates.map((cand, i) => {
            const header = headerFor(i);
            const row =
              cand.type === "person" ? (
                <PersonRow member={cand.member} now={now} />
              ) : cand.type === "group" ? (
                <GroupRow channel={cand.channel} members={teamMembers} byId={byId} />
              ) : (
                <ChannelRow channel={cand.channel} />
              );
            return (
              <div key={cand.key}>
                {header && <div className="ch-nm-section">{header}</div>}
                <button
                  type="button"
                  data-idx={i}
                  role="option"
                  aria-selected={i === highlight}
                  className={`ch-nm-row ${i === highlight ? "ch-nm-row-hot" : ""}`}
                  onMouseMove={() => setHighlight(i)}
                  onClick={() => choose(cand)}
                >
                  {row}
                  {cand.type !== "person" && <ArrowRight className="w-3 h-3 ch-nm-go-icon" aria-hidden="true" />}
                </button>
              </div>
            );
          })}
          {candidates.length === 0 && (
            <div className="ch-nm-empty">
              {chips.length ? "Everyone matching is already added." : "Nobody and nothing matches."}
            </div>
          )}
        </div>

        <div className="ch-nm-foot">
          <button
            type="button"
            className="ch-nm-start"
            disabled={chips.length === 0}
            onClick={() => start(chips)}
          >
            {chips.length > 1 ? `Start group conversation (${chips.length})` : "Start conversation"}
          </button>
          <button
            type="button"
            className="ch-nm-alt"
            onClick={() => {
              onClose();
              openCreateModal("chat");
            }}
          >
            <Hash className="w-3 h-3" />
            New channel instead
          </button>
        </div>
      </div>
    </div>
  );
}

function PersonRow({ member, now }: { member: Member; now: number }) {
  const state = memberPresenceState(member as any);
  return (
    <>
      <CommentAvatar
        name={memberName(member)}
        image={member.image || member.github_avatar_url}
        size={24}
        letters={1}
      />
      <span className="ch-nm-name truncate">{memberName(member)}</span>
      <span className={`ch-dm-dot ${PRESENCE_META[state].dot}`} aria-hidden="true" />
      <span className="ch-nm-sub truncate">{presenceLine(member as any, now)}</span>
    </>
  );
}

function GroupRow({
  channel,
  members,
  byId,
}: {
  channel: ChatChannelView;
  members: Member[];
  byId: Map<string, Member>;
}) {
  const ids = channel.dmMemberIds ?? [];
  return (
    <>
      <span className="ch-dm-faces" aria-hidden="true">
        {ids.slice(0, 3).map((id) => {
          const m = byId.get(String(id));
          return (
            <span className="ch-dm-face" key={String(id)}>
              <CommentAvatar name={memberName(m)} image={m?.image || m?.github_avatar_url} size={18} letters={1} />
            </span>
          );
        })}
      </span>
      <span className="ch-nm-name truncate">{channelDisplayName(channel, members)}</span>
      <span className="ch-nm-sub">
        <Users className="w-3 h-3 inline-block mr-1 align-[-2px]" />
        {ids.length + 1}
      </span>
    </>
  );
}

function ChannelRow({ channel }: { channel: ChatChannelView }) {
  return (
    <>
      <span className="ch-nm-hash" aria-hidden="true">
        {channel.isPrivate ? <Lock className="w-3.5 h-3.5" /> : <Hash className="w-3.5 h-3.5" />}
      </span>
      <span className="ch-nm-name truncate">{channel.name}</span>
      {channel.topic && <span className="ch-nm-sub truncate">{channel.topic}</span>}
    </>
  );
}
