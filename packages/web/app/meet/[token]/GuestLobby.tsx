import { useRef, useSyncExternalStore, type FormEvent } from "react";
import { Loader2, Mic, MicOff, RefreshCw, Video, VideoOff } from "lucide-react";
import { GUEST_NAME_MAX } from "@codecast/shared/contracts";
import { AvatarImg } from "../../../lib/avatarCache";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { canPickSpeaker, type GuestPreview } from "../../../lib/calls/guestRoom";
import { STAGE_CTL } from "../../../components/calls/StageViews";
import { firstName } from "../../../components/calls/speakers";
import { CallNotice, DeviceSelect } from "./MeetChrome";

// The lobby and the door, one screen: the guest's own camera on the left (it
// stays theirs to fix their hair in or switch off while they wait), what they
// are joining on the right. The right side is the only thing that changes
// between asking and waiting, so being let in is a small step, not a jump.

export type LobbyMode =
  /** Not knocked yet: name, notice, Ask to join. */
  | "ask"
  /** Knocked; the room has been asked. */
  | "waiting"
  /** Already let in, but this page has not been touched yet (a reload), and
   *  a browser plays no sound for a page nobody touched: one press to enter. */
  | "rejoin";

export function GuestLobby({
  preview,
  mode,
  title,
  inviter,
  live,
  transcribed,
  recording,
  name,
  onName,
  onAsk,
  onCancel,
  onJoin,
  onToggle,
  busy,
  error,
  waitingSince,
}: {
  preview: GuestPreview;
  mode: LobbyMode;
  title: string;
  inviter: { name: string | null; image?: string | null } | null;
  live: boolean;
  transcribed: boolean;
  recording: boolean;
  name: string;
  onName: (name: string) => void;
  onAsk: () => void;
  onCancel: () => void;
  onJoin: () => void;
  /** The guest turned a device on or off: remembered for next time. */
  onToggle: (kind: "mic" | "camera", on: boolean) => void;
  busy: boolean;
  error: string | null;
  waitingSince: number | null;
}) {
  const p = useSyncExternalStore(preview.subscribe, preview.getSnapshot, preview.getSnapshot);
  const inviterName = inviter?.name ? firstName(inviter.name) : null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (mode === "ask" && name.trim() && !busy) onAsk();
  };

  return (
    <div className="mx-auto grid w-full max-w-[1080px] flex-1 items-center gap-6 px-4 pb-10 pt-2 sm:px-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(320px,1fr)] lg:gap-12">
      {/* Their own picture, and the devices behind it. */}
      <section className="meet-rise flex min-w-0 flex-col gap-3" aria-label="Your camera and microphone">
        <PreviewFrame preview={preview} name={name} mode={mode} onToggle={onToggle} />
        <div className="flex flex-wrap gap-2">
          <DeviceSelect kind="mic" devices={p.devices.mic} choice={p.choice} onChoose={(k, id) => void preview.choose(k, id)} />
          <DeviceSelect kind="camera" devices={p.devices.camera} choice={p.choice} onChoose={(k, id) => void preview.choose(k, id)} />
          {canPickSpeaker() && p.devices.speaker.length > 0 && (
            <DeviceSelect kind="speaker" devices={p.devices.speaker} choice={p.choice} onChoose={(k, id) => void preview.choose(k, id)} />
          )}
        </div>
      </section>

      {/* What they are joining, and the one thing to do about it. */}
      <section className="meet-rise flex min-w-0 flex-col gap-5" aria-live="polite">
        <div className="flex flex-col gap-2">
          <span className="text-[12px] text-sol-text-muted">
            {mode === "waiting" ? "Asking to join" : mode === "rejoin" ? "You're in" : "You're invited to"}
          </span>
          <h1 className="meet-title text-balance text-[30px] leading-[1.12] text-sol-text sm:text-[36px]">{title}</h1>
          {inviter?.name && (
            <div className="flex items-center gap-2 text-[12px] text-sol-text-secondary">
              <span className="inline-block h-5 w-5 shrink-0 overflow-hidden rounded-full">
                <AvatarImg
                  src={inviter.image ?? undefined}
                  alt=""
                  className="h-full w-full object-cover"
                  fallback={
                    <span className="flex h-full w-full items-center justify-center bg-sol-base02 text-[10px] text-sol-text-muted">
                      {inviter.name.charAt(0).toUpperCase()}
                    </span>
                  }
                />
              </span>
              <span className="min-w-0 truncate">{inviter.name} invited you</span>
              <span className="text-sol-text-dim">·</span>
              <LiveLine live={live} />
            </div>
          )}
        </div>

        {mode === "waiting" ? (
          <WaitingCard name={name} live={live} inviterName={inviterName} since={waitingSince} onCancel={onCancel} busy={busy} />
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            {mode === "ask" && (
              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] text-sol-text-muted">Your name</span>
                <input
                  value={name}
                  onChange={(e) => onName(e.target.value)}
                  maxLength={GUEST_NAME_MAX}
                  autoComplete="name"
                  autoFocus={!name}
                  placeholder="How the room should see you"
                  className="rounded-xl bg-white/[0.04] px-3.5 py-3 text-[15px] text-sol-text outline-none ring-1 ring-white/10 transition-shadow placeholder:text-sol-text-dim focus:ring-2 focus:ring-sol-cyan/60"
                  style={{ fontVariantLigatures: "none" }}
                />
              </label>
            )}
            <CallNotice transcribed={transcribed} recording={recording} />
            <button
              type={mode === "ask" ? "submit" : "button"}
              onClick={mode === "rejoin" ? onJoin : undefined}
              disabled={busy || (mode === "ask" && !name.trim())}
              className="flex items-center justify-center gap-2 rounded-xl bg-sol-cyan px-4 py-3 text-[14px] font-semibold text-sol-base03 shadow-[0_8px_24px_-10px_rgba(42,161,152,0.7)] transition-[transform,background-color,opacity] hover:bg-[#33b3a9] active:scale-[0.985] disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {mode === "rejoin" ? "Join the call" : busy ? "Asking…" : "Ask to join"}
            </button>
            {error ? (
              <p role="alert" className="text-[12px] leading-snug text-sol-orange">
                {error}
              </p>
            ) : (
              <p className="text-[11.5px] leading-snug text-sol-text-dim">
                {mode === "rejoin"
                  ? "You were already let in. Your camera and microphone come with you as set above."
                  : `You'll join as a guest: nothing to install, no account. ${live ? "Someone in the call lets you in." : "Someone lets you in once the call starts."}`}
              </p>
            )}
          </form>
        )}
      </section>
    </div>
  );
}

