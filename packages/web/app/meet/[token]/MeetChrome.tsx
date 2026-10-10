import { useState, type ReactNode } from "react";
import { AudioLines, Camera, Mic, Volume2 } from "lucide-react";
import { guestNoticeLines, noticeNews, type GuestNotice } from "@codecast/shared/contracts";
import type { DeviceChoice } from "../../../lib/calls/guestRoom";
import { LogoMark } from "../../../components/Logo";
import { buttonVariants } from "../../../components/ui/button";

// The pieces every screen of the guest's page is built from: the shell, the
// notice about transcription and recording, and the device pickers. One
// place, so the lobby, the door and the call say the same things the same way.

/** The guest page's main press (Ask to join, Join, Ask again, Copy link):
 *  the app's Button in its cyan face, so an outsider's first look at
 *  codecast presses the way the app does. Padding is the caller's, by where
 *  it sits, so no size is applied here. */
export const GUEST_PRIMARY = buttonVariants({ variant: "cyan", size: null, className: "rounded-xl font-semibold" });

export function MeetShell({ children, bar }: { children: ReactNode; bar?: ReactNode }) {
  // `dark` here, not on <html>: the page is always the call's dark room,
  // whatever theme the visitor's system asks the rest of the site for.
  return (
    <main className="meet dark flex min-h-dvh flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 px-4 sm:px-6">
        <a className="meet-mark" href="https://codecast.sh" target="_blank" rel="noreferrer">
          <LogoMark size={16} monochrome />
          codecast
        </a>
        {bar}
      </header>
      {children}
    </main>
  );
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
  videoPublic = false,
  wordsPublic = false,
  compact = false,
  since,
}: {
  transcribed: boolean;
  recording: boolean;
  /** The recording's video goes to the call's public link: part of what the
   *  guest agrees to, so it is said wherever the recording is. */
  videoPublic?: boolean;
  /** The transcript goes to the call's public link, said wherever the
   *  transcription is, the same way. */
  wordsPublic?: boolean;
  /** The short lines alone (the waiting card's). Otherwise each line leads
   *  with its short form, the sentence the eye lands on before Ask to join,
   *  and the rest (who keeps it, who can watch, what can be shared) is one
   *  press away under it: accurate, and not a wall a guest scrolls past. */
  compact?: boolean;
  /** The notice the guest asked to join under, when they already have: a
   *  row that was not part of it is marked as new, so a recording that
   *  started while they waited is not just one more line in a list. */
  since?: GuestNotice | null;
}) {
  const notice: GuestNotice = { recording, transcribed, video_public: recording && videoPublic, words_public: transcribed && wordsPublic };
  const lines = guestNoticeLines(notice, "short");
  const long = compact ? null : guestNoticeLines(notice, "long");
  const [open, setOpen] = useState<Partial<Record<"rec" | "words", boolean>>>({});
  const news = noticeNews(since, notice);
  // A recording or a transcript they were told of that went to the public
  // link since is news of its own, and worded as that rather than as a
  // fresh start.
  const nowPublic = { rec: !!since?.recording && news.rec, words: !!since?.transcribed && news.words };
  if (lines.length === 0) {
    return (
      <p className="text-[11.5px] leading-relaxed text-sol-text-muted">
        This call is not being transcribed or recorded right now. If that changes while you are in it, you will see it here.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      {lines.map((l) => {
        const rec = l.key === "rec";
        const fresh = rec ? news.rec : news.words;
        return (
          <div
            key={l.key}
            className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 ${
              rec ? "border-sol-red/25 bg-sol-red/[0.07]" : "border-sol-cyan/20 bg-sol-cyan/[0.06]"
            } ${fresh ? "animate-in fade-in slide-in-from-top-1 duration-300 motion-reduce:animate-none" : ""}`}
          >
            <span className="mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center">
              {rec ? (
                <span className="block h-2 w-2 animate-pulse rounded-full bg-sol-red motion-reduce:animate-none" />
              ) : (
                <AudioLines className="h-3.5 w-3.5 text-sol-cyan" />
              )}
            </span>
            <span className="text-[11.5px] leading-relaxed text-sol-text-secondary">
              {fresh && (
                <span className={`mr-1.5 font-medium ${rec ? "text-sol-red" : "text-sol-cyan"}`}>
                  {nowPublic[l.key] ? "Now shared by public link." : rec ? "Started while you waited." : "Turned on while you waited."}
                </span>
              )}
              {long && open[l.key] ? long.find((x) => x.key === l.key)!.text : l.text}
              {long && (
                <button
                  type="button"
                  onClick={() => setOpen((o) => ({ ...o, [l.key]: !o[l.key] }))}
                  aria-expanded={!!open[l.key]}
                  className={`ml-1.5 inline-flex items-center gap-0.5 whitespace-nowrap rounded underline decoration-dotted underline-offset-2 transition-colors ${
                    rec ? "text-sol-red/80 hover:text-sol-red" : "text-sol-cyan/80 hover:text-sol-cyan"
                  }`}
                >
                  {open[l.key] ? "Less" : rec ? "What happens to the video" : "Who reads it"}
                </button>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** The live pill in the call's bar while it is transcribed. Recording wears
 *  the red mark every call surface wears (GuestInCall, RecordingMark), which
 *  is also where a guest stops it.
 *
 *  A phone has room for the word and not the rest ("transcribed", without
 *  ", public"), and a touch screen never shows a tooltip, so the pill is a
 *  button when the host can say more: a press brings back the notice line the
 *  guest was told on the way in (`onExplain`), the whole sentence, public
 *  link included. */
export function NoticePills({
  transcribed,
  wordsPublic = false,
  onExplain,
}: {
  transcribed: boolean;
  wordsPublic?: boolean;
  onExplain?: () => void;
}) {
  if (!transcribed) return null;
  const notice = { recording: false, transcribed: true, words_public: wordsPublic };
  const label = guestNoticeLines(notice, "label")[0].text;
  const title = guestNoticeLines(notice, "short")[0].text;
  const body = (
    <>
      <AudioLines className="h-3 w-3 shrink-0" />
      <span className="max-sm:hidden">{label}</span>
      <span className="text-[10px] sm:hidden">{guestNoticeLines({ ...notice, words_public: false }, "label")[0].text}</span>
    </>
  );
  const pill = "flex shrink-0 items-center gap-1.5 rounded-full bg-sol-cyan/10 px-2 py-0.5 font-mono text-[11px] text-sol-cyan max-sm:gap-1 max-sm:px-1.5";
  if (!onExplain) {
    return (
      <span className={pill} title={title}>
        {body}
      </span>
    );
  }
  return (
    <button type="button" onClick={onExplain} className={`${pill} transition-colors hover:bg-sol-cyan/20`} title={title} aria-label={title}>
      {body}
    </button>
  );
}

// `empty` is also what the lobby's preview says when the camera list is
// empty, so the picture and the picker under it name the same fact one way.
export const DEVICE_META = {
  mic: { icon: Mic, label: "Microphone", empty: "No microphone found" },
  camera: { icon: Camera, label: "Camera", empty: "No camera found" },
  speaker: { icon: Volume2, label: "Speaker", empty: "System default" },
} as const;

/** One device picker: the platform's own select (a phone's sheet is the
 *  right control there), dressed to sit in the page. Without permission the
 *  browser lists devices with no names, so they read "Microphone 1". While
 *  the permission prompt is up (`asking`) the browser lists nothing yet, and
 *  "No microphone found" beside "Allow your camera and microphone" would be
 *  two answers at once, so an empty list says it is waiting instead.
 *  `compact` is for a row of pickers under the lobby's preview: on a phone
 *  each shrinks to its icon (the platform's sheet still names every device
 *  when tapped). A list of its own, like the call's devices popover, keeps
 *  the names, so the guest can see which microphone is in use. */
export function DeviceSelect({
  kind,
  devices,
  choice,
  onChoose,
  asking = false,
  compact = false,
}: {
  kind: "mic" | "camera" | "speaker";
  devices: MediaDeviceInfo[];
  choice: DeviceChoice;
  onChoose: (kind: "mic" | "camera" | "speaker", id: string) => void;
  asking?: boolean;
  compact?: boolean;
}) {
  const meta = DEVICE_META[kind];
  const Icon = meta.icon;
  const value = (kind === "mic" ? choice.micId : kind === "camera" ? choice.cameraId : choice.speakerId) ?? devices[0]?.deviceId ?? "";
  return (
    <label className={`relative flex min-w-0 flex-1 items-center gap-2 text-sol-text-muted ${compact ? "max-sm:flex-none" : ""}`}>
      <Icon className="pointer-events-none absolute left-2.5 h-3.5 w-3.5" aria-hidden />
      <select
        aria-label={meta.label}
        value={value}
        disabled={devices.length === 0}
        onChange={(e) => onChoose(kind, e.target.value)}
        className={`meet-select w-full min-w-0 truncate rounded-lg ${compact ? "max-sm:w-[60px] max-sm:text-transparent" : ""} py-1.5 pl-8 font-mono text-[11.5px] text-sol-text-secondary outline-none ring-1 ring-white/[0.08] transition-colors hover:ring-white/15 focus-visible:ring-sol-cyan/60 disabled:opacity-50`}
      >
        {devices.length === 0 ? (
          <option value="">{asking ? "Waiting for permission" : meta.empty}</option>
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
