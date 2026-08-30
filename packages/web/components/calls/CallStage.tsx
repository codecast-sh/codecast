import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import Link from "next/link";
import {
  AppWindow,
  Captions,
  ChevronDown,
  Circle,
  CircleUserRound,
  ExternalLink,
  LayoutGrid,
  Lock,
  MessageSquare,
  MicOff,
  MonitorUp,
  Plus,
  Radio,
  Settings2,
  Sparkles,
  Unlock,
  User,
  Users,
  Video,
  VideoOff,
  Wand2,
  X,
} from "lucide-react";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { AvatarImg } from "../../lib/avatarCache";
import {
  getCallTiles,
  getRoom,
  listDevices,
  setCamera,
  setScreenShare,
  subscribeCallTiles,
  switchDevice,
  type ParticipantTile, stopTranscribing } from "../../lib/calls/callManager";
import { humanizeConvexError, parseRoomKey } from "@codecast/shared/contracts";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { getScribeStatus, subscribeScribe } from "../../lib/calls/transcription";
import { TranscribeControls } from "./TranscribePanel";
import { AddPeopleButton } from "./AddPeople";
import { RoomKnocks } from "./RoomDoor";
import { HangUpButton, MicButton } from "./CallControls";
import { CallChatPanel } from "./CallChatPanel";
import { FeedChip } from "./FeedChip";
import { faceTrackingNote } from "./useFaceCrop";
import { openFeedTargetPicker, useAddLiveFeed, useRemoveLiveFeed, type FeedTarget } from "./useCallFeed";
import { firstName, fmtClock, speakerColor } from "./speakers";
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
import { permissionActionLabel, requestOsPermission, type OsPermissionKind } from "../../lib/osPermissions";

