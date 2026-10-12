// The confirm step in front of every huddle start (lib/calls/huddleStart):
// the person's own camera, a meter that moves when they speak, the devices
// the call will open, and the guest link for somebody outside the team. What
// is chosen here is what the join opens: device picks go through
// switchDevice and the switches through the sticky join prefs, the same
// writes the stage and call settings make, so nothing is decided twice.
import { useRef, useState, useSyncExternalStore } from "react";
import { Headphones, Link2, Loader2, Mic, MicOff, Video, VideoOff, Volume2 } from "lucide-react";
import { CHANNEL_HUDDLE_WARNING_SIZE } from "@codecast/shared/contracts";
import { GuestPreview, canPickSpeaker } from "../../lib/calls/guestRoom";
import { readJoinPrefs, rememberCamera, rememberMic } from "../../lib/calls/joinPrefs";
import { switchDevice } from "../../lib/calls/callManager";
import { closeHuddleStart, runHuddleStart, type HuddleStartRequest } from "../../lib/calls/huddleStart";
import { useInboxStore } from "../../store/inboxStore";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { SelectBox } from "../ui/select-box";
import { memberDisplayName } from "../presence/memberPresence";
import { firstName } from "./speakers";
import { DeviceOptions } from "./DeviceRows";
import { GuestInvite } from "./GuestDoor";

type PreviewKind = "mic" | "camera" | "speaker";
const DEVICE_KIND = { mic: "audioinput", camera: "videoinput", speaker: "audiooutput" } as const;
const KIND_WORD = { mic: "Microphone", camera: "Camera", speaker: "Speaker" } as const;
const KIND_ICON = { mic: Mic, camera: Video, speaker: Volume2 } as const;

export default function HuddleStartDialog({ req }: { req: HuddleStartRequest }) {
  const preview = usePreview();
  return (
    <Dialog open onOpenChange={(open) => !open && closeHuddleStart()}>
      <DialogContent className="flex w-[calc(100%-2rem)] max-w-[420px] flex-col gap-0 overflow-hidden rounded-xl border-sol-border bg-sol-bg p-0 text-sol-text">
        <Heading req={req} />
        {preview && <PreviewBody preview={preview} />}
        <div className="flex items-center gap-2 border-t border-sol-border/60 px-4 py-3">
          <GuestInvite
            roomKey={req.roomKey}
            align="start"
            trigger={({ open, toggle }) => (
              <Button variant="ghost" size="xs" onClick={toggle} aria-expanded={open} className={`-ml-2 ${open ? "text-sol-yellow" : "text-sol-text-muted"} hover:text-sol-yellow`}>
                <Link2 />
                Guest link
              </Button>
            )}
          />
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" size="sm" onClick={closeHuddleStart}>
              Cancel
            </Button>
            <Button
              variant="violet"
              size="sm"
              autoFocus
              onClick={() => {
                preview?.dispose();
                runHuddleStart(req);
              }}
            >
              <Headphones />
              Start
            </Button>
          </div>
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

// Who the start reaches, as a line of facts: the room, then who hears it.
function Heading({ req }: { req: HuddleStartRequest }) {
  const names = useInboxStore((s) =>
    (req.toUserIds ?? [])
      .map((id) => s.teamMembers.find((m: any) => String(m?._id) === id))
      .filter(Boolean)
      .map((m) => firstName(memberDisplayName(m)))
      .join(", "),
  );
  const big = req.ringChannel && (req.channelMemberCount ?? 0) > CHANNEL_HUDDLE_WARNING_SIZE;
  const reach = req.ringChannel
    ? `Buzzes ${req.channelMemberCount ? `all ${Math.max(0, req.channelMemberCount - 1)} members` : "everyone"}`
    : names
      ? `Rings ${names}`
      : (req.hint ?? "Teammates can join");
  return (
    <div className="px-4 pb-3 pt-4 pr-10">
      <DialogTitle className="text-[15px] font-medium">Start a huddle</DialogTitle>
      <DialogDescription className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-sol-text-muted">
        {req.anchorTitle && <span className="truncate text-sol-text-secondary">{req.anchorTitle}</span>}
        {req.anchorTitle && <span className="text-sol-text-dim">·</span>}
        <span className={`truncate ${big ? "text-sol-orange" : ""}`}>{reach}</span>
      </DialogDescription>
    </div>
  );
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
      <div className="relative mx-4 aspect-video overflow-hidden rounded-lg bg-black/60">
        {p.video ? (
          <video ref={videoRef} autoPlay playsInline muted className="h-full w-full -scale-x-100 object-cover" />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 pb-12 text-xs text-white/60">
            {p.asking ? <Loader2 className="h-5 w-5 animate-spin" /> : <VideoOff className="h-5 w-5" />}
            {p.asking ? "Waiting for permission" : p.cameraError ? "No camera" : "Camera off"}
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
      {trouble && !p.asking && <p className="mx-4 mt-2 text-xs leading-snug text-sol-orange">{trouble}.</p>}
      {/* One row per device, full width so a device's name is never cut.
          The microphone's row carries its level, which says the mic really
          hears the room. */}
      <div className="mx-4 my-3 divide-y divide-sol-border/50 rounded-lg ring-1 ring-sol-border/60">
        {kinds.map((k) => {
          const devices = p.devices[k];
          const chosen = p.choice[`${k}Id` as const];
          const value = devices.some((d) => d.deviceId === chosen) ? chosen : (devices.find((d) => d.deviceId === "default") ?? devices[0])?.deviceId ?? "";
          const Icon = KIND_ICON[k];
          return (
            <label key={k} className="flex items-center gap-3 px-3 py-2">
              <Icon className="h-3.5 w-3.5 shrink-0 text-sol-text-dim" aria-hidden />
              <span className="sr-only">{KIND_WORD[k]}</span>
              <SelectBox
                variant="bare"
                value={value}
                disabled={devices.length === 0}
                onChange={(e) => choose(k, e.target.value)}
                wrapperClassName="min-w-0 flex-1"
                className="truncate text-sol-text disabled:cursor-default disabled:text-sol-text-dim"
              >
                {devices.length === 0 ? (
                  <option value="">{p.asking || !p.devicesListed ? KIND_WORD[k] : `No ${KIND_WORD[k].toLowerCase()} found`}</option>
                ) : (
                  <DeviceOptions kind={DEVICE_KIND[k]} devices={devices} />
                )}
              </SelectBox>
              {k === "mic" && (
                <div className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-sol-bg-highlight" title="Microphone level">
                  <div
                    ref={meterRef}
                    className="h-full origin-left rounded-full bg-sol-green transition-transform duration-75 ease-linear"
                    style={{ transform: "scaleX(var(--lvl, 0))" }}
                  />
                </div>
              )}
            </label>
          );
        })}
      </div>
    </>
  );
}
