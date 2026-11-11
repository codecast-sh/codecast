import { useState, type ReactNode } from "react";
import { Check, CircleSlash } from "lucide-react";
import { SESSION_STATUS } from "../../lib/sessionStatus";
import { SessionStatusMark } from "../inbox/SessionStatusMark";

// The Modern style's one loud thing in a transcript: something that waits on
// the person (an agent's question, a plan to approve, a secret it needs, a
// permission prompt, a decision). A card with a 2px edge in the Needs you
// colour (lib/sessionStatus), the question at the reading size in semibold,
// and the answers as real Buttons the caller passes in: primary for the
// recommended one, outline for the rest, 32px tall. Once answered it folds to
// ModernAnsweredRow, one line that says what was chosen. Everything quiet in
// the transcript is a row; this is the exception on purpose.

/** The card around an ask. `kicker` rides after the Needs you mark (a header, a tool); `aside` sits at its right (a deadline). */
export function ModernAskCard({ kicker, aside, question, detail, children, edge = "needs_you", className = "", ...rest }: {
  kicker?: ReactNode;
  aside?: ReactNode;
  question?: ReactNode;
  detail?: ReactNode;
  children?: ReactNode;
  /** The edge's colour: Needs you, or Error for an ask that failed. */
  edge?: "needs_you" | "error";
  className?: string;
} & Record<`data-${string}`, unknown>) {
  const meta = SESSION_STATUS[edge];
  return (
    <section
      data-cc-ask={edge}
      className={`my-2 min-w-0 rounded-card border border-sol-border border-l-2 bg-sol-card px-4 py-3 shadow-[0_1px_2px_rgb(16_24_22/0.05)] ${className}`}
      style={{ borderLeftColor: meta.color }}
      {...rest}
    >
      <div className="flex min-w-0 items-center gap-2 text-meta leading-5">
        <SessionStatusMark status={edge} />
        <span className={`shrink-0 font-medium ${meta.text}`}>{meta.word}</span>
        {kicker && <span className="flex min-w-0 items-center gap-2 truncate text-sol-text-muted">{kicker}</span>}
        {aside && <span className="ml-auto shrink-0 tabular-nums text-sol-text-dim">{aside}</span>}
      </div>
      {question && <div data-cc-ask-question className="mt-1.5 text-read font-semibold leading-6 text-sol-text [overflow-wrap:anywhere]">{question}</div>}
      {detail && <div data-cc-ask-detail className="mt-1 text-ui leading-5 text-sol-text-muted whitespace-pre-line [overflow-wrap:anywhere]">{detail}</div>}
      {children && <div className="mt-3 min-w-0">{children}</div>}
    </section>
  );
}

/**
 * An ask that is settled, as one row: what was asked, and at the right what
 * was chosen (or how it closed). `detail` opens under the chevron when given:
 * the question whole, with the choice in it.
 */
export function ModernAnsweredRow({ verb = "Answered", question, answer, closed, detail, ...rest }: {
  verb?: string;
  question: ReactNode;
  answer?: ReactNode;
  /** Closed without an answer (timed out, closed in the terminal): the row says so and draws no check. */
  closed?: boolean;
  detail?: ReactNode;
} & Record<`data-${string}`, unknown>) {
  const [open, setOpen] = useState(false);
  const Icon = closed ? CircleSlash : Check;
  const words = (
    <>
      <Icon data-cc-row-icon aria-hidden className={`w-4 h-4 shrink-0 ${closed ? "" : "text-sol-green"}`} strokeWidth={1.75} />
      <span data-cc-row-verb>{verb}</span>
      <span data-cc-row-text>{question}</span>
      {answer != null && answer !== "" && (
        <span data-cc-row-meta className={`max-w-[45%] overflow-hidden text-ellipsis ${closed ? "" : "!text-sol-text"}`}>{answer}</span>
      )}
    </>
  );
  return (
    <div data-cc-row="answered" {...rest}>
      {detail ? (
        <button type="button" data-cc-row-head aria-expanded={open} onClick={() => setOpen((v) => !v)} className="w-full text-left">{words}</button>
      ) : (
        <div data-cc-row-head>{words}</div>
      )}
      {open && detail && <div data-cc-row-detail className="px-3.5 py-2.5">{detail}</div>}
    </div>
  );
}
