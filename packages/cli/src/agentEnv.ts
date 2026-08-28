// Env a daemon-launched agent must NOT inherit from whatever started it.
//
// The tmux server, the launchd watchdog and the daemon all keep the env of the
// shell that bootstrapped them. When that shell ran inside a Claude Code
// session, they carry Claude's own session markers forward to every pane and
// every agent. CLAUDECODE / CLAUDE_CODE_ENTRYPOINT make claude refuse to
// launch "inside another session". CLAUDE_CODE_CHILD_SESSION is worse: claude
// starts fine but treats itself as a subagent and turns transcript saving
// OFF, so no JSONL is ever written, discovery times out, and the web thread
// stays at 0 messages forever (2026-08-27: six panes at once).
// CLAUDE_CODE_SESSION_ID makes `cast` inside the agent report the parent's
// session instead of its own.
//
// One list, four consumers: the daemon (its own process.env at module load,
// the tmux global env at boot, and the `env -u` prefix on every launch line),
// `cast start` (the env it hands the daemon), the watchdog shell script, and
// `cast doctor` (which reports and clears leaked markers).
export const AGENT_SCRUBBED_ENV_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
] as const;

// Launch prefix typed into every agent pane. Besides dropping the markers it
// pins transcript persistence ON, so no marker that slips past the scrub can
// silence a daemon-launched claude. Pane-content detection keys off the
// literal "env -u CLAUDECODE" head (daemon.ts findLaunchLine) — keep it first.
export const AGENT_ENV_SCRUB =
  `env ${AGENT_SCRUBBED_ENV_VARS.map((v) => `-u ${v}`).join(" ")} CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1`;

// Same scrub as a POSIX sh line, for generated shell scripts.
export const AGENT_ENV_UNSET_SH = `unset ${AGENT_SCRUBBED_ENV_VARS.join(" ")}`;

// Drop the markers from an env object in place and return it.
export function scrubAgentEnv<T extends Record<string, string | undefined>>(env: T): T {
  for (const v of AGENT_SCRUBBED_ENV_VARS) delete env[v];
  return env;
}

// Markers currently persisted in the tmux server's global environment.
export function leakedTmuxGlobalMarkers(showEnvironmentOutput: string): string[] {
  const set = new Set<string>(showEnvironmentOutput.split("\n").map((l) => l.split("=")[0]));
  return AGENT_SCRUBBED_ENV_VARS.filter((v) => set.has(v));
}
