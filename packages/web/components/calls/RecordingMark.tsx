import { useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { formatCallTime } from "@codecast/shared/entities";
import { RECORDING_SHARED_WORDS, STOP_RECORDING_ASK } from "../../lib/calls/roomRecordingEnd";
import "./recorder.css";

// THE RED MARK: a huddle is being recorded. One look on every call surface
// (the stage's header, the face row's card, a live room in the sidebar, the
// call page, the guest's own stage), so a person who has seen it once knows
// it everywhere: the breathing red dot the meeting recorder already wears,
// and "REC" beside it, with the time filmed when there is room for it.
//
// Red and REC mean one thing: the room is being filmed right now. A run that
// was stopped and is only being saved wears neither: a still, dim dot and
// "saving", so nobody reads a finished recording as one still running.
//
// And the way to end it, in the same file because it is the same on every
// surface: the mark is the Stop control wherever a person in the room sees
// it, and stopping is always asked once more (StopRecordingQuestion), since
// it ends the recording for everyone.
//
// Store free on purpose, like GuestTag: the guest's page draws the same mark
// from its own state and never loads the app's store. The hosts that do have
// the store read the room's state and hand it in.

export type RecordingMarkStatus = "starting" | "recording" | "stopping";

/** The words for a mark's tooltip and screen readers: what is happening, who
 *  started it, and that anyone in the room may end it. */
export function recordingMarkTitle(status: RecordingMarkStatus, by?: string | null, shared = false): string {
  if (status === "stopping") return "Recording stopped. Saving the video";
  const who = by ? ` ${by} started it.` : "";
  const where = shared ? ` ${RECORDING_SHARED_WORDS}` : "";
  return `This call is being recorded.${who}${where} Anyone in the call can stop it`;
}

const SAVING_DOT = "h-[7px] w-[7px] shrink-0 rounded-full bg-sol-text-dim";

export function RecordingMark({
  status = "recording",
  startedAt,
  by,
  shared = false,
  size = "regular",
  className = "",
}: {
  status?: RecordingMarkStatus;
  /** The run's video will be on the call's public link: said in the tooltip. */
  shared?: boolean;
  /** Wall ms the room began to be filmed; the clock runs from it. Absent: no clock. */
  startedAt?: number | null;
  /** Whoever pressed Record, for the tooltip. */
  by?: string | null;
  /** `regular` reads "REC 12:34" on a pill ("starting" until the room is
   *  being filmed); `pill` is the same pill with no clock, for a surface that
   *  knows only that the room records (the guest's bar, the call page's
   *  header); `dot` is the dot and "REC" alone, for the tight places (a face
   *  row card, a list row). */
  size?: "regular" | "pill" | "dot";
  className?: string;
}) {
  const title = recordingMarkTitle(status, by, shared);
  const saving = status === "stopping";
  const dot = <span className={saving ? SAVING_DOT : "rec-pill-dot rec-pill-dot--sm"} aria-hidden="true" />;
  if (size === "dot") {
    return (
      <span
        className={`inline-flex shrink-0 items-center gap-1 font-mono text-[10px] font-semibold tracking-wide ${
          saving ? "text-sol-text-muted" : "text-sol-red"
        } ${className}`}
        title={title}
        aria-label={title}
        role="img"
      >
        {dot}
        {saving ? "saving" : "REC"}
      </span>
    );
  }
  if (saving) {
    return (
      <span
        className={`inline-flex shrink-0 items-center gap-1.5 rounded-md bg-sol-bg-alt/60 px-2 py-1 font-mono text-[11px] font-medium text-sol-text-muted ring-1 ring-inset ring-sol-border/40 ${className}`}
        title={title}
        aria-label={title}
        role="img"
      >
        {dot}
        Saving recording
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
      {dot}
      <span className="font-semibold tracking-wide">REC</span>
      {size === "regular" &&
        (status === "starting" || !startedAt ? <span className="text-sol-red/80">starting</span> : <RecordingClock startedAt={startedAt} />)}
    </span>
  );
}

/** Time filmed so far, from the room's own time 0. Its own one-second clock,
 *  shared with every other one in the app, so only this span re-renders. */
function RecordingClock({ startedAt }: { startedAt: number }) {
  const now = useCoarseNow(1000);
  return <span className="tabular-nums">{formatCallTime(Math.max(0, now - startedAt))}</span>;
}

// ── Stopping, asked once more ────────────────────────────────────────────

// The question every Stop asks lives with the phone's words
// (lib/calls/roomRecordingEnd); re-exported for this file's importers.
export { STOP_RECORDING_ASK };

/** The question and its two answers. `dense` is one line for a face row
 *  card: the question, Stop, Keep. Focus is the host's to place; Stop is
 *  never the default, so a stray Enter cannot end the room's recording. */
export function StopRecordingQuestion({
  onStop,
  onKeep,
  busy = false,
  error = null,
  dense = false,
}: {
  onStop: () => void;
  onKeep: () => void;
  busy?: boolean;
  error?: string | null;
  dense?: boolean;
}) {
  const stop = (
    <button
      type="button"
      onClick={onStop}
      disabled={busy}
      className={`flex shrink-0 items-center gap-1.5 rounded-md bg-sol-red font-mono font-medium text-white transition-colors hover:bg-sol-red/85 disabled:opacity-60 ${
        dense ? "px-1.5 py-0.5 text-[10px]" : "px-3 py-1.5 text-[11.5px]"
      }`}
    >
      {busy && <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />}
      Stop
    </button>
  );
  const keep = (
    <button
      type="button"
      onClick={onKeep}
      className={`flex shrink-0 items-center gap-1.5 rounded-md font-mono text-sol-text-muted transition-colors hover:bg-white/[0.06] hover:text-sol-text ${
        dense ? "px-1.5 py-0.5 text-[10px]" : "px-2.5 py-1.5 text-[11.5px]"
      }`}
    >
      {dense ? "Keep" : STOP_RECORDING_ASK.keep}
    </button>
  );
  if (dense) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[10px] text-sol-text-secondary" role="group" aria-label={STOP_RECORDING_ASK.title}>
        <span className="whitespace-nowrap" title={`${STOP_RECORDING_ASK.title} ${STOP_RECORDING_ASK.body}`}>
          Stop for everyone?
        </span>
        {stop}
        {keep}
      </span>
    );
  }
  return (
    <>
      <div className="flex items-center gap-2 font-mono text-[12px] text-sol-text">
        <span className="h-2 w-2 shrink-0 rounded-full bg-sol-red" aria-hidden="true" />
        {STOP_RECORDING_ASK.title}
      </div>
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-sol-text-muted">Anyone in the call can stop it. {STOP_RECORDING_ASK.body}</p>
      {error && <p className="mt-1.5 text-[11.5px] leading-relaxed text-sol-orange">{error}</p>}
      <div className="mt-3 flex items-center justify-end gap-2">
        {keep}
        {stop}
      </div>
    </>
  );
}

