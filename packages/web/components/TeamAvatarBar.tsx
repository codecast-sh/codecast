import { useCallsAvailable } from "../lib/teamFeatures";
import { useRouter, useSearchParams } from "next/navigation";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { UserRound, Filter, Link2, Headphones, MessageSquare, ChevronRight, ArrowRight, Maximize2, PictureInPicture2 } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { useSyncCollection } from "../hooks/useSyncCollection";
import { useCoarseNow } from "../hooks/useCoarseNow";
import { useOpenSession } from "../hooks/useOpenSession";
import { useMissingSessionRow } from "../hooks/useMissingSessionRow";
import { useFaceRow } from "../hooks/useFaceRow";
import { cleanTitle } from "../lib/conversationProcessor";
import { copyToClipboard, shareOrigin } from "../lib/utils";
import { POP_OUT_PEOPLE_TITLE, canPopOutCall, useFacesFloating } from "../lib/desktop";
import { focusExistingHuddle } from "../lib/calls/huddleWindow";
import { popOutCall } from "../lib/calls/popOutCall";
import { openCallStage } from "../lib/calls/callStage";
import { ContextMenu, useContextMenu, CtxItem, CtxHeader } from "./ui/context-menu";
import {
  PRESENCE_META,
  localTimeLine,
  memberDisplayName,
  presenceLine,
  teammateWhereabouts,
} from "./presence/memberPresence";
import { MemberFace } from "./presence/MemberFace";
import { useMemberActivity } from "./presence/useMemberActivity";
import { useMemberHuddle } from "./presence/useMemberHuddle";
import { popOutPeople } from "./people/popOutPeople";
import { FaceRow } from "./faces/FaceRow";
import { EngagementCard } from "./faces/EngagementCard";
import { useOpenDm } from "../hooks/useChatSync";
import { ErrorBoundary } from "./ErrorBoundary";
import { ShortcutTooltip } from "./KeyboardShortcutsHelp";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";

interface TeamAvatarBarProps {
  teamId?: Id<"teams">;
}

/** How many faces the header holds before the rest fold into a count. The
 *  model puts me and the faces I am engaged with at the head, so the slice
 *  never cuts a live conversation. */
export const BAR_FACES = 6;

// Data pump, isolated so the live query's push rate never re-renders the
// visible bar: getTeamMembers re-emits every few seconds (teammates' presence
// heartbeats), and a useQuery in the display component re-rendered the whole
// avatar row on each push. The pump renders nothing; the bar below reads the
// store through the face row, whose identity only changes when something a
// face draws changed.
//
// It is a FEEDER, so it rides useSyncCollection and never a plain useQuery:
// the bar paints the cached roster, and a terminal server error must degrade
// to that cache, not unmount the bar. A plain useQuery re-throws the error
// during render, the boundary around the bar latches on it, and the bar stays
// "Failed to load" until somebody clicks retry, long after the server has
// recovered. On 2026-09-21 a half-saved edit of getTeamMembers reached prod
// for about a minute (ReferenceError: feedFilter is not defined), and every
// bar that was open then stayed broken for hours afterwards.
export function TeamMembersPump({ teamId }: { teamId: Id<"teams"> | undefined }) {
  useSyncCollection(
    "teamMembers",
    api.teams.getTeamMembers,
    // isConvexId: a just-created team holds an optimistic stub id until the
    // server echoes, and a stub is not an Id<"teams">.
    teamId && isConvexId(String(teamId)) ? { team_id: teamId } : "skip",
  );
  return null;
}

/**
 * THE HEADER IS THE FACE ROW (pl-756 F3).
 *
 * Presence, walkie, ringing and calls are the same faces in different states,
 * and this bar draws them from the one model every surface reads
 * (lib/faces/faceRow through useFaceRow): the row of circles, the links
 * between the faces I am engaged with, and the one control card the
 * engagement needs, hung under the row. Nothing here decides a state.
 *
 * What the bar adds is the shell's own chrome around the row: the hover card
 * with a person's activity, follow and profile; the context menu; the count of
 * faces that did not fit; the huddle and pop out buttons; and, while a call is
 * up, the door to the full stage. Popped out, the row lives in the floating
 * window and the header keeps one chip that brings it back.
 */
