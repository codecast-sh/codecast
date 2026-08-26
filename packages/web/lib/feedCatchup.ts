// Contiguity model for the accumulating feed caches (feedConversations, and
// eventually messageFeed — same cursor machinery, same hole class).
//
// The cache accumulates two ways: the live subscription merges the newest page,
// and "Load more" walks older pages below a persisted deep cursor. Both only
// ever extend the ENDS. While the app is closed, new rows pile on top — so a
// cache last walked weeks ago plus today's newest page has a hole in the
// middle, and neither the deep cursor nor a bottom-scroll reconfirm can ever
// reach it: the feed silently shows "Today, then July" and looks exhaustive.
//
// The fix is a persisted covered watermark per feed key: the timestamp down to
// which the cache is known contiguous with "now". Rows sort by updated_at,
// which only ever increases, so a row can leave a past time band (it updates
// and moves to the head, where the live page sees it) but can never appear
// INSIDE one — a band once fully walked stays covered forever. That makes the
// invariant sound: the cache is contiguous between the deep cursor's floor and
// the watermark. On boot, if the live page doesn't reach down to the watermark,
// walk pages from the head until it reconnects — exactly the absence gap.
//
// Legacy caches (built before the watermark existed) are hole-riddled at
// unknown depths, so they can't be trusted at all: walk from the head with a
// budget and, if the budget runs out, adopt the walk frontier as the new deep
// cursor. Deeper cached rows stay visible as display bonus, and scrolling
// re-examines everything below the frontier (dupes merge by _id), so nothing
// can stay permanently skipped.

export const FEED_CATCHUP_PAGE_LIMIT = 60;
export const FEED_CATCHUP_MAX_PAGES = 20;

// One definition for the watermark's syncMeta key (same convention as the
// sync-log scope cursors). Bump :v1 to force a one-time re-walk for everyone.
export function feedCoverMetaKey(feedKey: string): string {
  return `feedcover:v1:${feedKey}`;
}

export function newestTs(rows: Array<{ updated_at?: number }>): number | null {
  let max: number | null = null;
  for (const r of rows) {
    const ts = r.updated_at ?? 0;
    if (ts && (max === null || ts > max)) max = ts;
  }
  return max;
}

export function oldestTs(rows: Array<{ updated_at?: number }>): number | null {
  let min: number | null = null;
  for (const r of rows) {
    const ts = r.updated_at ?? 0;
    if (ts && (min === null || ts < min)) min = ts;
  }
  return min;
}

// Decide, from a fresh live page, whether the cache is contiguous with it.
//   "contiguous" — no hole; stamp the watermark at the live page's newest row.
//   "walk"       — a gap may exist between the live page and older coverage;
//                  walk pages from the head until walkStep says stop.
export function planFeedCatchup(opts: {
  coveredTo: number | undefined; // persisted watermark (undefined = never stamped)
  livePageFull: boolean; // page at server limit, or a continuation cursor exists
  liveOldest: number | null; // oldest updated_at in the live page
  cacheHasRowsBelowLive: boolean; // cached rows older than the live page exist
}): "contiguous" | "walk" {
  const { coveredTo, livePageFull, liveOldest, cacheHasRowsBelowLive } = opts;
  // A short page with no continuation IS the whole visible history.
  if (!livePageFull) return "contiguous";
  // The live page reaches down into the covered band — bands touch, no hole.
  if (coveredTo !== undefined && liveOldest !== null && liveOldest <= coveredTo)
    return "contiguous";
  // Never stamped and nothing cached below the live page: fresh cache, nothing
  // to connect to — coverage starts here.
  if (coveredTo === undefined && !cacheHasRowsBelowLive) return "contiguous";
  return "walk";
}

// Decide what a fetched walk page means.
//   "reconnected" — the page reaches the covered band; the deep cursor below
//                   stays authoritative, stop walking.
//   "end"         — the server confirmed true end-of-history (rows + null
//                   cursor); record honest end for the scroll pagination too.
//   "abort"       — empty page WITH a null cursor: indistinguishable from an
//                   auth blip (the query returns this exact shape signed out),
//                   so trust nothing — don't stamp, retry on a later push.
//   "continue"    — still above the covered band, keep walking.
export function walkStep(opts: {
  coveredTo: number | undefined;
  pageOldest: number | null;
  nextCursor: string | null;
}): "reconnected" | "end" | "abort" | "continue" {
  const { coveredTo, pageOldest, nextCursor } = opts;
  if (nextCursor === null) return pageOldest === null ? "abort" : "end";
  if (coveredTo !== undefined && pageOldest !== null && pageOldest <= coveredTo)
    return "reconnected";
  return "continue";
}
