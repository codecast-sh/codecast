// The replay stream (docs/architecture/external-data.md X5). A replay is a
// semantic record of what a person did and what the page said back, not
// pixels, so an agent can read it as text and turn it into a repro. The SDK
// recorder writes these, the rrweb converter produces them from PostHog and
// Sentry recordings, and the timeline and repro renderers read them. Every
// producer and reader imports this file, so the shape cannot drift between
// them.

/** Keys worth recording. Anything else a person typed is an input value, and values are never recorded. */
export const REPLAY_KEYS = ["Enter", "Escape", "Tab"] as const;
export type ReplayKey = (typeof REPLAY_KEYS)[number];

export const REPLAY_CONSOLE_LEVELS = ["warn", "error"] as const;
export type ReplayConsoleLevel = (typeof REPLAY_CONSOLE_LEVELS)[number];

/** `t` is milliseconds since the recording started. */
interface At {
  t: number;
}

export type ReplayEvent =
  | (At & { type: "nav"; url: string; title?: string })
  | (At & { type: "click"; label: string; role?: string; selector: string; text?: string })
  // Only the length of what was typed, never the value.
  | (At & { type: "input"; label: string; selector: string; length: number; redacted: true })
  | (At & { type: "submit"; label: string; selector: string })
  | (At & { type: "key"; key: ReplayKey })
  // Coarse: at most one per REPLAY_LIMITS.scroll_min_interval_ms.
  | (At & { type: "scroll"; y: number; of: number })
  | (At & { type: "console"; level: ReplayConsoleLevel; message: string })
  // Failures, plus anything slower than REPLAY_LIMITS.network_slow_ms.
  | (At & { type: "network"; method: string; url: string; status: number; ms: number })
  | (At & { type: "error"; message: string; stack?: string })
  // The visible text outline of the page, taken at navigation and before an error.
  | (At & { type: "view"; outline: string })
  // App-defined state markers.
  | (At & { type: "mark"; name: string; data?: Record<string, unknown> });

export type ReplayEventType = ReplayEvent["type"];

export const REPLAY_EVENT_TYPES: readonly ReplayEventType[] = [
  "nav", "click", "input", "submit", "key", "scroll", "console", "network", "error", "view", "mark",
];

/** Where a replay came from: our recorder, or a vendor recording mirrored on first read. */
export const REPLAY_PROVIDERS = ["sdk", "posthog", "sentry"] as const;
export type ReplayProvider = (typeof REPLAY_PROVIDERS)[number];

/**
 * A vendor's recording (PostHog, Sentry) whose events are not ours yet: the
 * first read imports it (convex sources/vendorReplay.ts). `cast replay show`
 * and the web replay page both ask this.
 */
/**
 * The version of the vendor conversion (rrweb to ReplayEvent) an imported
 * copy was made with. A copy is converted once, at import, so a fix to the
 * converter reaches stored replays only by importing them again; raise this
 * when the conversion's output changes and older copies re-import on their
 * next read or backfill pass. 2: performance entries other than resources
 * and navigations are no longer failed requests. 3: the rrweb capture itself
 * is kept beside the stream (DOM chunks, contracts/replayPlayer.ts), so the
 * player can play it and agents can see frames.
 */
export const VENDOR_CONVERTER_VERSION = 3;

/** A mirrored recording that has not been imported, or was imported by an older converter. */
export function needsVendorImport(row: { provider: string; imported_at?: number | null; converter_version?: number | null }): boolean {
  if (row.provider === "sdk" || !(REPLAY_PROVIDERS as readonly string[]).includes(row.provider)) return false;
  return !row.imported_at || (row.converter_version ?? 1) < VENDOR_CONVERTER_VERSION;
}

export const REPLAY_LIMITS = {
  /** The recorder's ring buffer: what an error upload carries. */
  ring_buffer_ms: 60_000,
  scroll_min_interval_ms: 1_000,
  network_slow_ms: 2_000,
  view_outline_max_chars: 4 * 1024,
  /** The cached text timeline on the replays row. */
  timeline_md_max_chars: 32 * 1024,
  console_message_max_chars: 1_000,
  error_stack_max_chars: 8 * 1024,
  label_max_chars: 200,
  selector_max_chars: 300,
  url_max_chars: 2_048,
  mark_data_max_chars: 2_000,
  /** One gzipped chunk the SDK PUTs to R2. */
  chunk_max_events: 5_000,
  chunk_max_bytes: 2 * 1024 * 1024,
  max_chunks_per_replay: 60,
  /** The R2 lifecycle rule on codecast-replays. */
  retention_days: 30,
  /** How long a presigned chunk PUT and a read redirect stay valid. */
  signed_url_ttl_s: 300,
} as const;

/**
 * Query values can carry tokens; keep the keys, drop the values and the hash.
 * Every URL a replay stores goes through this, whoever recorded it. The SDK
 * recorder in @platform/analytics spells the same function, and
 * replayContractDrift.test.ts holds the two to the same output.
 */
