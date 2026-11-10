import { useInboxStore } from "../store/inboxStore";

// Fields on the signed-in user row that daemon heartbeats and server
// bookkeeping rewrite and that no reader of useCurrentUser shows: the sync
// backlog and loop-freeze numbers (read per device from machineRoster by
// hooks/useDaemonHealth), the stamps a send moves, and digest cooldowns. Each
// change used to hand every caller (the open conversation, the composer, the
// Sidebar, the banners) a new user object. `daemon_last_seen` and
// `last_heartbeat` stay out of this list: the store quantizes them to the
// minute, and the profile page's daemon section and TmuxMissingBanner render
// them. A field missing here only costs a re-render, never a stale read of a
// field a caller shows.
export const CURRENT_USER_CHURN: ReadonlySet<string> = new Set([
  "daemon_pending_sync_count",
  "daemon_oldest_pending_ms",
  "daemon_pending_sync_messages",
  "daemon_pending_sync_conversations",
  "daemon_sync_no_progress_ms",
  "daemon_loop_freeze_ms",
  "daemon_loop_freeze_1h_ms",
  "daemon_loop_freeze_max_ms",
  "daemon_loop_freeze_top",
  "daemon_started_at",
  "daemon_pid",
  "daemon_fields_device_id",
  "local_project_roots",
  "local_project_roots_updated_at",
  "last_message_sent_at",
  "prev_message_sent_at",
  "work_cluster_started_at",
  "capability_revision",
  "team_conversations_last_seen",
  "email_digest_last_sent_at",
  "idle_digest_state",
  "blocked_notify_state",
]);

// Every field but the churn ones, objects by value: a push decodes the whole
// row afresh, so nested objects are new references even when nothing in them
// changed.
function identityKey(row: Record<string, unknown>): string {
  let key = "";
  for (const k in row) {
    if (CURRENT_USER_CHURN.has(k)) continue;
    const v = row[k];
    key += k + ":" + (v !== null && typeof v === "object" ? JSON.stringify(v) : String(v)) + ";";
  }
  return key;
}

let lastIn: unknown;
let lastOut: unknown;
let lastKey: string | undefined;

/**
 * The signed-in user row, held at the same reference while only churn fields
 * moved. A selector: subscribers wake when a field outside CURRENT_USER_CHURN
 * changes, or the user signs in or out. The churn fields on the returned row
 * can be older than the store's; read them from the store, never from here.
 */
export function stableCurrentUser<T>(row: T): T {
  if (row === lastIn) return lastOut as T;
  lastIn = row;
  if (row === null || row === undefined || typeof row !== "object") {
    lastOut = row;
    lastKey = undefined;
    return row;
  }
  const key = identityKey(row as Record<string, unknown>);
  if (key !== lastKey || lastOut === null || typeof lastOut !== "object") {
    lastOut = row;
    lastKey = key;
  }
  return lastOut as T;
}

export function useCurrentUser() {
  const user = useInboxStore((s) => stableCurrentUser(s.currentUser));

  return {
    user,
    isLoading: user === undefined,
    isAuthenticated: user !== null && user !== undefined,
  };
}
