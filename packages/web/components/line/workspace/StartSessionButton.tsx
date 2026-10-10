"use client";
// A control that starts an agent session ("Set up judging", "Improve this
// judge", learning-loop.md LL4). A session costs money and lands in the inbox,
// so the first press says what will happen and the second starts it, the way
// the start switch states its cost before it turns on (LL5.1).
import type { ReactNode } from "react";
import { usePopover } from "./usePopover";

export function StartSessionButton({ children, what, start, className = "lw-act", primary, title, data }: {
  children: ReactNode;
  /** What the session does and what comes back, in a sentence or two. */
  what: ReactNode;
  start: () => void;
  className?: string;
  primary?: boolean;
  title?: string;
  /** Data attributes for the trigger (tests and verification find it by them). */
  data?: Record<`data-${string}`, string>;
}) {
  const { open, setOpen, ref } = usePopover();
  return (
    <div className="lw-pop-host lw-start-session" ref={ref}>
      <button type="button" className={className} data-primary={primary ? "" : undefined} data-tone={className.includes("lw-chip") ? "ask" : undefined} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)} title={title} {...data}>
        {children}
      </button>
      {open && (
        <div className="lw-pop lw-start-session-pop" role="dialog" aria-label={typeof children === "string" ? children : "Start a session"} data-line-start-session>
          <p className="lw-start-session-what">{what}</p>
          <div className="lw-start-session-foot">
            <button type="button" className="lw-act" onClick={() => setOpen(false)}>Cancel</button>
            <button type="button" className="lw-act" data-primary="" onClick={() => { setOpen(false); start(); }} data-line-start-session-go>Start the session</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** What "Set up judging" does, said before it runs. */
export const SETUP_JUDGING_WHAT = "A session drafts what to judge, tries it on recent data, and brings you one card. Nothing turns on until you answer it.";

/** What "Improve this judge" does, said before it runs. */
export function improveJudgeWhat(judge: string, wrong: number): string {
  const from = wrong ? `the ${wrong === 1 ? "finding" : `${wrong} findings`} you marked wrong` : "its recent findings";
  return `A session works out why ${judge} misjudged, starting from ${from}, tries a fix on recent data and brings you one card. Nothing changes until you answer it.`;
}
