import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Hash, Headphones, Lock, Users, X } from "lucide-react";
import { CommentAvatar } from "../comments/CommentAvatar";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { ChatModalLegend } from "./ChatModalLegend";
import { useInboxStore } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useChatRail, useOpenDm } from "../../hooks/useChatSync";
import { matchScore } from "../../hooks/useMentionQuery";
import {
  memberPresenceVisual,
  presenceAvatarClass,
  presenceLine,
  compareMembersByPresence,
} from "../presence/memberPresence";
import { PresenceBadge } from "../presence/PresenceBadge";
import { STRAY_WORKSPACE, isStrayWorkspace } from "../people/peopleRoster";
import { channelDisplayName, chatViewRoomKey, memberHandles, memberName, type ChatMember } from "../../lib/chatViews";
import { joinCall, ringInto, startHuddle } from "../../lib/calls/callManager";
import { MAX_ROOM_MEMBERS, dmRoomKey } from "@codecast/shared/contracts";
import { memberAvatarUrl } from "../../lib/liveEntities";
import type { ChatChannelView } from "./chatTypes";
import "./chat.css";

import { useWatchEffect } from "../../hooks/useWatchEffect";
// New message / new huddle.
//
// One field answers "who do I want to talk to" — a person, several people, a
// channel, or a group conversation that already exists. Typing searches all of
// them at once; picking people accumulates chips; picking a room just goes
// there. The set of people IS the conversation's identity (dm_key), so opening
// the same trio twice lands in the same room — creation and navigation are the
// same gesture, and neither needs a confirm step.
//
// The same field starts a huddle (`intent="huddle"`): the set of people IS the
// huddle room too (dm room key), a group thread huddles in the room of its
// members, a channel in its own. Picking people rings them; picking a room
// joins it (a channel is an open door and rings nobody; a group thread rings
// its members). Chat rooms only appear when the team has chat on — the rail
// is empty otherwise and the field is people-only.
//
// Everything commits local-first: openDmChannel returns a room id in the same
// tick (an existing room's real id, or a stub the server row supersedes), so
// the modal never waits on the network to leave the screen; a huddle paints
// "connecting" in the dock the same tick.

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

