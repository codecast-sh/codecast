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
  // A call is up: a room I hold on purpose (the card offers Mute only then)
  // or somebody just stepped in. A burst is not a call and gets no stage.
  const inCall = (row.card.kind === "live" && row.card.mute) || row.card.kind === "joined-notice";

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
      onContextMenu={(e) => {
        const seat = ((e.target as Element | null)?.closest?.("[data-face-id]") as HTMLElement | null) ?? null;
        const face = seat && row.entries.find((f) => f.id === seat.dataset.faceId);
        if (!face) return;
        const member = useInboxStore.getState().teamMembers.find((m: any) => String(m?._id) === face.id);
        ctxMenu.open(e, { id: face.id, username: member?.github_username, displayName: face.name });
      }}
    >
      <TeamMembersPump teamId={effectiveTeamId} />
      <FaceRow row={shown} density="bar" viewerId={viewerId} callsEnabled={callsEnabled}>
        <EngagementCard card={row.card} density="bar" />
      </FaceRow>
      {/* THE DOOR TO THE STAGE. The card under the row carries the two
          controls a call needs mid-work; the full stage (video, screen share,
          transcript) opens only when asked. On the desktop the call already
          has a window, so this raises it, or gives it one. */}
      {inCall && (
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
