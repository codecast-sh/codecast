import { Video } from "lucide-react";
import { callMomentHref, describeClockSpans } from "@codecast/shared/contracts";

/**
 * Which part of a call was filmed, in the call's own clock: `video 4:40-7:20`.
 * One chip for every surface that names a call's video, so the call page's
 * header and a huddle's digest (a chat row, a session's card) read the same.
 * With `callRef` it is a link to the first filmed second of the call page,
 * where the player sits; on the call page itself it is a label.
 */
export function CallVideoStretchChip({
  stretches,
  callRef,
  className = "",
}: {
  stretches: ReadonlyArray<{ fromMs: number; toMs: number }>;
  /** The call's short or full id; makes the chip a link to that moment. */
  callRef?: string | null;
  className?: string;
}) {
  if (!stretches.length) return null;
  const look = `inline-flex shrink-0 items-center gap-1 rounded-md bg-sol-red/[0.07] px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-sol-text-muted ${className}`;
  const body = (
    <>
      <Video className="h-3 w-3 text-sol-red/70" aria-hidden="true" />
      video {describeClockSpans(stretches)}
    </>
  );
  if (!callRef) {
    return (
      <span className={look} title="The parts of the call that were filmed. The lines said in them carry a red rail">
        {body}
      </span>
    );
  }
  return (
    <a
      href={callMomentHref(callRef, stretches[0].fromMs)}
      className={`${look} no-underline transition-colors hover:bg-sol-red/[0.12] hover:text-sol-text`}
      title="Watch the recording on the call page"
    >
      {body}
    </a>
  );
}
