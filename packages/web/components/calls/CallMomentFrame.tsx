import { useMemo, useRef } from "react";
import Link from "next/link";
import { ArrowUpRight, MonitorUp, Phone } from "lucide-react";
import { CALL_FRAME_PREFER, locateCallMoment, offsetIntoRecording, recordingSubject, type CallMomentMiss } from "@codecast/shared/contracts";
import { formatCallTime, parseCallRef } from "@codecast/shared/entities";
import { toVideoFile, useCallRecordings } from "../../hooks/useRoomRecording";
import { useNearViewport } from "../../hooks/useNearViewport";
import { useStableMediaSrcs } from "../../hooks/useStableMediaSrcs";
import { playableFiles, videoAt } from "../../lib/calls/callVideo";

// A moment of a call, written in a message as `cl-42@12:34` on a line of its
// own: the call as it looked then, a frame of its video, linking to the call
// page waiting at that second. What an agent quotes after `cast call snap`,
// and what "Copy moment" on the call page puts on the clipboard.
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
 *  the hover card of an inline `cl-42@12:34` pill. The video mounts once the
 *  card comes near the screen (a thread of citations is not a wall of media
 *  players), keeps the URL it first loaded (useStableMediaSrcs: the query's
 *  window rolling over must not blank every frame on the page), and says so
 *  honestly when the URL cannot be played. */
export function CallMomentPicture({ rawId, entity, served }: { rawId: string; entity: any; served: boolean }) {
  const atMs = parseCallRef(rawId)?.at_ms ?? 0;
  const recs = useCallRecordings(entity ? String(entity._id) : null);
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
  const boxRef = useRef<HTMLDivElement>(null);
  const near = useNearViewport(boxRef);
  const media = useStableMediaSrcs(located?.ok ? [located.file] : NO_FILES);
  const src = located?.ok ? media.srcOf(located.file) : undefined;
  const dead = located?.ok ? media.dead(located.file.id) : false;
  return (
    <div ref={boxRef} className="relative aspect-video overflow-hidden bg-black">
      {located?.ok && !dead ? (
        near && src ? (
          <video
            key={src}
            // The fragment asks the browser for that frame; setting the time
            // once the length is known makes sure of it where the fragment is
            // ignored. Muted and never playing: this is a picture.
            src={`${src}#t=${located.seconds.toFixed(2)}`}
            preload="metadata"
            muted
            playsInline
            disablePictureInPicture
            tabIndex={-1}
            aria-label={`The call at ${time}`}
            className="pointer-events-none h-full w-full object-contain"
            onLoadedMetadata={(e) => {
              media.loaded(located.file.id);
              if (Math.abs(e.currentTarget.currentTime - located.seconds) > 0.5) e.currentTarget.currentTime = located.seconds;
            }}
            onError={() => media.refused(located.file.id)}
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
            {dead ? "The call's video is not available here" : missWords(located?.ok ? null : located, time)}
          </span>
        </div>
      )}
      <span className="absolute bottom-2 left-2 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-white">
        {time}
      </span>
      {located?.ok && !dead && located.file.kind === "screen" && (
        <span className="absolute bottom-2 right-2 flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10.5px] text-white/85">
          <MonitorUp className="h-3 w-3" /> {recordingSubject(located.file, "label")}
        </span>
      )}
    </div>
  );
}

const NO_FILES: never[] = [];

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
