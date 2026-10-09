// The confirm step in front of every huddle start (lib/calls/huddleStart):
// the person's own camera, a meter that moves when they speak, the devices
// the call will open, and the guest link for somebody outside the team. What
// is chosen here is what the join opens: device picks go through
// switchDevice and the switches through the sticky join prefs, the same
// writes the stage and call settings make, so nothing is decided twice.
import { useRef, useState, useSyncExternalStore } from "react";
import { Link2, Mic, MicOff, Video, VideoOff } from "lucide-react";
import { CHANNEL_HUDDLE_WARNING_SIZE } from "@codecast/shared/contracts";
import { GuestPreview, canPickSpeaker } from "../../lib/calls/guestRoom";
import { readJoinPrefs, rememberCamera, rememberMic } from "../../lib/calls/joinPrefs";
import { switchDevice } from "../../lib/calls/callManager";
import { closeHuddleStart, runHuddleStart, type HuddleStartRequest } from "../../lib/calls/huddleStart";
import { useInboxStore } from "../../store/inboxStore";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { memberDisplayName } from "../presence/memberPresence";
import { firstName } from "./speakers";
import { DeviceOptions } from "./DeviceRows";
import { GuestInvite } from "./GuestDoor";

type PreviewKind = "mic" | "camera" | "speaker";
const DEVICE_KIND = { mic: "audioinput", camera: "videoinput", speaker: "audiooutput" } as const;
const KIND_WORD = { mic: "Microphone", camera: "Camera", speaker: "Speaker" } as const;

