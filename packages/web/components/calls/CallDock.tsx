import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  Video,
  VideoOff,
  ChevronUp,
  ChevronDown,
  ExternalLink,
} from "lucide-react";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import {
  getCallTiles,
  getMicLevel,
  subscribeMicLevel,
  leaveCall,
  listDevices,
  setCamera,
  setMuted,
  setScreenShare,
  subscribeCallTiles,
  switchDevice,
  type ParticipantTile,
} from "../../lib/calls/callManager";
import { parseRoomKey } from "@codecast/shared/contracts";

// The in-call surface: a floating pill above the composer, on every tab, only
// while a call exists (call.phase !== idle). Expanded, it grows the roster,
// device pickers and video/screen tiles. All state reads are local-first —
// the store's ephemeral call slice and the occupancy sync — so every control
// paints its result synchronously.
export function CallDock() {
  const s = useTrackedStore([
    (st: any) => st.call,
    (st: any) => st.call.roomKey ? st.callOccupancy[st.call.roomKey] : undefined,
  ]);
  const call = s.call;
  const roster: any[] = (call.roomKey && s.callOccupancy[call.roomKey]) || [];
  const [expanded, setExpanded] = useState(false);
  const tiles = useSyncExternalStore(subscribeCallTiles, getCallTiles, () => []);
  // A media notice while connected (camera blocked, share refused) opens the
  // panel so its message is read — the pill has no room for a sentence.
  const notice = call.phase === "connected" ? call.error : null;
  useEffect(() => {
    if (notice) setExpanded(true);
  }, [notice]);

  if (call.phase === "idle") return null;
  return (
    <div className="fixed bottom-20 right-4 z-[70] w-auto max-w-[420px] select-none">
      <div className="rounded-xl border border-sol-border bg-sol-bg-alt/95 shadow-xl backdrop-blur">
        {expanded && (
          <ExpandedPanel call={call} roster={roster} tiles={tiles} />
        )}
        <DockPill
          call={call}
          roster={roster}
          expanded={expanded}
          onToggleExpand={() => setExpanded((e) => !e)}
        />
      </div>
    </div>
  );
}

function roomLabel(roomKey: string | null, roster: any[]): string {
  if (!roomKey) return "Huddle";
  const parsed = parseRoomKey(roomKey);
  if (parsed?.kind === "channel") return "Channel huddle";
  if (parsed?.kind === "session") return "Session huddle";
  const others = roster.filter((r) => r);
  if (others.length <= 2) {
    return others.map((r) => firstName(r.user_name)).join(" & ") || "Huddle";
  }
  return `Huddle · ${others.length}`;
}

function firstName(name: string | undefined): string {
  return (name || "").split(/\s+/)[0] || "Teammate";
}

function DockPill({
  call,
  roster,
  expanded,
  onToggleExpand,
}: {
  call: any;
  roster: any[];
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const speaking = new Set<string>(call.speaking);
  const statusText =
    call.phase === "error"
      ? call.error || "Call failed"
      : call.phase === "connecting"
        ? "Connecting…"
        : call.phase === "ringing_out"
          ? "Ringing…"
          : roomLabel(call.roomKey, roster);

  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <button
        onClick={onToggleExpand}
        className="flex items-center gap-2 rounded-md px-1 py-0.5 transition-colors hover:bg-sol-base02/60"
        title={expanded ? "Collapse" : "Expand"}
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
              {m.user_image ? (
                <img src={m.user_image} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="flex h-full w-full items-center justify-center bg-sol-base02 text-[10px] text-sol-text-muted">
                  {(m.user_name || "?").charAt(0).toUpperCase()}
                </span>
              )}
            </span>
          ))}
          {roster.length === 0 && (
            <span className="inline-block h-6 w-6 animate-pulse rounded-full bg-sol-base02" />
          )}
        </div>
        <span
          className={`max-w-[140px] truncate text-xs ${call.phase === "error" ? "text-sol-red" : "text-sol-text-muted"}`}
        >
          {statusText}
        </span>
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-sol-text-dim" />
        ) : (
          <ChevronUp className="h-3.5 w-3.5 text-sol-text-dim" />
        )}
      </button>
      <div className="mx-0.5 h-5 w-px bg-sol-border" />
      <MicLevel muted={call.muted} />
      <button
        onClick={() => void setMuted(!call.muted)}
        className={`rounded-md p-1.5 transition-colors ${
          call.muted
            ? "bg-sol-red/15 text-sol-red hover:bg-sol-red/25"
            : "text-sol-text-muted hover:bg-sol-base02"
        }`}
        title={call.muted ? "Unmute" : "Mute"}
      >
        {call.muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
      </button>
      <button
        onClick={() => void leaveCall()}
        className="rounded-md bg-sol-red/15 p-1.5 text-sol-red transition-colors hover:bg-sol-red/30"
        title="Leave huddle"
      >
        <PhoneOff className="h-4 w-4" />
      </button>
    </div>
  );
}

