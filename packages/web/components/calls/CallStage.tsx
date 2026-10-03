import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import {
  AppWindow,
  ChevronDown,
  Circle,
  CircleUserRound,
  ExternalLink,
  Link2,
  Lock,
  MessageSquare,
  Minimize2,
  MonitorUp,
  Radio,
  Unlock,
  Users,
  Video,
  VideoOff,
  X,
} from "lucide-react";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import {
  getCallTiles,
  getRoom,
  setCamera,
  setScreenShare,
  subscribeCallTiles,
  type ParticipantTile } from "../../lib/calls/callManager";
import { parseRoomKey } from "@codecast/shared/contracts";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useRoomTranscribeOff } from "../../hooks/useRoomTranscribeOff";
import { getScribeStatus, subscribeScribe } from "../../lib/calls/transcription";
import { TranscribeControls } from "./TranscribePanel";
import { RecordButton, RecordingNoticeBanner, StageRecordingBadge } from "./RoomRecording";
import { AddPeopleButton } from "./AddPeople";
import { RoomKnocks } from "./RoomDoor";
import { HangUpButton, MicButton } from "./CallControls";
import { RoomThread, SegmentedRadio, type RoomThreadCall } from "./RoomThread";
import { Avatar } from "./Avatar";
export { Avatar };
import type { ThreadRow } from "./roomThreadModel";
import { DeviceChips } from "./DeviceRows";
import { faceTrackingNote } from "./useFaceCrop";
import { PersonName } from "./GuestTag";
import { FollowChip } from "./FollowInCall";
import { AutoStage, GridStage, SpeakerStage } from "./StageViews";
import { STAGE_CTL, STAGE_CTL_IDLE, STAGE_VIEWS, StageHostProvider, type StageHost, type StageView } from "./stageHost";
import { GuestInvite, GuestRemoveButton } from "./GuestDoor";
import { guestsJoining, guestsSig, rosterWithGuests, withGuestMedia } from "../../lib/calls/roomGuests";
import { walkieCallState } from "../../lib/calls/walkie";
import { useOutgoingRings, useRoomDescription } from "../../hooks/useCallRoom";
import { useRoomLock } from "../../hooks/useLiveRooms";
import {
  POP_OUT_CALL_TITLE,
  SMALL_CALL_WINDOW_SIZES,
  attachTitlebarHead,
  canPopOutCall,
  canResizeCallWindow,
  closeCallPanel,
  navigateMainWindow,
  type CallWindowSize,
  type DesktopDisplaySource,
  type SmallCallWindowSize,
} from "../../lib/desktop";
import { popOutCall } from "../../lib/calls/popOutCall";
import { useOsPermissions } from "../../hooks/useOsPermissions";
import { permissionActionLabel, requestOsPermission, type AppPermissionKind } from "../../lib/osPermissions";
import { LivePulseDot } from "../SessionActivityLine";
import { prefersReducedMotion } from "../../hooks/useBottomAnchoredList";
import { useAgentsInRoom } from "./useCallFeed";
import { useRoomThreadUnread } from "../../hooks/useRoomThreadUnread";
import { EdgeResizeHandle, useEdgeResize } from "../../hooks/useEdgeResize";
import { UnreadCount } from "./UnreadCount";
import { AgentReplyPeek } from "./AgentReplyPeek";
import { takeCallThreadRequest } from "../../lib/calls/callStage";

