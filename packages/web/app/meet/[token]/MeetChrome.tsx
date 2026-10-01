import type { ReactNode } from "react";
import { AudioLines, Camera, Mic, Volume2 } from "lucide-react";
import type { DeviceChoice } from "../../../lib/calls/guestRoom";
import { firstName } from "../../../components/calls/speakers";

// The pieces every screen of the guest's page is built from: the shell, the
// notice about transcription and recording, and the device pickers. One
// place, so the lobby, the door and the call say the same things the same way.

export function MeetShell({ children, bar }: { children: ReactNode; bar?: ReactNode }) {
  // `dark` here, not on <html>: the page is always the call's dark room,
  // whatever theme the visitor's system asks the rest of the site for.
  return (
    <main className="meet dark flex min-h-dvh flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 px-4 sm:px-6">
        <a className="meet-mark" href="https://codecast.sh" target="_blank" rel="noreferrer">
          <i aria-hidden />
          codecast
        </a>
        {bar}
      </header>
      {children}
    </main>
  );
}

/** What a meeting is called on the guest's page: the name the inviter could
 *  see, else who invited them ("A call with Sam"). */
export function meetingTitle(title: string | null | undefined, inviter: { name: string | null } | null | undefined): string {
  return title?.trim() || (inviter?.name ? `A call with ${firstName(inviter.name)}` : "A codecast call");
}

/**
 * The notice a guest gets before joining and keeps while inside: is what they
 * say written down, is their face on file. Plain words about what happens to
 * them, never a checkbox: asking to join under the notice is the consent the
 * server records (requestJoin's accept_notice).
 */
export function CallNotice({
  transcribed,
  recording,
  compact = false,
}: {
  transcribed: boolean;
  recording: boolean;
  compact?: boolean;
}) {
  const rows: Array<{ key: string; icon: ReactNode; tone: string; text: string }> = [];
  if (recording) {
    rows.push({
      key: "rec",
      icon: <span className="block h-2 w-2 animate-pulse rounded-full bg-sol-red motion-reduce:animate-none" />,
      tone: "border-sol-red/25 bg-sol-red/[0.07]",
      text: compact
        ? "Being recorded, video and screen shares included."
        : "This call is being recorded, video and screen shares included. The recording is kept with the team's notes.",
    });
  }
  if (transcribed) {
    rows.push({
      key: "words",
      icon: <AudioLines className="h-3.5 w-3.5 text-sol-cyan" />,
      tone: "border-sol-cyan/20 bg-sol-cyan/[0.06]",
      text: compact
        ? "Transcribed: what you say is written down."
        : "This call is transcribed. What everyone says is written down for the team, and the AI agents they work with can read it.",
    });
  }
  if (rows.length === 0) {
    return (
      <p className="text-[11.5px] leading-relaxed text-sol-text-muted">
        This call is not being transcribed or recorded right now. If that changes while you are in it, you will see it here.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((r) => (
        <div key={r.key} className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 ${r.tone}`}>
          <span className="mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center">{r.icon}</span>
          <span className="text-[11.5px] leading-relaxed text-sol-text-secondary">{r.text}</span>
        </div>
      ))}
    </div>
  );
}

/** The live pills in the call's bar: recording and transcribing, while true. */
export function NoticePills({ transcribed, recording }: { transcribed: boolean; recording: boolean }) {
  return (
    <>
      {recording && (
        <span
          className="flex shrink-0 items-center gap-1.5 rounded-full bg-sol-red/15 px-2 py-0.5 font-mono text-[11px] text-sol-red"
          title="This call is being recorded, video and screen shares included"
        >
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sol-red motion-reduce:animate-none" />
          <span className="max-sm:hidden">recording</span>
          <span className="sm:hidden">rec</span>
        </span>
      )}
      {transcribed && (
        <span
          className="flex shrink-0 items-center gap-1.5 rounded-full bg-sol-cyan/10 px-2 py-0.5 font-mono text-[11px] text-sol-cyan"
          title="This call is transcribed: what everyone says is written down"
        >
          <AudioLines className="h-3 w-3" />
          <span className="max-sm:hidden">transcribed</span>
        </span>
      )}
    </>
  );
}

const DEVICE_META = {
  mic: { icon: Mic, label: "Microphone", empty: "No microphone found" },
  camera: { icon: Camera, label: "Camera", empty: "No camera found" },
  speaker: { icon: Volume2, label: "Speaker", empty: "System default" },
} as const;

/** One device picker: the platform's own select (a phone's sheet is the
 *  right control there), dressed to sit in the page. Without permission the
 *  browser lists devices with no names, so they read "Microphone 1". */
export function DeviceSelect({
  kind,
  devices,
  choice,
  onChoose,
}: {
  kind: "mic" | "camera" | "speaker";
  devices: MediaDeviceInfo[];
  choice: DeviceChoice;
  onChoose: (kind: "mic" | "camera" | "speaker", id: string) => void;
}) {
  const meta = DEVICE_META[kind];
  const Icon = meta.icon;
  const value = (kind === "mic" ? choice.micId : kind === "camera" ? choice.cameraId : choice.speakerId) ?? devices[0]?.deviceId ?? "";
  return (
    <label className="relative flex min-w-0 flex-1 items-center gap-2 text-sol-text-muted">
      <Icon className="pointer-events-none absolute left-2.5 h-3.5 w-3.5" aria-hidden />
      <select
        aria-label={meta.label}
        value={value}
        disabled={devices.length === 0}
        onChange={(e) => onChoose(kind, e.target.value)}
        className="meet-select w-full min-w-0 truncate rounded-lg py-1.5 pl-8 font-mono text-[11.5px] text-sol-text-secondary outline-none ring-1 ring-white/[0.08] transition-colors hover:ring-white/15 focus-visible:ring-sol-cyan/60 disabled:opacity-50"
      >
        {devices.length === 0 ? (
          <option value="">{meta.empty}</option>
        ) : (
          devices.map((d, i) => (
            <option key={d.deviceId || i} value={d.deviceId}>
              {d.label || `${meta.label} ${i + 1}`}
            </option>
          ))
        )}
      </select>
    </label>
  );
}
