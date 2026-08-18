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
import { CallStage } from "./CallStage";
import { AddPeopleButton } from "./AddPeople";
import { useOutgoingRings, useRoomDescription } from "../../hooks/useCallRoom";

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
  return (
    <div className="fixed bottom-20 right-4 z-[70] w-auto max-w-[420px] select-none">
      <div className="rounded-xl border border-sol-border bg-sol-bg-alt/95 shadow-xl backdrop-blur">
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
  const { label } = useRoomDescription(call.roomKey);
  // The caller's side of a ring settles the sentence: "ringing sam, ana…"
  // while phones ring, "ana declined" for a beat afterwards, then the room.
  const { ringing, declined } = useOutgoingRings(call.roomKey);
  const statusText =
    call.phase === "error"
      ? call.error || "Call failed"
      : call.phase === "connecting"
        ? "Connecting…"
        : call.phase === "ringing_out"
          ? "Ringing…"
          : ringing.length > 0
            ? `ringing ${ringing.map((r) => firstName(r.user_name)).join(", ")}…`
            : declined.length > 0 && roster.length <= 1
              ? `${declined.map((r) => firstName(r.user_name)).join(", ")} declined`
              : label;

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
      {call.roomKey && call.phase === "connected" && (
        <AddPeopleButton roomKey={call.roomKey} />
      )}
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