export function cleanUrl(raw: string, base?: string): string {
  const clip = (s: string) => (s.length > REPLAY_LIMITS.url_max_chars ? s.slice(0, REPLAY_LIMITS.url_max_chars) : s);
  try {
    const u = new URL(raw, base);
    for (const key of Array.from(u.searchParams.keys())) u.searchParams.set(key, "");
    u.hash = u.hash ? "#" : "";
    return clip(u.toString());
  } catch {
    return clip(raw.split("?")[0]);
  }
}

// ── Bulk import of a vendor's recordings (external-data.md X5) ──

/** How far back `cast replay import` and the web's import reach. "all" is everything the vendor still keeps. */
export const REPLAY_BACKFILL_WINDOWS = ["7d", "30d", "90d", "all"] as const;
export type ReplayBackfillWindow = (typeof REPLAY_BACKFILL_WINDOWS)[number];
export const DEFAULT_REPLAY_BACKFILL_WINDOW: ReplayBackfillWindow = "30d";

export const REPLAY_BACKFILL_STATUSES = ["running", "done", "paused", "error"] as const;
export type ReplayBackfillStatus = (typeof REPLAY_BACKFILL_STATUSES)[number];

/**
 * A source's one bulk import, as stored on its event_sources row. `started_at`
 * names the run: a page scheduled by an earlier run finds another value and
 * stops. `until` pins the list's end at the start, so pages walk a set that
 * new recordings do not shift; those are read on open, as always.
 */
export interface ReplayBackfill {
  status: ReplayBackfillStatus;
  window: ReplayBackfillWindow;
  /** Absent for "all". */
  since?: number;
  until: number;
  /** The vendor's position: PostHog's list offset, Sentry's cursor. Absent before the first page. */
  cursor?: string;
  /** Recordings of the page at `cursor` already imported or failed, so a page resumed after a rate limit counts each once. */
  page_seen?: string[];
  listed: number;
  imported: number;
  /** Already ours when the import reached them. */
  skipped: number;
  failed: number;
  /** Failures since the last success; past REPLAY_BACKFILL_LIMITS.failures_in_row the import stops on the error. */
  failures_in_row?: number;
  /** When the vendor began answering 429 without a recording landing since; past REPLAY_BACKFILL_LIMITS.rate_limited_max_ms the import stops. */
  rate_limited_since?: number;
  last_error?: string;
  started_at: number;
  updated_at: number;
  finished_at?: number;
}

export const REPLAY_BACKFILL_LIMITS = {
  /**
   * A running import whose last page wrote nothing for this long died (an
   * action killed mid page): it may be started again. Longer than the longest
   * rate limit wait plus the longest action, so a live import never reads as stalled.
   */
  stalled_ms: 30 * 60_000,
  failures_in_row: 10,
  /** Rate limited this long with nothing imported, the import stops on it rather than waiting forever. */
  rate_limited_max_ms: 2 * 3600_000,
} as const;

/** The start of a window, or undefined for "all". */
export function replayBackfillSince(window: ReplayBackfillWindow, now: number = Date.now()): number | undefined {
  const days = { "7d": 7, "30d": 30, "90d": 90 } as const;
  return window === "all" ? undefined : now - days[window] * 86_400_000;
}

export function isReplayBackfillWindow(value: unknown): value is ReplayBackfillWindow {
  return typeof value === "string" && (REPLAY_BACKFILL_WINDOWS as readonly string[]).includes(value);
}

/** Running in name only: no page has written for REPLAY_BACKFILL_LIMITS.stalled_ms. */
export function replayBackfillStalled(b: Pick<ReplayBackfill, "status" | "updated_at">, now: number = Date.now()): boolean {
  return b.status === "running" && now - b.updated_at > REPLAY_BACKFILL_LIMITS.stalled_ms;
}

/** The state a surface leads with: "stalled" is a running import nobody is running. */
export function replayBackfillState(b: Pick<ReplayBackfill, "status" | "updated_at">, now: number = Date.now()): ReplayBackfillStatus | "stalled" {
  return replayBackfillStalled(b, now) ? "stalled" : b.status;
}

/** Whether a start continues from the cursor rather than starting over: a stopped import that never finished. */
export function replayBackfillResumes(b: Pick<ReplayBackfill, "status" | "updated_at"> | null | undefined, now: number = Date.now()): boolean {
  return !!b && (b.status === "paused" || b.status === "error" || replayBackfillStalled(b, now));
}

/** One line for the CLI and the web: what the import did and where it stands. */
export function replayBackfillLine(b: ReplayBackfill, now: number = Date.now()): string {
  const state = replayBackfillState(b, now);
  const head = { running: "importing", done: "imported", paused: "paused", error: "stopped", stalled: "stalled" }[state];
  const window = b.window === "all" ? "all retained recordings" : `the last ${b.window}`;
  const counts = [`${b.imported} imported`, b.skipped ? `${b.skipped} already here` : "", b.failed ? `${b.failed} failed` : ""].filter(Boolean).join(", ");
  const tail = state === "paused" || state === "error" ? (b.last_error ? `: ${b.last_error}` : "") : "";
  return `${head} ${window}: ${b.listed} listed, ${counts}${tail}`;
}
