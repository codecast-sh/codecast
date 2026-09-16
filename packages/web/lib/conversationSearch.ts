// In-conversation search: the pure half. The server hands back per-message hit
// counts one page at a time; this module turns pages into a flat list of hit
// instances, steps through them, and decides — from what the page currently
// has mounted — what it takes to bring one hit into view. ConversationView
// owns the DOM and runs the plan; everything here is testable without it.

export type SearchMatch = { message_id: string; timestamp: number; match_count: number };
export type SearchPage = { matches: SearchMatch[]; next_after_ts: number | null };
export type MatchInstance = { messageId: string; localIndex: number; timestamp: number };

/** Flatten per-message counts into one instance per hit, in transcript order. */
export function instancesFromMatches(matches: SearchMatch[]): MatchInstance[] {
  const out: MatchInstance[] = [];
  for (const m of matches) {
    for (let i = 0; i < m.match_count; i++) out.push({ messageId: m.message_id, localIndex: i, timestamp: m.timestamp });
  }
  return out;
}

/** Wrap-around step through `count` hits. */
export function stepIndex(current: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((current + delta) % count) + count) % count;
}

/**
 * Walk every page of a search. Pages are appended as they land so the counter
 * grows and the first hit can be shown before the tail of a long transcript
 * has been scanned. `cancelled` is polled between pages: a newer query, or a
 * closed bar, stops the walk without a stale page landing afterwards.
 */
export async function walkSearchPages(
  fetchPage: (afterTs: number | undefined) => Promise<SearchPage>,
  onPage: (all: SearchMatch[], done: boolean) => void,
  cancelled: () => boolean,
  maxPages = 64,
): Promise<void> {
  const all: SearchMatch[] = [];
  let after: number | undefined = undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await fetchPage(after);
    if (cancelled()) return;
    all.push(...page.matches);
    const done = page.next_after_ts === null || i === maxPages - 1;
    onPage(all.slice(), done);
    if (done) return;
    after = page.next_after_ts as number;
  }
}

// --- bringing one hit into view -------------------------------------------

/** How long a mounted row gets to render its text before a hit with no mark
 *  is declared dead (a message the transcript hides, or text that only exists
 *  inside a tag the renderer strips). */
export const MOUNT_GRACE_MS = 1500;
/** Upper bound on one activation (a server jump plus a virtualizer settle). */
export const ACTIVATION_DEADLINE_MS = 8000;

export type PendingHit = {
  messageId: string;
  localIndex: number;
  timestamp: number;
  /** Direction of travel, so a dead hit is skipped the way the user was going. */
  dir: 1 | -1;
  startedAt: number;
  /** A server jump was already requested for this hit; do not request another. */
  jumped: boolean;
  /** Dead hits skipped in a row; bounded by the hit count so a transcript of
   *  only dead hits cannot spin. */
  skipped: number;
};

/** What the view knows about the pending hit right now. */
export type ActivationView = {
  /** The message is inside the loaded window (not necessarily mounted). */
  loaded: boolean;
  /** Timeline index of the row that shows this message at the current
   *  density (the message itself, or the row it folds into); -1 when the
   *  timeline has no row for it at all. */
  rowIndex: number;
  /** A fold that must open before the row shows the message's text. */
  expandKey: string | null;
  expanded: boolean;
  /** The row's element is in the DOM. */
  mounted: boolean;
  /** Search marks currently rendered inside that row. */
  markCount: number;
  /** The view can ask the server for the window around a timestamp. */
  canJump: boolean;
  elapsedMs: number;
};

export type ActivationStep =
  | { kind: "jump" }
  | { kind: "expand"; key: string }
  | { kind: "scrollRow"; index: number }
  | { kind: "wait" }
  | { kind: "dead" }
  | { kind: "activate"; markIndex: number };

export function planActivation(hit: Pick<PendingHit, "localIndex" | "jumped">, view: ActivationView): ActivationStep {
  if (view.elapsedMs >= ACTIVATION_DEADLINE_MS) return { kind: "dead" };
  if (!view.loaded) {
    if (view.canJump && !hit.jumped) return { kind: "jump" };
    return { kind: "wait" };
  }
  if (view.rowIndex < 0) return { kind: "dead" };
  if (view.expandKey && !view.expanded) return { kind: "expand", key: view.expandKey };
  if (!view.mounted) return { kind: "scrollRow", index: view.rowIndex };
  if (view.markCount === 0) return view.elapsedMs < MOUNT_GRACE_MS ? { kind: "wait" } : { kind: "dead" };
  return { kind: "activate", markIndex: Math.min(hit.localIndex, view.markCount - 1) };
}

/** The hit to try after a dead one, or null once every hit has been tried. */
export function skipDeadHit(hit: PendingHit, currentIndex: number, instances: MatchInstance[], now: number): { index: number; hit: PendingHit } | null {
  if (hit.skipped + 1 >= instances.length) return null;
  const index = stepIndex(currentIndex, hit.dir, instances.length);
  const next = instances[index];
  return { index, hit: { ...next, dir: hit.dir, startedAt: now, jumped: false, skipped: hit.skipped + 1 } };
}
