import Link from "next/link";
import type { ReactNode } from "react";

/** The decision closed most recently, said as what happened to it: the verdict and the change it settled, as every surface leads with it. */
export type LastClosed = { verdict: string; title: string; ago: string; href: string };

// The queue with nothing in it: said plainly, so an empty queue reads as
// good news rather than a page that failed to load. The last thing closed
// shows under it, so "nothing needs you" reads as earned, not as unknown.
export function QueueEmpty({ last, title, lede, children }: {
  last?: LastClosed | null;
  /** The mode's words (ModeWords.queueEmptyTitle, queueEmptyLede). */
  title: string;
  lede: string;
  /** What sits directly under the words (the scope's "N more in Everything"). */
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-3 text-center" data-queue-empty>
      <div className="text-2xl text-sol-text" data-queue-empty-title>{title}</div>
      <div className="text-sm text-sol-text-muted max-w-md">{lede}</div>
      {last && (
        // The line keeps inside the screen at any width: only the title gives way.
        // One muted run with single spaces: "You said yes: set up the routine
        // “Bins” · just now". Only the title part gives way at a narrow width.
        <Link href={last.href} title={last.title} className="mt-3 inline-flex w-full max-w-md justify-center items-baseline px-4 text-[12px] text-sol-text-dim hover:text-sol-text transition-colors" data-queue-last-closed>
          <span className="min-w-0 truncate">{`${last.verdict}: ${last.title}`}</span>
          {last.ago && <span className="shrink-0 whitespace-pre">{` · ${last.ago}`}</span>}
        </Link>
      )}
      {/* The scope's overflow comes last: the empty state, what was just
          answered here, then where more lives. */}
      {children}
    </div>
  );
}
