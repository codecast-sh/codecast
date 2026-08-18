import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  ExternalLink,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  Settings2,
  Video,
  VideoOff,
  X,
} from "lucide-react";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { AvatarImg } from "../../lib/avatarCache";
import {
  getCallTiles,
  getMicLevel,
  getRoom,
  leaveCall,
  listDevices,
  setCamera,
  setMuted,
  setScreenShare,
  subscribeCallTiles,
  subscribeMicLevel,
  switchDevice,
  type ParticipantTile,
} from "../../lib/calls/callManager";
import { parseRoomKey } from "@codecast/shared/contracts";
import { getScribeStatus, subscribeScribe } from "../../lib/calls/transcription";
import { TranscribeControls } from "./TranscribePanel";
import { AddPeopleButton } from "./AddPeople";
import { useOutgoingRings, useRoomDescription } from "../../hooks/useCallRoom";
import type { DesktopDisplaySource } from "../../lib/desktop";

// The call stage: the full surface a huddle opens into when video or a screen
// share deserves the room. Design intents, in order:
//
//   1. THE SCREEN IS THE HERO. Codecast's calling gesture is "look at my
//      screen", so any active share owns the stage and faces retreat to a
//      filmstrip. Multiple shares tab across the hero.
//   2. FACES ADAPT, CHROME DISAPPEARS. Without a share, cameras fill an
//      adaptive grid (1 solo → 4 quad). Controls live on one bottom bar that
//      fades when idle; every glyph has a title; names render in the app's
//      mono voice, lowercase, unshouting.
//   3. WORDS ARE PART OF THE PICTURE. When the scribe runs, attributed
//      captions flow along the stage bottom — the same Otter beat the routes
//      deliver on.
//
// The stage is an overlay, not a route: Esc (or collapse) drops back to the
// ambient pill and the call continues beside the work. All state is the same
// local-first call slice + manager snapshots the pill uses; the stage adds no
// new state machinery.
export function CallStage({ onCollapse }: { onCollapse: () => void }) {
  const s = useTrackedStore([
    (st: any) => st.call,
    (st: any) => (st.call.roomKey ? st.callOccupancy[st.call.roomKey] : undefined),
  ]);
  const call = s.call;
  const roster: any[] = (call.roomKey && s.callOccupancy[call.roomKey]) || [];
  const tiles = useSyncExternalStore(subscribeCallTiles, getCallTiles, () => []);
  const speaking = useMemo(() => new Set<string>(call.speaking), [call.speaking]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCollapse();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCollapse]);

  const screens = tiles.filter((t) => t.kind === "screen");
  const cameras = tiles.filter((t) => t.kind === "camera");
  const [heroKey, setHeroKey] = useState<string | null>(null);
  const hero = (heroKey && screens.find((t) => t.key === heroKey)) || screens[0] || null;

  const parsed = call.roomKey ? parseRoomKey(call.roomKey) : null;
  const { label } = useRoomDescription(call.roomKey);
  const { ringing, declined } = useOutgoingRings(call.roomKey);

  // Portaled to <body>: the dock mounts inside the app shell, whose
  // transformed ancestors would otherwise capture this fixed overlay (the
  // classic fixed-under-transform trap) and leave the header painted on top.
  return createPortal(
    <div className="fixed inset-0 z-[200] flex flex-col bg-sol-base03">
      {/* Header: where this huddle lives, and the way out. */}
      <div className="flex items-center gap-3 px-5 pt-4 pb-2">
        <span className="font-mono text-[13px] lowercase text-sol-text-muted">
          {parsed?.kind === "session" ? `huddle · ${label}` : label}
        </span>
        {parsed?.kind === "session" && (
          <button
            onClick={() => {
              useInboxStore.getState().navigateToSession(parsed.conversationId);
              onCollapse();
            }}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-sol-text-dim transition-colors hover:bg-sol-base02 hover:text-sol-text"
            title="Open the session this huddle is about"
          >
            <ExternalLink className="h-3 w-3" />
            open session
          </button>
        )}
        <div className="flex-1" />
        <button
          onClick={onCollapse}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-sol-text-muted transition-colors hover:bg-sol-base02 hover:text-sol-text"
          title="Collapse to the pill — the call continues (Esc)"
        >
          <ChevronDown className="h-3.5 w-3.5" />
          collapse
        </button>
      </div>

      {/* The stage itself. */}
      <div className="flex min-h-0 flex-1 gap-3 px-5 pb-2">
        {hero ? (
          <>
            <div className="relative min-w-0 flex-1">
              <StageVideo tile={hero} speaking={speaking.has(hero.identity)} contain />
              {screens.length > 1 && (
                <div className="absolute left-3 top-3 flex gap-1">
                  {screens.map((t) => (
                    <button
                      key={t.key}
                      onClick={() => setHeroKey(t.key)}
                      className={`rounded px-2 py-0.5 font-mono text-[10px] lowercase transition-colors ${
                        t.key === hero.key
                          ? "bg-sol-violet/30 text-sol-violet"
                          : "bg-sol-base03/70 text-sol-text-dim hover:text-sol-text"
                      }`}
                    >
                      {t.isLocal ? "your screen" : `${firstName(t.name)}'s screen`}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {cameras.length > 0 && (
              <div className="flex w-[180px] shrink-0 flex-col gap-2 overflow-y-auto">
                {cameras.map((t) => (
                  <StageVideo key={t.key} tile={t} speaking={speaking.has(t.identity)} small />
                ))}
                <VoiceRows roster={roster} cameras={cameras} speaking={speaking} small />
              </div>
            )}
          </>
        ) : cameras.length > 0 ? (
          <div
            className={`grid min-w-0 flex-1 gap-3 ${
              cameras.length === 1
                ? "grid-cols-1"
                : cameras.length === 2
                  ? "grid-cols-2"
                  : "grid-cols-2 grid-rows-2"
            }`}
          >
            {cameras.map((t) => (
              <StageVideo key={t.key} tile={t} speaking={speaking.has(t.identity)} />
            ))}
          </div>
        ) : (
          <AudioOnlyStage
            roster={roster}
            speaking={speaking}
            phase={call.phase}
            ringing={ringing}
            declined={declined}
          />
        )}
      </div>

      <CaptionsOverlay />

      {call.error && (
        <div className="mx-auto mb-2 flex max-w-lg items-start gap-2 rounded-md border border-sol-orange/40 bg-sol-orange/10 px-3 py-1.5 text-[12px] text-sol-orange">
          <span className="min-w-0 flex-1">{call.error}</span>
          <button
            onClick={() => useInboxStore.getState().setCallState({ error: null })}
            className="shrink-0 text-sol-orange/70 hover:text-sol-orange"
            title="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <ControlBar call={call} roster={roster} />
    </div>,
    document.body,
  );
}

function firstName(name: string | undefined): string {
  const base = (name || "").split("@")[0];
  return base.split(/\s+/)[0].toLowerCase() || "teammate";
}

// One video surface. `contain` letterboxes (screen shares must not crop);
// cameras cover. The speaking ring is the one accent the stage allows itself.
function StageVideo({
  tile,
  speaking,
  small,
  contain,
}: {
  tile: ParticipantTile;
  speaking: boolean;
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
      className={`relative overflow-hidden rounded-lg bg-sol-base03 ring-1 transition-shadow ${
        speaking ? "ring-2 ring-sol-cyan" : "ring-sol-border/40"
      } ${small ? "aspect-video w-full" : "h-full w-full"}`}
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
      <span className="absolute bottom-1.5 left-1.5 rounded bg-sol-base03/80 px-1.5 py-0.5 font-mono text-[10px] lowercase text-sol-text">
        {tile.isLocal ? "you" : firstName(tile.name)}
        {tile.kind === "screen" ? " · screen" : ""}
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
    <div className={small ? "space-y-1" : "flex gap-3"}>
      {voices.map((m) => (
        <div
          key={m.user_id}
          className={`flex items-center gap-2 rounded-md bg-sol-base02/50 px-2 py-1.5 ${
            speaking.has(String(m.user_id)) ? "ring-1 ring-sol-cyan" : ""
          }`}
        >
          <Avatar m={m} size={20} />
          <span className="truncate font-mono text-[11px] lowercase text-sol-text-muted">
            {firstName(m.user_name)}
          </span>
          {m.muted && <MicOff className="h-3 w-3 shrink-0 text-sol-text-dim" />}
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
  declined = [],
}: {
  roster: any[];
  speaking: Set<string>;
  phase: string;
  ringing?: { user_id: string; user_name: string; user_image?: string }[];
  declined?: { user_id: string; user_name: string; user_image?: string }[];
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
          <span className="font-mono text-[13px] lowercase text-sol-text-dim">
            {phase === "connecting" ? "connecting…" : phase === "ringing_out" ? "ringing…" : "just you so far"}
          </span>
        )}
        {ghosts.map((r) => (
          <div key={`ring:${r.user_id}`} className="flex flex-col items-center gap-3 opacity-60">
            <div className="animate-pulse rounded-full ring-2 ring-sol-violet/40 ring-offset-4 ring-offset-sol-base03">
              <Avatar m={r} size={88} />
            </div>
            <span className="font-mono text-[12px] lowercase text-sol-text-dim">
              {firstName(r.user_name)} · ringing…
            </span>
          </div>
        ))}
        {roster.map((m) => (
          <div key={m.user_id} className="flex flex-col items-center gap-3">
            <div
              className={`rounded-full transition-all duration-300 ${
                speaking.has(String(m.user_id))
                  ? "ring-4 ring-sol-cyan/70 ring-offset-4 ring-offset-sol-base03"
                  : ""
              }`}
            >
              <Avatar m={m} size={88} />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[12px] lowercase text-sol-text-muted">
                {firstName(m.user_name)}
              </span>
              {m.muted && <MicOff className="h-3 w-3 text-sol-text-dim" />}
              {m.sharing && <MonitorUp className="h-3 w-3 text-sol-violet" />}
            </div>
          </div>
        ))}
      </div>
      {declined.length > 0 && (
        <span className="font-mono text-[12px] lowercase text-sol-text-dim">
          {declined.map((r) => firstName(r.user_name)).join(", ")} declined
        </span>
      )}
    </div>
  );
}

function Avatar({ m, size }: { m: any; size: number }) {
  return (
    <AvatarImg
      src={m.user_image}
      alt=""
      style={{ width: size, height: size }}
      className="rounded-full object-cover"
      fallback={
        <span
          style={{ width: size, height: size, fontSize: Math.max(11, size / 2.6) }}
          className="flex items-center justify-center rounded-full bg-sol-base02 font-mono text-sol-text-muted"
        >
          {(m.user_name || "?").charAt(0).toUpperCase()}
        </span>
      }
    />
  );
}

// Attributed captions along the stage bottom while the scribe runs.
function CaptionsOverlay() {
  const scribe = useSyncExternalStore(subscribeScribe, getScribeStatus, getScribeStatus);
  if (!scribe.active || scribe.tail.length === 0) return null;
  return (
    <div className="pointer-events-none mx-auto mb-2 w-full max-w-3xl px-5">
      <div className="space-y-0.5">
        {scribe.tail.slice(-3).map((c, i, arr) => (
          <div
            key={i}
            className={`text-center text-[13px] leading-snug ${
              i === arr.length - 1 ? "text-sol-text" : "text-sol-text-dim"
            }`}
          >
            <span className="font-mono text-[11px] lowercase text-sol-cyan">
              {firstName(c.speaker)}
            </span>{" "}
            {c.text}
          </div>
        ))}
      </div>
    </div>
  );
}

// The one control bar. Order mirrors frequency of use; the destructive act
// sits alone at the right.
function ControlBar({ call, roster }: { call: any; roster: any[] }) {
  const [devicesOpen, setDevicesOpen] = useState(false);
  const level = useSyncExternalStore(subscribeMicLevel, getMicLevel, () => 0);

  return (
    <div className="flex items-center justify-center gap-2 px-5 pb-4 pt-1">
      <div className="flex items-center gap-1.5 rounded-xl border border-sol-border/60 bg-sol-bg-alt/90 px-2.5 py-1.5 shadow-xl">
        {/* Mic + live level, one control. */}
        <button
          onClick={() => void setMuted(!call.muted)}
          className={`relative rounded-lg p-2 transition-colors ${
            call.muted
              ? "bg-sol-red/15 text-sol-red hover:bg-sol-red/25"
              : "text-sol-text-muted hover:bg-sol-base02"
          }`}
          title={call.muted ? "Unmute" : "Mute"}
        >
          {call.muted ? <MicOff className="h-[18px] w-[18px]" /> : <Mic className="h-[18px] w-[18px]" />}
          {!call.muted && (
            <span
              className="absolute bottom-1 left-1 right-1 h-0.5 origin-left rounded-full bg-sol-green transition-transform duration-75"
              style={{ transform: `scaleX(${Math.min(1, level)})` }}
            />
          )}
        </button>
        <button
          onClick={() => void setCamera(!call.camera)}
          className={`rounded-lg p-2 transition-colors ${
            call.camera
              ? "bg-sol-cyan/15 text-sol-cyan"
              : "text-sol-text-muted hover:bg-sol-base02"
          }`}
          title={call.camera ? "Turn camera off" : "Turn camera on"}
        >
          {call.camera ? <Video className="h-[18px] w-[18px]" /> : <VideoOff className="h-[18px] w-[18px]" />}
        </button>
        <StageShareButton sharing={call.sharing} />
        {call.roomKey && call.phase === "connected" && (
          <AddPeopleButton
            roomKey={call.roomKey}
            className="rounded-lg p-2 text-sol-text-muted transition-colors hover:bg-sol-base02"
            iconClassName="h-[18px] w-[18px]"
            align="center"
          />
        )}
        {/* Transcribe, with its route picker (send the words to a session,
            doc or Slack channel; live routes deliver on conversation gaps). */}
        <TranscribeControls getRoom={getRoom} />
        <span className="relative">
          <button
            onClick={() => setDevicesOpen((o) => !o)}
            className="rounded-lg p-2 text-sol-text-muted transition-colors hover:bg-sol-base02"
            title="Devices"
          >
            <Settings2 className="h-[18px] w-[18px]" />
          </button>
          {devicesOpen && <DevicesPopover onClose={() => setDevicesOpen(false)} />}
        </span>
        <div className="mx-1 h-6 w-px bg-sol-border/60" />
        <button
          onClick={() => void leaveCall()}
          className="rounded-lg bg-sol-red/15 p-2 text-sol-red transition-colors hover:bg-sol-red/30"
          title="Leave huddle"
        >
          <PhoneOff className="h-[18px] w-[18px]" />
        </button>
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
        className={`rounded-lg p-2 transition-colors ${
          sharing ? "bg-sol-violet/15 text-sol-violet" : "text-sol-text-muted hover:bg-sol-base02"
        }`}
        title={sharing ? "Stop sharing" : "Share your screen"}
      >
        <MonitorUp className="h-[18px] w-[18px]" />
      </button>
      {open && (
        <div
          className="absolute bottom-full left-1/2 z-10 mb-2 w-[380px] -translate-x-1/2 rounded-lg border border-sol-border bg-sol-bg-alt p-2 shadow-xl"
          onMouseLeave={() => setOpen(false)}
        >
          <div className="mb-1.5 px-1 text-[11px] font-medium text-sol-text-muted">
            Share a screen or window
          </div>
          {sources === null ? (
            <div className="px-1 py-3 text-center text-[11px] text-sol-text-dim">Looking…</div>
          ) : sources.length === 0 ? (
            <div className="px-1 py-3 text-center text-[11px] text-sol-text-dim">
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
                    className="aspect-video w-full rounded object-cover ring-1 ring-sol-border"
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
        <span className="text-[10px] uppercase tracking-wide text-sol-text-dim">{label}</span>
        <select
          onChange={(e) => void switchDevice(kind, e.target.value)}
          className="mt-0.5 w-full rounded border border-sol-border bg-sol-bg px-1.5 py-1 text-[11px] text-sol-text"
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
      className="absolute bottom-full left-1/2 z-10 mb-2 w-[240px] -translate-x-1/2 space-y-2 rounded-lg border border-sol-border bg-sol-bg-alt p-2.5 shadow-xl"
      onMouseLeave={onClose}
    >
      {row("Microphone", mics, "audioinput")}
      {row("Speaker", outs, "audiooutput")}
      {row("Camera", cams, "videoinput")}
    </div>
  );
}
