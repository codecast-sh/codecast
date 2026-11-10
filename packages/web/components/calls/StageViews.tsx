import { useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Maximize2, MicOff, Minimize2, MonitorUp } from "lucide-react";
import { callParticipantKind } from "@codecast/shared/contracts";
import { isOwnScreen, type ParticipantTile } from "../../lib/calls/callMedia";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useNaturalSize, useScreenCursorSender } from "../../hooks/useScreenCursorSender";
import { useShareZoom } from "../../hooks/useShareZoom";
import { ScreenCursors } from "./ScreenCursors";
import { Avatar } from "./Avatar";
import { firstName } from "./speakers";
import { ParticipantTag, PersonName } from "./GuestTag";
import { isMuted, noFollowLeader, SPEAKING_RING, stageLattice, useIsSpeaking, useStageHost } from "./stageHost";
import "./callSurface.css";

// THE STAGE'S PICTURE, apart from the app.
//
// The views a call is seen in (auto, speaker, grid), the one video surface
// they are all built from, and the voice-only faces between them. Two rooms
// draw them: a member's huddle (CallStage, over the app) and a guest's
// (app/meet, a page with no account, no store and no call manager). So
// nothing here reads the store or the member's room. What only a member's
// stage has comes in through the host (StageHostProvider): the room the
// cursors ride on, following someone in the app, and the actions a person
// in the room may take on another (putting a guest out).
//
// A roster row is the call_members projection the stage has always drawn
// from: `{ user_id, user_name, user_image?, muted?, sharing? }`, where
// user_id is the participant's LiveKit identity. A member's roster adds the
// room's guests (`guest:<id>`); a guest's roster is built from the media
// room itself. Either way a guest is marked by identity (PersonName).

function PersonActions(p: { identity: string; name: string; variant: "tile" | "row" }) {
  const host = useStageHost();
  return <>{host.personActions?.(p) ?? null}</>;
}

/** A right click on someone opens what the viewer may do to them (the
 *  host's menu); no host menu, the browser's own. */
function usePersonMenu(identity: string, name: string, self = false): { onContextMenu?: (e: MouseEvent) => void } {
  const host = useStageHost();
  if (!host.openPersonMenu || self || identity === host.selfIdentity) return {};
  return { onContextMenu: (e) => host.openPersonMenu!(e, { identity, name }) };
}

/** Actions beside a centred name, out of the layout: a face whose name row
 *  grew by an invisible button would sit off the line of every other face. */
function SideActions({ identity, name }: { identity: string; name: string }) {
  return (
    <span className="absolute left-full top-1/2 ml-1 -translate-y-1/2">
      <PersonActions identity={identity} name={name} variant="row" />
    </span>
  );
}

/** A box around one person that opens their menu on a right click. */
function PersonMenuArea({ identity, name, className, children }: { identity: string; name: string; className?: string; children: ReactNode }) {
  return (
    <div className={className} {...usePersonMenu(identity, name)}>
      {children}
    </div>
  );
}

// ── Views ─────────────────────────────────────────────────────────────────

/** Somebody on their way into the call: a teammate being rung, or a guest
 *  who was let in and has not connected yet (`note` says which wait it is). */
export type StageGhost = { user_id: string; user_name: string; user_image?: string; note?: string };

