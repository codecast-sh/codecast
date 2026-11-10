import type { ReactNode } from "react";
import Link from "next/link";
import { useTitlebarHead } from "../../hooks/useTitlebarHead";

/** The Sessions page's own header, kept for Classic and Minimal (Modern draws
 *  components/ui/page-header). The presses and their reviews come from the page. */
export function SessionsLegacyHeader({ counts, parkCount, onPark, killCount, onKill, reviews }: {
  counts: { active: number; idle: number; dead: number; hibernated: number };
  parkCount: number;
  onPark: () => void;
  killCount: number;
  onKill: () => void;
  /** The park and kill reviews, open or not. */
  reviews: { park: ReactNode; kill: ReactNode };
}) {
  const titlebarRef = useTitlebarHead<HTMLDivElement>();
  return (
        <div ref={titlebarRef} className="flex flex-wrap items-center justify-between gap-3 mb-6">
          <div className="flex flex-wrap items-center gap-4">
            <Link href="/inbox" aria-label="Back to inbox" title="Back to inbox" className="text-sol-text-muted hover:text-sol-text-secondary transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </Link>
            <h1 className="text-lg font-medium tracking-tight">Sessions</h1>
            <Link href="/resources" className="rounded border border-sol-border px-2 py-0.5 text-xs text-sol-text-secondary hover:border-sol-text-dim hover:text-sol-text" title="CPU, memory and processes per machine and session">Resources</Link>
            <div className="flex flex-wrap items-center gap-3 text-xs text-sol-text-muted font-mono">
              <span><span className="text-sol-blue">{counts.active}</span> active</span>
              <span className="text-sol-border">|</span>
              <span><span className={counts.idle > 0 ? "text-sol-yellow" : "text-sol-text-dim"}>{counts.idle}</span> idle 2h+</span>
              <span className="text-sol-border">|</span>
              <span><span className="text-sol-text-dim">{counts.dead}</span> dead</span>
              <span className="text-sol-border">|</span>
              <span><span className="text-sol-blue">{counts.hibernated}</span> hibernated</span>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
          <button className="px-3 py-1.5 text-xs rounded border border-sol-blue/30 text-sol-blue disabled:opacity-40" disabled={!parkCount} onClick={onPark} aria-haspopup="dialog" title="Request parking for your idle sessions in this view; the daemon checks safety again">Hibernate idle ({parkCount})</button>
          {reviews.park}
          {killCount > 0 && (
            <button
              onClick={onKill}
              aria-haspopup="dialog"
              className="px-3 py-1.5 text-xs bg-sol-red/15 text-sol-red border border-sol-red/30 rounded-md hover:bg-sol-red/20 transition-colors"
              title="Kill every session in the current view (terminates tmux + claude + child processes)"
            >
              Kill all {killCount}
            </button>
          )}
          {reviews.kill}
          </div>
        </div>
  );
}