// The media notice, with the fix in reach: when the error is a device the OS
// refused, the button is the one gesture that changes that (the OS prompt,
// or System Settings). No button when the OS says it's granted — then the
// trouble is the device itself, and the sentence already says so.
function CallErrorNotice({ error, fix }: { error: string; fix: OsPermissionKind | null }) {
  const { permissions, refresh } = useOsPermissions();
  const readiness = fix ? permissions[fix] : null;
  const action = fix && readiness ? permissionActionLabel(readiness) : null;
  return (
    <div className="mx-auto mb-1 flex max-w-lg items-start gap-2 rounded-full bg-sol-orange/10 px-3.5 py-1.5 text-[12px] text-sol-orange">
      <span className="min-w-0 flex-1">{error}</span>
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
//   3. WORDS ARE A FIRST-CLASS LANE. The transcript rail shows the whole live
//      transcript and owns the FEED gestures (point the words at an agent
//      session, doc, or Slack — adding a feed auto-starts transcription, no
//      separate toggle first). Captions flow along the stage bottom for
//      everyone, scribe or not, and the header links out to the durable call
//      page. A chat rail gives the room its text lane.
//
// The stage is an overlay, not a route: Esc (or collapse) drops back to the
// ambient pill and the call continues beside the work.
// The one outline the stage allows itself: a soft cyan ring with a faint
// halo on whoever is speaking. Silent tiles have no border at all — the gap
// between them is the frame.
// Roster lookup for a tile: is this person muted right now?
const isMuted = (roster: any[], identity: string) =>
  !!roster.find((m) => String(m.user_id) === identity)?.muted;

const SPEAKING_RING = "ring-2 ring-sol-cyan/80 shadow-[0_0_0_5px_rgba(42,161,152,0.16)]";

type StageView = "auto" | "speaker" | "grid";

/**
 * How each of the window's small sizes reads on the stage's chrome.
 *
 * Keyed by the sizes themselves (`SMALL_CALL_WINDOW_SIZES`, which is the
 * shell's own list) so a new size without a button is a type error rather than
 * a shape nobody can reach. Each shrinks this same window — the media stays
 * put, so going from the stage to a circle is not asking for your audio to be
 * re-established.
 */
const SMALL_SIZE_CHROME: Record<
  SmallCallWindowSize,
  { icon: typeof Users; hint: string }
> = {
  circles: { icon: Users, hint: "Shrink to a row of faces over your work" },
  speaker: { icon: CircleUserRound, hint: "Shrink to one circle: whoever is talking" },
  tiny: { icon: Circle, hint: "Shrink to one circle the size of a menu bar icon" },
};
type RailTab = "transcript" | "chat";

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
}: {
  onCollapse?: () => void;
  panel?: boolean;
  /** Panel only: shrink the window to a row of circles, or to one. */
  onSetSize?: (size: CallWindowSize) => void;
}) {
  // Memoized because it feeds an effect's dependency list: a fresh no-op every
  // render would re-bind the key listener on every render.
  const collapse = useMemo(() => onCollapse ?? (() => {}), [onCollapse]);
  const s = useTrackedStore([
    (st: any) => st.call,
    (st: any) => (st.call.roomKey ? st.callOccupancy[st.call.roomKey] : undefined),
  ]);
  const call = s.call;
  const roster: any[] = (call.roomKey && s.callOccupancy[call.roomKey]) || [];
  const tiles = useSyncExternalStore(subscribeCallTiles, getCallTiles, () => []);
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
        routes: Array<{ kind: string; target: string; mode: string; added_by: string }>;
        tail: Array<{ seq: number; speaker_name: string; text: string; at: number }>;
      }
    | null
    | undefined;

  const [view, setView] = useState<StageView>("auto");
  const [rail, setRail] = useState<RailTab | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  // The face SPEAKER view follows when nothing is pinned: whoever spoke last.
  const [lastSpeaker, setLastSpeaker] = useState<string | null>(null);
  useEffect(() => {
    const first = call.speaking?.[0];
    if (first) setLastSpeaker(String(first));
  }, [call.speaking]);

  useWatchEffect(() => {
    // In the panel there is nothing behind the stage for Esc to reveal, and a
    // key that closed the window would end a call by accident.
    if (panel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Typing in the chat composer: Esc leaves the field, not the stage.
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
  const lock = useRoomLock(call.roomKey);

  const toggleRail = (tab: RailTab) => setRail((r) => (r === tab ? null : tab));

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
      className={`dark fixed inset-0 z-[200] flex flex-col select-none bg-sol-base03 text-sol-text${
        // The window is see-through and frameless, so the stage's own surface
        // is the only surface there is: a rounded card, clipped so the video
        // inside it does not square off the corners.
        chromeless ? " overflow-hidden rounded-xl" : ""
      }`}
    >
      {/* Header: where this huddle lives, the ways out, and the view. One
          quiet line — no boxes; the selected view reads by weight alone. */}
      <div ref={headRef} className="flex h-11 shrink-0 items-center gap-1 px-4">
        <span className="truncate font-mono text-[12.5px] text-sol-text-secondary">
          {parsed?.kind === "session" ? `huddle · ${label}` : label}
        </span>
        {roster.length > 0 && (
          <span className="ml-1 shrink-0 font-mono text-[11.5px] text-sol-text-muted">
            {roster.length} {roster.length === 1 ? "person" : "people"}
          </span>
        )}
        {parsed?.kind === "session" && (
          <StageChromeButton
            onClick={() => {
              if (panel) return void navigateMainWindow(`/conversation/${parsed.conversationId}`);
              useInboxStore.getState().navigateToSession(parsed.conversationId);
              collapse();
            }}
            title="Open the session this huddle is about"
            className="ml-1"
          >
            <ExternalLink className="h-3 w-3" />
            session
          </StageChromeButton>
        )}
        {live &&
          (panel ? (
            <StageChromeButton
              onClick={() => void navigateMainWindow(`/calls/${live.transcript_id}`)}
              className="text-sol-green hover:bg-sol-green/10 hover:text-sol-green"
              title="Open the call page in the main window — full transcript, summary, chat"
            >
              <Radio className="h-3 w-3" />
              call page
            </StageChromeButton>
          ) : (
            <Link
              href={`/calls/${live.transcript_id}`}
              onClick={collapse}
              className={`${CHROME_BTN} text-sol-green hover:bg-sol-green/10 hover:text-sol-green`}
              title="Open the call page — full transcript, summary, chat"
            >
              <Radio className="h-3 w-3" />
              call page
            </Link>
          ))}
        {/* The door. An open huddle is the default — any teammate can walk in
            — so the lock is the exception, and it reads as one: lit violet
            while the room is closed, quiet chrome while it is open. */}
        <StageChromeButton
          onClick={lock.toggle}
          active={lock.locked}
          accent="violet"
          title={lock.title}
          className="ml-1"
        >
          {lock.locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
          {lock.locked ? "locked" : "open"}
        </StageChromeButton>
        <div className="flex-1" />

        {/* View switcher: three words, the live one lit. */}
        <div className="mr-2 flex shrink-0 items-center gap-0.5">
          {(
            [
              { key: "auto", icon: Wand2, hint: "Auto — shares take the stage" },
              { key: "speaker", icon: User, hint: "Speaker — follow whoever is talking (click a tile to pin)" },
              { key: "grid", icon: LayoutGrid, hint: "Grid — everyone equal" },
            ] as const
          ).map((v) => (
            <StageChromeButton
              key={v.key}
              onClick={() => setView(v.key)}
              active={view === v.key}
              title={v.hint}
            >
              <v.icon className="h-3.5 w-3.5" />
              {v.key}
            </StageChromeButton>
          ))}
        </div>

        {/* Rails. */}
        <StageChromeButton
          onClick={() => toggleRail("transcript")}
          active={rail === "transcript"}
          accent="green"
          title="Live transcript + feeds (send the words to an agent)"
        >
          <Captions className="h-3.5 w-3.5" />
          transcript
        </StageChromeButton>
        <StageChromeButton
          onClick={() => toggleRail("chat")}
          active={rail === "chat"}
          accent="cyan"
          title="Chat with the room"
        >
          <MessageSquare className="h-3.5 w-3.5" />
          chat
        </StageChromeButton>
        {/* Give the call a window of its own. Desktop only, and deliberately
            absent in a browser rather than degraded: the ladder behind this
            has no browser rung, because a call in a Chrome popup is the bug
            this panel exists to make impossible. */}
        {canPopOutCall() && (
          <StageChromeButton
            onClick={() => void popOutCall()}
            className="ml-2"
            title={POP_OUT_CALL_TITLE}
          >
            <AppWindow className="h-3.5 w-3.5" />
            pop out
          </StageChromeButton>
        )}
        {/* The small sizes of this same window: everybody as a row of circles,
            one circle of whoever is talking, or that circle the size of a menu
            bar icon. The window keeps its media across the change — that is why they are sizes and not
            windows — so this is only a reshape. */}
        {panel &&
          onSetSize &&
          SMALL_CALL_WINDOW_SIZES.map((size, i) => {
            const chrome = SMALL_SIZE_CHROME[size];
            return (
              <StageChromeButton
                key={size}
                onClick={() => onSetSize(size)}
                className={i === 0 ? "ml-2" : undefined}
                title={chrome.hint}
              >
                <chrome.icon className="h-3.5 w-3.5" />
                {size}
              </StageChromeButton>
            );
          })}
        {/* The window's own close. There is no traffic light to do it: closing
            hands the call back to the main window, which joins and carries on
            — hanging up is the other door, and it is the red button on the
            control bar below. */}
        {panel && chromeless && (
          <StageChromeButton
            onClick={() => void closeCallPanel({})}
            className="ml-2"
            title="Close this window — the call carries on in the main window"
          >
            <X className="h-3.5 w-3.5" />
          </StageChromeButton>
        )}
        {!panel && (
          <StageChromeButton
            onClick={collapse}
            className="ml-2"
            title="Collapse to the pill — the call continues (Esc)"
          >
            <ChevronDown className="h-3.5 w-3.5" />
            collapse
          </StageChromeButton>
        )}
      </div>

      {/* Who is at the door, over the stage's top-right corner — visible
          without taking a lane from the people already in the room. */}
      {call.roomKey && call.phase === "connected" && (
        <div className="pointer-events-none absolute right-3 top-12 z-10 w-64">
          <div className="pointer-events-auto rounded-lg bg-sol-base03/80 backdrop-blur">
            <RoomKnocks roomKey={call.roomKey} />
          </div>
        </div>
      )}

      {/* The stage itself. */}
      <div className="flex min-h-0 flex-1 gap-2 px-3 pb-1">
        <div key={view} className="flex min-h-0 min-w-0 flex-1 animate-in fade-in duration-200">
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
              ringing={ringing}
              settledLine={settledLine}
            />
          )}
        </div>
        {rail && (
          <StageRail tab={rail} onClose={() => setRail(null)} roomKey={call.roomKey} live={live ?? null} />
        )}
      </div>

      {rail !== "transcript" && <CaptionsOverlay live={live ?? null} />}

      {call.error && <CallErrorNotice error={call.error} fix={call.errorFix} />}

      <ControlBar call={call} />
    </div>,
    document.body,
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
  accent?: "green" | "cyan" | "violet";
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
          : "bg-white/10 text-sol-text"
    : "text-sol-text-muted hover:bg-white/[0.06] hover:text-sol-text";
  return (
    <button className={`${CHROME_BTN} ${tone} ${className}`} {...rest}>
      {children}
    </button>
  );
}

// ── Views ─────────────────────────────────────────────────────────────────

// Auto: an active share owns the stage; else adaptive camera grid; else the
// audio-only avatar stage.
function AutoStage({
  roster,
  cameras,
  screens,
  speaking,
  phase,
  ringing = [],
  settledLine,
}: {
  roster: any[];
  cameras: ParticipantTile[];
  screens: ParticipantTile[];
  speaking: Set<string>;
  phase: string;
  ringing?: { user_id: string; user_name: string; user_image?: string }[];
  settledLine?: string | null;
}) {
  const [heroKey, setHeroKey] = useState<string | null>(null);
  const hero = (heroKey && screens.find((t) => t.key === heroKey)) || screens[0] || null;
  if (hero) {
    return (
      <>
        <div className="relative min-w-0 flex-1">
          <StageVideo tile={hero} speaking={speaking.has(hero.identity)} contain />
          {screens.length > 1 && (
            <div className="absolute left-3 top-3 flex gap-1">
              {screens.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setHeroKey(t.key)}
                  className={`rounded-full px-2.5 py-0.5 font-mono text-[11px] backdrop-blur transition-colors ${
                    t.key === hero.key
                      ? "bg-sol-violet/30 text-white"
                      : "bg-black/45 text-white/70 hover:text-white"
                  }`}
                >
                  {t.isLocal ? "your screen" : `${firstName(t.name)}'s screen`}
                </button>
              ))}
            </div>
          )}
        </div>
        {(cameras.length > 0 || roster.length > 0) && (
          <div className="ml-2 flex w-[200px] shrink-0 flex-col gap-2 overflow-y-auto">
            {cameras.map((t) => (
              <StageVideo
                key={t.key}
                tile={t}
                speaking={speaking.has(t.identity)}
                muted={isMuted(roster, t.identity)}
                small
              />
            ))}
            <VoiceRows roster={roster} cameras={cameras} speaking={speaking} small />
          </div>
        )}
      </>
    );
  }
  if (cameras.length > 0) {
    return (
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div
          className={`grid min-h-0 flex-1 gap-2 ${
            cameras.length === 1
              ? "grid-cols-1"
              : cameras.length === 2
                ? "grid-cols-2"
                : "grid-cols-2 grid-rows-2"
          }`}
        >
          {cameras.map((t) => (
            <StageVideo
              key={t.key}
              tile={t}
              speaking={speaking.has(t.identity)}
              muted={isMuted(roster, t.identity)}
            />
          ))}
        </div>
        <VoiceRows roster={roster} cameras={cameras} speaking={speaking} />
      </div>
    );
  }
  return (
    <AudioOnlyStage
      roster={roster}
      speaking={speaking}
      phase={phase}
      ringing={ringing}
      settledLine={settledLine}
    />
  );
}