export default function HuddleStartDialog({ req }: { req: HuddleStartRequest }) {
  const preview = usePreview();
  return (
    <Dialog open onOpenChange={(open) => !open && closeHuddleStart()}>
      <DialogContent className="w-[calc(100%-2rem)] max-w-md gap-3 rounded-xl border-sol-border bg-sol-bg p-4 text-sol-text">
        <Heading req={req} />
        {preview && <PreviewBody preview={preview} />}
        <GuestInvite
          roomKey={req.roomKey}
          align="start"
          trigger={({ open, toggle }) => (
            <button
              type="button"
              onClick={toggle}
              aria-expanded={open}
              className={`flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs transition-colors hover:text-sol-yellow ${open ? "text-sol-yellow" : "text-sol-text-muted"}`}
            >
              <Link2 className="h-3.5 w-3.5" />
              Invite someone outside the team
            </button>
          )}
        />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={closeHuddleStart} className="rounded-md border border-sol-border px-3 py-1.5 text-sm hover:bg-sol-bg-highlight">
            Cancel
          </button>
          <button
            type="button"
            autoFocus
            onClick={() => {
              preview?.dispose();
              runHuddleStart(req);
            }}
            className="sol-btn-solid rounded-md bg-sol-violet px-3 py-1.5 text-sm text-sol-base3"
          >
            {startLabel(req)}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// One preview per open dialog, opened with the remembered devices and the
// remembered on/off, and closed with the dialog (a Start disposes it first, so
// the join opens the devices fresh rather than beside a lit preview).
function usePreview(): GuestPreview | null {
  const [preview, setPreview] = useState<GuestPreview | null>(null);
  useMountEffect(() => {
    const prefs = readJoinPrefs();
    const p = new GuestPreview({ micId: prefs.micDeviceId, cameraId: prefs.cameraDeviceId, speakerId: prefs.speakerDeviceId });
    setPreview(p);
    void p.start({ mic: prefs.micOn, camera: prefs.cameraOn });
    return () => p.dispose();
  });
  return preview;
}

function Heading({ req }: { req: HuddleStartRequest }) {
  const names = useInboxStore((s) =>
    (req.toUserIds ?? [])
      .map((id) => s.teamMembers.find((m: any) => String(m?._id) === id))
      .filter(Boolean)
      .map((m) => firstName(memberDisplayName(m)))
      .join(", "),
  );
  const others = Math.max(0, (req.channelMemberCount ?? 1) - 1);
  const big = req.ringChannel && (req.channelMemberCount ?? 0) > CHANNEL_HUDDLE_WARNING_SIZE;
  const line = req.ringChannel
    ? big
      ? `${req.anchorTitle || "This channel"} has ${req.channelMemberCount} members. Starting buzzes all ${others} others.`
      : `Starting buzzes everyone in ${req.anchorTitle || "the channel"}.`
    : names
      ? `Starting rings ${names}.`
      : (req.hint ?? "Teammates see it and can join.");
  return (
    <div className="pr-6">
      <DialogTitle className="text-base">Start a huddle</DialogTitle>
      <DialogDescription className={`mt-0.5 text-xs ${big ? "text-sol-orange" : "text-sol-text-muted"}`}>{line}</DialogDescription>
    </div>
  );
}

function startLabel(req: HuddleStartRequest): string {
  if (req.ringChannel) return "Start and buzz everyone";
  const n = req.toUserIds?.length ?? 0;
  if (n === 1) return "Start and ring";
  if (n > 1) return `Start and ring ${n}`;
  return "Start huddle";
}

function PreviewBody({ preview }: { preview: GuestPreview }) {
  const p = useSyncExternalStore(preview.subscribe, preview.getSnapshot, preview.getSnapshot);
  const videoRef = useRef<HTMLVideoElement>(null);
  const meterRef = useRef<HTMLDivElement>(null);
  useWatchEffect(() => {
    const el = videoRef.current;
    if (!el || !p.video) return;
    p.video.attach(el);
    return () => {
      p.video?.detach(el);
    };
  }, [p.video]);
  // The level moves many times a second, so it never touches React: the
  // meter's width is a CSS variable written straight from the mic meter.
  useWatchEffect(() => {
    const write = () => meterRef.current?.style.setProperty("--lvl", String(preview.level()));
    write();
    return preview.subscribeLevel(write);
  }, [preview, p.audio]);

  const toggle = (kind: "mic" | "camera") => {
    const on = kind === "mic" ? !p.audio : !p.video;
    if (kind === "mic") {
      rememberMic(on);
      void preview.setMic(on);
    } else {
      rememberCamera(on);
      void preview.setCamera(on);
    }
  };
  const choose = (kind: PreviewKind, id: string) => {
    void preview.choose(kind, id);
    void switchDevice(DEVICE_KIND[kind], id);
  };
  const ctl = (on: boolean) =>
    p.asking ? "bg-white/10 text-white/50" : on ? "bg-white/15 text-white hover:bg-white/25" : "bg-sol-red/85 text-white hover:bg-sol-red";
  const trouble = [p.micError, p.cameraError].filter(Boolean).join(". ");
  const kinds: PreviewKind[] = canPickSpeaker() ? ["mic", "camera", "speaker"] : ["mic", "camera"];

  return (
    <>
      <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black/60">
        {p.video ? (
          <video ref={videoRef} autoPlay playsInline muted className="h-full w-full -scale-x-100 object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center pb-10 text-xs text-white/60">
            {p.asking ? "Allow your camera and microphone in the browser's prompt" : p.cameraError ? "No camera" : "Your camera is off"}
          </div>
        )}
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-2 bg-gradient-to-t from-black/55 to-transparent pb-2.5 pt-8">
          <button
            type="button"
            disabled={p.asking}
            onClick={() => toggle("mic")}
            className={`rounded-full p-2.5 backdrop-blur transition-colors ${ctl(!!p.audio)}`}
            aria-label={p.audio ? "Turn your microphone off" : "Turn your microphone on"}
            title={p.audio ? "Turn your microphone off" : "Turn your microphone on"}
          >
            {p.audio || p.asking ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
          </button>
          <button
            type="button"
            disabled={p.asking}
            onClick={() => toggle("camera")}
            className={`rounded-full p-2.5 backdrop-blur transition-colors ${ctl(!!p.video)}`}
            aria-label={p.video ? "Turn your camera off" : "Turn your camera on"}
            title={p.video ? "Turn your camera off" : "Turn your camera on"}
          >
            {p.video || p.asking ? <Video className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
          </button>
        </div>
      </div>
      {/* Says the microphone is really hearing the room, which no label can. */}
      <div className="flex items-center gap-2" title="Your microphone's level">
        <Mic className="h-3.5 w-3.5 shrink-0 text-sol-text-dim" />
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-sol-bg-highlight">
          <div
            ref={meterRef}
            className="h-full origin-left rounded-full bg-sol-green transition-transform duration-75 ease-linear"
            style={{ transform: "scaleX(var(--lvl, 0))" }}
          />
        </div>
      </div>
      {trouble && !p.asking && <p className="text-xs leading-snug text-sol-orange">{trouble}.</p>}
      <div className={`grid gap-2 ${kinds.length === 3 ? "grid-cols-3" : "grid-cols-2"}`}>
        {kinds.map((k) => {
          const devices = p.devices[k];
          const chosen = p.choice[`${k}Id` as const];
          const value = devices.some((d) => d.deviceId === chosen) ? chosen : (devices.find((d) => d.deviceId === "default") ?? devices[0])?.deviceId ?? "";
          return (
            <label key={k} className="min-w-0">
              <span className="text-[10px] uppercase tracking-wide text-sol-text-muted">{KIND_WORD[k]}</span>
              <select
                value={value}
                disabled={devices.length === 0}
                onChange={(e) => choose(k, e.target.value)}
                className="mt-0.5 w-full truncate rounded-md border border-sol-border/60 bg-sol-bg px-1.5 py-1 text-[11px] text-sol-text outline-none focus:ring-1 focus:ring-sol-cyan/60 disabled:opacity-50"
              >
                {devices.length === 0 ? (
                  <option value="">{p.asking ? "Waiting for permission" : `No ${KIND_WORD[k].toLowerCase()}`}</option>
                ) : (
                  <DeviceOptions kind={DEVICE_KIND[k]} devices={devices} />
                )}
              </select>
            </label>
          );
        })}
      </div>
    </>
  );
}
