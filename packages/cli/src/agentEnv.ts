import * as fs from "fs";
import * as path from "path";
import { atomicWriteFile } from "./atomicWrite.js";

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

// Claude's own override: any session that sees this saves its transcript even
// with CLAUDE_CODE_CHILD_SESSION inherited (verified 2026-08-28: the footer
// warning clears and JSONL is written).
export const FORCE_PERSISTENCE_VAR = "CLAUDE_CODE_FORCE_SESSION_PERSISTENCE";

// Launch prefix typed into every agent pane. Besides dropping the markers it
// pins transcript persistence ON, so no marker that slips past the scrub can
// silence a daemon-launched claude. Pane-content detection keys off the
// literal "env -u CLAUDECODE" head (daemon.ts findLaunchLine) — keep it first.
export const AGENT_ENV_SCRUB =
  `env ${AGENT_SCRUBBED_ENV_VARS.map((v) => `-u ${v}`).join(" ")} ${FORCE_PERSISTENCE_VAR}=1`;

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

// ─── Settings-level persistence pin ──────────────────────────────────────────
// The launch prefix and the tmux scrub only protect claudes codecast launches.
// A claude the user opens by hand in a pane seeded by a leaked marker — or any
// launch path we don't own — still inherits CLAUDE_CODE_CHILD_SESSION and goes
// silent. Claude applies the `env` block of ~/.claude/settings.json to every
// session on this machine, so pinning the override there disables the feature
// globally and permanently. The daemon re-asserts it on every boot and
// `cast doctor` reports it, so every machine with codecast installed converges
// without the user doing anything.

export type PersistencePinResult =
  | "wrote" // key was absent (or the file was) — pinned it
  | "already-pinned" // key present with value "1"
  | "left-alone" // key present with another value: an authored choice we respect
  | "unparseable"; // file exists but is not valid JSON — nothing safe to rewrite

/** Pure planner: the new settings.json text, or null when nothing to write. */
export function planClaudeSettingsPersistence(text: string | null): string | null {
  if (text === null) return JSON.stringify({ env: { [FORCE_PERSISTENCE_VAR]: "1" } }, null, 4) + "\n";
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.env && typeof parsed.env === "object" && !Array.isArray(parsed.env)) {
    if (FORCE_PERSISTENCE_VAR in parsed.env) return null; // pinned or authored — either way not ours to change
  } else {
    parsed.env = {};
  }
  parsed.env[FORCE_PERSISTENCE_VAR] = "1";
  // Keep the file's own indent (installStableHook writes 4, older tools 2).
  const indent = /^\{\n( +)"/.exec(text)?.[1]?.length ?? 4;
  return JSON.stringify(parsed, null, indent) + (text.endsWith("\n") ? "\n" : "");
}

/** Reconcile ~/.claude/settings.json on disk. Creates the file when absent. */
export function ensureClaudeSettingsPersistence(home: string = process.env.HOME || ""): PersistencePinResult {
  if (!home) return "left-alone";
  const file = path.join(home, ".claude", "settings.json");
  let text: string | null = null;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {}
  const next = planClaudeSettingsPersistence(text);
  if (next !== null) {
    atomicWriteFile(file, next, text === null ? { mode: 0o644 } : {});
    return "wrote";
  }
  if (text === null) return "left-alone"; // unreachable (null text always plans), kept for type honesty
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "unparseable";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "unparseable";
  return parsed.env?.[FORCE_PERSISTENCE_VAR] === "1" ? "already-pinned" : "left-alone";
}
