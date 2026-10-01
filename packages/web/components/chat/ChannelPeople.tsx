import { useEffect, useMemo, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { Check, LogOut, Plus, Search, UserPlus, Users, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { CommentAvatar } from "../comments/CommentAvatar";
import { useInboxStore } from "../../store/inboxStore";
import { useRouter } from "next/navigation";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import {
  memberPresenceVisual,
  presenceAvatarClass,
  presenceLine,
} from "../presence/memberPresence";
import { PresenceBadge } from "../presence/PresenceBadge";
import { channelDisplayName, knownAgentMember, memberName, type ChatMember } from "../../lib/chatViews";
import { AnchorScopePill } from "../anchor/AnchorIdentity";
import { useAnchorIdentity } from "../../hooks/useSyncAnchors";
import type { ChatRailChannel } from "../../store/chatSlice";
import { buildChannelRoster, isInRoom, type RosterRow, type RosterSide } from "../../lib/channelRoster";
import { useChannelSlackLink } from "../../hooks/useChannelSlackLink";
import { useSlackConnect } from "../../hooks/useSlackConnect";
import { SlackLogo } from "../SlackLogo";
import "./chat.css";
import { isPerson } from "@codecast/shared/team/memberKind";

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

function face(name: string, image: string | null | undefined, isAgent: boolean | undefined, size: number) {
  return <CommentAvatar name={name} image={image || undefined} isAgent={isAgent} size={size} letters={1} />;
}

function memberAvatar(m: Member | undefined, size: number) {
  return face(memberName(m), m?.image || m?.github_avatar_url, m?.is_bot, size);
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
        // Anchor bots first (they carry anchor_id for the scope pill; a team
        // anchor is also on the roster, without it), then teammates.
        .map((id) => knownAgentMember(String(id)) ?? teamMembers?.find((m) => String(m._id) === String(id)))
        .filter(Boolean) as Member[],
    [channel.dmMemberIds, teamMembers],
  );
  const one = others.length === 1 ? others[0] : undefined;
  const state = one && !one.is_bot ? memberPresenceVisual(one as any) : undefined;
  // A DM with an anchor says WHICH anchor: two of them can share the name.
  const anchorScope = useAnchorIdentity(one && (one as any).is_bot ? (one as any).anchor_id ?? null : null);
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
      {anchorScope && <AnchorScopePill anchor={anchorScope} />}
      {one && state && (
        <span className="ch-dm-presence" title={presenceLine(one as any, now)}>
          <PresenceBadge state={state} size="sm" />
          <span className="ch-dm-presence-line">{presenceLine(one as any, now)}</span>
        </span>
      )}
    </span>
  );
}

/** The room's roster in its header: a facepile that opens one list of the
 *  people in it, on both sides when it mirrors Slack. Each row carries a mark
 *  per side (here, Slack); a mark is the control, so adding someone to the
 *  Slack channel or taking them out of a private room is one click on the row
 *  they are already looking at. "Add people" searches everyone who is not in
 *  yet, teammates and Slack people alike. */
