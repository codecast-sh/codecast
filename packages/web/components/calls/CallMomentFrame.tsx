import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Film, MonitorUp, Phone } from "lucide-react";
import { CALL_FRAME_PREFER, CALL_JUST_SAID_MS, isRecordingFilming, locateCallMoment, offsetIntoRecording, recordingSubject, type CallMomentMiss } from "@codecast/shared/contracts";
import { formatCallTime, parseCallRef } from "@codecast/shared/entities";
import { toVideoFile, useCallRecordings } from "../../hooks/useRoomRecording";
import { useNearViewport } from "../../hooks/useNearViewport";
import { useStableMediaSrcs } from "../../hooks/useStableMediaSrcs";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { ParticipantTag, PersonName } from "./GuestTag";
import { speakerColor } from "./speakers";
import { CALL_VIDEO_LOADING, playableFiles, videoAt } from "../../lib/calls/callVideo";
import { keepMomentFrame, momentFrame, momentFrameKey } from "../../lib/calls/momentFrames";

// A moment of a call, written in a message as `cl-42@12:34` on a line of its
// own: the call as it looked then, a frame of its video, linking to the call
// page waiting at that second. What an agent quotes after `cast call snap`,
// and what the call page's player copies as the moment's reference. Its
// caption is the line being said at that moment, by the rule the CLI prints
// beside the same frame (lineSaidAt), so a reader and an agent see the same
// words under the same picture.
//
// The frame is the recording itself, seeked: no image is made or stored, so it
// is exactly the picture the page plays at that second, and it is read under
// the same rule (webCallRecordings answers only someone who may read the
// call). A moment nobody recorded still reads as the call at a time, with the
// reason there is no picture, never as a broken box.
//
// The link (entityRoute) names the view as well as the second: the page's
// player opens on the room, and a frame of a shared screen must not open on a
// different picture, so it carries `view=screen` and the page shows the
// screen this frame shows, by the same rule (CALL_FRAME_PREFER).
//
// Once a frame has drawn it is kept as a picture in memory
// (lib/calls/momentFrames), and the next mount of that moment (the card
// scrolled back to, a hover card, a second citation) is an image: no
// request, no decoder.

export function CallMomentFrame({
  rawId,
  entity,
  served,
  href,
}: {
  rawId: string;
  /** The call (webGetCallRef), once resolved. */
  entity: any;
  /** The server answered, so a missing entity means no access. */
  served: boolean;
  /** The call page at this second. */
  href: string;
}) {
  const ref = parseCallRef(rawId);
  const time = formatCallTime(ref?.at_ms ?? 0);
  const title = entity?.title || entity?.short_id || ref?.call || "Call";
  // What was being said then, the most useful words a frame can carry (the
  // call's title is the same on every frame of it, so it drops to the dim
  // second line).
  const caption = momentCaption(entity, ref?.at_ms ?? 0);
  const line = caption?.line;
  const saidBefore = !!caption?.saidBefore;

  if (served && !entity) {
    return (
      <div className="my-1 w-fit max-w-full rounded-lg border border-sol-border/40 px-3 py-2 text-[11.5px] text-sol-text-dim">
        <span className="font-mono">{rawId}</span> · not available to you
      </div>
    );
  }

  return (
    <Link
      href={href}
      // The ring stays neutral on hover: the call's own colour is on its
      // icon, as on every other call card and pill, and a red ring here
      // would read as the REC mark of a call being filmed now.
      className="group my-1 block w-[min(100%,420px)] overflow-hidden rounded-lg bg-sol-bg-alt ring-1 ring-sol-border/40 transition-shadow hover:ring-sol-border/70"
      title={`Open ${title} at ${time}`}
      data-call-moment={rawId}
    >
      <CallMomentPicture rawId={rawId} entity={entity} served={served} />
      {line ? (
        <div className="px-2.5 py-1.5">
          <div className="flex items-center gap-1.5 text-[12px]" data-moment-line={line.seq}>
            <span className={`flex min-w-0 max-w-[40%] shrink-0 items-center gap-1 font-medium ${speakerColor(line.speaker_id)}`}>
              <PersonName identity={line.speaker_id} name={line.speaker_name} />
            </span>
            <span className="min-w-0 flex-1 truncate text-sol-text">{line.text}</span>
            <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-sol-text-dim transition-colors group-hover:text-sol-text" />
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-sol-text-dim">
            <Film className="h-3 w-3 shrink-0" />
            <span className="min-w-0 truncate">{title}</span>
            {saidBefore && <span className="shrink-0">· last said at {formatCallTime(line.t0)}</span>}
            <span className="ml-auto shrink-0 font-mono">{rawId}</span>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 px-2.5 py-1.5">
          {/* A frame, not a phone: in a chat of citations a red handset reads
              as a missed call, and red is kept for the REC mark of a call being
              filmed now. */}
          <Film className="h-3.5 w-3.5 shrink-0 text-sol-text-dim" />
          <span className="min-w-0 flex-1 truncate text-[12px] text-sol-text">{title}</span>
          <span className="shrink-0 font-mono text-[10.5px] text-sol-text-dim">{rawId}</span>
          <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-sol-text-dim transition-colors group-hover:text-sol-text" />
        </div>
      )}
    </Link>
  );
}

