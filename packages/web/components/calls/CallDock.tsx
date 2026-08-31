import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AppWindow, ChevronUp, Maximize2, Pin, PinOff, Video, VideoOff } from "lucide-react";
import { useTrackedStore } from "../../store/inboxStore";
import {
  getCallTiles,
  setCamera,
  subscribeCallTiles,
  type ParticipantTile,
} from "../../lib/calls/callManager";
import { Avatar, CallStage, StageVideo } from "./CallStage";
import { AvatarImg } from "../../lib/avatarCache";
import { AddPeopleButton } from "./AddPeople";
import { HangUpButton, MicButton } from "./CallControls";
import { RoomKnocks, RoomLockButton } from "./RoomDoor";
import { WalkieBanner } from "./WalkieDock";
import { callDockSurface, useWalkieStatus } from "../../hooks/useWalkie";
import { CallSurfaceRoot, surfaceShape, useSurfaceHandles } from "./CallSurfaceRoot";
import { firstName } from "./speakers";
import { useOutgoingRings, useRoomDescription } from "../../hooks/useCallRoom";
import { POP_OUT_CALL_TITLE, canPopOutCall, isCallPanelWindow } from "../../lib/desktop";
import { useDesktopWindowRole } from "../../hooks/useDesktopWindowRole";
import { popOutCall } from "../../lib/calls/popOutCall";
import {
  getJoinAnnouncement,
  joinTitle,
  subscribeJoinAnnouncement,
} from "../../lib/calls/joinAnnounce";

