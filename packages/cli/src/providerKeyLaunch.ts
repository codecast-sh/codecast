// Injecting managed provider keys into a launched client, WITHOUT exposing them.
//
// A key on the launch command line (`env OPENROUTER_API_KEY=sk-… opencode`) would
// land in `ps aux` for every process on the box and flash in the tmux pane — a real
// leak, and inconsistent with keys never touching Convex in plaintext. Instead the
// daemon writes the keys to a mode-0600 file the user owns and the launch command
// SOURCES it: only the file PATH is on the command line, never the key. The file
// sits beside config.json (same trust boundary, same 0600 owner-only perms).
//
// Injection is gated to the clients that actually read provider env vars for their
// models (opencode, pi). Claude and Codex authenticate through their own
// subscription OAuth — setting ANTHROPIC_API_KEY on a Claude session could silently
// redirect it off the subscription onto the API key — so they are never injected.

import * as fs from "fs";
import * as path from "path";
import type { AgentClientId } from "@codecast/shared/contracts";
import { providerKeyEnv } from "@codecast/shared/contracts";
import { getProviderKeys, type Config } from "./config/types.js";

// Clients whose model auth comes from provider env vars, so a managed key helps.
// Claude/Codex use subscription OAuth and are deliberately excluded; cursor has its
// own auth. gemini could be added (it reads GEMINI_API_KEY) once verified.
const PROVIDER_KEY_CLIENTS: ReadonlySet<AgentClientId> = new Set<AgentClientId>(["opencode", "pi"]);

export function clientUsesProviderKeys(agentType: AgentClientId): boolean {
  return PROVIDER_KEY_CLIENTS.has(agentType);
}

const ENV_FILE_NAME = "agent-provider-env.sh";

function envFilePath(configDir: string): string {
  return path.join(configDir, ENV_FILE_NAME);
}

/** Serialize an env map to `export VAR='value'` lines, single-quoting values so a
 *  key with shell metacharacters can't break out (an embedded single quote becomes
 *  the standard `'\''`). Deterministic order for stable file content. */
export function renderProviderEnvFile(env: Record<string, string>): string {
  return Object.keys(env)
    .sort()
    .map((k) => `export ${k}='${env[k].replace(/'/g, "'\\''")}'`)
    .join("\n") + "\n";
}

/** Write (or, when there are no keys, remove) the 0600 provider-env file from the
 *  config's managed keys. Atomic (temp + rename) so a concurrent launch never reads
 *  a half-written file. Returns the file path when written, or null when nothing is
 *  managed (the default — clients then fall back to system auth). */
export function syncProviderKeyEnvFile(config: Config | null | undefined, configDir: string): string | null {
  const env = providerKeyEnv(getProviderKeys(config));
  const file = envFilePath(configDir);
  if (Object.keys(env).length === 0) {
    try { fs.rmSync(file, { force: true }); } catch {}
    return null;
  }
  try {
    fs.mkdirSync(configDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, renderProviderEnvFile(env), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600); // writeFileSync mode is masked by umask; force it.
    fs.renameSync(tmp, file);
    return file;
  } catch {
    return null;
  }
}

/** The shell prefix that sources the provider-env file for a client that reads
 *  provider keys, or "" when injection doesn't apply (wrong client, or no managed
 *  keys). Prepended to the launch command; sources into the shell so the client
 *  inherits the vars, with the file path — never a key — on the command line. The
 *  `2>/dev/null || true` keeps a missing/removed file a clean no-op. */
export function providerKeySourcePrefix(
  config: Config | null | undefined,
  agentType: AgentClientId,
  configDir: string,
): string {
  if (!clientUsesProviderKeys(agentType)) return "";
  const file = syncProviderKeyEnvFile(config, configDir);
  if (!file) return "";
  return `. ${file} 2>/dev/null || true; `;
}