/** The line a moment's card is captioned with (webGetCallRef's `line`, the
 *  shared lineSaidAt), and whether it ended long enough before the moment
 *  that the card says when it was said, the way `cast call snap` does. */
function momentCaption(entity: any, atMs: number): { line: MomentLine; saidBefore: boolean } | null {
  const line: MomentLine | null | undefined = entity?.line;
  if (!line) return null;
  return { line, saidBefore: !line.during && atMs - line.t1 >= CALL_JUST_SAID_MS };
}

type MomentLine = { seq: number; speaker_id: string; speaker_name: string; text: string; t0: number; t1: number; during: boolean };

/** The picture alone, 16:9 with the time in its corner: the embed's top, and
 *  the hover card of an inline `cl-42@12:34` pill. Nothing is asked of the
 *  server and no video mounts until the card comes near the screen (a long
 *  thread of citations is not a wall of subscriptions, each signing every
 *  file of its call, nor of media players). The video keeps the URL it first
 *  loaded (useStableMediaSrcs: the query's window rolling over must not blank
 *  every frame on the page), and says so honestly when the URL cannot be
 *  played or the browser will not draw a frame of a video it has not played. */
export function CallMomentPicture({ rawId, entity, served }: { rawId: string; entity: any; served: boolean }) {
  const atMs = parseCallRef(rawId)?.at_ms ?? 0;
  const boxRef = useRef<HTMLDivElement>(null);
  // The subscription latches (one per call, shared by every card of it); the
  // video does not. A player holds a decoder and a buffer, so a thread of
  // citations keeps only those within a screen or so of the reader, and one
  // scrolled far past gives its player back and rests as the loading box.
  const near = useNearViewport(boxRef);
  const close = useNearViewport(boxRef, "1500px", { latch: false });
  const asked = useCallRecordings(near && entity ? String(entity._id) : null);
  // Not asked yet is "loading", not "no such call".
  const recs = near ? asked : undefined;
  const located = useMemo(() => {
    if (!recs) return null;
    const files = recs.recordings.map(toVideoFile);
    // The view `cast call snap` takes for the same citation (the shared
    // screen when one was recorded), so the frame an agent read and cited is
    // the frame its readers see.
    const hit = videoAt(files, recs.call_started_at, atMs, CALL_FRAME_PREFER);
    if (hit) return { ok: true as const, ...hit };
    // Why there is no picture, from the shared rule over every file (a file
    // still being written is "not yet", not "never"; one still filming is
    // "now", not "saving").
    const miss = locateCallMoment({ callStartedAt: recs.call_started_at, atMs, recordings: files });
    const filming = files.some((f) => isRecordingFilming(f.status) && offsetIntoRecording(f, recs.call_started_at, atMs) !== null);
    return {
      ok: false as const,
      reason: miss.ok ? ("outside" as const) : miss.reason,
      filming,
      unsigned: playableFiles(files).length === 0 && files.some((f) => f.status === "ready"),
    };
  }, [recs, atMs]);
  const time = formatCallTime(atMs);
  const media = useStableMediaSrcs(located?.ok ? [located.file] : NO_FILES);
  const src = located?.ok ? media.srcOf(located.file) : undefined;
  const dead = located?.ok ? media.dead(located.file.id) : false;
  // The browser took the video and drew nothing (see MomentVideo).
  const [blank, setBlank] = useState<string | null>(null);
  const undrawn = !!src && blank === src;
  // This moment drawn before on this page: its kept picture, shown at once.
  const frameKey = located?.ok ? momentFrameKey(located.file.id, located.seconds) : null;
  const kept = frameKey ? momentFrame(frameKey) : null;
  return (
    <div ref={boxRef} className="relative aspect-video overflow-hidden bg-black">
      {/* Until a frame draws (and wherever none will), a faint grid under the
          pulse so the box reads as a picture on its way, not a dead screen. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-[0.07]" style={GRID} />
      {kept ? (
        <img src={kept} alt={`The call at ${time}`} draggable={false} className="pointer-events-none relative h-full w-full bg-black object-contain" />
      ) : located?.ok && !dead && !undrawn ? (
        src && close ? (
          <MomentVideo
            key={src}
            src={src}
            seconds={located.seconds}
            label={`The call at ${time}`}
            onLoaded={() => media.loaded(located.file.id)}
            onRefused={() => media.refused(located.file.id)}
            onBlank={() => setBlank(src)}
            onDrawn={(el) => void keepMomentFrame(frameKey!, { call: String(entity._id), recording: located.file.id }, el)}
          />
        ) : (
          <div className={CALL_VIDEO_LOADING} />
        )
      ) : recs === undefined || !served ? (
        <div className={CALL_VIDEO_LOADING} />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-6 text-center">
          <Phone className="h-4 w-4 text-sol-text-dim" />
          <span className="text-[11.5px] leading-snug text-sol-text-muted">
            {undrawn
              ? `Open the call at ${time} to watch this moment`
              : dead
                ? "The call's video is not available here"
                : missWords(located?.ok ? null : located, time)}
          </span>
        </div>
      )}
      <span className="absolute bottom-2 left-2 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-white">
        {time}
      </span>
      {located?.ok && (kept || (!dead && !undrawn)) && located.file.kind === "screen" && (
        <span className="absolute bottom-2 right-2 flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10.5px] text-white/85">
          <MonitorUp className="h-3 w-3" /> {recordingSubject(located.file, "label")}
          <ParticipantTag identity={located.file.participant_identity} />
        </span>
      )}
    </div>
  );
}

const NO_FILES: never[] = [];

const GRID = {
  backgroundImage: "linear-gradient(to right, white 1px, transparent 1px), linear-gradient(to bottom, white 1px, transparent 1px)",
  backgroundSize: "24px 24px",
} as const;

// How long a frame gets to appear at each step before the next is tried.
const PAINT_WAIT_MS = 2_500;

/**
 * One frame of a recording: a video that never plays. The fragment asks the
 * browser for that frame, and setting the time once the length is known makes
 * sure of it where the fragment is ignored. Muted and never playing: this is
 * a picture.
 *
 * Whether it IS a picture is checked, not assumed. A desktop browser decodes
 * the frame at the seek and draws it; iOS Safari loads the metadata and draws
 * nothing of a video until it plays, which would leave a black box with a
 * time in its corner. So the frame counts as drawn only when the browser says
 * it has data at the position (`loadeddata`, `seeked`); if that has not come
 * a while after the metadata did, the element is asked to load the media
 * itself, and if it still has not, the host is told (`onBlank`) and says
 * where to watch the moment instead.
 */
function MomentVideo({
  src,
  seconds,
  label,
  onLoaded,
  onRefused,
  onBlank,
  onDrawn,
}: {
  src: string;
  seconds: number;
  label: string;
  onLoaded: () => void;
  onRefused: () => void;
  onBlank: () => void;
  /** The frame at the position is on screen: the host keeps it. */
  onDrawn: (el: HTMLVideoElement) => void;
}) {
  const [step, setStep] = useState<"waiting" | "metadata" | "eager" | "drawn">("waiting");
  const blankRef = useRef(onBlank);
  blankRef.current = onBlank;
  useWatchEffect(() => {
    if (step !== "metadata" && step !== "eager") return;
    const timer = setTimeout(() => (step === "metadata" ? setStep("eager") : blankRef.current()), PAINT_WAIT_MS);
    return () => clearTimeout(timer);
  }, [step]);
  const drawn = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    setStep("drawn");
    // Kept only once the picture is the moment's own: a first frame that
    // arrives before the seek lands is not.
    const el = e.currentTarget;
    if (Math.abs(el.currentTime - seconds) <= 0.5) onDrawn(el);
  };
  // The frame fades in over the loading box once it has data at the position,
  // so it arrives rather than pops (and a browser that loads the metadata but
  // draws nothing never shows a black rectangle in place of the pulse).
  return (
    <>
      {step !== "drawn" && <div className={CALL_VIDEO_LOADING} />}
      <video
        src={`${src}#t=${seconds.toFixed(2)}`}
        // CORS (the recordings bucket allows the app's origins), so the drawn
        // frame can be kept as a picture (lib/calls/momentFrames).
        crossOrigin="anonymous"
        preload={step === "eager" ? "auto" : "metadata"}
        muted
        playsInline
        disablePictureInPicture
        tabIndex={-1}
        aria-label={label}
        className={`pointer-events-none relative h-full w-full bg-black object-contain transition-opacity duration-150 motion-reduce:transition-none ${step === "drawn" ? "opacity-100" : "opacity-0"}`}
        onLoadedMetadata={(e) => {
          onLoaded();
          if (Math.abs(e.currentTarget.currentTime - seconds) > 0.5) e.currentTarget.currentTime = seconds;
          setStep((cur) => (cur === "waiting" ? "metadata" : cur));
        }}
        onLoadedData={drawn}
        onSeeked={drawn}
        onError={onRefused}
      />
    </>
  );
}

function missWords(
  located: { ok: false; reason: CallMomentMiss["reason"]; filming: boolean; unsigned: boolean } | null,
  time: string,
): string {
  if (!located) return "No video of this call";
  if (located.unsigned) return "The call's video is not available here";
  if (located.reason === "no_recordings") return "This call was not recorded";
  if (located.reason === "not_ready") return located.filming ? "Recording now. The frame appears once it stops" : "The recording is still saving";
  return `No video at ${time}. The call was recorded at other times`;
}
