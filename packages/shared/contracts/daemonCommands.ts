// Single source of truth for the commands a daemon can be told to run. Mirrors
// the daemon_commands.command union in convex/schema.ts exactly — all 21,
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
  // Fork fast path: resume a fork by copying the parent's local JSONL. A
  // SEPARATE command (not resume_session) so daemons that predate it report
  // "Unknown command" and do nothing — falling into their resume_session path
  // would reconstitute from a mid-copy export and truncate the fork's history.
  "fork_session",
  // Swap the machine's active Claude Code account to a saved profile, tear down
  // the listed limit/auth-blocked sessions, and enqueue "continue" to each so
  // the delivery rail resumes them on the new account.
  "switch_account",
  // In-place model/effort switch for a RUNNING claude session: the daemon
  // drives the /model picker (arrows + `s`) so the change stays session-scoped
  // — the one-shot `/model <x>` and `/effort <x>` forms rewrite the user's
  // GLOBAL default in ~/.claude/settings.json. Old daemons: "Unknown command".
  "set_model",
] as const;

export type DaemonCommand = (typeof DAEMON_COMMANDS)[number];