// Auto: an active share owns the stage; else adaptive camera grid; else the
// audio-only avatar stage.
export function AutoStage({
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
  /** Who is speaking, for a host with no reactive read of its own (useIsSpeaking). */
  speaking?: ReadonlySet<string>;
  phase: string;
  ringing?: StageGhost[];
  settledLine?: string | null;
}) {
  const [heroKey, setHeroKey] = useState<string | null>(null);
  const hero = (heroKey && screens.find((t) => t.key === heroKey)) || screens[0] || null;
  if (hero) {
    return (
      // The faces file into a strip beside the share, or under it once the
      // view itself is narrow (callSurface.css, .stage-fit): a phone, the
      // call window with the thread open, a rail dragged wide.
      <div className="stage-fit flex min-h-0 min-w-0 flex-1">
      <div className="stage-split flex min-h-0 min-w-0 flex-1 gap-2">
        <div className="relative min-h-0 min-w-0 flex-1">
          <StageVideo tile={hero} speaking={speaking} contain />
          {screens.length > 1 && (
            <div className="absolute left-3 top-3 flex gap-1">
              {screens.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setHeroKey(t.key)}
                  className={`rounded-full px-2.5 py-0.5 font-mono text-meta backdrop-blur transition-colors ${
                    t.key === hero.key
                      ? "bg-sol-violet/30 text-white"
                      : "bg-black/45 text-white/70 hover:text-white"
                  }`}
                >
                  <span className="flex items-center gap-1">
                    {t.isLocal ? "your screen" : `${firstName(t.name)}'s screen`}
                    <ParticipantTag identity={t.identity} />
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        {(cameras.length > 0 || roster.length > 0) && (
          <div className="stage-strip flex w-[clamp(120px,22%,200px)] shrink-0 flex-col gap-2 overflow-y-auto">
            {cameras.map((t) => (
              <StageVideo
                key={t.key}
                tile={t}
                speaking={speaking}
                muted={isMuted(roster, t.identity)}
                small
              />
            ))}
            <VoiceRows roster={roster} cameras={cameras} speaking={speaking} small />
          </div>
        )}
      </div>
      </div>
    );
  }
  if (cameras.length > 0) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
        {/* Every camera gets a cell: as many equal rows as the count needs. */}
        <div className="grid min-h-0 flex-1 gap-2" style={stageLattice(cameras.length)}>
          {cameras.map((t) => (
            <StageVideo
              key={t.key}
              tile={t}
              speaking={speaking}
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

// Speaker: one face owns the stage: whoever spoke last, or whoever the
// viewer pinned. Everything else (faces, shares, voices) files into a strip.
export function SpeakerStage({
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
  /** Who is speaking, for a host with no reactive read of its own (useIsSpeaking). */
  speaking?: ReadonlySet<string>;
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
  const stripVoices = roster.filter(
    (m) => !onCamera.has(String(m.user_id)) && String(m.user_id) !== String(focusMember?.user_id ?? ""),
  );

  return (
    // The strip sits beside the focus, or under it once the view is narrow
    // (callSurface.css, .stage-fit).
    <div className="stage-fit flex min-h-0 min-w-0 flex-1">
    <div className="stage-split flex min-h-0 min-w-0 flex-1 gap-2">
      <div className="relative min-h-0 min-w-0 flex-1">
        {focus ? (
          <StageVideo
            tile={focus}
            speaking={speaking}
            muted={isMuted(roster, focus.identity)}
            contain={focus.kind === "screen"}
          />
        ) : focusMember ? (
          <FocusFace m={focusMember} speaking={speaking} />
        ) : (
          <div className="flex h-full items-center justify-center font-mono text-[13px] text-sol-text-muted">
            just you so far
          </div>
        )}
        {pinned && (
          <button
            onClick={() => onPin(pinned)}
            className="absolute left-3 top-3 rounded-full bg-black/45 px-2.5 py-0.5 font-mono text-meta text-sol-yellow backdrop-blur transition-colors hover:text-white"
            title="Unpin: follow the active speaker again"
          >
            pinned · unpin
          </button>
        )}
      </div>
      {(others.length > 0 || stripVoices.length > 0) && (
        <div className="stage-strip flex w-[clamp(120px,22%,200px)] shrink-0 flex-col gap-2 overflow-y-auto">
          {others.map((t) => (
            <button
              key={t.key}
              onClick={() => onPin(t.identity)}
              title="Pin this tile"
              className="shrink-0 rounded-lg text-left transition-opacity hover:opacity-85"
            >
              <StageVideo
                tile={t}
                speaking={speaking}
                muted={isMuted(roster, t.identity)}
                small
              />
            </button>
          ))}
          {stripVoices.map((m) => (
            <StripVoiceRow key={m.user_id} m={m} speaking={speaking} onPin={onPin} />
          ))}
        </div>
      )}
    </div>
    </div>
  );
}

/** The face that holds the stage in Speaker view when nobody is on camera. */
function FocusFace({ m, speaking }: { m: any; speaking?: ReadonlySet<string> }) {
  const on = useIsSpeaking(String(m.user_id), speaking);
  return (
    <div
      className={`flex h-full w-full flex-col items-center justify-center gap-4 rounded-xl bg-white/[0.05] transition-shadow ${
        on ? SPEAKING_RING : ""
      }`}
    >
      <Avatar m={m} size={120} />
      <span className="flex items-center gap-2 font-mono text-[15px] text-sol-text">
        <PersonName identity={String(m.user_id)} name={m.user_name} />
      </span>
    </div>
  );
}

/** A voice-only person in Speaker view's strip: a press pins them. */
function StripVoiceRow({ m, speaking, onPin }: { m: any; speaking?: ReadonlySet<string>; onPin: (id: string) => void }) {
  const on = useIsSpeaking(String(m.user_id), speaking);
  return (
    <PersonMenuArea identity={String(m.user_id)} name={m.user_name} className="shrink-0">
      <button
        onClick={() => onPin(String(m.user_id))}
        className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/[0.06] ${
          on ? "bg-sol-cyan/10" : ""
        }`}
        title="Pin this person"
      >
        <Avatar m={m} size={24} />
        <PersonName identity={String(m.user_id)} name={m.user_name} className="font-mono text-[12px] text-sol-text" />
        {m.muted && <MicOff className="h-3 w-3 shrink-0 text-sol-text-muted" />}
      </button>
    </PersonMenuArea>
  );
}

// Grid: everyone equal, with cameras, shares, and voice-only faces in one lattice.
export function GridStage({
  roster,
  cameras,
  screens,
  speaking,
}: {
  roster: any[];
  cameras: ParticipantTile[];
  screens: ParticipantTile[];
  /** Who is speaking, for a host with no reactive read of its own (useIsSpeaking). */
  speaking?: ReadonlySet<string>;
}) {
  const onCamera = new Set(cameras.map((c) => c.identity));
  const voices = roster.filter((m) => !onCamera.has(String(m.user_id)));
  const n = screens.length + cameras.length + voices.length;
  return (
    <div className="grid min-h-0 min-w-0 flex-1 gap-2" style={stageLattice(n)}>
      {screens.map((t) => (
        <StageVideo key={t.key} tile={t} speaking={speaking} contain />
      ))}
      {cameras.map((t) => (
        <StageVideo
          key={t.key}
          tile={t}
          speaking={speaking}
          muted={isMuted(roster, t.identity)}
        />
      ))}
      {voices.map((m) => (
        <GridVoiceTile key={m.user_id} m={m} speaking={speaking} />
      ))}
      {n === 0 && (
        <div className="flex items-center justify-center font-mono text-[13px] text-sol-text-muted">
          just you so far
        </div>
      )}
    </div>
  );
}

/** A voice-only person's cell in the grid. */
function GridVoiceTile({ m, speaking }: { m: any; speaking?: ReadonlySet<string> }) {
  const on = useIsSpeaking(String(m.user_id), speaking);
  return (
    <PersonMenuArea
      identity={String(m.user_id)}
      name={m.user_name}
      className={`group flex min-h-0 flex-col items-center justify-center gap-2.5 rounded-xl bg-white/[0.05] transition-shadow ${
        on ? SPEAKING_RING : ""
      }`}
    >
      <Avatar m={m} size={64} />
      <div className="relative flex max-w-full items-center gap-1.5 px-2">
        <PersonName identity={String(m.user_id)} name={m.user_name} className="font-mono text-[12.5px] text-sol-text" />
        {m.muted && <MicOff className="h-3 w-3 shrink-0 text-sol-text-muted" />}
        <SideActions identity={String(m.user_id)} name={m.user_name} />
      </div>
    </PersonMenuArea>
  );
}

// One video surface. `contain` letterboxes (screen shares must not crop);
// cameras cover. The name chip is fixed black-on-white so it reads over any
// video in any theme (the mini window renders these in the app's theme).
// The tile reads its own speaking state (useIsSpeaking), so a change of who
// is talking redraws the tiles it changes and nothing else.
type StageVideoProps = {
  tile: ParticipantTile;
  speaking?: ReadonlySet<string>;
  muted?: boolean;
  small?: boolean;
  contain?: boolean;
};

export function StageVideo(props: StageVideoProps) {
  return isOwnScreen(props.tile) ? <OwnScreenTile tile={props.tile} small={props.small} /> : <TrackVideo {...props} />;
}

// Your own share, as the others see it named, without its picture: the video
// of a screen drawn back onto the screen it captures is the stage inside
// itself, over and over. The tile is what says the share is live.
function OwnScreenTile({ tile, small }: { tile: ParticipantTile; small?: boolean }) {
  return (
    <div
      data-own-screen
      className={`relative flex flex-col items-center justify-center gap-2 overflow-hidden border border-sol-green/25 bg-sol-green/[0.06] ${
        small ? "stage-tile-small aspect-video w-full shrink-0 rounded-lg" : "h-full w-full rounded-xl"
      }`}
    >
      <MonitorUp className={`text-sol-green ${small ? "h-5 w-5" : "h-9 w-9"}`} />
      {!small && <span className="font-mono text-[13px] text-sol-text">your screen is live</span>}
      <span className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-full bg-black/45 px-2 py-px font-mono text-meta text-white/90 backdrop-blur">
        <span className="h-1.5 w-1.5 rounded-full bg-sol-green" />
        <PersonName identity={tile.identity} name={tile.name} you />
        <span className="shrink-0">· screen</span>
      </span>
    </div>
  );
}

function TrackVideo({ tile, speaking: speakingSet, muted, small, contain }: StageVideoProps) {
  const host = useStageHost();
  const speaking = useIsSpeaking(tile.identity, speakingSet);
  const ref = useRef<HTMLVideoElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  useWatchEffect(() => {
    const el = ref.current;
    if (!el) return;
    tile.track.attach(el);
    return () => {
      tile.track.detach(el);
    };
  }, [tile.track]);
  // Cursors ride only a letterboxed share: a cropped one has no honest
  // mapping between the pointer and the share's pixels.
  const cursorsOn = tile.kind === "screen" && !!contain;
  const sender = useScreenCursorSender(tile, ref, host.getRoom);
  // A big share tile can be read at the share's own size or fullscreen
  // (hooks/useShareZoom). The video sits in a frame inside a scroller: fitted,
  // the frame is the tile; at 1:1 it is the share's size and the scroller
  // pans it (a finger pans it natively, and may pinch past 1:1, which on a
  // phone's dense screen is still small). Cursors draw over the frame, so
  // they map in both. On a touch screen the zoom pill shows at rest: there
  // is no hover to reveal it.
  const zoomable = cursorsOn && !small;
  const scrollRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const natural = useNaturalSize(ref, tile.track);
  const zoom = useShareZoom(boxRef, scrollRef, natural, zoomable, ref);
  const menu = usePersonMenu(tile.identity, tile.name, tile.isLocal);
  return (
    <div
      ref={boxRef}
      {...menu}
      data-sv-screen-tile={cursorsOn ? "cursors" : undefined}
      onPointerMove={cursorsOn ? sender.onPointerMove : undefined}
      onPointerLeave={cursorsOn ? sender.onPointerLeave : undefined}
      onDoubleClick={zoom.canFullscreen ? zoom.toggleFullscreen : undefined}
      className={`group relative overflow-hidden bg-black/60 transition-shadow duration-300 ${
        speaking ? SPEAKING_RING : ""
      } ${small ? "stage-tile-small aspect-video w-full shrink-0 rounded-lg" : "h-full w-full rounded-xl"}`}
    >
      <div
        ref={scrollRef}
        {...zoom.panHandlers}
        className={`absolute inset-0 flex ${zoom.actual ? "cursor-grab touch-pan-x touch-pan-y touch-pinch-zoom overflow-auto active:cursor-grabbing" : "overflow-hidden"}`}
      >
        <div
          ref={frameRef}
          className={`relative shrink-0 ${zoom.actual ? "m-auto" : "h-full w-full"}`}
          style={zoom.actualSize ?? undefined}
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
          {cursorsOn && <ScreenCursors tile={tile} boxRef={frameRef} videoRef={ref} getRoom={host.getRoom} />}
        </div>
      </div>
      <span className="absolute bottom-2 left-2 flex items-center gap-1.5">
        <span
          className={`flex items-center gap-1.5 rounded-full bg-black/45 font-mono text-white/90 backdrop-blur ${
            small ? "px-2 py-px text-meta" : "px-2.5 py-0.5 text-[12px]"
          }`}
        >
          <PersonName identity={tile.identity} name={tile.name} you={tile.isLocal} />
          {tile.kind === "screen" ? <span className="shrink-0">· screen</span> : null}
          {muted && tile.kind === "camera" && <MicOff className="h-3 w-3 text-sol-red/90" />}
        </span>
        {/* Follow them in the app. A shared screen carries it at rest: that
            is the moment it is for. A camera tile reveals it on hover. An
            agent's face has no app to follow, and neither has a guest. */}
        {!small && host.FollowChip && callParticipantKind(tile.identity) === "person" && (
          <host.FollowChip identity={tile.identity} name={tile.name} variant="tile" always={tile.kind === "screen"} />
        )}
        {!small && !tile.isLocal && <PersonActions identity={tile.identity} name={tile.name} variant="tile" />}
      </span>
      {zoomable && (
        <span
          onDoubleClick={(e) => e.stopPropagation()}
          className={`absolute bottom-2 right-2 flex items-center gap-0.5 rounded-full bg-black/45 p-0.5 font-mono text-meta text-white/85 backdrop-blur transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100 ${
            zoom.actual || zoom.fullscreen ? "opacity-100" : "opacity-0"
          }`}
        >
          <button
            type="button"
            onClick={zoom.toggleActual}
            className={`rounded-full px-2 py-0.5 transition-colors hover:bg-white/15 hover:text-white ${zoom.actual ? "bg-white/20 text-white" : ""}`}
            title={zoom.actual ? "Fit the share to the tile" : "Show the share at its real size, one pixel per pixel. Drag to pan"}
            aria-pressed={zoom.actual}
          >
            {zoom.actual ? "fit" : "1:1"}
          </button>
          {zoom.canFullscreen && (
            <button
              type="button"
              onClick={zoom.toggleFullscreen}
              className="rounded-full p-1 transition-colors hover:bg-white/15 hover:text-white"
              title={zoom.fullscreen ? "Exit fullscreen" : "Fullscreen (or double-click the share)"}
              aria-label={zoom.fullscreen ? "Exit fullscreen" : "Fullscreen"}
            >
              {zoom.fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </button>
          )}
        </span>
      )}
    </div>
  );
}

// Roster rows for people who are voice-only while others are on camera.
export function VoiceRows({
  roster,
  cameras,
  speaking,
  small,
}: {
  roster: any[];
  cameras: ParticipantTile[];
  speaking?: ReadonlySet<string>;
  small?: boolean;
}) {
  const onCamera = new Set(cameras.map((c) => c.identity));
  const voices = roster.filter((m) => !onCamera.has(String(m.user_id)));
  const host = useStageHost();
  const followLeaderId = (host.useFollowLeader ?? noFollowLeader)();
  if (voices.length === 0) return null;
  return (
    // In the strip a column of rows, or one row of them once the strip runs
    // under the share (callSurface.css, .stage-voices).
    <div className={small ? "stage-voices flex shrink-0 flex-col gap-1" : "flex flex-wrap gap-2"}>
      {/* A row wraps rather than squeeze: in the 200px side column a guest's
          remove, once pressed, asks "remove Pat?" and offers the link too,
          and on one line that crushed the face and the name it is asking
          about. Its actions take their own line instead. */}
      {voices.map((m) => (
        <VoiceRow key={m.user_id} m={m} speaking={speaking} followed={followLeaderId === String(m.user_id)} />
      ))}
    </div>
  );
}

function VoiceRow({ m, speaking, followed }: { m: any; speaking?: ReadonlySet<string>; followed: boolean }) {
  const host = useStageHost();
  const on = useIsSpeaking(String(m.user_id), speaking);
  return (
    <PersonMenuArea
      identity={String(m.user_id)}
      name={m.user_name}
      className={`group flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-2 py-1.5 transition-colors ${
        on ? "bg-sol-cyan/10" : ""
      }`}
    >
      <Avatar m={m} size={22} followed={followed} />
      <PersonName identity={String(m.user_id)} name={m.user_name} className="font-mono text-[12px] text-sol-text" />
      {m.muted && <MicOff className="h-3 w-3 shrink-0 text-sol-text-muted" />}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        <PersonActions identity={String(m.user_id)} name={m.user_name} variant="row" />
        {host.FollowChip && callParticipantKind(String(m.user_id)) === "person" && (
          <host.FollowChip identity={String(m.user_id)} name={m.user_name} variant="row" />
        )}
      </span>
    </PersonMenuArea>
  );
}

/** The voice-only stage's face size and spacing by how many faces it holds:
 *  a dozen 88px faces overflow a call window, so a big room steps down. */
function audioFaceScale(n: number): { size: number; gap: string } {
  return n > 9 ? { size: 48, gap: "gap-4" } : n > 6 ? { size: 64, gap: "gap-6" } : { size: 88, gap: "gap-10" };
}

// Nobody on camera: large avatars breathing on the stage, speaking ring live.
export function AudioOnlyStage({
  roster,
  speaking,
  phase,
  ringing = [],
  settledLine,
}: {
  roster: any[];
  speaking?: ReadonlySet<string>;
  phase: string;
  ringing?: StageGhost[];
  settledLine?: string | null;
}) {
  const inRoom = new Set(roster.map((m) => String(m.user_id)));
  // People we are ringing take a seat before they answer: a breathing,
  // translucent face with "ringing…" under it, so a group start reads as
  // "these three are on their way" rather than "just you so far". A guest
  // who was let in and is still on the way in sits the same way.
  const ghosts = ringing.filter((r) => !inRoom.has(r.user_id));
  const scale = audioFaceScale(roster.length + ghosts.length);
  return (
    // Centred while the faces fit, scrolled once they do not: the auto
    // margins collapse instead of pushing the first row up under the header.
    <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center overflow-y-auto">
      <div className="my-auto flex w-full flex-col items-center gap-6 py-2">
      <div className={`flex flex-wrap items-center justify-center ${scale.gap}`}>
        {roster.length === 0 && ghosts.length === 0 && (
          <span className="font-mono text-[13px] text-sol-text-muted">
            {phase === "connecting" ? "connecting…" : phase === "ringing_out" ? "ringing…" : "just you so far"}
          </span>
        )}
        {ghosts.map((r) => (
          <div key={`ring:${r.user_id}`} className="flex flex-col items-center gap-3 opacity-60">
            <div className="animate-pulse rounded-full ring-2 ring-sol-violet/40 ring-offset-4 ring-offset-sol-base03">
              <Avatar m={r} size={scale.size} />
            </div>
            <span className="flex items-center gap-1.5 font-mono text-[12.5px] text-sol-text-muted">
              {firstName(r.user_name)}
              <ParticipantTag identity={r.user_id} />
              <span>· {r.note ?? "ringing…"}</span>
            </span>
          </div>
        ))}
        {roster.map((m) => (
          <AudioFace key={m.user_id} m={m} size={scale.size} speaking={speaking} />
        ))}
      </div>
      {settledLine && (
        <span className="font-mono text-[12px] text-sol-text-muted">
          {settledLine.toLowerCase()}
        </span>
      )}
      </div>
    </div>
  );
}

function AudioFace({ m, size, speaking }: { m: any; size: number; speaking?: ReadonlySet<string> }) {
  const on = useIsSpeaking(String(m.user_id), speaking);
  return (
    <PersonMenuArea identity={String(m.user_id)} name={m.user_name} className="group flex flex-col items-center gap-3">
      <div
        className={`rounded-full transition-all duration-300 ${
          on ? "ring-2 ring-sol-cyan/80 ring-offset-4 ring-offset-sol-base03 shadow-[0_0_0_8px_rgba(42,161,152,0.14)]" : ""
        }`}
      >
        <Avatar m={m} size={size} />
      </div>
      <div className="relative flex max-w-[160px] items-center gap-1.5">
        <PersonName identity={String(m.user_id)} name={m.user_name} className="font-mono text-[13px] text-sol-text" />
        {m.muted && <MicOff className="h-3 w-3 shrink-0 text-sol-text-muted" />}
        {m.sharing && <MonitorUp className="h-3 w-3 shrink-0 text-sol-violet" />}
        <SideActions identity={String(m.user_id)} name={m.user_name} />
      </div>
    </PersonMenuArea>
  );
}