// The in-call surface while the stage is collapsed, on every tab, only while
// a call exists (call.phase !== idle). Two shapes, chosen by the pin:
//
//   PINNED (default) — a small floating window, like the palette: it sits on
//   top of the work, shows the people (video tiles, or faces when audio only)
//   and the three controls that matter mid-call. Drag it anywhere, resize it,
//   or expand it into the full stage.
//   UNPINNED — the compact pill above the composer: faces, status, mute, end.
//   For when the window is in the way but the call goes on.
//
// All state reads are local-first — the store's ephemeral call slice and the
// occupancy sync — so every control paints its result synchronously.
export function CallDock() {
  const s = useTrackedStore([
    (st: any) => st.call,
    (st: any) => st.call.roomKey ? st.callOccupancy[st.call.roomKey] : undefined,
  ]);
  const call = s.call;
  const roster: any[] = (call.roomKey && s.callOccupancy[call.roomKey]) || [];
  const [expanded, setExpanded] = useState(false);
  const [pinned, setPinned] = useState(true);
  const tiles = useSyncExternalStore(subscribeCallTiles, getCallTiles, () => []);
  const walkie = useWalkieStatus();
  const role = useDesktopWindowRole();
  // New video or a share arriving is the moment the stage earns the room;
  // a media notice opens it too, so its sentence is read.
  const notice = call.phase === "connected" ? call.error : null;
  const remoteVideo = tiles.some((t) => !t.isLocal);
  const seenMedia = useRef({ video: false, notice: false });

  // Which of the four surfaces this is, decided once, by the lookup that lives
  // beside the walkie because it is a fact about the walkie.
  const surface = callDockSurface(walkie, call, {
    expanded,
    video: remoteVideo || !!call.camera || !!call.sharing,
  });
  const walkieOwns = surface === "walkie";

  // THE STAGE BELONGS TO THE CALL THAT WAS EXPANDED, and to no call after it
  // (ct-45974). Nothing used to put `expanded` back: this component is mounted
  // for the life of the page and merely returns null when there is nothing to
  // show, so one expanded huddle left the flag true forever — and the next
  // call, or the next walkie burst, opened full screen by itself. One line
  // where the flag lives, settled during the render that sees the change:
  // React throws the first pass away, so there is no committed frame in
  // between and no second paint.
  if (expanded && surface === "none") setExpanded(false);

  // Remote video or a media notice ARRIVING is the moment a huddle earns the
  // stage. Never over a burst: three seconds of somebody's voice has not earned
  // the screen, and the flag would outlive the burst and take the surface from
  // every later one.
  //
  // Both are edges, and that is what lets a collapse stick: a notice sits in
  // `call.error` for as long as the call has one, so "it is set" would re-open
  // the stage on the very next render after the person closed it. Settled in
  // the render that sees the change, beside the reset above, rather than in an
  // effect whose dependency list would have to carry the same edge anyway.
  const arrived = (remoteVideo && !seenMedia.current.video) || (!!notice && !seenMedia.current.notice);
  seenMedia.current = { video: remoteVideo, notice: !!notice };
  if (arrived && !walkieOwns && !expanded) setExpanded(true);

  if (surface === "none") return null;
  // The call has a window of its own, and it is not this one. Every other
  // window stands down from the dock rather than drawing a second set of
  // controls for a microphone it does not hold — the elsewhere pill says where
  // to look instead. Below the walkie branches on purpose: a burst is not the
  // panel's business, and the strip stays wherever it lands. This window's own
  // call state goes idle a moment later anyway, when the panel's join evicts
  // it; the gate is what keeps two docks off the screen during that moment.
  if (surface !== "walkie" && role.callPanel && !isCallPanelWindow()) return null;

  // ONE ROOT, whichever shape the corner is holding. The strip, the pill and
  // the floating window are contents of the same node, so a burst becoming a
  // call is that node changing shape (CallSurfaceRoot) instead of one surface
  // being destroyed and another built. The stage is the exception the other
  // way round: it draws its own full-screen surface, so the root goes empty and
  // simply grows into it.
  const shape = surfaceShape(surface, pinned);
  return (
    <>
      <CallSurfaceRoot shape={shape}>
        {surface === "walkie" ? (
          <WalkieBanner />
        ) : surface === "dock" ? (
          pinned ? (
            <MiniWindow
              call={call}
              roster={roster}
              tiles={tiles}
              onUnpin={() => setPinned(false)}
              onExpand={() => setExpanded(true)}
            />
          ) : (
            <div className="rounded-xl border border-sol-border bg-sol-bg-alt/95 shadow-xl backdrop-blur">
              {call.roomKey && call.phase === "connected" && <RoomKnocks roomKey={call.roomKey} />}
              <DockPill
                call={call}
                roster={roster}
                onExpand={() => setExpanded(true)}
                onPin={() => setPinned(true)}
              />
            </div>
          )
        ) : null}
      </CallSurfaceRoot>
      {surface === "stage" && <CallStage onCollapse={() => setExpanded(false)} />}
    </>
  );
}

// One sentence for where the call stands, shared by the pill and the window.
// The caller's side of a ring settles it: "ringing sam, ana…" while phones
// ring, "ana declined" / "no answer from sam" for a beat afterwards, then the
// room. One composer (useOutgoingRings) so every surface reads the same words.
function useCallStatusText(call: any, roster: any[]): string {
  const { label } = useRoomDescription(call.roomKey);
  const { ringingLine, settledLine } = useOutgoingRings(call.roomKey);
  // THE JOIN, FOR THE FOUR SECONDS IT IS NEWS. A burst turning into a call is
  // the biggest thing the walkie does and the sender used to meet it as a
  // surface swap and nothing else — the strip became this window, the mic
  // stayed open, and no words anywhere said why. Its own line rather than a
  // branch in the chain below: it outranks the room's name for a moment and
  // then stops existing, which is not a phase and must not become one.
  const announcement = useSyncExternalStore(
    subscribeJoinAnnouncement,
    getJoinAnnouncement,
    () => null,
  );
  const text =
    call.phase === "error"
      ? call.error || "Call failed"
      : call.phase === "connecting"
        ? "Connecting…"
        : call.phase === "ringing_out"
          ? "Ringing…"
          : ringingLine ?? (roster.length <= 1 ? settledLine : null) ?? label;
  // An error still wins: a call that failed is not a call anybody joined.
  if (call.phase === "error") return text;
  return joinTitle(announcement, call.roomKey, Date.now(), text);
}