function LiveLine({ live }: { live: boolean }) {
  return live ? (
    <span className="flex shrink-0 items-center gap-1.5 text-sol-green">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sol-green motion-reduce:animate-none" />
      live now
    </span>
  ) : (
    <span className="shrink-0 text-sol-text-muted">not started yet</span>
  );
}

/** The door: their face with rings leaving it, how long they have waited, and
 *  a way to stop asking. The words say who knows they are here. */
function WaitingCard({
  name,
  live,
  inviterName,
  since,
  onCancel,
  busy,
}: {
  name: string;
  live: boolean;
  inviterName: string | null;
  since: number | null;
  onCancel: () => void;
  busy: boolean;
}) {
  const now = useCoarseNow(5000);
  const waited = since ? Math.max(0, now - since) : 0;
  const mins = Math.floor(waited / 60_000);
  return (
    <div className="flex flex-col gap-4 rounded-2xl bg-white/[0.035] p-5 ring-1 ring-white/[0.07]">
      <div className="flex items-center gap-4">
        <span className="meet-knock flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-sol-base02 font-mono text-[16px] text-sol-text">
          <span className="meet-knock-ring" aria-hidden />
          {(name || "?").charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-sol-text">
            {live ? "The room knows you're here" : "Waiting for the call to start"}
          </div>
          <div className="mt-0.5 text-[12px] leading-snug text-sol-text-muted">
            {live
              ? "Someone in the call will let you in."
              : `${inviterName ?? "Whoever invited you"} has been told you're here. You'll get in once someone joins.`}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] pt-3 font-mono text-[11px] text-sol-text-dim">
        <span>{mins < 1 ? "waiting less than a minute" : `waiting ${mins} min`}</span>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-md px-2 py-1 text-sol-text-muted transition-colors hover:bg-white/[0.06] hover:text-sol-text disabled:opacity-50"
        >
          Stop asking
        </button>
      </div>
    </div>
  );
}

/** The guest's own picture, with the two switches over it. With the camera
 *  off it says so and shows their initial; with a device refused it says
 *  which one and how to allow it. */
