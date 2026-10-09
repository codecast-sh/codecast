import { BAR_FACES } from "../lib/faces/layout";
import { useCallsAvailable } from "../lib/teamFeatures";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useRef } from "react";
import { toast } from "sonner";
import { UserRound, Filter, Link2, Headphones, PanelTop, PictureInPicture2 } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { useSyncTeamMembers } from "../hooks/useSyncTeamMembers";
import { useFaceRow } from "../hooks/useFaceRow";
import { copyToClipboard, shareOrigin } from "../lib/utils";
import { DOCK_FACES_TITLE, POP_OUT_PEOPLE_TITLE, useFacesFloating } from "../lib/desktop";
import { ContextMenu, useContextMenu, CtxItem, CtxHeader } from "./ui/context-menu";
import { memberDisplayName } from "./presence/memberPresence";
import { popOutPeople } from "./people/popOutPeople";
import { FaceRow } from "./faces/FaceRow";
import { EngagementCard } from "./faces/EngagementCard";
import { isCallCard } from "../lib/faces/faceRow";
import { CallCardAccessories } from "./calls/CallCardAccessories";
import { ShortcutTooltip } from "./KeyboardShortcutsHelp";
import { TopbarButton } from "./TopbarButton";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { peopleOf } from "@codecast/shared/team/memberKind";
import { objectHref, personRefOf } from "../lib/entityLinks";
import { FaceChatLayer } from "./faces/FaceChatLayer";
import { useFaceChatActive } from "../lib/chat/faceChat";

interface TeamAvatarBarProps {
  teamId?: Id<"teams">;
}

