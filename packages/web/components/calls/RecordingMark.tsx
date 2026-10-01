import { useCoarseNow } from "../../hooks/useCoarseNow";
import { fmtClock } from "./speakers";
import "./recorder.css";

// THE RED MARK: a huddle is being recorded. One look on every call surface
// (the stage's header, the face row's card, a live room in the sidebar, the
// call page, the guest's own stage), so a person who has seen it once knows
// it everywhere: the breathing red dot the meeting recorder already wears,
// and "REC" beside it, with the time filmed when there is room for it.
//
// Store free on purpose, like GuestTag: the guest's page draws the same mark
// from its own state and never loads the app's store. The hosts that do have
// the store read the room's state and hand it in.

export type RecordingMarkStatus = "starting" | "recording" | "stopping";

/** The words for a mark's tooltip and screen readers: what is happening, who
 *  started it, and that anyone in the room may end it. */
export function recordingMarkTitle(status: RecordingMarkStatus, by?: string | null): string {
  if (status === "stopping") return "Recording stopped. Saving the video";
  const who = by ? ` ${by} started it.` : "";
  return `This call is being recorded.${who} Anyone in the call can stop it`;
}

export function RecordingMark({
  status = "recording",
  startedAt,
  by,
  size = "regular",
  className = "",
}: {
  status?: RecordingMarkStatus;
  /** Wall ms the room began to be filmed; the clock runs from it. Absent: no clock. */
  startedAt?: number | null;
  /** Whoever pressed Record, for the tooltip. */
  by?: string | null;
  /** `regular` reads "REC 12:34" on a pill; `dot` is the dot and "REC" alone,
   *  for the tight places (a face row card, a list row). */
  size?: "regular" | "dot";
  className?: string;
}) {
  const title = recordingMarkTitle(status, by);
  if (size === "dot") {
    return (
      <span
        className={`inline-flex shrink-0 items-center gap-1 font-mono text-[10px] font-semibold tracking-wide text-sol-red ${className}`}
        title={title}
        aria-label={title}
        role="img"
      >
        <span className="rec-pill-dot !h-[7px] !w-[7px]" aria-hidden="true" />
        REC
      </span>
    );
  }
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-md bg-sol-red/[0.12] px-2 py-1 font-mono text-[11px] font-medium text-sol-red ring-1 ring-inset ring-sol-red/25 ${className}`}
      title={title}
      aria-label={title}
      role="img"
    >
      <span className={status === "stopping" ? "h-[7px] w-[7px] rounded-full bg-sol-red/60" : "rec-pill-dot !h-[7px] !w-[7px]"} aria-hidden="true" />
      <span className="font-semibold tracking-wide">REC</span>
      {status === "stopping" ? (
        <span className="text-sol-red/80">saving</span>
      ) : status === "starting" || !startedAt ? (
        <span className="text-sol-red/80">starting</span>
      ) : (
        <RecordingClock startedAt={startedAt} />
      )}
    </span>
  );
}

/** Time filmed so far, from the room's own time 0. Its own one-second clock,
 *  shared with every other one in the app, so only this span re-renders. */
function RecordingClock({ startedAt }: { startedAt: number }) {
  const now = useCoarseNow(1000);
  return <span className="tabular-nums">{fmtClock(Math.max(0, now - startedAt))}</span>;
}