// Speaker: one face owns the stage — whoever spoke last, or whoever the
// viewer pinned. Everything else (faces, shares, voices) files into a strip.
function SpeakerStage({
  roster,
  cameras,
  screens,
  speaking,
  focusId,
  pinned,
  onPin,
}: {
  roster: any[];
  cameras: ParticipantTile[];
  screens: ParticipantTile[];
  speaking: Set<string>;
  focusId: string | null;
  pinned: string | null;
  onPin: (id: string) => void;
}) {
  const focus =
    (focusId && cameras.find((t) => t.identity === focusId)) ||
    (focusId && screens.find((t) => t.identity === focusId)) ||
    cameras[0] ||
    null;
  const focusMemberId = focus ? focus.identity : focusId;
  const focusMember =
    roster.find((m) => String(m.user_id) === focusMemberId) ?? roster[0];
  const others = [...screens, ...cameras].filter((t) => t.key !== focus?.key);
  const onCamera = new Set(cameras.map((c) => c.identity));

  return (
    <div className="flex min-h-0 min-w-0 flex-1 gap-2">
      <div className="relative min-h-0 min-w-0 flex-1">
        {focus ? (
          <StageVideo
            tile={focus}
            speaking={speaking.has(focus.identity)}
            muted={isMuted(roster, focus.identity)}
            contain={focus.kind === "screen"}
          />
        ) : focusMember ? (
          <div
            className={`flex h-full w-full flex-col items-center justify-center gap-4 rounded-xl bg-white/[0.05] transition-shadow ${
              speaking.has(String(focusMember.user_id)) ? SPEAKING_RING : ""
            }`}
          >
            <Avatar m={focusMember} size={120} />
            <span className="font-mono text-[15px] text-sol-text">
              {firstName(focusMember.user_name)}
            </span>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center font-mono text-[13px] text-sol-text-muted">
            just you so far
          </div>
        )}
        {pinned && (
          <button
            onClick={() => onPin(pinned)}
            className="absolute left-3 top-3 rounded-full bg-black/45 px-2.5 py-0.5 font-mono text-[11px] text-sol-yellow backdrop-blur transition-colors hover:text-white"
            title="Unpin — follow the active speaker again"
          >
            pinned · unpin
          </button>
        )}
      </div>
      <div className="flex w-[200px] shrink-0 flex-col gap-2 overflow-y-auto">
        {others.map((t) => (
          <button
            key={t.key}
            onClick={() => onPin(t.identity)}
            title="Pin this tile"
            className="rounded-lg text-left transition-opacity hover:opacity-85"
          >
            <StageVideo
              tile={t}
              speaking={speaking.has(t.identity)}
              muted={isMuted(roster, t.identity)}
              small
            />
          </button>
        ))}
        {roster
          .filter(
            (m) =>
              !onCamera.has(String(m.user_id)) &&
              String(m.user_id) !== String(focusMember?.user_id ?? ""),
          )
          .map((m) => (
            <button
              key={m.user_id}
              onClick={() => onPin(String(m.user_id))}
              className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/[0.06] ${
                speaking.has(String(m.user_id)) ? "bg-sol-cyan/10" : ""
              }`}
              title="Pin this person"
            >
              <Avatar m={m} size={24} />
              <span className="truncate font-mono text-[12px] text-sol-text">
                {firstName(m.user_name)}
              </span>
              {m.muted && <MicOff className="h-3 w-3 shrink-0 text-sol-text-muted" />}
            </button>
          ))}
      </div>
    </div>
  );
}

// Grid: everyone equal — cameras, shares, and voice-only faces in one lattice.
function GridStage({
  roster,
  cameras,
  screens,
  speaking,
}: {
  roster: any[];
  cameras: ParticipantTile[];
  screens: ParticipantTile[];
  speaking: Set<string>;
}) {
  const onCamera = new Set(cameras.map((c) => c.identity));
  const voices = roster.filter((m) => !onCamera.has(String(m.user_id)));
  const n = screens.length + cameras.length + voices.length;
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
  return (
    <div
      className="grid min-h-0 min-w-0 flex-1 gap-2"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {screens.map((t) => (
        <StageVideo key={t.key} tile={t} speaking={speaking.has(t.identity)} contain />
      ))}
      {cameras.map((t) => (
        <StageVideo
          key={t.key}
          tile={t}
          speaking={speaking.has(t.identity)}
          muted={isMuted(roster, t.identity)}
        />
      ))}
      {voices.map((m) => (
        <div
          key={m.user_id}
          className={`flex flex-col items-center justify-center gap-2.5 rounded-xl bg-white/[0.05] transition-shadow ${
            speaking.has(String(m.user_id)) ? SPEAKING_RING : ""
          }`}
        >
          <Avatar m={m} size={64} />
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[12.5px] text-sol-text">{firstName(m.user_name)}</span>
            {m.muted && <MicOff className="h-3 w-3 text-sol-text-muted" />}
          </div>
        </div>
      ))}
      {n === 0 && (
        <div className="flex items-center justify-center font-mono text-[13px] text-sol-text-muted">
          just you so far
        </div>
      )}
    </div>
  );
}

// One video surface. `contain` letterboxes (screen shares must not crop);
// cameras cover. The name chip is fixed black-on-white so it reads over any
// video in any theme (the mini window renders these in the app's theme).
export function StageVideo({
  tile,
  speaking,
  muted,
  small,
  contain,
}: {
  tile: ParticipantTile;
  speaking: boolean;
  muted?: boolean;
  small?: boolean;
  contain?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    tile.track.attach(el);
    return () => {
      tile.track.detach(el);
    };
  }, [tile.track]);
  return (
    <div
      className={`relative overflow-hidden bg-black/60 transition-shadow duration-300 ${
        speaking ? SPEAKING_RING : ""
      } ${small ? "aspect-video w-full rounded-lg" : "h-full w-full rounded-xl"}`}
    >
      <video
        ref={ref}
        autoPlay
        playsInline
        muted={tile.isLocal}
        className={`h-full w-full ${contain ? "object-contain" : "object-cover"} ${
          tile.isLocal && tile.kind === "camera" ? "-scale-x-100" : ""
        }`}
      />
      <span
        className={`absolute bottom-2 left-2 flex items-center gap-1.5 rounded-full bg-black/45 font-mono text-white/90 backdrop-blur ${
          small ? "px-2 py-px text-[11px]" : "px-2.5 py-0.5 text-[12px]"
        }`}
      >
        {tile.isLocal ? "you" : firstName(tile.name)}
        {tile.kind === "screen" ? " · screen" : ""}
        {muted && tile.kind === "camera" && <MicOff className="h-3 w-3 text-sol-red/90" />}
      </span>
    </div>
  );
}

// Roster rows for people who are voice-only while others are on camera.
function VoiceRows({
  roster,
  cameras,
  speaking,
  small,
}: {
  roster: any[];
  cameras: ParticipantTile[];
  speaking: Set<string>;
  small?: boolean;
}) {
  const onCamera = new Set(cameras.map((c) => c.identity));
  const voices = roster.filter((m) => !onCamera.has(String(m.user_id)));
  if (voices.length === 0) return null;
  return (
    <div className={small ? "space-y-1" : "flex flex-wrap gap-2"}>
      {voices.map((m) => (
        <div
          key={m.user_id}
          className={`flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors ${
            speaking.has(String(m.user_id)) ? "bg-sol-cyan/10" : ""
          }`}
        >
          <Avatar m={m} size={22} />
          <span className="truncate font-mono text-[12px] text-sol-text">
            {firstName(m.user_name)}
          </span>
          {m.muted && <MicOff className="h-3 w-3 shrink-0 text-sol-text-muted" />}
        </div>
      ))}
    </div>
  );
}

// Nobody on camera: large avatars breathing on the stage, speaking ring live.
function AudioOnlyStage({
  roster,
  speaking,
  phase,
  ringing = [],
  settledLine,
}: {
  roster: any[];
  speaking: Set<string>;
  phase: string;
  ringing?: { user_id: string; user_name: string; user_image?: string }[];
  settledLine?: string | null;
}) {
  const inRoom = new Set(roster.map((m) => String(m.user_id)));
  // People we are ringing take a seat before they answer: a breathing,
  // translucent face with "ringing…" under it, so a group start reads as
  // "these three are on their way" rather than "just you so far".
  const ghosts = ringing.filter((r) => !inRoom.has(r.user_id));
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-6">
      <div className="flex flex-wrap items-center justify-center gap-10">
        {roster.length === 0 && ghosts.length === 0 && (
          <span className="font-mono text-[13px] text-sol-text-muted">
            {phase === "connecting" ? "connecting…" : phase === "ringing_out" ? "ringing…" : "just you so far"}
          </span>
        )}
        {ghosts.map((r) => (
          <div key={`ring:${r.user_id}`} className="flex flex-col items-center gap-3 opacity-60">
            <div className="animate-pulse rounded-full ring-2 ring-sol-violet/40 ring-offset-4 ring-offset-sol-base03">
              <Avatar m={r} size={88} />
            </div>
            <span className="font-mono text-[12.5px] text-sol-text-muted">
              {firstName(r.user_name)} · ringing…
            </span>
          </div>
        ))}
        {roster.map((m) => (
          <div key={m.user_id} className="flex flex-col items-center gap-3">
            <div
              className={`rounded-full transition-all duration-300 ${
                speaking.has(String(m.user_id))
                  ? "ring-2 ring-sol-cyan/80 ring-offset-4 ring-offset-sol-base03 shadow-[0_0_0_8px_rgba(42,161,152,0.14)]"
                  : ""
              }`}
            >
              <Avatar m={m} size={88} />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[13px] text-sol-text">
                {firstName(m.user_name)}
              </span>
              {m.muted && <MicOff className="h-3 w-3 text-sol-text-muted" />}
              {m.sharing && <MonitorUp className="h-3 w-3 text-sol-violet" />}
            </div>
          </div>
        ))}
      </div>
      {settledLine && (
        <span className="font-mono text-[12px] text-sol-text-muted">
          {settledLine.toLowerCase()}
        </span>
      )}
    </div>
  );
}

export function Avatar({ m, size }: { m: any; size: number }) {
  return (
    <AvatarImg
      src={m.user_image}
      alt=""
      style={{ width: size, height: size }}
      className="rounded-full object-cover"
      fallback={
        <span
          style={{ width: size, height: size, fontSize: Math.max(11, size / 2.6) }}
          className="flex items-center justify-center rounded-full bg-sol-bg-highlight font-mono text-sol-text-muted"
        >
          {(m.user_name || "?").charAt(0).toUpperCase()}
        </span>
      }
    />
  );
}

// ── The rail: transcript (words + feeds) / chat ───────────────────────────

function StageRail({
  tab,
  onClose,
  roomKey,
  live,
}: {
  tab: RailTab;
  onClose: () => void;
  roomKey: string | null;
  live: {
    transcript_id: string;
    started_at: number;
    routes: Array<{ kind: string; target: string; mode: string; added_by: string }>;
  } | null;
}) {
  return (
    <aside className="relative flex w-[340px] shrink-0 flex-col overflow-hidden rounded-xl bg-white/[0.04] animate-in fade-in slide-in-from-right-2 duration-200">
      {/* The header's transcript/chat buttons are the tabs; the lane only
          needs a way out of its own. */}
      <button
        onClick={onClose}
        className="absolute right-1.5 top-1.5 z-10 rounded-md p-1.5 text-sol-text-muted transition-colors hover:bg-white/10 hover:text-sol-text"
        title="Close"
      >
        <X className="h-3.5 w-3.5" />
      </button>
      {tab === "chat" ? (
        roomKey ? (
          <CallChatPanel roomKey={roomKey} className="min-h-0 flex-1 pt-6" />
        ) : null
      ) : (
        <TranscriptRail roomKey={roomKey} live={live} />
      )}
    </aside>
  );
}

function TranscriptRail({
  roomKey,
  live,
}: {
  roomKey: string | null;
  live: {
    transcript_id: string;
    started_at: number;
    routes: Array<{ kind: string; target: string; mode: string; added_by: string }>;
  } | null;
}) {
  const scribe = useSyncExternalStore(subscribeScribe, getScribeStatus, getScribeStatus);
  const addFeed = useAddLiveFeed({
    roomKey,
    liveTranscriptId: live?.transcript_id ?? null,
    getRoom,
  });
  const removeFeed = useRemoveLiveFeed(live?.transcript_id ?? null);
  const myUserId = useInboxStore((s: any) => s.currentUser?._id?.toString?.() ?? null);

  const call = useQueryNoThrow(
    api.transcripts.webGetCall,
    live ? { transcript_id: live.transcript_id as any } : "skip",
  ).data as { segments: Array<any> } | null | undefined;

  const scrollRef = useRef<HTMLDivElement>(null);
  const segCount = call?.segments?.length ?? 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [segCount]);

  // addRoute/startScribe can refuse (room authorization, ended transcript);
  // a silent close-and-nothing is the one wrong outcome.
  const onPick = (t: FeedTarget) =>
    void addFeed(t).catch((err: any) =>
      toast.error(humanizeConvexError(err, "Could not point the words there")),
    );
  const openPicker = () =>
    openFeedTargetPicker({ title: "Feed the live words to…", gesture: "feed", showSlack: true, onPick });

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Feed bar: where the words are flowing, and the button that points
          them somewhere new. Adding a feed with no scribe running starts
          transcription in the same gesture. */}
      <div className="shrink-0 py-2 pl-3 pr-9">
        <div className="flex flex-wrap items-center gap-1">
          {(live?.routes ?? []).map((r) => (
            <FeedChip
              key={`${r.kind}:${r.target}`}
              route={r}
              removable={!!myUserId && r.added_by === myUserId}
              onRemove={() => void removeFeed(r.kind, r.target)}
            />
          ))}
          <button
            onClick={openPicker}
            className="flex items-center gap-1 rounded-full bg-sol-violet/10 px-2.5 py-0.5 font-mono text-[11px] text-sol-violet transition-colors hover:bg-sol-violet/20"
            title="Send the live words to an agent session, doc, or Slack"
          >
            <Plus className="h-3 w-3" />
            feed
          </button>
          {scribe.active && (
            <button
              onClick={() => roomKey && void stopTranscribing(roomKey)}
              className="ml-auto rounded-full px-2 py-0.5 font-mono text-[10.5px] text-sol-text-muted transition-colors hover:bg-sol-red/10 hover:text-sol-red"
              title="Stop transcribing this huddle (for everyone)"
            >
              stop
            </button>
          )}
        </div>
      </div>

      {/* The words are content, not chrome: the stage turns selection off
          wholesale (its toolbar is a toolbar, not a paragraph) and the
          transcript turns it back on, so a call can still be quoted. */}
      <div ref={scrollRef} className="min-h-0 flex-1 select-text overflow-y-auto px-3 pb-3 pt-1">
        {!live ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-3 text-center">
            <Captions className="h-5 w-5 text-sol-text-muted" />
            <p className="text-[12px] leading-relaxed text-sol-text-muted">
              Nobody is transcribing yet. Feed an agent — or just start the
              transcript — and the words land here and on the call page.
            </p>
            <button
              onClick={openPicker}
              className="flex items-center gap-1.5 rounded-full bg-sol-violet/15 px-3.5 py-1.5 text-[12px] font-medium text-sol-violet transition-colors hover:bg-sol-violet/25"
            >
              <Sparkles className="h-3.5 w-3.5" />
              feed an agent
            </button>
          </div>
        ) : segCount === 0 ? (
          <div className="py-6 text-center text-[12px] text-sol-text-muted">
            Listening — words appear as people speak.
          </div>
        ) : (
          <div className="space-y-1 pb-2">
            {(call?.segments ?? []).map((s: any, i: number, arr: any[]) => {
              const prev = arr[i - 1];
              const newSpeaker = !prev || prev.speaker_id !== s.speaker_id;
              return (
                <div key={s.seq}>
                  {newSpeaker && (
                    <div className={`mt-2.5 font-mono text-[11px] font-medium ${speakerColor(s.speaker_id)}`}>
                      {firstName(s.speaker_name)}
                      <span className="ml-1.5 font-normal text-sol-text-muted">{fmtClock(s.t0)}</span>
                    </div>
                  )}
                  <p className="text-[12.5px] leading-relaxed text-sol-text-secondary">{s.text}</p>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// Attributed captions along the stage bottom — for everyone in the room, not
// just the scribe: the scribe reads its own local tail, everyone else the
// synced one. Lines age out so a lull never shows stale words.
function CaptionsOverlay({
  live,
}: {
  live: { tail: Array<{ speaker_name: string; text: string; at: number }> } | null;
}) {
  const scribe = useSyncExternalStore(subscribeScribe, getScribeStatus, getScribeStatus);
  const now = useCoarseNow(5000);
  const lines = scribe.active
    ? scribe.tail.map((c) => ({ speaker: c.speaker, text: c.text }))
    : (live?.tail ?? [])
        .filter((c) => now - c.at < 45_000)
        .map((c) => ({ speaker: c.speaker_name, text: c.text }));
  if (lines.length === 0) return null;
  return (
    <div className="pointer-events-none mx-auto mb-1 w-full max-w-3xl px-5 pt-1">
      <div className="space-y-0.5">
        {lines.slice(-3).map((c, i, arr) => (
          <div
            key={i}
            className={`text-center text-[13px] leading-snug transition-colors ${
              i === arr.length - 1 ? "text-sol-text" : "text-sol-text-muted"
            }`}
          >
            <span className="font-mono text-[11px] text-sol-cyan">{firstName(c.speaker)}</span>{" "}
            {c.text}
          </div>
        ))}
      </div>
    </div>
  );
}

// The one control bar. Order mirrors frequency of use; the destructive act
// sits alone at the right. Round buttons on a borderless pill: state reads
// by tint (cyan = camera on, violet = sharing, green = transcribing, red =
// muted), never by outline.
const STAGE_CTL = "rounded-full p-2 transition-colors";
const STAGE_CTL_IDLE = "text-sol-text-muted hover:bg-white/10 hover:text-sol-text";
function ControlBar({ call }: { call: any }) {
  const [devicesOpen, setDevicesOpen] = useState(false);

  return (
    <div className="flex items-center justify-center px-5 pb-3 pt-2">
      <div className="flex items-center gap-1 rounded-full bg-white/[0.04] px-2 py-1.5">
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
            className={`${STAGE_CTL} ${STAGE_CTL_IDLE}`}
            iconClassName="h-[18px] w-[18px]"
            align="center"
          />
        )}
        <TranscribeControls />
        <span className="relative">
          <button
            onClick={() => setDevicesOpen((o) => !o)}
            className={`${STAGE_CTL} ${STAGE_CTL_IDLE}`}
            title="Devices"
          >
            <Settings2 className="h-[18px] w-[18px]" />
          </button>
          {devicesOpen && <DevicesPopover onClose={() => setDevicesOpen(false)} />}
        </span>
        <div className="mx-1.5 h-5 w-px bg-white/10" />
        <HangUpButton />
      </div>
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
        <div
          className="absolute bottom-full left-1/2 z-10 mb-3 w-[380px] -translate-x-1/2 rounded-xl bg-sol-bg-alt p-2 shadow-2xl ring-1 ring-white/5"
          onMouseLeave={() => setOpen(false)}
        >
          <div className="mb-1.5 px-1 text-[11px] font-medium text-sol-text-muted">
            Share a screen or window
          </div>
          {sources === null ? (
            <div className="px-1 py-3 text-center text-[11px] text-sol-text-muted">Looking…</div>
          ) : sources.length === 0 ? (
            <div className="px-1 py-3 text-center text-[11px] text-sol-text-muted">
              Nothing to share — check Screen Recording permission in System Settings
            </div>
          ) : (
            <div className="grid max-h-[240px] grid-cols-2 gap-1.5 overflow-y-auto">
              {sources.map((src) => (
                <button
                  key={src.id}
                  onClick={() => {
                    setOpen(false);
                    void setScreenShare(true, src.id);
                  }}
                  className="group flex flex-col gap-1 rounded-md border border-transparent p-1 text-left transition-colors hover:border-sol-violet/50 hover:bg-sol-violet/10"
                  title={src.name}
                >
                  <img
                    src={src.thumbnail}
                    alt=""
                    className="aspect-video w-full rounded-md object-cover"
                  />
                  <span className="truncate text-[10px] text-sol-text-muted group-hover:text-sol-text">
                    {src.name}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </span>
  );
}

function DevicesPopover({ onClose }: { onClose: () => void }) {
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [outs, setOuts] = useState<MediaDeviceInfo[]>([]);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    let alive = true;
    void Promise.all([
      listDevices("audioinput"),
      listDevices("audiooutput"),
      listDevices("videoinput"),
    ]).then(([m, o, c]) => {
      if (!alive) return;
      setMics(m);
      setOuts(o);
      setCams(c);
    });
    return () => {
      alive = false;
    };
  }, []);
  const row = (
    label: string,
    devices: MediaDeviceInfo[],
    kind: "audioinput" | "audiooutput" | "videoinput",
  ) =>
    devices.length > 0 && (
      <label className="block">
        <span className="text-[10px] uppercase tracking-wide text-sol-text-muted">{label}</span>
        <select
          onChange={(e) => void switchDevice(kind, e.target.value)}
          className="mt-0.5 w-full rounded-md bg-sol-bg px-1.5 py-1 text-[11px] text-sol-text outline-none focus:ring-1 focus:ring-sol-cyan/60"
        >
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `${label} ${d.deviceId.slice(0, 4)}`}
            </option>
          ))}
        </select>
      </label>
    );
  return (
    <div
      className="absolute bottom-full left-1/2 z-10 mb-3 w-[240px] -translate-x-1/2 space-y-2 rounded-xl bg-sol-bg-alt p-2.5 shadow-2xl ring-1 ring-white/5"
      onMouseLeave={onClose}
    >
      {row("Microphone", mics, "audioinput")}
      {row("Speaker", outs, "audiooutput")}
      {row("Camera", cams, "videoinput")}
      {/* Not a setting — a fact. The floating circles either follow a face or
          show the middle of the frame, and only this build knows which. */}
      <p className="pt-0.5 text-[10px] leading-snug text-sol-text-muted">{faceTrackingNote()}</p>
    </div>
  );
}
