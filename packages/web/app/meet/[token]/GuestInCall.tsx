import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Loader2, Mic, MicOff, MonitorUp, PhoneOff, Settings2, Video, VideoOff, Volume2, WifiOff, X } from "lucide-react";
import { canPickSpeaker, canShareScreen, type GuestCall } from "../../../lib/calls/guestRoom";
import { listDevices } from "../../../lib/calls/callMedia";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import {
  AutoStage,
  GridStage,
  SpeakerStage,
  STAGE_CTL,
  STAGE_CTL_IDLE,
  STAGE_VIEWS,
  StageHostProvider,
  type StageHost,
  type StageView,
} from "../../../components/calls/StageViews";
import { DeviceSelect, NoticePills } from "./MeetChrome";

// The call, for a guest: the member's stage (StageViews: the same tiles, the
// same views, the same speaking ring and guest marks), with the chrome a
// guest needs and nothing a guest cannot use. No thread, no agents, no
// transcript: a guest learns what anyone in a call learns, from the media.
// What they ARE told, always, is whether the call is recorded and transcribed,
// in the bar for as long as it is true, and in a line the moment it starts.

export function GuestInCall({
  call,
  title,
  myName,
  transcribed,
  recording,
  onLeave,
  onReconnect,
}: {
  call: GuestCall;
  title: string;
  myName: string;
  transcribed: boolean;
  recording: boolean;
  onLeave: () => void;
  /** The media room let go and could not get back: a new connection. */
  onReconnect: () => void;
}) {
  const c = useSyncExternalStore(call.subscribe, call.getSnapshot, call.getSnapshot);
  const [view, setView] = useState<StageView>("auto");
  const [pinned, setPinned] = useState<string | null>(null);
  const [lastSpeaker, setLastSpeaker] = useState<string | null>(null);
  useWatchEffect(() => {
    if (c.speaking[0]) setLastSpeaker(c.speaking[0]);
  }, [c.speaking]);
  const host = useMemo<StageHost>(() => ({ getRoom: call.getRoom }), [call]);

  // The stage reads the room's people as roster rows (StageViews). Mine is
  // the name I typed, and everyone else's is the name the room gave them.
  const roster = useMemo(
    () =>
      c.people.map((p) => ({
        user_id: p.identity,
        user_name: p.isLocal ? myName : p.name,
        user_image: p.image,
        muted: p.muted,
        sharing: p.sharing,
      })),
    [c.people, myName],
  );
  const speaking = useMemo(() => new Set(c.speaking), [c.speaking]);
  const screens = c.tiles.filter((t) => t.kind === "screen");
  const cameras = c.tiles.filter((t) => t.kind === "camera");

  // A recording that starts while they are inside is said in words once,
  // not only by a pill appearing in the corner.
  const [recordNote, setRecordNote] = useState(false);
  const wasRecording = useRef(recording);
  useWatchEffect(() => {
    if (recording && !wasRecording.current) setRecordNote(true);
    if (!recording) setRecordNote(false);
    wasRecording.current = recording;
  }, [recording]);

  return (
    <div className="call-stage dark fixed inset-0 flex flex-col bg-sol-base03 text-sol-text">
      {/* The bar: where this is, who is in it, and what is being kept. */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 sm:px-4">
        <span className="meet-mark max-sm:hidden" aria-hidden>
          <i />
        </span>
        <span className="min-w-0 truncate font-mono text-[12.5px] text-sol-text-secondary">{title}</span>
        <span className="shrink-0 rounded-full bg-white/[0.06] px-1.5 py-px font-mono text-[10.5px] text-sol-text-muted" title="People in the call">
          {roster.length}
        </span>
        <div className="min-w-2 flex-1" />
        <NoticePills transcribed={transcribed} recording={recording} />
        <div role="radiogroup" aria-label="View" className="ml-1 flex shrink-0 items-center rounded-lg bg-white/[0.04] p-0.5 max-sm:hidden">
          {STAGE_VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              role="radio"
              aria-checked={view === v.key}
              onClick={() => setView(v.key)}
              title={v.hint}
              className={`flex items-center gap-1 rounded-md px-2 py-1 font-mono text-[11px] transition-colors ${
                view === v.key ? "bg-white/10 text-sol-text" : "text-sol-text-muted hover:text-sol-text"
              }`}
            >
              <v.icon className="h-3.5 w-3.5" />
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {c.phase === "reconnecting" && (
        <Banner tone="yellow" icon={<Loader2 className="h-3.5 w-3.5 animate-spin" />}>
          Reconnecting… your connection dropped for a moment.
        </Banner>
      )}
      {c.phase === "disconnected" && c.ended === "lost" && (
        <Banner tone="orange" icon={<WifiOff className="h-3.5 w-3.5" />} action={{ label: "Reconnect", onClick: onReconnect }}>
          You lost the connection to the call.
        </Banner>
      )}
      {c.audioBlocked && c.phase === "connected" && (
        <Banner tone="cyan" icon={<Volume2 className="h-3.5 w-3.5" />} action={{ label: "Turn on sound", onClick: () => void call.startAudio() }}>
          Your browser is holding the call's sound until you click.
        </Banner>
      )}
      {recordNote && (
        <Banner tone="red" icon={<span className="h-2 w-2 rounded-full bg-sol-red" />} onDismiss={() => setRecordNote(false)}>
          This call is now being recorded, video and screen shares included.
        </Banner>
      )}
      {c.error && (
        <Banner tone="orange" onDismiss={() => call.dismissError()}>
          {c.error}
        </Banner>
      )}

      <div className="flex min-h-0 flex-1 gap-2 p-2 sm:p-3">
        <StageHostProvider value={host}>
          <div key={view} className="flex min-h-0 min-w-0 flex-1 animate-in fade-in duration-200 max-sm:flex-col">
            {c.phase === "connecting" && c.people.length <= 1 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 font-mono text-[12.5px] text-sol-text-muted">
                <Loader2 className="h-5 w-5 animate-spin" />
                joining…
              </div>
            ) : view === "grid" ? (
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
              <AutoStage roster={roster} cameras={cameras} screens={screens} speaking={speaking} phase={c.phase} />
            )}
          </div>
        </StageHostProvider>
      </div>

      {/* The one control bar, the stage's own buttons. */}
      <div className="shrink-0 border-t border-white/[0.06] bg-black/[0.12] px-3 pb-[max(10px,env(safe-area-inset-bottom))] pt-2.5">
        <div className="mx-auto flex w-fit items-center gap-1 rounded-full bg-white/[0.05] px-2 py-1.5 ring-1 ring-white/[0.06]">
          <button
            type="button"
            onClick={() => void call.setMic(!c.mic)}
            className={`${STAGE_CTL} ${c.mic ? STAGE_CTL_IDLE : "bg-sol-red/15 text-sol-red hover:bg-sol-red/25"}`}
            title={c.mic ? "Mute your microphone" : "Unmute your microphone"}
            aria-label={c.mic ? "Mute your microphone" : "Unmute your microphone"}
            aria-pressed={!c.mic}
          >
            {c.mic ? <Mic className="h-[18px] w-[18px]" /> : <MicOff className="h-[18px] w-[18px]" />}
          </button>
          <button
            type="button"
            onClick={() => void call.setCamera(!c.camera)}
            className={`${STAGE_CTL} ${c.camera ? "bg-sol-cyan/15 text-sol-cyan hover:bg-sol-cyan/25" : STAGE_CTL_IDLE}`}
            title={c.camera ? "Turn camera off" : "Turn camera on"}
            aria-label={c.camera ? "Turn camera off" : "Turn camera on"}
          >
            {c.camera ? <Video className="h-[18px] w-[18px]" /> : <VideoOff className="h-[18px] w-[18px]" />}
          </button>
          {canShareScreen() && (
            <button
              type="button"
              onClick={() => void call.setScreenShare(!c.sharing)}
              className={`${STAGE_CTL} ${c.sharing ? "bg-sol-violet/15 text-sol-violet hover:bg-sol-violet/25" : STAGE_CTL_IDLE}`}
              title={c.sharing ? "Stop sharing" : "Share your screen"}
              aria-label={c.sharing ? "Stop sharing your screen" : "Share your screen"}
            >
              <MonitorUp className="h-[18px] w-[18px]" />
            </button>
          )}
          <DevicesButton call={call} />
          <div className="mx-1.5 h-5 w-px bg-white/10" />
          <button
            type="button"
            onClick={onLeave}
            className="flex items-center gap-1.5 rounded-full bg-sol-red/90 px-3.5 py-2 font-mono text-[12px] font-medium text-white transition-colors hover:bg-sol-red"
            title="Leave the call"
          >
            <PhoneOff className="h-4 w-4" />
            leave
          </button>
        </div>
      </div>
    </div>
  );
}

const BANNER_TONE = {
  yellow: "bg-sol-yellow/10 text-sol-yellow",
  orange: "bg-sol-orange/10 text-sol-orange",
  cyan: "bg-sol-cyan/10 text-sol-cyan",
  red: "bg-sol-red/10 text-sol-red",
} as const;

/** One line over the stage: what happened and the one thing to do about it. */
function Banner({
  tone,
  icon,
  action,
  onDismiss,
  children,
}: {
  tone: keyof typeof BANNER_TONE;
  icon?: React.ReactNode;
  action?: { label: string; onClick: () => void };
  onDismiss?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div role="status" className="mx-auto mt-2 flex w-full max-w-[min(560px,calc(100%-24px))] text-[12px] animate-in fade-in slide-in-from-top-1 duration-200 motion-reduce:animate-none">
      <div className={`flex min-w-0 flex-1 items-center gap-2 rounded-full px-3.5 py-1.5 ${BANNER_TONE[tone]}`}>
        {icon && <span className="flex shrink-0 items-center">{icon}</span>}
        <span className="min-w-0 flex-1 truncate" title={typeof children === "string" ? children : undefined}>
          {children}
        </span>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            className="shrink-0 rounded-full px-2 py-0.5 font-medium ring-1 ring-current/30 transition-colors hover:bg-white/10"
          >
            {action.label}
          </button>
        )}
        {onDismiss && (
          <button type="button" onClick={onDismiss} className="shrink-0 rounded-full p-0.5 opacity-70 transition-opacity hover:opacity-100" aria-label="Dismiss">
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

/** The devices, from inside the call: switch a microphone or camera without
 *  hanging up (LiveKit swaps the track in place). */
function DevicesButton({ call }: { call: GuestCall }) {
  const c = useSyncExternalStore(call.subscribe, call.getSnapshot, call.getSnapshot);
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<{ mic: MediaDeviceInfo[]; camera: MediaDeviceInfo[]; speaker: MediaDeviceInfo[] } | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  useWatchEffect(() => {
    if (!open) return;
    let alive = true;
    void Promise.all([
      listDevices("audioinput", { prompt: false }),
      listDevices("videoinput", { prompt: false }),
      canPickSpeaker() ? listDevices("audiooutput", { prompt: false }) : Promise.resolve([]),
    ]).then(([mic, camera, speaker]) => alive && setDevices({ mic, camera, speaker }));
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      alive = false;
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const choose = (kind: "mic" | "camera" | "speaker", id: string) => void call.choose(kind, id);
  return (
    <span ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`${STAGE_CTL} ${open ? "bg-white/10 text-sol-text" : STAGE_CTL_IDLE}`}
        title="Microphone, camera and speaker"
        aria-label="Choose your microphone, camera and speaker"
        aria-expanded={open}
      >
        <Settings2 className="h-[18px] w-[18px]" />
      </button>
      {open && (
        <div className="absolute bottom-full left-1/2 z-20 mb-3 flex w-[min(320px,calc(100vw-24px))] -translate-x-1/2 flex-col gap-2 rounded-xl bg-sol-bg-alt p-3 shadow-2xl ring-1 ring-white/[0.08] animate-in fade-in slide-in-from-bottom-1 duration-150 motion-reduce:animate-none">
          {devices === null ? (
            <div className="py-3 text-center font-mono text-[11px] text-sol-text-muted">Looking…</div>
          ) : (
            <>
              <DeviceSelect kind="mic" devices={devices.mic} choice={c.choice} onChoose={choose} />
              <DeviceSelect kind="camera" devices={devices.camera} choice={c.choice} onChoose={choose} />
              {devices.speaker.length > 0 && <DeviceSelect kind="speaker" devices={devices.speaker} choice={c.choice} onChoose={choose} />}
            </>
          )}
        </div>
      )}
    </span>
  );
}
