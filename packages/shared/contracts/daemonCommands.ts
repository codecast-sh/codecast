// Single source of truth for the commands a daemon can be told to run. Mirrors
// the daemon_commands.command union in convex/schema.ts exactly, including
// "move_to_device".
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
  // The web asked for a session on the cloud host. Targeted at an online LOCAL
  // daemon (the one with the host registry + SSH key): it wakes the host,
  // refreshes the checkout there, copies the manifest's secret files, acquires
  // an isolated worktree with `cast ws acquire` on the host, then places the
  // conversation on the host's device (cloud.placeConversation). Runs as
  // `cast cloud start <conversation>` in a child, like move_to_device. args:
  // { conversation_id, cloud_device_id? }. Old daemons: "Unknown command".
  "cloud_spawn",
  // Fork fast path: resume a fork by copying the parent's local JSONL. A
  // SEPARATE command (not resume_session) so daemons that predate it report
  // "Unknown command" and do nothing — falling into their resume_session path
  // would reconstitute from a mid-copy export and truncate the fork's history.
  "fork_session",
  // Swap the machine's active Claude Code account to a saved profile, tear down
  // the listed blocked sessions (parked on a limit, auth, or dropped-connection
  // banner), and enqueue "continue" to each so the delivery rail resumes them
  // on the new account.
  "switch_account",
  // User clicked "Update now" on the in-app desktop-update banner: apply the
  // published desktop release immediately (force quit + swap + relaunch), rather
  // than waiting for the next app quit. Old daemons: "Unknown command".
  "desktop_update",
  // Web Settings toggled an agent-feature snippet for THIS device: run
  // `cast install <slug>` (or `--disable`) locally, then heartbeat so the new
  // state round-trips back. args: { snippet: <slug>, enabled: boolean }. Old
  // daemons: "Unknown command" (the toggle just doesn't take on that machine).
  "apply_snippet",
  // Ownership of a conversation was reassigned AWAY from this device ("Run
  // here" on another machine). Targeted at the PREVIOUS owner: kill the local
  // tmux + process tree so no stale copy keeps running there — the same
  // teardown move_to_device runs on the source after a transfer. Old daemons:
  // "Unknown command" (the stale tmux just survives on that machine).
  "release_session",
  // Web set/removed a managed provider API key for THIS device (pl-207). args is a
  // ProviderKeyCommand JSON: {op:"set", payload:<encrypted>} or {op:"remove",
  // provider}. The key is sealed to the device's ECDH public key so Convex never
  // sees plaintext; the daemon decrypts, updates its 0600 store, and fans out to
  // remotes. Old daemons: "Unknown command" (the key just doesn't take there).
  "set_provider_key",
  // Web sign-in CTA: run `claude auth login` in a utility tmux pane (opens the
  // browser OAuth flow on this machine), watch the keychain for the outcome,
  // and report it via accountSwitch.completeLoginFlow. args: { email? } — the
  // account to pre-fill on the login page. Old daemons: "Unknown command" (the
  // web's pending flow goes stale and the CTA returns).
  "start_login",
  // Integrated terminal discovery: reply with this daemon's loopback terminal
  // endpoint ({port, token, device_id, tmux}). The web sends one per live
  // device and connects to whichever endpoint answers on 127.0.0.1 — only the
  // machine the browser is on is reachable. Old daemons: "Unknown command"
  // (the web treats no-answer as "no local daemon"). See
  // packages/cli/src/terminal/.
  "get_terminal_endpoint",
  // Watch a tmux pane on THIS device for a browser that can't reach it on
  // loopback (the pane runs on another of the user's machines). args:
  // StreamPaneArgs — { target }. The daemon captures the pane's screen while
  // the viewer's lease is live and pushes changed frames to /cli/terminal/frame;
  // the lease lapsing is what stops it. Old daemons: "Unknown command" (the
  // split reports the machine can't stream and offers the ssh command instead).
  // See packages/shared/contracts/terminalStream.ts.
  "stream_pane",
  // Park a session's pane to give the machine back its resources: the reaper's
  // teardown (heartbeat stopped first, transcript kept, tmux session and its
  // process tree killed) plus the "hibernated" agent status. The next message
  // resumes it. args: { session_id, conversation_id }. Old daemons: "Unknown
  // command" (the session just stays live). There is no wake_session: waking is
  // a resume, so `cast wake` sends resume_session.
  "hibernate_session",
] as const;

export type DaemonCommand = (typeof DAEMON_COMMANDS)[number];