export function NewMessageModal({
  onClose,
  intent = "message",
}: {
  onClose: () => void;
  intent?: "message" | "huddle";
}) {
  const huddle = intent === "huddle";
  // Already in a huddle? Then this field means "bring people into it" — a
  // second room would silently drop the one you are in. Picking a room
  // (channel / group thread) still switches: naming a destination is the
  // explicit gesture.
  const liveRoomKey = useInboxStore((s) =>
    intent === "huddle" && s.call.phase !== "idle" && s.call.phase !== "error"
      ? s.call.roomKey
      : null,
  );
  const now = useCoarseNow(30_000);
  const openDm = useOpenDm();
  const router = useRouter();
  const go = (path: string) => router.push(path);
  const rail = useChatRail();
  const teamMembers = useInboxStore((s) => s.teamMembers) as Member[];
  // "No people match" is a lie when the window is pointed at a workspace the
  // viewer has left: teams.getTeamMembers answers a non-member with [], not an
  // error, so the roster is empty for a reason the picker would otherwise keep
  // to itself. The predicate stays false until the real team list has arrived,
  // so a cold boot never accuses anyone of anything.
  const strayWorkspace = useInboxStore((s) =>
    isStrayWorkspace(s.teams as any, s.clientState?.ui?.active_team_id),
  );
  const viewer = useInboxStore((s) => (s as any).currentUser?._id ?? "");
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

  // A people huddle room holds MAX_ROOM_MEMBERS including you; ringing into
  // a live room is capped by the same roster size. Past the cap the field
  // stops offering people instead of failing after the modal closed.
  const chipCap = huddle ? MAX_ROOM_MEMBERS - 1 : Infinity;
  const capReached = chips.length >= chipCap;

  const candidates = useMemo<Candidate[]>(() => {
    if (capReached) return [];
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
  }, [q, chips, teamMembers, viewer, rail, capReached]);

  // The keyboard cursor follows the list, never dangles past it.
  useWatchEffect(() => {
    setHighlight((h) => Math.min(h, Math.max(candidates.length - 1, 0)));
  }, [candidates.length]);
  useWatchEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  const start = (ids: string[]) => {
    if (!ids.length) return;
    onClose();
    if (huddle) {
      // Context lines for people rooms are server-derived per recipient.
      if (liveRoomKey) void ringInto(liveRoomKey, ids);
      else void startHuddle({ roomKey: dmRoomKey(String(viewer), ...ids), toUserIds: ids });
      return;
    }
    openDm(ids);
  };

  const choose = (cand: Candidate | undefined) => {
    if (!cand) return;
    if (cand.type === "person") {
      setChips((prev) => [...prev, String(cand.member._id)]);
      setQ("");
      setHighlight(0);
      setNavigated(false);
      inputRef.current?.focus();
    } else if (huddle) {
      onClose();
      const c = cand.channel;
      const roomKey = chatViewRoomKey(c, String(viewer), teamMembers);
      if (cand.type === "group") {
        void startHuddle({ roomKey, toUserIds: c.dmMemberIds ?? [] });
      } else {
        // Picking a person and pressing Enter is as deliberate as a join gets.
        void joinCall(roomKey, { intent: "deliberate" });
      }
    } else {
      onClose();
      go(`/chat/${cand.channel.id}`);
    }
  };

  // ONE rule decides what Enter does, and the same rule decides what looks
  // selected — a row that renders hot while Enter would do something else is a
  // lie. With people picked and an empty field, Enter starts the conversation
  // and no row is hot; the moment the cursor moves (keys or mouse) or text is
  // typed, Enter picks the hot row instead.
  const enterStarts = chips.length > 0 && !q.trim() && !navigated;
  const hot = enterStarts ? -1 : highlight;

  // Keys are handled on the INPUT, not the dialog: a dialog-level Enter would
  // swallow the click of every focused button (a chip's remove, the footer).
  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
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
      if ((e.metaKey || e.ctrlKey) && chips.length) return start(chips);
      if (enterStarts) return start(chips);
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
    <div className="ch-modal-overlay" onClick={onClose} role="presentation">
      <div
        className="ch-modal ch-nm"
        role="dialog"
        aria-modal="true"
        aria-label={huddle ? "New huddle" : "New message"}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <div className="ch-nm-head">
          <span className="ch-nm-title">
            {huddle && <Headphones className="w-3.5 h-3.5 inline-block mr-1.5 align-[-2px] text-sol-violet" aria-hidden="true" />}
            {huddle ? (liveRoomKey ? "Add to your huddle" : "New huddle") : "New message"}
          </span>
          <button type="button" className="ch-modal-close" aria-label="Close" onClick={onClose}>
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="ch-nm-to" onClick={() => inputRef.current?.focus()}>
          <span className="ch-nm-to-label">{huddle ? "With:" : "To:"}</span>
          {chips.map((id) => {
            const m = byId.get(id);
            return (
              <span className="ch-nm-chip" key={id}>
                <CommentAvatar name={memberName(m)} image={memberAvatarUrl(m)} size={14} letters={1} />
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
            placeholder={
              chips.length
                ? "Add another"
                : huddle && !rail.length
                  ? "A person or several people"
                  : "A person, several people, or a channel"
            }
            onKeyDown={onInputKeyDown}
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
                {header && <div className="ch-eyebrow">{header}</div>}
                <button
                  type="button"
                  data-idx={i}
                  role="option"
                  aria-selected={i === hot}
                  className={`ch-nm-row ${i === hot ? "ch-row-hot" : ""}`}
                  onMouseMove={() => {
                    setHighlight(i);
                    setNavigated(true);
                  }}
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
              {capReached
                ? `A huddle holds up to ${MAX_ROOM_MEMBERS} people.`
                : chips.length
                  ? "Everyone matching is already added."
                  : strayWorkspace
                    ? `${STRAY_WORKSPACE} Switch workspace to reach your team.`
                    : "No people or channels match."}
              {!huddle && !chips.length && q.trim() && (
                <button
                  type="button"
                  className="ch-nm-empty-action"
                  onClick={() => {
                    onClose();
                    openCreateModal("chat");
                  }}
                >
                  <Hash className="w-3 h-3" />
                  New channel &ldquo;{q.trim()}&rdquo;
                </button>
              )}
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
            {huddle
              ? liveRoomKey
                ? `Ring ${chips.length > 1 ? chips.length : "them"} into your huddle`
                : chips.length > 1
                  ? `Start huddle · ring ${chips.length}`
                  : "Start huddle"
              : chips.length > 1
                ? "Start group conversation"
                : "Start conversation"}
            {enterStarts && <KeyCap size="xs">{"\u21a9"}</KeyCap>}
          </button>
          {!huddle && (
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
          )}
        </div>
        <ChatModalLegend enterLabel={enterStarts ? "start" : "pick"} />
      </div>
    </div>
  );
}

function PersonRow({ member, now }: { member: Member; now: number }) {
  const state = memberPresenceVisual(member as any);
  return (
    <>
      <span className={presenceAvatarClass(state)}>
        <CommentAvatar
          name={memberName(member)}
          image={memberAvatarUrl(member)}
          size={24}
          letters={1}
        />
      </span>
      <span className="ch-nm-name truncate">{memberName(member)}</span>
      <PresenceBadge state={state} size="sm" />
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
              <CommentAvatar name={memberName(m)} image={memberAvatarUrl(m)} size={18} letters={1} />
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
