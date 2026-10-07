import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { Loader2 } from "lucide-react";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { BELOW_SM, useMediaQuery } from "../../hooks/useIsPhone";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { usePressOutside } from "../../hooks/usePressOutside";
import { useMountEffect } from "../../hooks/useMountEffect";
import { formatCallTime } from "@codecast/shared/entities";
import { KeyCap } from "../KeyCap";
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
function recordingMarkTitle(status: RecordingMarkStatus, by?: string | null, shared = false): string {
  if (status === "stopping") return "Recording stopped. Saving the video";
  const who = by ? ` ${by} started it.` : "";
  const where = shared ? ` ${RECORDING_SHARED_WORDS}` : "";
  return `This call is being recorded.${who}${where} Anyone in the call can stop it`;
}

/** The color of a run that is only being saved: still and grey, never red.
 *  The mark's dot and the Record button's (while the last run saves) both
 *  wear it, so the saving look has one home. */
export const SAVING_DOT_COLOR = "bg-sol-text-dim";
const SAVING_DOT = `h-[7px] w-[7px] shrink-0 rounded-full ${SAVING_DOT_COLOR}`;

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

/** The type of the two questions about the room's recording (Record's
 *  first press, and Stop): one title size and one body size, so the two read
 *  as the same component side by side. */
export const QUESTION_TITLE = "font-mono text-[12.5px] text-sol-text";
export const QUESTION_BODY = "text-[12px] leading-relaxed";

/** The question and its two answers. `dense` is one line for a face row
 *  card: the question, Stop, Keep. Focus is the host's to place; Stop is
 *  never the default, so a stray Enter cannot end the room's recording.
 *  `escKeeps`: the host closes the question on Esc (RecordingQuestionBox),
 *  so Keep shows the key. */
export function StopRecordingQuestion({
  onStop,
  onKeep,
  busy = false,
  error = null,
  dense = false,
  escKeeps = false,
}: {
  onStop: () => void;
  onKeep: () => void;
  busy?: boolean;
  error?: string | null;
  dense?: boolean;
  escKeeps?: boolean;
}) {
  const stop = (
    <button
      type="button"
      onClick={onStop}
      disabled={busy}
      className={`sol-btn-solid flex shrink-0 items-center gap-1.5 rounded-md bg-sol-red font-mono font-medium text-white disabled:opacity-60 ${
        dense ? "px-1.5 py-0.5 text-[10px]" : "px-3 py-1.5 text-[11.5px]"
      }`}
    >
      {busy && <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />}
      {dense ? "Stop" : STOP_RECORDING_ASK.stop}
    </button>
  );
  const keep = (
    <button
      type="button"
      onClick={onKeep}
      className={`flex shrink-0 items-center gap-1.5 rounded-md font-mono text-sol-text-muted transition-colors hover:bg-sol-text-muted/10 hover:text-sol-text ${
        dense ? "px-1.5 py-0.5 text-[10px]" : "px-2.5 py-1.5 text-[11.5px]"
      }`}
    >
      {dense ? "Keep" : STOP_RECORDING_ASK.keep}
      {!dense && escKeeps && <KeyCap size="xs">Esc</KeyCap>}
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
      <div className={`flex items-center gap-2 ${QUESTION_TITLE}`}>
        <span className="h-2 w-2 shrink-0 rounded-full bg-sol-red" aria-hidden="true" />
        {STOP_RECORDING_ASK.title}
      </div>
      <p className={`mt-2 ${QUESTION_BODY} text-sol-text-muted`}>Anyone in the call can stop it. {STOP_RECORDING_ASK.body}</p>
      {error && <p className={`mt-1.5 ${QUESTION_BODY} text-sol-orange`}>{error}</p>}
      <div className="mt-3.5 flex items-center justify-end gap-2">
        {keep}
        {stop}
      </div>
    </>
  );
}

// On a phone a box hung from its control runs off an edge whenever the
// control is off the screen's centre (the guest's REC pill sits near the
// right, the stage's badge near the left), so below `sm` every placement is
// pinned to the screen's sides instead: under the guest's bar for a control
// at the top, over the stage's control bar for one at the bottom. The same
// rule the guest's devices popover uses. Each placement's own width gives way
// to the screen's (`max-sm:w-auto`). The offsets here are the guest page's
// bars; a question opened from a control measures where that control sits
// (usePhonePin) and lands just past it, since the member's stage header and
// the strip under the app's header put theirs at other heights.
const PHONE_BELOW = "max-sm:fixed max-sm:inset-x-3 max-sm:top-[calc(env(safe-area-inset-top)+56px)] max-sm:mt-0 max-sm:w-auto";
const PHONE_ABOVE =
  "max-sm:fixed max-sm:inset-x-3 max-sm:bottom-[calc(76px+env(safe-area-inset-bottom))] max-sm:top-auto max-sm:mb-0 max-sm:w-auto max-sm:translate-x-0";