export function TeamAvatarBar({ teamId: propTeamId }: TeamAvatarBarProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const memberFilter = searchParams.get("member");
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as Id<"teams"> | undefined;
  // Only the viewer's id is rendered, never the whole user doc, whose
  // identity churns on daemon heartbeats.
  const viewerId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : ""));
  // Explicit prop, else the active workspace. No currentUser.team_id fallback:
  // an unset pointer IS the personal workspace, and falling back to the user's
  // default team would render that team's roster inside the personal space.
  const effectiveTeamId = propTeamId ?? activeTeamId;
  // A scalar: the roster array itself re-pushes on every heartbeat.
  const rosterCount = useInboxStore((s) => s.teamMembers.length);
  const callsEnabled = useCallsAvailable();
  // THE ROW. One subscription, signature gated: a heartbeat, a level tick or
  // a mute that moves no face hands back the same row and this bar sleeps.
  const row = useFaceRow();
  const floating = useFacesFloating();
  // Opens (or creates, local-first) THIS member's DM room. A bare
  // router.push("/chat") landed on the chat page's fallback: the busiest
  // room, i.e. somebody else's DM.
  const openDm = useOpenDm();
  const ctxMenu = useContextMenu<{ id: string; username?: string | null; displayName: string }>();

  // The header's slice of the row: me and the linked faces first (the model
  // puts them at the head), then the rest by presence, up to the cap.
  const shown = useMemo(
    () => (row.entries.length > BAR_FACES ? { ...row, entries: row.entries.slice(0, BAR_FACES) } : row),
    [row],
  );
  const hidden = row.entries.length - shown.entries.length;
  // Something is happening on the row: an engagement, a ring, a voice. The
  // minimal style hides the bar otherwise (globals.css).
  const live = !!row.me || row.links.length > 0;

  // Which face's hover card is open. State-driven (not pure CSS hover) so
  // the card, which subscribes to session data for its fleet line, is
  // MOUNTED only while pointed at; the always-visible bar itself never
  // subscribes to session churn. Two timers make the hover humane: a short
  // dwell before opening (drive-by pointers don't flash cards) and a grace
  // period before closing (crossing into the card, or between faces, never
  // drops it). The row's seats are found by delegation on `data-face-id`, so
  // the row itself carries no hover wiring for this one surface.
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverStay = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const hoverEnter = (id: string) => {
    hoverStay();
    if (hoveredId === id) return;
    if (openTimer.current) clearTimeout(openTimer.current);
    // Instant switch when a card is already open; dwell when opening cold.
    if (hoveredId) setHoveredId(id);
    else openTimer.current = setTimeout(() => setHoveredId(id), 120);
  };
  const hoverLeave = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = null;
    hoverStay();
    closeTimer.current = setTimeout(() => setHoveredId(null), 200);
  };
  const seatOf = (target: EventTarget | null): HTMLElement | null =>
    ((target as Element | null)?.closest?.("[data-face-id]") as HTMLElement | null) ?? null;
  const onPointerOver = (e: React.MouseEvent) => {
    const seat = seatOf(e.target);
    if (seat) {
      // The three actions are open under this face: two floating things
      // under one face is one too many, so the card stands down.
      if (seat.querySelector('[aria-expanded="true"]')) return hoverLeave();
      return hoverEnter(seat.dataset.faceId!);
    }
    if ((e.target as Element | null)?.closest?.("[data-member-card]")) return hoverStay();
    hoverLeave();
  };

  // The card hangs under the face it belongs to: the seat's own left edge,
  // read once when the card opens (the row's FLIP moves seats by transform,
  // so offsetLeft is the resting spot).
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [cardLeft, setCardLeft] = useState(0);
  useLayoutEffect(() => {
    if (!hoveredId) return;
    const seat = rowRef.current?.querySelector<HTMLElement>(`[data-face-id="${hoveredId}"]`);
    if (seat) setCardLeft(seat.offsetLeft);
  }, [hoveredId]);
  // The member row behind the card, subscribed only while the card is open.
  const hoveredMember = useInboxStore((s) =>
    hoveredId ? (s.teamMembers.find((m: any) => String(m?._id) === hoveredId) ?? null) : null,
  );

  if (!effectiveTeamId || rosterCount === 0) {
    return <TeamMembersPump teamId={effectiveTeamId} />;
  }

  const handleMemberClick = (memberId: string) => {
    if (memberFilter === memberId) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("member");
      router.push(`/team/activity?${params.toString()}`);
    } else {
      router.push(`/team/activity?filter=team&member=${memberId}`);
    }
  };

  const handleClearFilter = () => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("member");
    router.push(`/team/activity?${params.toString()}`);
  };

  const selectedMember = memberFilter
    ? useInboxStore.getState().teamMembers.find((m: any) => String(m?._id) === memberFilter)
    : null;

  // The row is floating over the work: one chip, and the pump.
  if (floating.floating) {
    return (
      <div className="people-bar flex items-center gap-1 px-2" data-floating="1">
        <TeamMembersPump teamId={effectiveTeamId} />
        <button
          type="button"
          onClick={() => floating.setFloating(false)}
          className="flex h-7 items-center gap-1.5 rounded-full border border-sol-cyan/40 bg-sol-cyan/10 px-2.5 text-[11px] text-sol-cyan transition-colors hover:bg-sol-cyan/20"
          title="The faces are floating over your work. Click to bring them back here."
        >
          <PictureInPicture2 className="h-3 w-3" />
          Faces are floating
        </button>
      </div>
    );
  }

  const openTheCall = () => {
    if (canPopOutCall()) {
      void focusExistingHuddle().then((shown) => {
        if (!shown) void popOutCall();
      });
      return;
    }
    openCallStage();
  };

  return (
    <div
      className="people-bar flex items-center gap-1 px-2"
      data-live={live ? "1" : undefined}
      onMouseOver={onPointerOver}
      onMouseLeave={hoverLeave}
      onClickCapture={(e) => {
        // A click on a face opens its three actions; the hover card steps
        // back so the two never stack.
        if (seatOf(e.target)) hoverLeave();
      }}
      onContextMenu={(e) => {
        const seat = seatOf(e.target);
        if (!seat) return;
        const member = useInboxStore.getState().teamMembers.find((m: any) => String(m?._id) === seat.dataset.faceId);
        if (!member) return;
        ctxMenu.open(e, { id: String(member._id), username: member.github_username, displayName: memberDisplayName(member) });
      }}
    >
      <TeamMembersPump teamId={effectiveTeamId} />
      <FaceRow row={shown} density="bar" viewerId={viewerId} callsEnabled={callsEnabled} rootRef={rowRef}>
        <EngagementCard card={row.card} density="bar" />
        {hoveredId && hoveredMember && (
          // Anchored on the hovered seat; the card positions itself under
          // the anchor. Its own boundary: a crash inside the card (or a join
          // it starts) must degrade to a chip that NAMES this surface, not
          // take the App boundary, and the whole shell, down with it.
          <span className="absolute top-0 h-full" style={{ left: cardLeft, width: 32 }} data-member-card>
            <ErrorBoundary name="member card" level="inline">
              <MemberHoverCard
                member={hoveredMember}
                displayName={memberDisplayName(hoveredMember)}
                isSelf={String(hoveredMember._id) === viewerId}
                callsEnabled={callsEnabled}
                currentUserId={viewerId}
                onOpenProfile={() => router.push(`/team/${hoveredMember.github_username || hoveredMember._id}`)}
                onOpenChat={() => openDm([String(hoveredMember._id)])}
              />
            </ErrorBoundary>
          </span>
        )}
      </FaceRow>
      {/* THE DOOR TO THE STAGE. The card under the row carries the two
          controls a call needs mid-work; the full stage (video, screen share,
          transcript) opens only when asked. On the desktop the call already
          has a window, so this raises it, or gives it one. */}
      {(row.card.kind === "live" || row.card.kind === "joined-notice") && (
        <ShortcutTooltip label="Open the call">
          <button
            type="button"
            onClick={openTheCall}
            data-open-call
            className="ml-1 flex h-8 w-8 items-center justify-center rounded-full text-sol-text-muted transition-colors hover:bg-sol-bg-highlight hover:text-sol-text"
            aria-label="Open the call"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        </ShortcutTooltip>
      )}
      {/* Group huddle: the row is where the people are, so the "ring several
          of them" gesture starts here (the new-huddle field, which also
          reaches group threads and channels). A solid circle the size of a
          face with a solid border: a dashed ring with a headset in it once
          read as a seventh person. */}
      {callsEnabled && rosterCount > 1 && (
        <ShortcutTooltip label="Start a huddle with several teammates">
          <button
            onClick={() => useInboxStore.getState().openCreateModal("huddle")}
            className="ml-1 flex h-8 w-8 items-center justify-center rounded-full border border-sol-border/60 text-sol-text-muted transition-colors hover:border-sol-violet/50 hover:text-sol-violet"
            aria-label="Start a huddle with several teammates"
          >
            <Headphones className="h-3.5 w-3.5" />
          </button>
        </ShortcutTooltip>
      )}
      {/* POP OUT. The same row, floating over the work in the shell's
          see-through window; the header keeps a chip while it is out. Off
          the desktop the buddy list window is the nearest thing. */}
      <ShortcutTooltip label={POP_OUT_PEOPLE_TITLE}>
        <button
          type="button"
          data-pop-out
          onClick={() => (floating.available ? floating.setFloating(true) : void popOutPeople())}
          className="flex h-8 w-8 items-center justify-center rounded-full text-sol-text-dim transition-colors hover:bg-sol-bg-highlight hover:text-sol-text"
          aria-label={POP_OUT_PEOPLE_TITLE}
        >
          <PictureInPicture2 className="h-3.5 w-3.5" />
        </button>
      </ShortcutTooltip>
      {hidden > 0 && (
        <ShortcutTooltip label={`${hidden} more team members`}>
          <button
            onClick={() => router.push("/team/activity?filter=team")}
            data-overflow
            className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-sol-border/50 bg-sol-bg-highlight text-xs text-sol-text-muted transition-colors hover:border-sol-border"
          >
            +{hidden}
          </button>
        </ShortcutTooltip>
      )}
      {selectedMember && (
        <ShortcutTooltip label="Clear filter">
          <button
            onClick={handleClearFilter}
            className="ml-1 flex items-center gap-1.5 rounded-full border border-sol-cyan/40 bg-sol-cyan/20 px-2 py-1 text-xs text-sol-cyan transition-colors hover:bg-sol-cyan/30"
            aria-label="Clear filter"
          >
            <span className="max-w-[80px] truncate">{memberDisplayName(selectedMember)}</span>
            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </ShortcutTooltip>
      )}
      <ContextMenu state={ctxMenu}>
        {(m) => (
          <>
            <CtxHeader title={m.displayName} />
            <CtxItem icon={UserRound} onSelect={() => router.push(`/team/${m.username || m.id}`)}>
              Open profile
            </CtxItem>
            <CtxItem icon={Filter} onSelect={() => handleMemberClick(m.id)}>
              Filter activity by member
            </CtxItem>
            <CtxItem
              icon={Link2}
              onSelect={() => {
                copyToClipboard(`${shareOrigin()}/team/${m.username || m.id}`);
                toast.success("Profile link copied");
              }}
            >
              Copy profile link
            </CtxItem>
          </>
        )}
      </ContextMenu>
    </div>
  );
}

