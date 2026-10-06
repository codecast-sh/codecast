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
      <div className="text-2xl text-sol-text">{title}</div>
      <div className="text-sm text-sol-text-muted max-w-md">{lede}</div>
      {children}
      {last && (
        // The line keeps inside the screen at any width: only the title gives way.
        <Link href={last.href} title={last.title} className="mt-3 inline-flex w-full max-w-md justify-center items-baseline gap-1.5 px-4 text-[12px] text-sol-text-dim hover:text-sol-text transition-colors" data-queue-last-closed>
          <span className="shrink-0 text-sol-text-muted">{last.verdict}:</span>
          <span className="min-w-0 truncate">{last.title}</span>
          {last.ago && <span className="shrink-0">· {last.ago}</span>}
        </Link>
      )}
    </div>
  );
}
