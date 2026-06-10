// Single source of truth for the commands a daemon can be told to run. Mirrors
// the daemon_commands.command union in convex/schema.ts exactly — all 18,
// including "move_to_device".
//
// DIVERGENCE NOTE: convex/users.ts sendDaemonCommand currently accepts only 17
// of these (it omits "move_to_device" — that command is enqueued through the
// device-move path, not this generic mutation). It is intentionally a subset of
// this full set; do not assume the mutation's arg union equals DAEMON_COMMANDS.
//
// PURE isomorphic data — safe to import from the Convex runtime, the daemon, and
// the browser.
export const DAEMON_COMMANDS = [
  "status",
  "restart",
  "force_update",
  "version",
  "start_session",
  "escape",
  "resume_session",
  "kill_session",
  "send_keys",
  "rewind",
  "config_list",
  "config_read",
  "config_write",
  "config_create",
  "config_delete",
  "run_workflow",
  "reinstall",
  "move_to_device",
] as const;

export type DaemonCommand = (typeof DAEMON_COMMANDS)[number];
