import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Rnd } from "react-rnd";
import { ChevronUp, Maximize2, Pin, PinOff, Video, VideoOff } from "lucide-react";
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
import { firstName } from "./speakers";
import { useOutgoingRings, useRoomDescription } from "../../hooks/useCallRoom";

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
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const tiles = useSyncExternalStore(subscribeCallTiles, getCallTiles, () => []);
  // New video or a share arriving is the moment the stage earns the room;
  // a media notice opens it too, so its sentence is read.
  const notice = call.phase === "connected" ? call.error : null;
  const remoteVideo = tiles.some((t) => !t.isLocal);
  const prevRemoteVideo = useRef(false);
  useEffect(() => {
    if (notice) setExpanded(true);
    if (remoteVideo && !prevRemoteVideo.current) setExpanded(true);
    prevRemoteVideo.current = remoteVideo;
  }, [notice, remoteVideo]);

  if (call.phase === "idle") return null;
  if (expanded) {
    return <CallStage onCollapse={() => setExpanded(false)} />;
  }
  // Portaled to <body> like the stage: the dock mounts inside the app shell,
  // whose transformed ancestors would otherwise capture a fixed overlay.
  return createPortal(
    pinned ? (
      <MiniWindow
        call={call}
        roster={roster}
        tiles={tiles}
        bounds={bounds ?? defaultBounds()}
        onBounds={setBounds}
        onUnpin={() => setPinned(false)}
        onExpand={() => setExpanded(true)}
      />
    ) : (
      <div className="fixed bottom-20 right-4 z-[150] w-auto max-w-[420px] select-none">
        <div className="rounded-xl border border-sol-border bg-sol-bg-alt/95 shadow-xl backdrop-blur">
          <DockPill
            call={call}
            roster={roster}
            onExpand={() => setExpanded(true)}
            onPin={() => setPinned(true)}
          />
        </div>
      </div>
    ),
    document.body,
  );
}

type Bounds = { x: number; y: number; width: number; height: number };
const MINI_W = 320;
const MINI_H = 250;
// Top right, under the header — where the palette-style overlays live.
function defaultBounds(): Bounds {
  const vw = typeof window === "undefined" ? 1200 : window.innerWidth;
  return { x: Math.max(8, vw - MINI_W - 16), y: 60, width: MINI_W, height: MINI_H };
}

// One sentence for where the call stands, shared by the pill and the window.
// The caller's side of a ring settles it: "ringing sam, ana…" while phones
// ring, "ana declined" / "no answer from sam" for a beat afterwards, then the
// room. One composer (useOutgoingRings) so every surface reads the same words.
function useCallStatusText(call: any, roster: any[]): string {
  const { label } = useRoomDescription(call.roomKey);
  const { ringingLine, settledLine } = useOutgoingRings(call.roomKey);
  return call.phase === "error"
    ? call.error || "Call failed"
    : call.phase === "connecting"
      ? "Connecting…"
      : call.phase === "ringing_out"
        ? "Ringing…"
        : ringingLine ?? (roster.length <= 1 ? settledLine : null) ?? label;
}

function MiniWindow({
  call,
  roster,
  tiles,
  bounds,
  onBounds,
  onUnpin,
  onExpand,
}: {
  call: any;
  roster: any[];
  tiles: ParticipantTile[];
  bounds: Bounds;
  onBounds: (b: Bounds) => void;
  onUnpin: () => void;
  onExpand: () => void;
}) {
  const statusText = useCallStatusText(call, roster);
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
    <div className="pointer-events-none fixed inset-0 z-[150]">
      <Rnd
        position={{ x: bounds.x, y: bounds.y }}
        size={{ width: bounds.width, height: bounds.height }}
        minWidth={240}
        minHeight={180}
        bounds="parent"
        dragHandleClassName="call-window-drag-handle"
        onDragStop={(_e, d) => onBounds({ ...bounds, x: d.x, y: d.y })}
        onResizeStop={(_e, _dir, ref, _delta, position) =>
          onBounds({ x: position.x, y: position.y, width: ref.offsetWidth, height: ref.offsetHeight })
        }
        className="pointer-events-auto"
      >
        <div className="flex h-full w-full select-none flex-col overflow-hidden rounded-xl border border-sol-border bg-sol-bg-alt/95 shadow-2xl backdrop-blur">
          <div className="call-window-drag-handle flex shrink-0 cursor-grab items-center gap-1.5 px-2.5 py-1.5 active:cursor-grabbing">
            <span
              className={`min-w-0 flex-1 truncate font-mono text-[11px] ${
                call.phase === "error" ? "text-sol-red" : "text-sol-text-muted"
              }`}
            >
              {statusText}
            </span>
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
            {call.roomKey && call.phase === "connected" && <AddPeopleButton roomKey={call.roomKey} />}
            <div className="mx-0.5 h-5 w-px bg-sol-border" />
            <HangUpButton size="compact" />
          </div>
        </div>
      </Rnd>
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
      <div className="mx-0.5 h-5 w-px bg-sol-border" />
      {call.roomKey && call.phase === "connected" && (
        <AddPeopleButton roomKey={call.roomKey} />
      )}
      <MicButton muted={call.muted} size="compact" />
      <HangUpButton size="compact" />
    </div>
  );
}