export const PLACE = {
  /** Under the control, its right edge on the control's. */
  below: `right-0 top-full mt-2 ${PHONE_BELOW}`,
  /** Under the control, its left edge on the control's. */
  "below-start": `left-0 top-full mt-2 ${PHONE_BELOW}`,
  /** Over the control, centred on it (a control bar at the bottom). */
  above: `bottom-full left-1/2 mb-3 -translate-x-1/2 ${PHONE_ABOVE}`,
} as const;

/**
 * Where a question pinned to the screen's sides (PLACE's phone classes) sits
 * on a phone: just past the control it opened from, under it for a `below`
 * placement and over it for `above`, with PLACE's own gap. Measured before
 * paint while the question is open (and again on a resize or rotation), so
 * one control at the top of the guest's bar, the stage's header or the strip
 * under the app's header each get a question at their own edge rather than
 * at one height that covered some of them. Nothing above `sm`, where the box
 * hangs from its control.
 */
function usePhonePin(anchorRef: RefObject<HTMLElement | null>, place: keyof typeof PLACE, open: boolean): CSSProperties | undefined {
  const phone = useMediaQuery(BELOW_SM);
  const [edge, setEdge] = useState<number | null>(null);
  const above = place === "above";
  useLayoutEffect(() => {
    if (!open || !phone) return setEdge(null);
    const measure = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (r) setEdge(above ? window.innerHeight - r.top + 12 : r.bottom + 8);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, phone, above, anchorRef]);
  if (!phone || edge === null) return undefined;
  return above ? { bottom: edge } : { top: edge };
}

/**
 * The box both questions about the room's recording open in (Record's first
 * press, RoomRecording's RecordConfirm, and Stop): hung from its control at
 * `place` (pinned to the screen's sides on a phone), one width, one look,
 * rising from its control's side. Focus lands on the box, never on a
 * button, so a stray Space answers nothing. Esc closes it (and only it: a
 * stage collapses on Esc), and so does a press outside `insideRef` (the
 * control and the box together). `onEnter` makes Enter on the box itself an
 * answer, for a question whose deliberate second step is its default
 * (Record); without it Enter does nothing, so Stop is never a stray Enter.
 * A held Enter (the press that opened it, repeating) is not an answer.
 */
export function RecordingQuestionBox({
  label,
  place,
  insideRef,
  onClose,
  onEnter,
  children,
}: {
  /** The question, for screen readers. */
  label: string;
  place: keyof typeof PLACE;
  insideRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onEnter?: () => void;
  children: ReactNode;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const pin = usePhonePin(insideRef, place, true);
  useMountEffect(() => boxRef.current?.focus());
  usePressOutside(insideRef, true, onClose, { escape: true });
  return (
    <div
      ref={boxRef}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (onEnter && e.key === "Enter" && !e.repeat && e.target === e.currentTarget) {
          e.preventDefault();
          e.stopPropagation();
          onEnter();
        }
      }}
      className={`absolute z-20 w-[min(300px,calc(100vw-24px))] outline-none ${PLACE[place]}`}
      style={pin}
    >
      {/* The rise is on an inner box: the enter animation writes
          `transform`, which would drop a centring translate above. */}
      <div
        className={`rounded-xl bg-sol-bg-alt p-3.5 text-left shadow-2xl ring-1 ring-sol-border/40 animate-in fade-in ${
          place === "above" ? "slide-in-from-bottom-1" : "slide-in-from-top-1"
        } duration-150 motion-reduce:animate-none`}
      >
        {children}
      </div>
    </div>
  );
}

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useWatchEffect(() => {
    if (!asking) setError(null);
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
        // On the question, not on Stop, and no onEnter: ending the room's
        // recording is a deliberate press, never a stray Enter or Space.
        <RecordingQuestionBox label={STOP_RECORDING_ASK.title} place={place} insideRef={rootRef} onClose={() => setAsking(false)}>
          <StopRecordingQuestion onStop={stop} onKeep={() => setAsking(false)} busy={busy} error={error} escKeeps />
        </RecordingQuestionBox>
      )}
    </span>
  );
}