export function ChannelMembersButton({ channel }: { channel: ChatRailChannel }) {
  const teamMembers = useInboxStore((s) => s.teamMembers) as Member[];
  const slackPeopleById = useInboxStore((s) => s.chatSlackPeople);
  const viewer = useInboxStore((s) => (s as any).currentUser?._id ?? "");
  const creator = useInboxStore((s) => s.chatChannels[channel.id]?.created_by);
  const addMembers = useInboxStore((s) => s.addChatChannelMembers);
  const removeMember = useInboxStore((s) => s.removeChatChannelMember);
  const setSlackMember = useInboxStore((s) => s.setChatSlackMember);
  const link = useChannelSlackLink(channel.kind === "dm" ? null : channel.id);
  const refreshSlack = useAction(api.slackSync.refreshSlackMembers);
  const router = useRouter();
  const now = useCoarseNow(30_000);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const [slackReadError, setSlackReadError] = useState<string | null>(null);

  const isDm = channel.kind === "dm";
  const isPrivate = channel.kind === "private" || (!!channel.isPrivate && !isDm);
  const slackPeople = useMemo(() => Object.values(slackPeopleById ?? {}), [slackPeopleById]);
  const rows = useMemo(
    () => buildChannelRoster({
      kind: isDm ? "dm" : isPrivate ? "private" : channel.kind,
      memberIds: channel.memberIds,
      teamMembers: teamMembers ?? [],
      slackPeople,
      link,
    }),
    [isDm, isPrivate, channel.kind, channel.memberIds, teamMembers, slackPeople, link],
  );
  const inRoom = useMemo(() => rows.filter(isInRoom), [rows]);

  const viewerRole = (teamMembers ?? []).find((m) => String(m._id) === viewer)?.role;
  const mayManage = creator === viewer || viewerRole === "admin";
  const slackWritable = !!link?.member_writer;
  const canAddHere = isPrivate;
  const canAddSlack = !!link && slackWritable;

  // Read the Slack side whole when the panel opens; the server skips the call
  // when it read the channel moments ago, and the roster arrives on the link.
  useEffect(() => {
    if (!open || !link) return;
    let live = true;
    setSlackReadError(null);
    refreshSlack({ chat_channel_id: channel.id as Id<"chat_channels"> })
      .then((res: any) => { if (live && res && !res.ok) setSlackReadError(res.error ?? "Couldn't read the Slack channel"); })
      .catch(() => { if (live) setSlackReadError("Couldn't read the Slack channel"); });
    return () => { live = false; };
  }, [open, link?._id, channel.id, refreshSlack]);

  const needle = q.trim().toLowerCase();
  const matches = (r: RosterRow) =>
    !needle || r.name.toLowerCase().includes(needle) || (r.member?.github_username ?? "").toLowerCase().includes(needle);
  const shownIn = inRoom.filter(matches);
  // People not in on any side who could be added on at least one.
  const candidates = adding
    ? rows.filter((r) => !isInRoom(r) && ((canAddHere && r.here === "out") || (canAddSlack && r.slack === "out")) && matches(r)).slice(0, 30)
    : [];

  const toggleHere = (r: RosterRow) => {
    if (!r.userId) return;
    if (r.here === "out") return addMembers(channel.id, [r.userId]);
    removeMember(channel.id, r.userId);
    if (r.userId === viewer) {
      setOpen(false);
      router.replace("/chat");
    }
  };
  const toggleSlack = (r: RosterRow) => {
    if (r.slackUserId) setSlackMember(channel.id, r.slackUserId, r.slack === "out");
  };
  // A candidate joins every side they can: the add is about the person.
  const addEverywhere = (r: RosterRow) => {
    if (canAddHere && r.here === "out" && r.userId) addMembers(channel.id, [r.userId]);
    if (canAddSlack && r.slack === "out" && r.slackUserId) setSlackMember(channel.id, r.slackUserId, true);
  };

  const hereControl = (r: RosterRow) => {
    if (r.here === "team" || r.here === "none" || isDm) return null;
    if (r.here === "out") return canAddHere ? "add" : null;
    return r.userId === viewer || mayManage ? "remove" : null;
  };
  const slackControl = (r: RosterRow) => {
    if (!link || !slackWritable) return null;
    if (r.slack === "out") return "add";
    if (r.slack === "in") return mayManage ? "remove" : null;
    return null;
  };

  const memberError = link?.member_error && now - link.member_error.at < 10 * 60_000 ? link.member_error : null;
  const errorName = memberError ? rows.find((r) => r.slackUserId === memberError.slack_user_id)?.name : null;

  if (!inRoom.length && !link) return null;
  const faces = inRoom.slice(0, 3);
  const count = inRoom.length;

  const renderRow = (r: RosterRow, candidate: boolean) => {
    const state = r.member ? memberPresenceVisual(r.member as any) : "offline";
    return (
      <div className={`ch-people-row ch-roster-row${candidate ? " ch-roster-candidate" : ""}`} key={r.key}>
        <span className={r.member ? presenceAvatarClass(state) : undefined}>{rosterAvatar(r, 22)}</span>
        <span className="ch-people-name truncate">
          {r.name}
          {r.userId === viewer && <span className="ch-people-you"> (you)</span>}
        </span>
        {r.member && !candidate && (
          <PresenceBadge state={state} size="sm" title={presenceLine(r.member as any, now)} />
        )}
        {candidate ? (
          <button type="button" className="ch-roster-add" onClick={() => addEverywhere(r)}>
            <Plus className="w-3 h-3" />
            Add
          </button>
        ) : (
          <>
            {!isDm && (
              <SideMark
                side={r.here}
                control={hereControl(r)}
                label={isPrivate ? "this channel" : "codecast"}
                self={r.userId === viewer}
                name={r.name}
                onToggle={() => toggleHere(r)}
              />
            )}
            {link && (
              <SideMark
                side={r.slack}
                control={slackControl(r)}
                label="Slack"
                slack
                name={r.name}
                onToggle={() => toggleSlack(r)}
              />
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setAdding(false); setQ(""); } }}>
      <PopoverTrigger asChild>
        <button type="button" className="ch-tool ch-members-btn" title={`${count} ${count === 1 ? "member" : "members"}`}>
          <span className="ch-dm-faces" aria-hidden="true">
            {faces.map((r) => (
              <span className="ch-dm-face" key={r.key}>{rosterAvatar(r, 16)}</span>
            ))}
          </span>
          <span className="ch-members-count">{count}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className={`ch-people-pop${link ? " ch-roster-pop-wide" : ""}`}>
        <div className="ch-roster-head">
          <span className="ch-people-title">
            <Users className="w-3 h-3 opacity-60" />
            {isDm ? "In this conversation" : "Members"}
            <span className="ch-roster-count">{count}</span>
          </span>
          {!isDm && (
            <span className="ch-roster-cols" aria-hidden="true">
              <span className="ch-roster-col" title={isPrivate ? "In this channel" : "Everyone on the team"}>here</span>
              {link && (
                <span className="ch-roster-col" title={`In Slack #${link.slack_channel_name ?? link.slack_channel_id}`}>
                  <SlackLogo className="w-3 h-3" />
                </span>
              )}
            </span>
          )}
        </div>
        {!isDm && !isPrivate && (
          <div className="ch-roster-note">
            Public channel: everyone on the team is in it{link ? ", and the Slack column is the Slack channel" : ""}.
          </div>
        )}
        {adding && (
          <div className="ch-picker-search ch-roster-search">
            <Search className="w-3 h-3 opacity-50" />
            <input
              value={q}
              autoFocus
              placeholder={canAddSlack && !canAddHere ? "Invite someone from Slack" : "Search teammates and Slack people"}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && candidates.length === 1) {
                  e.preventDefault();
                  addEverywhere(candidates[0]);
                  setQ("");
                }
                if (e.key === "Escape" && q) {
                  e.preventDefault();
                  e.stopPropagation();
                  setQ("");
                }
              }}
            />
          </div>
        )}
        <div className="ch-people-list">
          {shownIn.map((r) => renderRow(r, false))}
          {adding && (
            <>
              <div className="ch-roster-divider">Not in this channel</div>
              {candidates.map((r) => renderRow(r, true))}
              {candidates.length === 0 && <div className="ch-picker-empty">{needle ? "Nobody matches" : "Everyone is already in"}</div>}
            </>
          )}
        </div>
        {memberError && (
          <div className="ch-roster-err">
            {errorName ? `${errorName}: ` : ""}{memberError.message}
          </div>
        )}
        {slackReadError && !memberError && <div className="ch-roster-err">{slackReadError}</div>}
        {link && !slackWritable && (
          <SlackReconnect teamId={link.team_id} returnTo={`/chat/${channel.id}`} isAdmin={viewerRole === "admin"} isPrivate={!!link.slack_channel_private} />
        )}
        {!isDm && !adding && (canAddHere || canAddSlack) && (
          <button type="button" className="ch-people-add" onClick={() => setAdding(true)}>
            <UserPlus className="w-3 h-3" /> Add people
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}

function rosterAvatar(r: RosterRow, size: number) {
  return face(r.name, r.avatar, r.member?.is_bot, size);
}

/** One side of one person: a mark that says whether they are in, and, when the
 *  viewer may change it, the button that does. Hovering an "in" mark turns it
 *  into the remove, so the control sits exactly where the state is read. */
function SideMark({
  side,
  control,
  label,
  slack,
  self,
  name,
  onToggle,
}: {
  side: RosterSide;
  control: "add" | "remove" | null;
  label: string;
  slack?: boolean;
  self?: boolean;
  name: string;
  onToggle: () => void;
}) {
  const tone = slack ? " ch-roster-mark-slack" : "";
  if (side === "none") {
    const why = slack ? "Not matched to a Slack person" : "No codecast account";
    return <span className={`ch-roster-mark ch-roster-mark-none${tone}`} title={why}>–</span>;
  }
  if (side === "team") {
    return (
      <span className={`ch-roster-mark ch-roster-mark-team${tone}`} title="In by being on the team">
        <Check className="w-3 h-3" />
      </span>
    );
  }
  const title = side === "in"
    ? control ? (self ? `Leave ${label}` : `Remove ${name} from ${label}`) : `In ${label}`
    : control ? `Add ${name} to ${label}` : `Not in ${label}`;
  const body = side === "in" ? (
    <>
      <Check className="w-3 h-3 ch-roster-mark-on" />
      {control && (self && !slack ? <LogOut className="w-3 h-3 ch-roster-mark-off" /> : <X className="w-3 h-3 ch-roster-mark-off" />)}
    </>
  ) : control ? <Plus className="w-3 h-3" /> : null;
  if (!control) {
    return <span className={`ch-roster-mark ch-roster-mark-${side}${tone}`} title={title}>{body}</span>;
  }
  return (
    <button
      type="button"
      className={`ch-roster-mark ch-roster-mark-${side} ch-roster-mark-btn${tone}`}
      title={title}
      aria-label={title}
      onClick={onToggle}
    >
      {body}
    </button>
  );
}

/** The Slack app predates member management: say who can grant it and do it
 *  in one click. An admin re-adds the app (covers every channel); anyone can
 *  connect their own Slack, which covers private channels they are in. Shown
 *  in a mirrored room's member panel and on the team's Slack card. */
export function SlackReconnect({ teamId, returnTo, isAdmin, isPrivate }: { teamId: string; returnTo: string; isAdmin: boolean; isPrivate: boolean }) {
  const team = useSlackConnect(teamId, returnTo, "team");
  const self = useSlackConnect(teamId, returnTo, "self");
  const conn = isAdmin ? team : isPrivate ? self : null;
  return (
    <div className="ch-roster-reconnect">
      <SlackLogo className="w-3 h-3 shrink-0" muted />
      <span className="flex-1 min-w-0">
        {conn
          ? "Slack needs a newer permission before people can be invited to and removed from mirrored channels."
          : "A team admin reconnects Slack before people can be invited to and removed from mirrored channels."}
        {conn?.error && <span className="ch-roster-err-inline"> {conn.error}</span>}
      </span>
      {conn && (
        <button type="button" className="ch-roster-reconnect-btn" disabled={conn.busy} onClick={conn.connect}>
          {conn.started ? "Opened" : conn.busy ? "Opening" : "Reconnect"}
        </button>
      )}
    </div>
  );
}

/** The teammate multi-picker: search, click to toggle, one primary action.
 *  Used by "Add people" (ChannelMembersButton) and the private-channel roster
 *  in CreateChannelModal. Starting a conversation has its own surface —
 *  NewMessageModal — because there the pick IS the destination. */
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
      .filter((m) => isPerson(m) && !exclude.includes(String(m._id)))
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

