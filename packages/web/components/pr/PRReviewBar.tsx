import type { ReactNode } from "react";

/**
 * The review in progress, pinned to the bottom of the page for as long as
 * notes are waiting in it. A held note is invisible to everyone else, so the
 * page says so where the reader is, and puts the one next step beside it.
 * `children` is the review's own menu, opened from this bar.
 */
export function PRReviewBar({
  count,
  onFirst,
  children,
  centered = false,
}: {
  /** Over a full width diff it sits in the middle; beside prose it lines up
   *  with the text. */
  centered?: boolean;
  count: number;
  onFirst: () => void;
  children: ReactNode;
}) {
  const one = count === 1;
  return (
    <div className="pr-review-bar sticky bottom-0 z-30 px-4 pb-3 pt-6 pointer-events-none">
      <div
        role="status"
        className={`pointer-events-auto flex ${centered ? "mx-auto max-w-[760px]" : "max-w-[1048px]"} items-center gap-3 rounded-lg border border-sol-yellow/40 bg-sol-bg px-4 py-2.5 shadow-lg flex-wrap`}
      >
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="absolute inline-flex h-full w-full rounded-full bg-sol-yellow opacity-60 motion-safe:animate-ping" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-sol-yellow" />
        </span>
        <p className="min-w-0 flex-1 text-left text-[12px] leading-snug text-sol-text-muted">
          <button type="button" onClick={onFirst} className="text-left font-medium text-sol-text hover:underline underline-offset-2">
            {count} {one ? "note" : "notes"} not sent yet.
          </button>{" "}
          <span className="pr-review-hint">Only you can see {one ? "it" : "them"} until you finish your review.</span>
        </p>
        {children}
      </div>
    </div>
  );
}