function ExpandedPanel({
  call,
  roster,
  tiles,
}: {
  call: any;
  roster: any[];
  tiles: ParticipantTile[];
}) {
  const speaking = new Set<string>(call.speaking);
  const parsed = call.roomKey ? parseRoomKey(call.roomKey) : null;
  const videoTiles = tiles;
  // The "jump to session" affordance is noise while you're already looking
  // at that session — which is exactly where you usually start the huddle.
  const currentConv = useInboxStore((st) =>
    st.currentSessionId ? st.getConvexId(st.currentSessionId) ?? st.currentSessionId : null,
  );
  const viewingAnchor =
    parsed?.kind === "session" && !!currentConv && String(currentConv) === parsed.conversationId;

  const openAnchor = () => {
    if (parsed?.kind === "session") {
      // In-app tab navigation, never router.push (TabContent is the router).
      useInboxStore.getState().navigateToSession(parsed.conversationId);
    }
  };

  return (
    <div className="border-b border-sol-border px-3 py-2.5">
      {videoTiles.length > 0 && <TileGrid tiles={videoTiles} speaking={speaking} />}
      {call.error && (
        <div className="mb-2 flex items-start gap-2 rounded-md border border-sol-orange/40 bg-sol-orange/10 px-2 py-1.5 text-[11px] leading-snug text-sol-orange">
          <span className="min-w-0 flex-1">{call.error}</span>
          <button
            onClick={() => useInboxStore.getState().setCallState({ error: null })}
            className="shrink-0 rounded px-1 text-sol-orange/70 hover:text-sol-orange"
            title="Dismiss"
          >
            ×
          </button>
        </div>
      )}
      <div className="mb-2 space-y-1">
        {roster.map((m) => (
          <div key={m.user_id} className="flex items-center gap-2 text-xs">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                speaking.has(String(m.user_id)) ? "bg-sol-cyan" : m.muted ? "bg-sol-base01" : "bg-sol-green"
              }`}
            />
            <span className="truncate text-sol-text">{m.user_name}</span>
            {m.muted && <MicOff className="h-3 w-3 shrink-0 text-sol-text-dim" />}
            {m.sharing && <MonitorUp className="h-3 w-3 shrink-0 text-sol-violet" />}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => void setCamera(!call.camera)}
          className={`rounded-md p-1.5 transition-colors ${
            call.camera ? "bg-sol-cyan/15 text-sol-cyan" : "text-sol-text-muted hover:bg-sol-base02"
          }`}
          title={call.camera ? "Turn camera off" : "Turn camera on"}
        >
          {call.camera ? <Video className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
        </button>
        <button
          onClick={() => void setScreenShare(!call.sharing)}
          className={`rounded-md p-1.5 transition-colors ${
            call.sharing ? "bg-sol-violet/15 text-sol-violet" : "text-sol-text-muted hover:bg-sol-base02"
          }`}
          title={call.sharing ? "Stop sharing" : "Share screen"}
        >
          <MonitorUp className="h-4 w-4" />
        </button>
        {parsed?.kind === "session" && !viewingAnchor && (
          <button
            onClick={openAnchor}
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-sol-text-muted transition-colors hover:bg-sol-base02 hover:text-sol-text"
            title="Jump to the session this huddle is about"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            <span>session</span>
          </button>
        )}
        <div className="flex-1" />
        <DevicePicker kind="audioinput" label="Mic" />
        <DevicePicker kind="audiooutput" label="Speaker" />
      </div>
    </div>
  );
}

function TileGrid({
  tiles,
  speaking,
}: {
  tiles: ParticipantTile[];
  speaking: Set<string>;
}) {
  const [focused, setFocused] = useState<string | null>(null);
  // A focused tile that has since gone away (share stopped) falls back to
  // the grid instead of rendering nothing.
  const focusedTile = focused ? tiles.find((t) => t.key === focused) : null;
  const shown = focusedTile ? [focusedTile] : tiles;
  return (
    <div
      className={`mb-2 grid gap-1.5 ${shown.length === 1 ? "grid-cols-1" : "grid-cols-2"}`}
    >
      {shown.map((t) => (
        <VideoTile
          key={t.key}
          tile={t}
          speaking={speaking.has(t.identity)}
          onClick={() => setFocused((f) => (f === t.key ? null : t.key))}
        />
      ))}
    </div>
  );
}

function VideoTile({
  tile,
  speaking,
  onClick,
}: {
  tile: ParticipantTile;
  speaking: boolean;
  onClick: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const { track } = tile;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // livekit's attach() sets srcObject and calls play(); the local camera
    // track's underlying MediaStreamTrack can be swapped by device changes,
    // and attach() follows it — so attach once per (element, track) pair and
    // let the tile key (track sid) drive remounts.
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);
  return (
    <button
      onClick={onClick}
      className={`relative aspect-video w-full overflow-hidden rounded-md bg-sol-base03 transition-shadow ${
        speaking ? "ring-2 ring-sol-cyan" : ""
      }`}
      title={`${tile.name}${tile.kind === "screen" ? " (screen)" : ""} — click to focus`}
    >
      <video
        ref={ref}
        autoPlay
        playsInline
        // Own tiles are always silent (audio goes through the SFU path, and a
        // local <video> with sound would echo the room back at you) and, for
        // the camera, mirrored — the selfie convention every calling app uses.
        muted={tile.isLocal}
        className={`h-full w-full object-cover ${
          tile.isLocal && tile.kind === "camera" ? "-scale-x-100" : ""
        }`}
      />
      <span className="absolute bottom-1 left-1 rounded bg-sol-base03/80 px-1 text-[10px] text-sol-text">
        {tile.isLocal ? "You" : firstName(tile.name)}
        {tile.kind === "screen" ? " · screen" : ""}
      </span>
    </button>
  );
}

// Own-mic level, rendered as a short vertical bar beside the mute button.
// Reads the analyser signal through useSyncExternalStore so this ~20fps
// value re-renders ONLY this tiny component, never the dock.
function MicLevel({ muted }: { muted: boolean }) {
  const level = useSyncExternalStore(subscribeMicLevel, getMicLevel, () => 0);
  return (
    <span
      className="relative inline-block h-4 w-1 overflow-hidden rounded-full bg-sol-base02"
      title={muted ? "Muted" : "Mic level"}
      aria-hidden="true"
    >
      <span
        className={`absolute bottom-0 left-0 w-full rounded-full transition-[height] duration-75 ${
          muted ? "bg-sol-base01" : level > 0.85 ? "bg-sol-orange" : "bg-sol-green"
        }`}
        style={{ height: `${Math.round((muted ? 0 : level) * 100)}%` }}
      />
    </span>
  );
}

function DevicePicker({
  kind,
  label,
}: {
  kind: "audioinput" | "audiooutput";
  label: string;
}) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    let alive = true;
    void listDevices(kind).then((d) => alive && setDevices(d));
    return () => {
      alive = false;
    };
  }, [kind]);
  if (devices.length < 2) return null;
  return (
    <select
      onChange={(e) => void switchDevice(kind, e.target.value)}
      className="max-w-[110px] truncate rounded border border-sol-border bg-sol-bg px-1 py-0.5 text-[10px] text-sol-text-muted"
      title={`${label} device`}
      defaultValue=""
    >
      <option value="" disabled>
        {label}
      </option>
      {devices.map((d) => (
        <option key={d.deviceId} value={d.deviceId}>
          {d.label || `${label} ${d.deviceId.slice(0, 4)}`}
        </option>
      ))}
    </select>
  );
}