function MiniWindow({
  call,
  roster,
  tiles,
  onUnpin,
  onExpand,
}: {
  call: any;
  roster: any[];
  tiles: ParticipantTile[];
  onUnpin: () => void;
  onExpand: () => void;
}) {
  const statusText = useCallStatusText(call, roster);
  // The box belongs to the root now: it is anchored to the corner the strip
  // shares, clamped into the viewport on every layout, and this window only
  // says which parts of itself are a handle.
  const handles = useSurfaceHandles();
  const speaking = useMemo(() => new Set<string>(call.speaking), [call.speaking]);
  // Others first — their screens, then their faces — and your own camera last,
  // so the window shows the people you are talking to, not a mirror.
  const video = useMemo(
    () =>
      [...tiles].sort(
        (a, b) =>
          Number(a.isLocal) - Number(b.isLocal) ||
          Number(a.kind === "camera") - Number(b.kind === "camera"),
      ),
    [tiles],
  );
  const cols = video.length <= 1 ? 1 : 2;

  return (
    <div className="relative flex h-full w-full select-none flex-col overflow-hidden rounded-xl border border-sol-border bg-sol-bg-alt/95 shadow-2xl backdrop-blur">
      <div
        className="call-surface-grip"
        onPointerDown={handles?.onResize}
        aria-hidden="true"
      />
      <div
        className="call-window-drag-handle flex shrink-0 cursor-grab items-center gap-1.5 px-2.5 py-1.5 active:cursor-grabbing"
        onPointerDown={handles?.onMove}
      >
        <span
          className={`min-w-0 flex-1 truncate font-mono text-[11px] ${
            call.phase === "error" ? "text-sol-red" : "text-sol-text-muted"
          }`}
        >
          {statusText}
        </span>
        <PopOutCallButton />
        <button
          onClick={onExpand}
          className="rounded p-1 text-sol-text-dim transition-colors hover:bg-sol-bg-highlight hover:text-sol-text"
          title="Expand to the full stage"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={onUnpin}
          className="rounded p-1 text-sol-text-dim transition-colors hover:bg-sol-bg-highlight hover:text-sol-text"
          title="Unpin — shrink to the pill, the call continues"
        >
          <PinOff className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 px-2">
        {video.length > 0 ? (
          <div
            className="grid h-full min-h-0 gap-1.5"
            style={{
              gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
              gridAutoRows: "minmax(0, 1fr)",
            }}
          >
            {video.map((t) => (
              <StageVideo
                key={t.key}
                tile={t}
                speaking={speaking.has(t.identity)}
                contain={t.kind === "screen"}
              />
            ))}
          </div>
        ) : (
          <div className="flex h-full flex-wrap content-center items-center justify-center gap-4">
            {roster.length === 0 && (
              <span className="inline-block h-10 w-10 animate-pulse rounded-full bg-sol-bg-highlight" />
            )}
            {roster.map((m) => (
              <div key={m.user_id} className="flex flex-col items-center gap-1.5">
                <div
                  className={`rounded-full transition-all duration-300 ${
                    speaking.has(String(m.user_id))
                      ? "ring-2 ring-sol-cyan/70 ring-offset-2 ring-offset-sol-bg-alt"
                      : ""
                  }`}
                >
                  <Avatar m={m} size={44} />
                </div>
                <span className="font-mono text-[11px] text-sol-text-muted">{firstName(m.user_name)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {call.roomKey && call.phase === "connected" && <RoomKnocks roomKey={call.roomKey} />}

      <div className="flex shrink-0 items-center justify-center gap-1 px-2 py-1.5">
        <MicButton muted={call.muted} size="compact" />
        <button
          onClick={() => void setCamera(!call.camera)}
          className={`rounded-md p-1.5 transition-colors ${
            call.camera ? "bg-sol-cyan/15 text-sol-cyan" : "text-sol-text-muted hover:bg-sol-bg-highlight"
          }`}
          title={call.camera ? "Turn camera off" : "Turn camera on"}
        >
          {call.camera ? <Video className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
        </button>
        {call.roomKey && call.phase === "connected" && (
          <>
            <AddPeopleButton roomKey={call.roomKey} />
            <RoomLockButton roomKey={call.roomKey} />
          </>
        )}
        <div className="mx-0.5 h-5 w-px bg-sol-border" />
        <HangUpButton size="compact" />
      </div>
    </div>
  );
}

function DockPill({
  call,
  roster,
  onExpand,
  onPin,
}: {
  call: any;
  roster: any[];
  onExpand: () => void;
  onPin: () => void;
}) {
  const speaking = new Set<string>(call.speaking);
  const statusText = useCallStatusText(call, roster);

  return (
    <div className="flex items-center gap-1.5 px-3 py-2">
      <button
        onClick={onExpand}
        className="flex items-center gap-2 rounded-md px-1 py-0.5 transition-colors hover:bg-sol-bg-highlight"
        title="Expand to the full stage"
      >
        <div className="flex -space-x-2">
          {roster.slice(0, 4).map((m) => (
            <span
              key={m.user_id}
              className={`relative inline-block h-6 w-6 overflow-hidden rounded-full border border-sol-bg transition-shadow ${
                speaking.has(String(m.user_id))
                  ? "ring-2 ring-sol-cyan"
                  : ""
              }`}
            >
              <AvatarImg
                src={m.user_image}
                alt=""
                className="h-full w-full object-cover"
                fallback={
                  <span className="flex h-full w-full items-center justify-center bg-sol-bg-highlight text-[10px] text-sol-text-muted">
                    {(m.user_name || "?").charAt(0).toUpperCase()}
                  </span>
                }
              />
            </span>
          ))}
          {roster.length === 0 && (
            <span className="inline-block h-6 w-6 animate-pulse rounded-full bg-sol-bg-highlight" />
          )}
        </div>
        <span
          className={`max-w-[140px] truncate text-xs ${call.phase === "error" ? "text-sol-red" : "text-sol-text-muted"}`}
        >
          {statusText}
        </span>
        <ChevronUp className="h-3.5 w-3.5 text-sol-text-dim" />
      </button>
      <button
        onClick={onPin}
        className="rounded-md p-1.5 text-sol-text-dim transition-colors hover:bg-sol-bg-highlight hover:text-sol-text"
        title="Pin — float a small window with the people on the call"
      >
        <Pin className="h-4 w-4" />
      </button>
      <PopOutCallButton className="rounded-md p-1.5 text-sol-text-dim transition-colors hover:bg-sol-bg-highlight hover:text-sol-text" iconClassName="h-4 w-4" />
      <div className="mx-0.5 h-5 w-px bg-sol-border" />
      {call.roomKey && call.phase === "connected" && (
        <>
          <AddPeopleButton roomKey={call.roomKey} />
          <RoomLockButton roomKey={call.roomKey} />
        </>
      )}
      <MicButton muted={call.muted} size="compact" />
      <HangUpButton size="compact" />
    </div>
  );
}

/**
 * Give the call a window of its own.
 *
 * Desktop only, and ABSENT rather than degraded anywhere else: the ladder
 * behind it (lib/calls/popOutCall) has no browser rung on purpose, so a browser
 * has no gesture to offer and offering one would only produce the Chrome popup
 * this panel exists to make impossible. It hides inside the panel too, where
 * the call already has its window.
 */
function PopOutCallButton({
  className = "rounded p-1 text-sol-text-dim transition-colors hover:bg-sol-bg-highlight hover:text-sol-text",
  iconClassName = "h-3.5 w-3.5",
}: {
  className?: string;
  iconClassName?: string;
}) {
  if (!canPopOutCall()) return null;
  return (
    <button
      type="button"
      onClick={() => void popOutCall()}
      className={className}
      title={POP_OUT_CALL_TITLE}
      aria-label={POP_OUT_CALL_TITLE}
    >
      <AppWindow className={iconClassName} />
    </button>
  );
}