// The rich hover card. Mounted only while its face (or the card itself) is
// hovered: the bar owns one hover scope with a close-grace timer, so crossing
// from the face into the card never drops it. Session data is read only here
// (transient subscription), never by the always-mounted bar. The walkie is
// not on this card: the face itself offers Talk, Ring and Message under a
// click, and a second key on a card that appears after a dwell was the
// founder's complaint.
// Exported for the _membercard visual harness only.
export function MemberHoverCard({
  member,
  displayName,
  isSelf,
  callsEnabled,
  currentUserId,
  onOpenProfile,
  onOpenChat,
}: {
  member: any;
  displayName: string;
  isSelf: boolean;
  callsEnabled: boolean;
  currentUserId: string;
  onOpenProfile: () => void;
  onOpenChat: () => void;
}) {
  const now = useCoarseNow(15_000);
  // One source for the badge, the activity line and the fleet counts: the
  // people window reads the same hook, so the two surfaces cannot phrase the
  // same situation differently.
  const { visual, line, fleet, room: liveRoom } = useMemberActivity(member);
  const meta = PRESENCE_META[visual];

  const time = localTimeLine(member.timezone, now);
  const presence = presenceLine(member, now);
  const presenceEchoesLine = presence.toLowerCase() === line.toLowerCase();
  // A quote is only worth quoting when it reads like a sentence the agent
  // wrote, not a bare status token.
  const quote =
    fleet?.topStatus && fleet.topStatus.trim().split(/\s+/).length >= 3
      ? fleet.topStatus.trim()
      : null;
  const cap = (n: number) => (n > 20 ? "20+" : String(n));

  // The huddle gesture is shared with the people window's roster rows
  // (components/presence/useMemberHuddle), so the two surfaces cannot drift
  // into two answers for the same door.
  const huddle = useMemberHuddle(member, currentUserId, liveRoom, displayName);
  const memberId = String(member._id);

  // Where they are: the session they have open, by the same rule the
  // palette's Teammates group uses (teammateWhereabouts), so the two surfaces
  // cannot disagree about who is followable. Opened through the app's one
  // session path (useOpenSession), which fetches a row the store lacks; the
  // title is read the same way for the line, and only the title is
  // subscribed, never the row (a teammate's session streams).
  const where = useMemo(
    () => teammateWhereabouts([member], currentUserId, "")[0]?.conversationId ?? null,
    [member, currentUserId],
  );
  const openSession = useOpenSession();
  const storedWhereTitle = useInboxStore((s) => (where ? s.sessions[where]?.title : undefined));
  const whereInStore = useInboxStore((s) => !!(where && s.sessions[where]));
  const fetchedWhere = useMissingSessionRow(where && !whereInStore ? where : null);
  const whereTitle = storedWhereTitle ?? fetchedWhere?.title;
  const followingThem = useInboxStore((s) => s.followLeaderId === memberId);

  // Local-first: the store action flips the roster row in the same tick (the
  // pill must not wait on a server round-trip) and dispatches the
  // authoritative updateProfile through the outbox.
  const setStatus = (status: "available" | "busy" | "away") => {
    useInboxStore.getState().setMyStatus(status);
  };

  // Edge-aware anchoring: a 280px card anchored right-of-face clips off
  // screen when the bar sits near the left edge (it did). Measure once on
  // mount and flip.
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [alignLeft, setAlignLeft] = useState(false);
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.left < 8) setAlignLeft(true);
    else if (r.right > window.innerWidth - 8) setAlignLeft(false);
  }, []);

  return (
    // pt-2 bridge, not mt-2 gap: the pointer never leaves the hover scope on
    // the way from the face into the card.
    <div
      ref={cardRef}
      className={`absolute top-full z-[80] cursor-default pt-2 ${alignLeft ? "left-0" : "right-0"}`}
    >
      <div className="w-[280px] rounded-lg border border-sol-border bg-sol-bg-alt p-3 text-left shadow-xl motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-1 motion-safe:duration-150">
        {/* The whole identity block is the door to the profile: one large
            target instead of a name-sized hot zone that read as a label. The
            chevron is always there saying "this goes somewhere"; hovering
            highlights the row and names the destination. */}
        <button
          type="button"
          onClick={onOpenProfile}
          title="Open profile"
          className="group -m-1.5 flex w-[calc(100%+0.75rem)] items-start gap-2.5 rounded-md p-1.5 text-left transition-colors hover:bg-sol-bg-highlight/70"
        >
          <MemberFace member={member} size={36} title="" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-sol-text transition-colors group-hover:text-sol-cyan">
              {displayName}
              {isSelf && <span className="ml-1.5 text-[10px] font-normal text-sol-text-dim">you</span>}
            </div>
            {/* What they are DOING leads; the presence fact and their clock
                follow it, smaller. That order is the whole complaint: status
                was legible only to someone who knew the color code, and the
                activity was not on the card at all.

                With nothing to report the activity line IS the presence line
                ("active now"), so the second row drops to the clock alone
                rather than saying it twice. */}
            <div className={`mt-0.5 line-clamp-2 text-[12px] leading-snug ${meta.text}`} title={line}>
              {line}
            </div>
            {(!presenceEchoesLine || time) && (
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-sol-text-dim">
                {!presenceEchoesLine && <span>{presence}</span>}
                {time && <span>{presenceEchoesLine ? time : `· ${time}`}</span>}
              </div>
            )}
          </div>
          {/* Chevron only: a text label here reserved width and truncated
              real names. The name's cyan shift + this slide say "profile". */}
          <ChevronRight className="h-3.5 w-3.5 shrink-0 self-center text-sol-text-dim transition-all group-hover:translate-x-0.5 group-hover:text-sol-cyan" />
        </button>

        {/* Follow them: this window mirrors theirs (route, session, place in
            the transcript) until you move on your own or stop. The session
            they have open, if any, opens at once so the follow starts where
            they are instead of a beat later. */}
        {!isSelf && (where || followingThem) && (
          <button
            type="button"
            data-sv-follow-button={followingThem ? "unfollow" : "follow"}
            onClick={() => {
              const st = useInboxStore.getState();
              if (followingThem) {
                st.setFollowLeader(null);
                return;
              }
              st.setFollowLeader(memberId);
              if (where) openSession(where);
            }}
            title={followingThem ? "Stop following" : "Follow them: your view mirrors theirs until you move"}
            className={`group mt-2.5 flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors ${
              followingThem ? "border-sol-cyan/60 bg-sol-cyan/15 hover:bg-sol-cyan/20" : "border-sol-cyan/25 bg-sol-cyan/[0.07] hover:bg-sol-cyan/15"
            }`}
          >
            <ArrowRight className="h-3.5 w-3.5 shrink-0 text-sol-cyan transition-transform group-hover:translate-x-0.5" />
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] font-medium text-sol-cyan">{followingThem ? "Stop following" : "Follow"}</span>
              <span className="block truncate text-[11px] text-sol-text-dim">
                {where ? (whereTitle ? cleanTitle(whereTitle) : fetchedWhere === null ? "a session that no longer opens" : "a session") : "around, not in a session"}
              </span>
            </span>
          </button>
        )}

        {fleet && (fleet.working > 0 || fleet.needsYou > 0) && (
          <div className="mt-2.5 border-t border-sol-border/60 pt-2">
            <div className="flex items-center gap-3 text-[11px]">
              {fleet.working > 0 && (
                <span className="flex items-center gap-1 text-sol-text-muted">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-sol-cyan" />
                  {cap(fleet.working)} working
                </span>
              )}
              {fleet.needsYou > 0 && (
                <span className="flex items-center gap-1 text-sol-yellow">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-sol-yellow" />
                  {cap(fleet.needsYou)} need{fleet.needsYou === 1 ? "s" : ""} input
                </span>
              )}
            </div>
            {quote && (
              <div className="mt-1 truncate text-[11px] italic text-sol-text-dim" title={quote}>
                “{quote}”
              </div>
            )}
          </div>
        )}

        <div className="mt-2.5 flex gap-1.5 border-t border-sol-border/60 pt-2">
          {isSelf ? (
            // Your own card is the status switch: the one action that makes
            // sense on yourself.
            (["available", "busy", "away"] as const).map((st) => (
              <button
                key={st}
                onClick={() => setStatus(st)}
                className={`flex-1 rounded px-1.5 py-1 text-[11px] capitalize transition-colors ${
                  (member.status ?? "available") === st
                    ? st === "busy"
                      ? "bg-sol-red/15 text-sol-red"
                      : st === "away"
                        ? "bg-sol-bg-highlight text-sol-text"
                        : "bg-sol-cyan/15 text-sol-cyan"
                    : "text-sol-text-dim hover:bg-sol-bg-highlight hover:text-sol-text"
                }`}
              >
                {st}
              </button>
            ))
          ) : (
            <>
              {callsEnabled && (
                <button
                  type="button"
                  onClick={huddle.go}
                  disabled={huddle.waiting}
                  title={huddle.title}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] font-medium transition-colors ${
                    huddle.waiting
                      ? "cursor-default border border-sol-border/50 text-sol-text-dim"
                      : "bg-sol-violet/15 text-sol-violet hover:bg-sol-violet/25"
                  }`}
                >
                  <Headphones className="h-3.5 w-3.5" />
                  {huddle.label}
                </button>
              )}
              <button
                onClick={onOpenChat}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-sol-bg-highlight px-2 py-1.5 text-[12px] text-sol-text-muted transition-colors hover:text-sol-text"
              >
                <MessageSquare className="h-3.5 w-3.5" />
                Message
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
