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
