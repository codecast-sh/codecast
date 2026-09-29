/**
 * Agent sessions that run in a vendor's cloud and sync into codecast through
 * the daemon (Claude Code on claude.ai/code, Cursor Cloud Agents, Codex
 * Cloud). Each is an account setting: a boolean on the user row, sent to
 * every daemon on its heartbeat, which starts or stops that source's mirror.
 * Unset means the source's `defaultOn`: Codex Cloud reads a private API with
 * the person's Codex login, so it waits until they turn it on. One table so
 * the settings page, the mutation, the heartbeat and the daemon all walk the
 * same list.
 */
export const CLOUD_SESSION_SOURCES = {
  claude: { field: "claude_cloud_sync", label: "Claude Code cloud sessions", defaultOn: true },
  cursor: { field: "cursor_cloud_sync", label: "Cursor Cloud agents", defaultOn: true },
  codex: { field: "codex_cloud_sync", label: "Codex Cloud tasks", defaultOn: false },
} as const;

export type CloudSessionSource = keyof typeof CLOUD_SESSION_SOURCES;
export type CloudSessionSyncField = (typeof CLOUD_SESSION_SOURCES)[CloudSessionSource]["field"];

const DEFAULT_ON = new Map<string, boolean>(Object.values(CLOUD_SESSION_SOURCES).map((s) => [s.field, s.defaultOn]));

/** Whether a source syncs, from its stored setting: the value when set, else the source's default. */
export function cloudSessionSyncOn(field: CloudSessionSyncField | string, value: boolean | null | undefined): boolean {
  return typeof value === "boolean" ? value : DEFAULT_ON.get(field) ?? true;
}

/** Each source's setting from a user row (or heartbeat payload). */
export function cloudSessionSyncSettings(row: Partial<Record<CloudSessionSyncField, boolean | undefined>> | null | undefined): Record<CloudSessionSyncField, boolean> {
  const out = {} as Record<CloudSessionSyncField, boolean>;
  for (const { field } of Object.values(CLOUD_SESSION_SOURCES)) out[field] = cloudSessionSyncOn(field, row?.[field]);
  return out;
}
