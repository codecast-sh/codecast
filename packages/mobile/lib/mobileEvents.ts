// Events only the phone sends. They live beside the app rather than in the
// shared catalog (@codecast/shared/analytics) because every surface that loads
// that catalog pays for it, the CLI's boot included; the app's analytics merges
// the two (lib/analytics.ts), so the same catalog rules apply.
import { defineCatalog } from "@platform/analytics/catalog";

const COUNT = { type: "number" } as const;

export const MOBILE_EVENTS = defineCatalog({
  // One phone return from the background (lib/foregroundSyncTrace.ts): how
  // long until the open conversation showed what the server already had, and
  // where the time went. Durations are ms from the return; -1 means the step
  // never happened.
  mobile_foreground_sync: {
    outcome: { type: "string", values: ["caught_up", "up_to_date", "backgrounded", "timeout"] },
    on_session: { type: "boolean" },
    away_ms: COUNT,
    ws_up_at_start: { type: "boolean" },
    ws_state_at_start: { type: "string", values: ["ready", "connecting", "disconnected", "stopped", "terminated", "unknown"] },
    socket_idle_ms: COUNT,
    reconnect_ms: COUNT,
    first_msg_ms: COUNT,
    probe_ms: COUNT,
    behind_rows: COUNT,
    first_rows_ms: COUNT,
    http_rows_ms: COUNT,
    http_rows: COUNT,
    // Rows the notification service extension read before the push showed;
    // absent on binaries without it.
    prefetch_rows: { type: "number", optional: true },
    store_ms: COUNT,
    paint_ms: COUNT,
    duration_ms: COUNT,
    max_stall_ms: COUNT,
    stall_ms: COUNT,
    msgs_in: COUNT,
    held_mutations_max: COUNT,
    active_mutations_max: COUNT,
    pending_sends: COUNT,
  },
});