function PreviewFrame({
  preview,
  name,
  mode,
  onToggle,
}: {
  preview: GuestPreview;
  name: string;
  mode: LobbyMode;
  onToggle: (kind: "mic" | "camera", on: boolean) => void;
}) {
  const p = useSyncExternalStore(preview.subscribe, preview.getSnapshot, preview.getSnapshot);
  const videoRef = useRef<HTMLVideoElement>(null);
  const micRef = useRef<HTMLButtonElement>(null);
  useWatchEffect(() => {
    const el = videoRef.current;
    if (!el || !p.video) return;
    p.video.attach(el);
    return () => {
      p.video?.detach(el);
    };
  }, [p.video]);
  // The level never touches React: the meter writes the button's variable.
  useWatchEffect(() => {
    const write = () => micRef.current?.style.setProperty("--meet-level", String(preview.level()));
    write();
    return preview.subscribeLevel(write);
  }, [preview, p.audio]);

  const refused = p.cameraError || p.micError;
  const initial = (name.trim() || "?").charAt(0).toUpperCase();
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-2xl bg-black/50 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.8)] ring-1 ring-white/[0.08]">
      {p.video ? (
        <video ref={videoRef} autoPlay playsInline muted className="h-full w-full -scale-x-100 object-cover" />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center">
          {p.asking ? (
            <>
              <Loader2 className="h-6 w-6 animate-spin text-sol-text-dim" />
              <span className="text-[12px] text-sol-text-muted">Allow your camera and microphone in the browser's prompt</span>
            </>
          ) : (
            <>
              <span className="flex h-20 w-20 items-center justify-center rounded-full bg-sol-base02 font-mono text-[30px] text-sol-text-secondary">
                {initial}
              </span>
              <span className="text-[12px] text-sol-text-muted">{p.cameraError ?? "Your camera is off"}</span>
            </>
          )}
        </div>
      )}
      {mode !== "waiting" && name.trim() && p.video && (
        <span className="absolute left-3 top-3 rounded-full bg-black/45 px-2.5 py-0.5 font-mono text-[12px] text-white/90 backdrop-blur">
          {name.trim()}
        </span>
      )}
      {refused && !p.asking && (
        <div className="absolute inset-x-3 top-3 flex items-center gap-2 rounded-lg bg-black/60 px-3 py-2 text-[11.5px] leading-snug text-sol-orange backdrop-blur">
          <span className="min-w-0 flex-1">
            {p.micError && p.cameraError
              ? "Your browser is blocking the camera and microphone. Allow them from the icon in the address bar, then try again."
              : p.micError
                ? `${p.micError}. You can still join and listen.`
                : `${p.cameraError}.`}
          </span>
          <button
            type="button"
            onClick={() => void preview.start({ mic: !!p.micError, camera: !!p.cameraError })}
            className="flex shrink-0 items-center gap-1 rounded-md bg-white/10 px-2 py-1 font-mono text-[11px] text-white/90 transition-colors hover:bg-white/20"
          >
            <RefreshCw className="h-3 w-3" />
            try again
          </button>
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-3 bg-gradient-to-t from-black/55 to-transparent pb-3 pt-10">
        <button
          ref={micRef}
          type="button"
          onClick={() => {
            const on = !p.audio;
            onToggle("mic", on);
            void preview.setMic(on);
          }}
          className={`${STAGE_CTL} meet-level p-3 backdrop-blur ${
            p.audio ? "bg-white/15 text-white hover:bg-white/25" : "bg-sol-red/85 text-white hover:bg-sol-red"
          }`}
          title={p.audio ? "Turn your microphone off" : "Turn your microphone on"}
          aria-label={p.audio ? "Turn your microphone off" : "Turn your microphone on"}
          aria-pressed={!p.audio}
        >
          {p.audio ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
        </button>
        <button
          type="button"
          onClick={() => {
            const on = !p.video;
            onToggle("camera", on);
            void preview.setCamera(on);
          }}
          className={`${STAGE_CTL} p-3 backdrop-blur ${
            p.video ? "bg-white/15 text-white hover:bg-white/25" : "bg-sol-red/85 text-white hover:bg-sol-red"
          }`}
          title={p.video ? "Turn your camera off" : "Turn your camera on"}
          aria-label={p.video ? "Turn your camera off" : "Turn your camera on"}
          aria-pressed={!p.video}
        >
          {p.video ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
        </button>
      </div>
    </div>
  );
}