// Data pump, isolated so the live query's push rate never re-renders the
// visible bar: getTeamMembers re-emits every few seconds (teammates' presence
// heartbeats), and a useQuery in the display component re-rendered the whole
// avatar row on each push. The pump renders nothing; the bar below reads the
// store through the face row, whose identity only changes when something a
// face draws changed.
export function TeamMembersPump({ teamId }: { teamId: Id<"teams"> | undefined }) {
  useSyncTeamMembers(teamId);
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
  const rosterCount = useInboxStore((s) => peopleOf(s.teamMembers).length);
  const callsEnabled = useCallsAvailable();
  // THE ROW. One subscription, signature gated: a heartbeat, a level tick or
  // a mute that moves no face hands back the same row and this bar sleeps.
  const row = useFaceRow();
  const floating = useFacesFloating();
  const ctxMenu = useContextMenu<{ id: string; profileHref: string; displayName: string }>();

  const barRef = useRef<HTMLDivElement | null>(null);
  // Whoever is talking in chat right now, or holds a count, keeps a seat.
  const chatActive = useFaceChatActive();

  // The header's slice of the row: me and the linked faces first (the model
  // puts them at the head), then the rest by presence, up to the cap. Agents
  // are off the header for now (people only); a teammate speaking in chat is
  // pulled into the last seats so their line can drop from their face.
  const people = useMemo(() => row.entries.filter((e) => !e.bot || row.links.some((l) => l.to === e.id)), [row]);
  const shown = useMemo(() => {
    if (people.length <= BAR_FACES) return people === row.entries ? row : { ...row, entries: people };
    const head = people.slice(0, BAR_FACES);
    const want = chatActive ? chatActive.split(",") : [];
    const pulled = people.filter((e, i) => i >= BAR_FACES && want.includes(e.id)).slice(0, BAR_FACES - 1);
    if (!pulled.length) return { ...row, entries: head };
    // Make room from the end of the slice, never taking a linked face or me.
    const keep = [...head];
    for (const p of pulled) {
      const at = keep.findLastIndex((e) => !e.me && !want.includes(e.id) && !row.links.some((l) => l.to === e.id));
      if (at < 0) break;
      keep.splice(at, 1);
      keep.push(p);
    }
    return { ...row, entries: keep };
  }, [row, people, chatActive]);
  const hidden = people.length - shown.entries.length;
  // Something is happening on the row: an engagement, a ring, a voice. The
  // minimal style hides the bar otherwise (globals.css).
  const live = !!row.me || row.links.length > 0;
  const inCall = isCallCard(row.card);

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

  // The row is floating over the work: one chip, and the pump. The chip
  // says what a click does, in the same verb the float's own button uses.
  if (floating.floating) {
    return (
      <div className="people-bar flex items-center gap-1 px-2" data-floating="1">
        <TeamMembersPump teamId={effectiveTeamId} />
        <button
          type="button"
          data-dock-faces
          onClick={() => floating.setFloating(false)}
          className="flex h-7 items-center gap-1.5 rounded-full border border-sol-cyan/40 bg-sol-cyan/10 px-2.5 text-[11px] text-sol-cyan transition-colors hover:bg-sol-cyan/20"
          title={DOCK_FACES_TITLE}
        >
          <PanelTop className="h-3.5 w-3.5" />
          Dock faces
        </button>
      </div>
    );
  }

  return (
    <div
      ref={barRef}
      className="people-bar flex items-center gap-1 px-2"
      data-live={live ? "1" : undefined}
      onContextMenu={(e) => {
        const seat = ((e.target as Element | null)?.closest?.("[data-face-id]") as HTMLElement | null) ?? null;
        const face = seat && row.entries.find((f) => f.id === seat.dataset.faceId);
        if (!face) return;
        const member = useInboxStore.getState().teamMembers.find((m: any) => String(m?._id) === face.id);
        ctxMenu.open(e, { id: face.id, profileHref: objectHref("person", personRefOf({ _id: face.id, github_username: member?.github_username })), displayName: face.name });
      }}
    >
      <TeamMembersPump teamId={effectiveTeamId} />
      <FaceChatLayer barRef={barRef} />
      <FaceRow
        row={shown}
        density="bar"
        viewerId={viewerId}
        callsEnabled={callsEnabled}
        onOpenProfile={(m) => router.push(objectHref("person", personRefOf(m)))}
      >
        {/* EXPAND rides the call's own card, beside the mic and End: it
            acts on the call, so it sits in the call. Pop out (below, at the
            row's end) moves the whole row; expand opens the call's stage. */}
        <EngagementCard
          card={row.card}
          density="bar"
          accessory={inCall && <CallCardAccessories />}
        />
      </FaceRow>
      {/* The faces that did not fit, counted right after the ones that did:
          the count belongs to the roster, not to the controls after it. On a
          team of 23 it sat past the huddle and the pop out buttons, two
          controls away from the people it counts. It keeps the row's own
          rhythm (6px, the face gap: the bar's 4px and 2px of its own); the
          controls after the roster are top bar buttons, 2px apart. */}
      {hidden > 0 && (
        <ShortcutTooltip label={`${hidden} more team members`}>
          <button
            onClick={() => router.push("/team/activity?filter=team")}
            data-overflow
            className="ml-0.5 flex h-7 min-w-7 px-1.5 items-center justify-center rounded-full border border-sol-border/60 text-[11px] tabular-nums text-sol-text-muted transition-colors hover:border-sol-border hover:text-sol-text"
          >
            +{hidden}
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
          <TopbarButton
            onClick={() => useInboxStore.getState().openCreateModal("huddle")}
            className="ml-1"
            aria-label="Start a huddle with several teammates"
          >
            <Headphones />
          </TopbarButton>
        </ShortcutTooltip>
      )}
      {/* POP OUT. The same row, floating over the work in the shell's
          see-through window; the header keeps a chip while it is out. Off
          the desktop the buddy list window is the nearest thing. */}
      <ShortcutTooltip label={POP_OUT_PEOPLE_TITLE}>
        <TopbarButton
          data-pop-out
          className="ml-1 hidden xl:flex"
          onClick={() => (floating.available ? floating.setFloating(true) : void popOutPeople())}
          aria-label={POP_OUT_PEOPLE_TITLE}
        >
          <PictureInPicture2 />
        </TopbarButton>
      </ShortcutTooltip>
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
            <CtxItem icon={UserRound} onSelect={() => router.push(m.profileHref)}>
              Open profile
            </CtxItem>
            <CtxItem icon={Filter} onSelect={() => handleMemberClick(m.id)}>
              Filter activity by member
            </CtxItem>
            <CtxItem
              icon={Link2}
              onSelect={() => {
                copyToClipboard(`${shareOrigin()}${m.profileHref}`);
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