// The media notice, with the fix in reach: when the error is a device the OS
// refused, the button is the one gesture that changes that (the OS prompt,
// or System Settings). No button when the OS says it's granted — then the
// trouble is the device itself, and the sentence already says so.
function CallErrorNotice({ error, fix }: { error: string; fix: AppPermissionKind | null }) {
  const { permissions, refresh } = useOsPermissions();
  const readiness = fix ? permissions[fix] : null;
  const action = fix && readiness ? permissionActionLabel(readiness) : null;
  return (
    <div className="mx-auto mt-2 flex max-w-lg items-center gap-2 rounded-full bg-sol-orange/10 px-3.5 py-1.5 text-[12px] text-sol-orange">
      {/* One line, however long the sentence: the notice sits over the stage
          until dismissed, and a 380px window cannot spare a second row. The
          whole sentence is in the title. */}
      <span className="min-w-0 flex-1 truncate" title={error}>
        {error}
      </span>
      {fix && readiness && action && (
        <button
          onClick={() => requestOsPermission(fix, readiness).then(refresh)}
          className="shrink-0 rounded-full bg-sol-orange/20 px-2 py-0.5 font-medium transition-colors hover:bg-sol-orange/30"
        >
          {action}
        </button>
      )}
      <button
        onClick={() => useInboxStore.getState().setCallState({ error: null, errorFix: null })}
        className="shrink-0 rounded-full p-0.5 text-sol-orange/70 transition-colors hover:bg-sol-orange/15 hover:text-sol-orange"
        title="Dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// The call stage: the full surface a huddle opens into when video or a screen
// share deserves the room. Design intents, in order:
//
//   1. THE SCREEN IS THE HERO — in the default (auto) view an active share
//      owns the stage and faces retreat to a filmstrip. The viewer can
//      override: SPEAKER view follows (or pins) one face, GRID gives everyone
//      an equal tile.
//   2. FACES ADAPT, CHROME DISAPPEARS. Names render readably on every tile;
//      controls live on one bottom bar; every glyph has a title.
//   3. THE ROOM HAS ONE THREAD. The thread rail holds what was said (folded
//      into passages), what was typed, what an agent answered and who came
//      and went, and it owns the way to add an agent (which starts
//      transcription by itself, no separate toggle first). Captions flow
//      along the stage bottom for everyone while the rail is closed; the
//      header links out to the durable call page.
//
// The stage is an overlay, not a route: Esc (or collapse) drops back to the
// ambient pill and the call continues beside the work.
// What a member's stage adds to the shared views (StageViews): the room the
// cursors ride on is the call manager's, following somebody opens their work
// in the app, and a guest can be put out from beside their name (of the room
// the stage is drawing, which the host is made for: memberStageHost).
const MEMBER_STAGE_HOST: StageHost = {
  getRoom,
  FollowChip,
  useFollowLeader: () => useInboxStore((s) => s.followLeaderId),
};
function memberStageHost(roomKey: string | null): StageHost {
  if (!roomKey) return MEMBER_STAGE_HOST;
  return {
    ...MEMBER_STAGE_HOST,
    personActions: ({ identity, name, variant }) => <GuestRemoveButton roomKey={roomKey} identity={identity} name={name} variant={variant} />,
  };
}


/**
 * How each of the window's small sizes reads on the stage's chrome, on the
 * older shell's per call window (LegacyCallPanel). A voice host has one small
 * shape, the float, and shrinks with one button (`onShrink`); these three
 * would all land there, promising three pictures and drawing one.
 *
 * Keyed by the sizes themselves (`SMALL_CALL_WINDOW_SIZES`, which is the
 * shell's own list) so a new size without a button is a type error rather than
 * a shape nobody can reach. Each shrinks this same window — the media stays
 * put, so going from the stage to a circle is not asking for your audio to be
 * re-established.
 */
const SMALL_SIZE_CHROME: Record<
  SmallCallWindowSize,
  { icon: typeof Users; label: string; hint: string }
> = {
  circles: { icon: Users, label: "All faces", hint: "Float everyone on the call as circles over your work" },
  speaker: { icon: CircleUserRound, label: "Who's talking", hint: "Float one circle over your work: whoever is talking" },
  tiny: { icon: Circle, label: "Tiny", hint: "One tiny circle, the size of a menu bar icon" },
};

/**
 * The huddle, full bleed.
 *
 * Two shapes, one component. In the app it is an OVERLAY over the work
 * (`fixed inset-0`, portaled to the body) that the collapse button and Esc put
 * away. In `panel` mode it is the whole contents of a window of its own — the
 * desktop call panel — and there is nothing to collapse INTO, so the ways out
 * change rather than the stage: no collapse button, no Esc, and the two links
 * that leave the huddle (its session, its call page) open in the MAIN window
 * instead of navigating this one. A satellite window is a place you stand, not
 * a place you browse; a call panel that browsed away from its own call would
 * take the microphone with it.
 */
export function CallStage({
  onCollapse,
  panel = false,
  onSetSize,
  onShrink,
  onHide,
}: {
  onCollapse?: () => void;
  panel?: boolean;
  /** Panel only, older shell: shrink the window to a row of circles, or to one. */
  onSetSize?: (size: CallWindowSize) => void;
  /** Panel only, voice host: shrink the window to the float, its one small
   *  shape. One button, because one shape. */
  onShrink?: () => void;
  /** Panel only: put the call away. The voice host keeps the call and shows
   *  the team (or nothing) instead; without this the shell hides the window. */
  onHide?: () => void;
}) {
  // Memoized because it feeds an effect's dependency list: a fresh no-op every
  // render would re-bind the key listener on every render.
  const collapse = useMemo(() => onCollapse ?? (() => {}), [onCollapse]);
  const s = useTrackedStore([
    (st: any) => st.call,
    (st: any) => (st.call.roomKey ? st.callOccupancy[st.call.roomKey] : undefined),
    // The room's guests by signature: liveRooms is rewritten whole on every
    // push, and only who is in (and their names) paints here.
    (st: any) => guestsSig(st.liveRooms?.find((r: any) => r.room_key === st.call.roomKey)?.guests),
  ]);
  const call = s.call;
  const seats: any[] = (call.roomKey && s.callOccupancy[call.roomKey]) || [];
  const guestKey = guestsSig(s.liveRooms?.find((r: any) => r.room_key === call.roomKey)?.guests);
  // Seats, then the guests let in on a link: a guest has no seat, and a guest
  // with no camera was nobody on the stage without them (lib/calls/roomGuests).
  const listed: any[] = useMemo(
    () => rosterWithGuests(seats, s.liveRooms?.find((r: any) => r.room_key === call.roomKey)?.guests),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [seats, guestKey, call.roomKey],
  );
  const myUserId = useInboxStore((st: any) => st.currentUser?._id?.toString?.() ?? null);
  const tiles = useSyncExternalStore(subscribeCallTiles, getCallTiles, () => []);
  // ...as the media has them once connected: a guest who cannot be heard is
  // not drawn as here, and a guest's microphone shows (roomGuests). The list
  // is the voice host's (mirrored on desktop) and moves with the tiles.
  const guestMedia = call.phase === "connected" ? walkieCallState().guests : null;
  const roster: any[] = useMemo(() => withGuestMedia(listed, guestMedia), [listed, guestMedia]);
  const speaking = useMemo(() => new Set<string>(call.speaking), [call.speaking]);

  // The live transcript, if anyone is scribing: id (for the call-page link),
  // routes (the feed chips), caption tail (captions for non-scribes too).
  const live = useQueryNoThrow(
    api.transcripts.getLive,
    call.roomKey ? { room_key: call.roomKey, tail: 8 } : "skip",
  ).data as
    | {
        transcript_id: string;
        started_at: number;
        team_id: string;
        routes: Array<{ kind: string; target: string; mode: string; added_by: string }>;
        tail: Array<{ seq: number; speaker_name: string; text: string; at: number }>;
      }
    | null
    | undefined;
  // The record outlives a switch to off (off is a gap in the huddle), so the
  // words are flowing only while it is live and the room has not opted out.
  // The hook is read before the test, never behind it: short circuited, it
  // ran only once the record answered, and the hook count changing between
  // renders crashed the whole stage.
  const transcribeOff = useRoomTranscribeOff(call.roomKey);
  const stageHost = useMemo(() => memberStageHost(call.roomKey), [call.roomKey]);
  const transcribing = !!live && !transcribeOff;

  const [view, setView] = useState<StageView>("auto");
  const [threadOpen, setThreadOpen] = useState(takeCallThreadRequest);
  // The rail leaves with motion: it stays mounted through a 150ms exit and
  // goes on the animation's end. Exits are shorter than entrances (200ms in).
  const [railClosing, setRailClosing] = useState(false);
  // The thread's rows, read here so the header can count what arrived while
  // the rail was closed (lib/calls/roomThreadSeen: the same count the door to
  // the call in the app header wears when this stage is collapsed).
  const { rows, unread, latest } = useRoomThreadUnread(call.roomKey, threadOpen);
  const toggleThread = () => {
    if (threadOpen && !prefersReducedMotion()) setRailClosing(true);
    setThreadOpen((o) => !o);
  };
  // The agents in the room, for the button: while the rail is closed, the
  // state a person waits on most is "an agent is answering".
  const agentWorking = useAgentsInRoom(live?.routes ?? []).some((a) => a.working);
  const [pinned, setPinned] = useState<string | null>(null);
  // The face SPEAKER view follows when nothing is pinned: whoever spoke last.
  const [lastSpeaker, setLastSpeaker] = useState<string | null>(null);
  useWatchEffect(() => {
    const first = call.speaking?.[0];
    if (first) setLastSpeaker(String(first));
  }, [call.speaking]);

  useWatchEffect(() => {
    // In the panel there is nothing behind the stage for Esc to reveal, and a
    // key that closed the window would end a call by accident.
    if (panel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Typing in the thread composer: Esc leaves the field, not the stage.
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) return el.blur();
      collapse();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [collapse, panel]);

  const screens = tiles.filter((t) => t.kind === "screen");
  const cameras = tiles.filter((t) => t.kind === "camera");

  const parsed = call.roomKey ? parseRoomKey(call.roomKey) : null;
  const { label } = useRoomDescription(call.roomKey);
  const { ringing, settledLine } = useOutgoingRings(call.roomKey);
  // On their way in: the teammates being rung, and the guests let in who
  // have not connected yet (roomGuests.guestsJoining), so an Admit shows on
  // the stage at once rather than only when the guest's media arrives.
  const arriving = useMemo(
    () => [
      ...ringing,
      ...guestsJoining(listed, guestMedia).map((g: any) => ({ user_id: String(g.user_id), user_name: g.user_name ?? "Guest", note: "joining…" })),
    ],
    [ringing, listed, guestMedia],
  );
  const lock = useRoomLock(call.roomKey);

  // In the panel this header row IS the window's titlebar: it is what you drag
  // the window by, and `.electron-drag-region` is also what marks every button
  // inside it no-drag, so the controls still take their clicks.
  //
  // The window has no traffic lights to indent past — it is frameless, and the
  // close button on this row is its own. An OLDER desktop build still frames
  // this window, though, and there the row has to measure itself into the
  // titlebar the way every other window's top row does, or it paints under the
  // lights. `canResizeCallWindow` is the honest test for which build this is:
  // the sizes and the frameless window shipped together.
  const chromeless = panel && canResizeCallWindow();
  const headRef = useRef<HTMLDivElement | null>(null);
  useWatchEffect(() => {
    const el = headRef.current;
    if (!panel || !el) return;
    if (!chromeless) return attachTitlebarHead(el);
    el.classList.add("electron-drag-region");
    return () => el.classList.remove("electron-drag-region");
  }, [panel, chromeless]);

  // Portaled to <body>: the dock mounts inside the app shell, whose
  // transformed ancestors would otherwise capture this fixed overlay (the
  // classic fixed-under-transform trap) and leave the header painted on top.
  //
  // The stage is always dark — video wants a dark room — so it carries the
  // `dark` class itself: every sol-* token inside resolves to the dark
  // palette whatever theme the app is in. Without it, light mode paints
  // --sol-text (#002b36) on a #002b36 stage and every label disappears.
  return createPortal(
    <div
      className={`call-stage dark fixed inset-0 z-[200] flex flex-col select-none bg-sol-base03 text-sol-text${
        // The window is see-through and frameless, so the stage's own surface
        // is the only surface there is: a rounded card, clipped so the video
        // inside it does not square off the corners — and EDGED, because the
        // card sits over the app's own dark surfaces and without a line the
        // eye cannot tell where the window stops.
        chromeless
          ? " overflow-hidden rounded-xl border border-white/[0.13] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
          : ""
      }`}
    >
      {/* Header: four groups on one line, thin rules between them. WHERE this
          is (the room, its links, its door); HOW it is seen (the view, as one
          segmented control); WHAT ELSE is open (the rails); and the WINDOW's
          own controls (shrink, hide). Nothing else earns a place here.
          The stage is a container (`.call-stage`, callSurface.css): as it
          narrows, the words beside the icons go first (`.stage-word` under
          760px, `.stage-word-tight` under 640px) and the title's "huddle · "
          with them, so the room's name is what survives truncation. The left
          group clips: nothing in it may ever paint under the view control. */}
      <div ref={headRef} className="flex h-11 shrink-0 items-center gap-1 border-b border-white/[0.06] px-3">
        <div className="flex min-w-0 shrink items-center gap-0.5 overflow-hidden">
          <span className="min-w-0 truncate px-1 font-mono text-[12.5px] text-sol-text-secondary">
            {parsed?.kind === "session" && <span className="stage-word">huddle · </span>}
            {label}
          </span>
          {roster.length > 0 && (
            <span className="shrink-0 rounded-full bg-white/[0.06] px-1.5 py-px font-mono text-[10.5px] text-sol-text-muted">
              {roster.length}
            </span>
          )}
          {/* The room is being recorded: said where the room's name is, for
              everyone in it, whoever pressed. */}
          <StageRecordingBadge roomKey={call.roomKey} />
          {parsed?.kind === "session" && (
            <StageChromeButton
              onClick={() => {
                if (panel) return void navigateMainWindow(`/conversation/${parsed.conversationId}`);
                useInboxStore.getState().navigateToSession(parsed.conversationId);
                collapse();
              }}
              title="Open the session this huddle is about"
              aria-label="Open the session this huddle is about"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </StageChromeButton>
          )}
          {live &&
            (panel ? (
              <StageChromeButton
                onClick={() => void navigateMainWindow(`/calls/${live.transcript_id}`)}
                className="text-sol-green hover:bg-sol-green/10 hover:text-sol-green"
                title="Open the call page in the main window: the whole thread and the summary"
                aria-label="Open the call page"
              >
                <Radio className="h-3.5 w-3.5" />
              </StageChromeButton>
            ) : (
              <Link
                href={`/calls/${live.transcript_id}`}
                onClick={collapse}
                className={`${CHROME_BTN} text-sol-green hover:bg-sol-green/10 hover:text-sol-green`}
                title="Open the call page: the whole thread and the summary"
                aria-label="Open the call page"
              >
                <Radio className="h-3.5 w-3.5" />
              </Link>
            ))}
          {/* The door. An open huddle is the default — any teammate can walk
              in — so the lock is the exception, and it reads as one: lit
              violet while the room is closed, quiet chrome while it is open. */}
          <StageChromeButton onClick={lock.toggle} active={lock.locked} accent="violet" title={lock.title}>
            {lock.locked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
            <span className="stage-word">{lock.locked ? "locked" : "open"}</span>
          </StageChromeButton>
          {/* The door for somebody with no account: a link they open in a
              browser. Beside the lock, because both decide who gets in. */}
          {call.roomKey && call.phase === "connected" && (
            <GuestInvite
              roomKey={call.roomKey}
              trigger={({ open, toggle }) => (
                <StageChromeButton
                  onClick={toggle}
                  active={open}
                  accent="yellow"
                  title="Invite someone outside the team: a link they join from in a browser"
                  aria-label="Invite someone outside the team"
                  aria-expanded={open}
                >
                  <Link2 className="h-3.5 w-3.5" />
                  <span className="stage-word">invite</span>
                </StageChromeButton>
              )}
            />
          )}
        </div>
        <div className="min-w-2 flex-1" />

        {/* The view: one control with three positions, the live one raised. */}
        <SegmentedRadio label="View" options={STAGE_VIEWS} value={view} onChange={setView} labels iconClass="h-3.5 w-3.5" className="shrink-0" />

        <HeaderRule />

        {/* The thread: the one rail beside the stage. Not the transcription
            switch: the dot says the room is being transcribed whether or not
            the rail is open, and the switch itself lives in the thread. The
            count is what landed in the thread while it was closed. */}
        {/* The thread button carries the peek: an agent's answer that
            landed while the rail was closed hangs under it for a moment. */}
        <span className="relative shrink-0">
        <StageChromeButton
          onClick={toggleThread}
          active={threadOpen}
          accent="cyan"
          aria-label={
            (unread > 0 ? `Open the thread, ${unread} new line${unread === 1 ? "" : "s"}` : threadOpen ? "Close the thread" : "Open the thread") +
            (!threadOpen && agentWorking ? ", an agent is working" : "")
          }
          title={
            transcribing
              ? "Transcribing. Open the thread: the words, the chat, the agents in the room."
              : "Open the thread: chat with the room, add an agent, start transcribing."
          }
        >
          <span className="relative">
            <MessageSquare className="h-3.5 w-3.5" />
            {transcribing && <LivePulseDot className="absolute -right-1 -top-1 h-1.5 w-1.5" />}
          </span>
          <span className="stage-word-tight">thread</span>
          {!threadOpen && agentWorking && (
            <span className="ch-typing-dots text-sol-violet" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          )}
          <UnreadCount count={unread} agent={!!latest?.agent} />
        </StageChromeButton>
        <AgentReplyPeek row={latest} onOpen={() => !threadOpen && toggleThread()} />
        </span>

        <HeaderRule />

        {/* Give the call a window of its own. Desktop only, and deliberately
            absent in a browser rather than degraded: the ladder behind this
            has no browser rung, because a call in a Chrome popup is the bug
            this panel exists to make impossible. */}
        {canPopOutCall() && (
          <StageChromeButton onClick={() => void popOutCall()} title={POP_OUT_CALL_TITLE}>
            <AppWindow className="h-3.5 w-3.5" />
            <span className="stage-word-tight">pop out</span>
          </StageChromeButton>
        )}
        {/* The voice host's one small shape: the face row floating over the
            work. The window keeps its media across the change — that is why
            it is a shape and not a window — so this is only a reshape. */}
        {panel && onShrink && (
          <StageChromeButton onClick={onShrink} title="Shrink this window to the faces floating over your work. The call keeps going">
            <Minimize2 className="h-3.5 w-3.5" />
            shrink
          </StageChromeButton>
        )}
        {/* The older shell's small sizes of this same window, behind one
            control: everybody as a row of circles, one circle of whoever is
            talking, or that circle the size of a menu bar icon. */}
        {panel && onSetSize && <ShrinkMenu onSetSize={onSetSize} />}
        {/* The window's own close. There is no traffic light to do it. Hide,
            like the palette: the huddle stays in this window. Hang-up is the
            red button on the control bar below. */}
        {panel && chromeless && (
          <StageChromeButton
            onClick={() => (onHide ? onHide() : void closeCallPanel({}))}
            title="Hide this window. The huddle keeps going"
            aria-label="Hide this window. The huddle keeps going"
          >
            <X className="h-3.5 w-3.5" />
          </StageChromeButton>
        )}
        {!panel && (
          <StageChromeButton onClick={collapse} title="Collapse to the pill. The call continues (Esc)">
            <ChevronDown className="h-3.5 w-3.5" />
            <span className="stage-word-tight">collapse</span>
          </StageChromeButton>
        )}
      </div>

      {/* Who is at the door, over the stage's top-right corner — visible
          without taking a lane from the people already in the room. */}
      {call.roomKey && call.phase === "connected" && (
        <div className="pointer-events-none absolute right-3 top-12 z-10 w-72 max-w-[calc(100%-24px)]">
          <div className="pointer-events-auto rounded-lg bg-sol-base03/80 backdrop-blur">
            <RoomKnocks roomKey={call.roomKey} />
          </div>
        </div>
      )}
      {/* A recording somebody else started, said once, top left. In a window
          of its own the stage is where the person looks; anywhere else the
          app's toast says it (RoomRecording). */}
      {panel && call.roomKey && call.phase === "connected" && (
        <div className="pointer-events-none absolute left-3 top-12 z-10">
          <RecordingNoticeBanner roomKey={call.roomKey} />
        </div>
      )}

      {/* The stage itself. */}
      <div className="flex min-h-0 flex-1 gap-2 px-3 pb-3 pt-3">
        <StageHostProvider value={stageHost}>
        <div key={view} className="flex min-h-0 min-w-0 flex-1 animate-in fade-in duration-200 max-sm:flex-col">
          {view === "grid" ? (
            <GridStage roster={roster} cameras={cameras} screens={screens} speaking={speaking} />
          ) : view === "speaker" ? (
            <SpeakerStage
              roster={roster}
              cameras={cameras}
              screens={screens}
              speaking={speaking}
              focusId={pinned ?? lastSpeaker}
              pinned={pinned}
              onPin={(id) => setPinned((p) => (p === id ? null : id))}
            />
          ) : (
            <AutoStage
              roster={roster}
              cameras={cameras}
              screens={screens}
              speaking={speaking}
              phase={call.phase}
              ringing={arriving}
              settledLine={settledLine}
            />
          )}
        </div>
        </StageHostProvider>
        {(threadOpen || railClosing) && call.roomKey && (
          <ThreadRail
            roomKey={call.roomKey}
            live={live ?? null}
            rows={rows}
            panel={panel}
            sinceAt={roster.find((m) => String(m.user_id) === myUserId)?.joined_at}
            closing={railClosing && !threadOpen}
            onClosed={() => setRailClosing(false)}
          />
        )}
      </div>

      {/* The foot: a band of its own under a rule, so the words and the
          controls have a floor to stand on rather than floating up into the
          video. Captions first — a lane, left-aligned, the speaker in a
          column — then the notice, then the one control bar. */}
      <div className="shrink-0 border-t border-white/[0.06] bg-black/[0.12]">
        {/* The lane folds to nothing while the rail is open (the open
            passage shows the words) instead of leaving the tree, so the foot
            changes height over the same 200ms the rail slides in. */}
        <div
          className="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
          style={{ gridTemplateRows: threadOpen ? "0fr" : "1fr" }}
        >
          <div className="min-h-0 overflow-hidden">
            <CaptionsLane live={transcribing ? live! : null} />
          </div>
        </div>
        {call.error && <CallErrorNotice error={call.error} fix={call.errorFix} />}
        <ControlBar call={call} live={live ?? null} />
      </div>
    </div>,
    document.body,
  );
}

/** A thin rule between the header's groups. */
function HeaderRule() {
  return <span aria-hidden="true" className="mx-1.5 h-4 w-px shrink-0 bg-white/[0.08]" />;
}

/**
 * The three small sizes of the window, behind one button. They are one
 * decision — how little of this call to keep on screen — and three buttons
 * on the header line made it read as three unrelated things.
 */
function ShrinkMenu({ onSetSize }: { onSetSize: (size: CallWindowSize) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative">
      <StageChromeButton
        onClick={() => setOpen((o) => !o)}
        active={open}
        title="Shrink this window to faces floating over your work"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Minimize2 className="h-3.5 w-3.5" />
        shrink
      </StageChromeButton>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1.5 w-[248px] rounded-lg bg-sol-bg-alt p-1 shadow-2xl ring-1 ring-white/[0.08]"
          onMouseLeave={() => setOpen(false)}
        >
          {SMALL_CALL_WINDOW_SIZES.map((size) => {
            const chrome = SMALL_SIZE_CHROME[size];
            return (
              <button
                key={size}
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onSetSize(size);
                }}
                className="flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/[0.06]"
              >
                <chrome.icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sol-text-muted" />
                <span className="min-w-0">
                  <span className="block font-mono text-[11.5px] text-sol-text">{chrome.label}</span>
                  <span className="block text-[10.5px] leading-snug text-sol-text-muted">{chrome.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}

// Header chrome: one quiet button style for the whole top line. Selected
// reads by brightness (and an accent tint when the surface it opens has
// one); nothing wears a border.
const CHROME_BTN =
  "flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[11.5px] transition-colors";

function StageChromeButton({
  active,
  accent,
  className = "",
  children,
  ...rest
}: {
  active?: boolean;
  accent?: "green" | "cyan" | "violet" | "yellow";
  className?: string;
  children: React.ReactNode;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children">) {
  const tone = active
    ? accent === "green"
      ? "bg-sol-green/10 text-sol-green"
      : accent === "cyan"
        ? "bg-sol-cyan/10 text-sol-cyan"
        : accent === "violet"
          ? "bg-sol-violet/10 text-sol-violet"
          : accent === "yellow"
            ? "bg-sol-yellow/10 text-sol-yellow"
            : "bg-white/10 text-sol-text"
    : "text-sol-text-muted hover:bg-white/[0.06] hover:text-sol-text";
  return (
    <button className={`${CHROME_BTN} ${tone} ${className}`} {...rest}>
      {children}
    </button>
  );
}

// ── The rail: the room's one thread ──────────────────────────────────────

// The thread beside the stage: what was said (folded into passages), what
// was typed, what an agent answered, who came and went. RoomThread renders
// it; this wrapper owns the reads it needs (the transcript's call record) and
// the rail's box. The reader drags its left edge to widen it; the stage
// always keeps STAGE_MIN_W, so a width saved on a wide window shrinks to fit
// the panel (about 690px) rather than burying the faces.
const RAIL_MIN_W = 280;
const STAGE_MIN_W = 200;
const railMaxWidth = (handle: HTMLElement) =>
  (handle.parentElement?.parentElement?.clientWidth ?? Infinity) - STAGE_MIN_W;
function ThreadRail({
  roomKey,
  live,
  rows,
  panel,
  sinceAt,
  closing,
  onClosed,
}: {
  roomKey: string;
  live: { transcript_id: string } | null;
  rows: ThreadRow[] | null | undefined;
  panel: boolean;
  /** When the viewer joined: the thread's divider anchor before any transcript. */
  sinceAt?: number;
  /** On its way out: the exit runs and `onClosed` fires when it ends. */
  closing: boolean;
  onClosed: () => void;
}) {
  const call = useQueryNoThrow(
    api.transcripts.webGetCall,
    live ? { transcript_id: live.transcript_id as any } : "skip",
  ).data as RoomThreadCall | null | undefined;
  const { width, onResizeDown } = useEdgeResize({
    storageKey: "call-thread-rail-width",
    min: RAIL_MIN_W,
    fallback: 340,
    max: railMaxWidth,
  });
  return (
    <aside
      style={{ width: `min(${width}px, calc(100% - ${STAGE_MIN_W}px))` }}
      className={`relative flex shrink-0 flex-col overflow-hidden rounded-xl bg-white/[0.04] motion-reduce:animate-none ${
        closing
          ? "animate-out fade-out slide-out-to-right-2 fill-mode-forwards duration-150"
          : "animate-in fade-in slide-in-from-right-2 duration-200"
      }`}
      onAnimationEnd={(e) => {
        // Rows inside the thread animate too; only the aside's own end counts.
        if (e.target === e.currentTarget) onClosed();
      }}
    >
      <EdgeResizeHandle onResizeDown={onResizeDown} />
      <RoomThread
        roomKey={roomKey}
        call={live ? call : null}
        rows={rows}
        liveTranscriptId={live?.transcript_id ?? null}
        surface="stage"
        seated
        panel={panel}
        sinceAt={sinceAt}
        className="min-h-0 flex-1"
      />
    </aside>
  );
}

// Attributed captions in a lane of their own at the foot of the stage — for
// everyone in the room, not just the scribe: the scribe reads its own local
// tail, everyone else the synced one. Lines age out so a lull never shows
// stale words.
//
// A LANE, not a caption burned into the picture: the words are left-aligned
// with the speaker in a column, the way a transcript reads, and the lane
// keeps its height while a transcript is live so the control bar under it
// does not jump with every sentence. Nothing is drawn when nobody is
// transcribing — an empty lane is a promise the stage cannot keep.
//
// The lane holds exactly what it shows: CAPTION_LINES lines of 13px at
// leading-snug (1.375), the 4px between them (space-y-1) and the 8px pads,
// so the bar under it never moves.
const CAPTION_LINES = 3;
const CAPTION_MAX_AGE_MS = 45_000;
function CaptionsLane({
  live,
}: {
  live: { tail: Array<{ speaker_name: string; text: string; at: number }> } | null;
}) {
  const scribe = useSyncExternalStore(subscribeScribe, getScribeStatus, getScribeStatus);
  const now = useCoarseNow(5000);
  const lines = scribe.active
    ? scribe.tail.map((c) => ({ speaker: c.speaker, text: c.text }))
    : (live?.tail ?? [])
        .filter((c) => now - c.at < CAPTION_MAX_AGE_MS)
        .map((c) => ({ speaker: c.speaker_name, text: c.text }));
  if (!live && !scribe.active) return null;
  const shown = lines.slice(-CAPTION_LINES);
  return (
    <div
      className="pointer-events-none border-b border-white/[0.06] px-5 py-2"
      style={{ minHeight: `calc(${CAPTION_LINES} * 13px * 1.375 + ${CAPTION_LINES - 1} * 4px + 16px)` }}
    >
      {shown.length === 0 ? (
        <div className="font-mono text-[11px] text-sol-text-dim">
          {scribe.error ?? "listening…"}
        </div>
      ) : (
        <div className="space-y-1">
          {shown.map((c, i, arr) => (
            <div
              key={i}
              className={`flex items-baseline gap-3 text-[13px] leading-snug transition-colors ${
                i === arr.length - 1 ? "text-sol-text" : "text-sol-text-muted"
              }`}
            >
              <span className="flex w-20 shrink-0 items-center justify-end gap-1 font-mono text-[11px] text-sol-cyan">
                <PersonName name={c.speaker} tagClassName="!px-0.5" />
              </span>
              <span className="min-w-0 truncate">{c.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// The one control bar. Order mirrors frequency of use; the destructive act
// sits alone at the right. Round buttons on a borderless pill: state reads
// by tint (cyan = camera on, violet = sharing, green = transcribing, red =
// muted), never by outline.
function ControlBar({ call, live }: { call: any; live: { transcript_id: string; routes?: Array<{ kind: string; target: string }> } | null }) {
  const transcribing = !!live;

  return (
    <div className="group/ctl flex flex-col items-center gap-1 px-5 pb-1.5 pt-2.5">
      <div className="flex items-center gap-1 rounded-full bg-white/[0.05] px-2 py-1.5 ring-1 ring-white/[0.06]">
        <MicButton muted={call.muted} />
        <button
          onClick={() => void setCamera(!call.camera)}
          className={`${STAGE_CTL} ${
            call.camera ? "bg-sol-cyan/15 text-sol-cyan hover:bg-sol-cyan/25" : STAGE_CTL_IDLE
          }`}
          title={call.camera ? "Turn camera off" : "Turn camera on"}
        >
          {call.camera ? <Video className="h-[18px] w-[18px]" /> : <VideoOff className="h-[18px] w-[18px]" />}
        </button>
        <StageShareButton sharing={call.sharing} />
        {call.roomKey && call.phase === "connected" && (
          <AddPeopleButton
            roomKey={call.roomKey}
            live={live}
            className={`${STAGE_CTL} ${STAGE_CTL_IDLE}`}
            iconClassName="h-[18px] w-[18px]"
          />
        )}
        <TranscribeControls live={transcribing} />
        {call.roomKey && call.phase === "connected" && <RecordButton roomKey={call.roomKey} />}
        <div className="mx-1.5 h-5 w-px bg-white/10" />
        <HangUpButton />
      </div>
      {/* Not a setting, a fact: the floating circles either follow a face or
          show the middle of the frame, and only this build knows which. */}
      <DeviceChips
        footer={<p className="px-2 pb-1 text-[10px] leading-snug text-sol-text-dim">{faceTrackingNote()}</p>}
      />
    </div>
  );
}

function StageShareButton({ sharing }: { sharing: boolean }) {
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState<DesktopDisplaySource[] | null>(null);
  const bridge = typeof window !== "undefined" ? window.__CODECAST_ELECTRON__ : undefined;
  const canPick = !!bridge?.getDisplaySources && !!bridge?.selectDisplaySource;

  const onClick = async () => {
    if (sharing) return void setScreenShare(false);
    if (!canPick) return void setScreenShare(true);
    setOpen(true);
    setSources(null);
    try {
      setSources(await bridge!.getDisplaySources!({ types: ["screen", "window"] }));
    } catch {
      setSources([]);
    }
  };

  return (
    <span className="relative">
      <button
        onClick={() => void onClick()}
        className={`${STAGE_CTL} ${
          sharing ? "bg-sol-violet/15 text-sol-violet hover:bg-sol-violet/25" : STAGE_CTL_IDLE
        }`}
        title={sharing ? "Stop sharing" : "Share your screen"}
      >
        <MonitorUp className="h-[18px] w-[18px]" />
      </button>
      {open && (
        <SharePicker
          sources={sources}
          onClose={() => setOpen(false)}
          onPick={(id) => {
            setOpen(false);
            void setScreenShare(true, id);
          }}
        />
      )}
    </span>
  );
}

/** A capture preview, or the source's icon on a quiet tile when the shell
 *  sent none: an empty image serializes as a bare `data:image/png;base64,`,
 *  which Chromium draws as a broken image. */
function ShareThumb({ src, icon: Icon, className }: { src: string; icon: typeof MonitorUp; className: string }) {
  const [failed, setFailed] = useState(false);
  if (failed || !src || src.endsWith("base64,")) {
    return (
      <span className={`flex items-center justify-center bg-white/[0.04] ${className}`}>
        <Icon className="h-5 w-5 text-sol-text-dim" />
      </span>
    );
  }
  return <img src={src} alt="" onError={() => setFailed(true)} className={`object-cover ${className}`} />;
}

/** Screens and windows are different choices, so they get different shapes:
 *  whole screens as a row of large previews, windows as a scannable list with
 *  the app's icon and full title, filtered by typing. The shell lists windows
 *  front to back, so the one you were just in is already near the top. */
function SharePicker({
  sources,
  onClose,
  onPick,
}: {
  sources: DesktopDisplaySource[] | null;
  onClose: () => void;
  onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  useWatchEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [onClose]);

  const screens = sources?.filter((s) => s.kind === "screen") ?? [];
  const q = query.trim().toLowerCase();
  const windows = (sources ?? []).filter((s) => s.kind === "window" && (!q || s.name.toLowerCase().includes(q)));
  const windowCount = sources?.filter((s) => s.kind === "window").length ?? 0;

  return (
    <div
      ref={rootRef}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        onClose();
      }}
      className="absolute bottom-full left-1/2 z-10 mb-3 w-[440px] -translate-x-1/2 rounded-xl bg-sol-bg-alt p-2.5 shadow-2xl ring-1 ring-white/5"
    >
      {sources === null ? (
        <div className="px-1 py-6 text-center text-[11px] text-sol-text-muted">Looking…</div>
      ) : sources.length === 0 ? (
        <div className="px-1 py-6 text-center text-[11px] text-sol-text-muted">
          Nothing to share. Check Screen Recording permission in System Settings
        </div>
      ) : (
        <>
          {screens.length > 0 && (
            <section>
              <div className="mb-1.5 px-1 text-[11px] font-medium text-sol-text-muted">Entire screen</div>
              <div className={`grid gap-2 ${screens.length === 1 ? "grid-cols-1" : "grid-cols-2"}`}>
                {screens.map((src, i) => (
                  <button
                    key={src.id}
                    onClick={() => onPick(src.id)}
                    className="group flex flex-col gap-1.5 rounded-lg border border-white/5 p-1.5 text-left transition-colors hover:border-sol-violet/60 hover:bg-sol-violet/10"
                    title={src.name}
                  >
                    <ShareThumb
                      src={src.thumbnail}
                      icon={MonitorUp}
                      className={`w-full rounded-md ${screens.length === 1 ? "aspect-[16/7]" : "aspect-video"}`}
                    />
                    <span className="flex items-center gap-1.5 px-0.5 text-[11px] text-sol-text-muted group-hover:text-sol-text">
                      <MonitorUp className="h-3 w-3 shrink-0" />
                      <span className="truncate">{screens.length === 1 ? "Your entire screen" : `Screen ${i + 1}`}</span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}
          {windowCount > 0 && (
            <section className={screens.length > 0 ? "mt-3 border-t border-white/5 pt-2.5" : ""}>
              <div className="mb-1.5 flex items-center gap-2 px-1">
                <span className="text-[11px] font-medium text-sol-text-muted">
                  Windows <span className="text-sol-text-dim">· {windowCount}</span>
                </span>
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && windows[0]) onPick(windows[0].id);
                  }}
                  placeholder="Find a window…"
                  className="ml-auto h-6 w-40 rounded-md bg-white/5 px-2 text-[11px] text-sol-text outline-none ring-1 ring-white/5 placeholder:text-sol-text-dim focus:ring-sol-violet/50"
                  style={{ fontVariantLigatures: "none" }}
                />
              </div>
              <div className="max-h-[260px] space-y-0.5 overflow-y-auto">
                {windows.length === 0 ? (
                  <div className="px-1 py-3 text-center text-[11px] text-sol-text-muted">No window matches "{query}"</div>
                ) : (
                  windows.map((src, i) => (
                    <button
                      key={src.id}
                      onClick={() => onPick(src.id)}
                      className={`group flex w-full items-center gap-2.5 rounded-md p-1 text-left transition-colors hover:bg-sol-violet/10 ${
                        q && i === 0 ? "bg-sol-violet/10" : ""
                      }`}
                      title={src.name}
                    >
                      <ShareThumb src={src.thumbnail} icon={AppWindow} className="h-9 w-16 shrink-0 rounded ring-1 ring-white/5" />
                      {src.appIcon ? (
                        <img src={src.appIcon} alt="" className="h-4 w-4 shrink-0" />
                      ) : (
                        <AppWindow className="h-4 w-4 shrink-0 text-sol-text-dim" />
                      )}
                      <span className="line-clamp-2 min-w-0 text-[11px] leading-snug text-sol-text-muted group-hover:text-sol-text">
                        {src.name || "Untitled window"}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
