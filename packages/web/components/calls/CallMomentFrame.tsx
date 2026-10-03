import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, MonitorUp, Phone } from "lucide-react";
import { CALL_FRAME_PREFER, locateCallMoment, offsetIntoRecording, recordingSubject, type CallMomentMiss } from "@codecast/shared/contracts";
import { formatCallTime, parseCallRef } from "@codecast/shared/entities";
import { toVideoFile, useCallRecordings } from "../../hooks/useRoomRecording";
import { useNearViewport } from "../../hooks/useNearViewport";
import { useStableMediaSrcs } from "../../hooks/useStableMediaSrcs";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { playableFiles, videoAt } from "../../lib/calls/callVideo";

// A moment of a call, written in a message as `cl-42@12:34` on a line of its
// own: the call as it looked then, a frame of its video, linking to the call
// page waiting at that second. What an agent quotes after `cast call snap`,
// and what the call page's player copies as the moment's reference.
//
// The frame is the recording itself, seeked: no image is made or stored, so it
// is exactly the picture the page plays at that second, and it is read under
// the same rule (webCallRecordings answers only someone who may read the
// call). A moment nobody recorded still reads as the call at a time, with the
// reason there is no picture, never as a broken box.

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
      className="group my-1 block w-[min(100%,420px)] overflow-hidden rounded-lg bg-sol-bg-alt ring-1 ring-sol-border/40 transition-shadow hover:ring-sol-red/40"
      title={`Open the call at ${time}`}
      data-call-moment={rawId}
    >
      <CallMomentPicture rawId={rawId} entity={entity} served={served} />
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <Phone className="h-3.5 w-3.5 shrink-0 text-sol-red" />
        <span className="min-w-0 flex-1 truncate text-[12px] text-sol-text">{title}</span>
        <span className="shrink-0 font-mono text-[10.5px] text-sol-text-dim">{rawId}</span>
        <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-sol-text-dim transition-colors group-hover:text-sol-text" />
      </div>
    </Link>
  );
}

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
  // Latches: scrolling away keeps the frame (and its one subscription).
  const near = useNearViewport(boxRef);
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
    const filming = files.some((f) => (f.status === "starting" || f.status === "recording") && offsetIntoRecording(f, recs.call_started_at, atMs) !== null);
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
  return (
    <div ref={boxRef} className="relative aspect-video overflow-hidden bg-black">
      {located?.ok && !dead && !undrawn ? (
        src ? (
          <MomentVideo
            key={src}
            src={src}
            seconds={located.seconds}
            label={`The call at ${time}`}
            onLoaded={() => media.loaded(located.file.id)}
            onRefused={() => media.refused(located.file.id)}
            onBlank={() => setBlank(src)}
          />
        ) : (
          <div className="absolute inset-0 animate-pulse bg-white/[0.04] motion-reduce:animate-none" />
        )
      ) : recs === undefined || !served ? (
        <div className="absolute inset-0 animate-pulse bg-white/[0.04] motion-reduce:animate-none" />
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
      {located?.ok && !dead && !undrawn && located.file.kind === "screen" && (
        <span className="absolute bottom-2 right-2 flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10.5px] text-white/85">
          <MonitorUp className="h-3 w-3" /> {recordingSubject(located.file, "label")}
        </span>
      )}
    </div>
  );
}

const NO_FILES: never[] = [];

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
}: {
  src: string;
  seconds: number;
  label: string;
  onLoaded: () => void;
  onRefused: () => void;
  onBlank: () => void;
}) {
  const [step, setStep] = useState<"waiting" | "metadata" | "eager" | "drawn">("waiting");
  const blankRef = useRef(onBlank);
  blankRef.current = onBlank;
  useWatchEffect(() => {
    if (step !== "metadata" && step !== "eager") return;
    const timer = setTimeout(() => (step === "metadata" ? setStep("eager") : blankRef.current()), PAINT_WAIT_MS);
    return () => clearTimeout(timer);
  }, [step]);
  const drawn = () => setStep("drawn");
  return (
    <video
      src={`${src}#t=${seconds.toFixed(2)}`}
      preload={step === "eager" ? "auto" : "metadata"}
      muted
      playsInline
      disablePictureInPicture
      tabIndex={-1}
      aria-label={label}
      className="pointer-events-none h-full w-full object-contain"
      onLoadedMetadata={(e) => {
        onLoaded();
        if (Math.abs(e.currentTarget.currentTime - seconds) > 0.5) e.currentTarget.currentTime = seconds;
        setStep((cur) => (cur === "waiting" ? "metadata" : cur));
      }}
      onLoadedData={drawn}
      onSeeked={drawn}
      onError={onRefused}
    />
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
