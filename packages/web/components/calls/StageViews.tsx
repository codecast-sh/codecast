import { useRef, useState } from "react";
import { Maximize2, MicOff, Minimize2, MonitorUp } from "lucide-react";
import { callParticipantKind } from "@codecast/shared/contracts";
import type { ParticipantTile } from "../../lib/calls/callMedia";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useNaturalSize, useScreenCursorSender } from "../../hooks/useScreenCursorSender";
import { useShareZoom } from "../../hooks/useShareZoom";
import { ScreenCursors } from "./ScreenCursors";
import { Avatar } from "./Avatar";
import { firstName } from "./speakers";
import { ParticipantTag, PersonName } from "./GuestTag";
import { isMuted, noFollowLeader, SPEAKING_RING, useStageHost } from "./stageHost";

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

/** Actions beside a centred name, out of the layout: a face whose name row
 *  grew by an invisible button would sit off the line of every other face. */
function SideActions({ identity, name }: { identity: string; name: string }) {
  return (
    <span className="absolute left-full top-1/2 ml-1 -translate-y-1/2">
      <PersonActions identity={identity} name={name} variant="row" />
    </span>
  );
}

// ── Views ─────────────────────────────────────────────────────────────────

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
                  {t.isLocal ? (
                    "your screen"
                  ) : (
                    <span className="flex items-center gap-1">
                      {`${firstName(t.name)}'s screen`}
                      <ParticipantTag identity={t.identity} />
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        {(cameras.length > 0 || roster.length > 0) && (
          // On a phone the strip runs under the share instead of beside it:
          // a 200px column would leave the share a third of the screen.
          <div className="ml-2 flex w-[200px] shrink-0 flex-col gap-2 overflow-y-auto max-sm:ml-0 max-sm:mt-2 max-sm:w-full max-sm:flex-row max-sm:items-center max-sm:overflow-x-auto max-sm:overflow-y-hidden">
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
            <span className="flex items-center gap-2 font-mono text-[15px] text-sol-text">
              <PersonName identity={String(focusMember.user_id)} name={focusMember.user_name} />
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
            title="Unpin: follow the active speaker again"
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
              <PersonName identity={String(m.user_id)} name={m.user_name} className="font-mono text-[12px] text-sol-text" />
              {m.muted && <MicOff className="h-3 w-3 shrink-0 text-sol-text-muted" />}
            </button>
          ))}
      </div>
    </div>
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
          className={`group flex flex-col items-center justify-center gap-2.5 rounded-xl bg-white/[0.05] transition-shadow ${
            speaking.has(String(m.user_id)) ? SPEAKING_RING : ""
          }`}
        >
          <Avatar m={m} size={64} />
          <div className="relative flex max-w-full items-center gap-1.5 px-2">
            <PersonName identity={String(m.user_id)} name={m.user_name} className="font-mono text-[12.5px] text-sol-text" />
            {m.muted && <MicOff className="h-3 w-3 shrink-0 text-sol-text-muted" />}
            <SideActions identity={String(m.user_id)} name={m.user_name} />
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
  const host = useStageHost();
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
  // pans it. Cursors draw over the frame, so they map in both.
  const zoomable = cursorsOn && !small;
  const scrollRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const natural = useNaturalSize(ref, tile.track);
  const zoom = useShareZoom(boxRef, scrollRef, natural, zoomable);
  return (
    <div
      ref={boxRef}
      data-sv-screen-tile={cursorsOn ? "cursors" : undefined}
      onPointerMove={cursorsOn ? sender.onPointerMove : undefined}
      onPointerLeave={cursorsOn ? sender.onPointerLeave : undefined}
      onDoubleClick={zoom.canFullscreen ? zoom.toggleFullscreen : undefined}
      className={`group relative overflow-hidden bg-black/60 transition-shadow duration-300 ${
        speaking ? SPEAKING_RING : ""
      } ${small ? "aspect-video w-full rounded-lg max-sm:w-36 max-sm:shrink-0" : "h-full w-full rounded-xl"}`}
    >
      <div
        ref={scrollRef}
        {...zoom.panHandlers}
        className={`absolute inset-0 flex ${zoom.actual ? "cursor-grab overflow-auto active:cursor-grabbing" : "overflow-hidden"}`}
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
            small ? "px-2 py-px text-[11px]" : "px-2.5 py-0.5 text-[12px]"
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
          className={`absolute bottom-2 right-2 flex items-center gap-0.5 rounded-full bg-black/45 p-0.5 font-mono text-[11.5px] text-white/85 backdrop-blur transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100 ${
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
  speaking: Set<string>;
  small?: boolean;
}) {
  const onCamera = new Set(cameras.map((c) => c.identity));
  const voices = roster.filter((m) => !onCamera.has(String(m.user_id)));
  const host = useStageHost();
  const followLeaderId = (host.useFollowLeader ?? noFollowLeader)();
  if (voices.length === 0) return null;
  return (
    <div className={small ? "space-y-1 max-sm:flex max-sm:shrink-0 max-sm:gap-1 max-sm:space-y-0" : "flex flex-wrap gap-2"}>
      {voices.map((m) => (
        <div
          key={m.user_id}
          className={`group flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors ${
            speaking.has(String(m.user_id)) ? "bg-sol-cyan/10" : ""
          }`}
        >
          <Avatar m={m} size={22} followed={followLeaderId === String(m.user_id)} />
          <PersonName identity={String(m.user_id)} name={m.user_name} className="font-mono text-[12px] text-sol-text" />
          {m.muted && <MicOff className="h-3 w-3 shrink-0 text-sol-text-muted" />}
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <PersonActions identity={String(m.user_id)} name={m.user_name} variant="row" />
            {host.FollowChip && callParticipantKind(String(m.user_id)) === "person" && (
              <host.FollowChip identity={String(m.user_id)} name={m.user_name} variant="row" />
            )}
          </span>
        </div>
      ))}
    </div>
  );
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
          <div key={m.user_id} className="group flex flex-col items-center gap-3">
            <div
              className={`rounded-full transition-all duration-300 ${
                speaking.has(String(m.user_id))
                  ? "ring-2 ring-sol-cyan/80 ring-offset-4 ring-offset-sol-base03 shadow-[0_0_0_8px_rgba(42,161,152,0.14)]"
                  : ""
              }`}
            >
              <Avatar m={m} size={88} />
            </div>
            <div className="relative flex max-w-[160px] items-center gap-1.5">
              <PersonName identity={String(m.user_id)} name={m.user_name} className="font-mono text-[13px] text-sol-text" />
              {m.muted && <MicOff className="h-3 w-3 shrink-0 text-sol-text-muted" />}
              {m.sharing && <MonitorUp className="h-3 w-3 shrink-0 text-sol-violet" />}
              <SideActions identity={String(m.user_id)} name={m.user_name} />
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