export const PLACE = {
  /** Under the control, its right edge on the control's. */
  below: "right-0 top-full mt-2",
  /** Under the control, its left edge on the control's. */
  "below-start": "left-0 top-full mt-2",
  /** Over the control, centred on it (a control bar at the bottom). */
  above: "bottom-full left-1/2 mb-3 -translate-x-1/2",
} as const;

/**
 * A control that stops the room's recording: whatever it draws (the mark, a
 * round button), a press opens the question beside it and the second press
 * stops the recording for everyone. The question closes on Esc, a press
 * outside, or Keep. `onStop` may reject with why (a guest's stop is a request
 * with an answer); the reason shows in the question and it stays open.
 *
 * `asking` and `onAsk` let a host open the question from elsewhere (the
 * guest's notice has its own "Stop recording").
 */
export function RecordingStopControl({
  onStop,
  children,
  asking: askingProp,
  onAsk,
  place = "below",
  label = "This call is being recorded. Stop recording",
  title,
  disabled = false,
  buttonClassName = "flex items-center rounded-md transition-opacity hover:opacity-80",
  className = "",
  describe = (err) => (err instanceof Error && err.message ? err.message : "Could not stop the recording"),
}: {
  onStop: () => Promise<unknown> | void;
  children: ReactNode;
  asking?: boolean;
  onAsk?: (asking: boolean) => void;
  place?: keyof typeof PLACE;
  label?: string;
  title?: string;
  disabled?: boolean;
  buttonClassName?: string;
  className?: string;
  /** A rejected stop as the sentence the question shows. */
  describe?: (err: unknown) => string;
}) {
  const [own, setOwn] = useState(false);
  const asking = askingProp ?? own;
  const setAsking = onAsk ?? setOwn;
  const rootRef = useRef<HTMLSpanElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useWatchEffect(() => {
    if (!asking) return setError(null);
    // On the question, not on Stop: ending the room's recording is a
    // deliberate press, never a stray Enter or Space.
    boxRef.current?.focus();
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setAsking(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [asking]);
  const stop = () => {
    setError(null);
    const done = onStop();
    if (!done) return setAsking(false);
    setBusy(true);
    void done
      .then(() => setAsking(false))
      .catch((err) => setError(describe(err)))
      .finally(() => setBusy(false));
  };
  return (
    <span ref={rootRef} className={`relative shrink-0 ${className}`}>
      <button
        type="button"
        onClick={() => setAsking(!asking)}
        disabled={disabled}
        className={buttonClassName}
        aria-expanded={asking}
        aria-label={label}
        title={title}
      >
        {children}
      </button>
      {asking && (
        <div
          ref={boxRef}
          role="dialog"
          aria-label={STOP_RECORDING_ASK.title}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            // A stage collapses on Esc; this Esc only closes the question.
            e.stopPropagation();
            setAsking(false);
          }}
          className={`absolute z-20 w-[min(280px,calc(100vw-24px))] outline-none ${PLACE[place]}`}
        >
          {/* The rise is on an inner box: the enter animation writes
              `transform`, which would drop a centring translate above. */}
          <div className="rounded-xl bg-sol-bg-alt p-3 text-left shadow-2xl ring-1 ring-white/[0.08] animate-in fade-in duration-150 motion-reduce:animate-none">
            <StopRecordingQuestion onStop={stop} onKeep={() => setAsking(false)} busy={busy} error={error} />
          </div>
        </div>
      )}
    </span>
  );
}
