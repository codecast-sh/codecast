/**
 * Agent sessions that run in a vendor's cloud and sync into codecast through
 * the daemon (Claude Code on claude.ai/code, Cursor Cloud Agents). Each is an
 * account setting: a boolean on the user row, on unless turned off, sent to
 * every daemon on its heartbeat, which starts or stops that source's mirror.
 * One table so the settings page, the mutation, the heartbeat and the daemon
 * all walk the same list.
 */
export const CLOUD_SESSION_SOURCES = {
  claude: { field: "claude_cloud_sync", label: "Claude Code cloud sessions" },
  cursor: { field: "cursor_cloud_sync", label: "Cursor Cloud agents" },
} as const;

export type CloudSessionSource = keyof typeof CLOUD_SESSION_SOURCES;
export type CloudSessionSyncField = (typeof CLOUD_SESSION_SOURCES)[CloudSessionSource]["field"];

/** Each source's setting from a user row (or heartbeat payload): on unless explicitly false. */
export function cloudSessionSyncSettings(row: Partial<Record<CloudSessionSyncField, boolean | undefined>> | null | undefined): Record<CloudSessionSyncField, boolean> {
  const out = {} as Record<CloudSessionSyncField, boolean>;
  for (const { field } of Object.values(CLOUD_SESSION_SOURCES)) out[field] = row?.[field] !== false;
  return out;
}
