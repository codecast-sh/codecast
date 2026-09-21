// The secret an installed Claude Code hook presents to the daemon's loopback
// hook routes (/hook/status, /hook/statusline).
//
// Those routes used to take anything that reached 127.0.0.1. That made them
// writable by any process on the machine — including one running under another
// OS account, which cannot read this user's files — and by a web page whose
// browser still allows a plain loopback GET. What they write is not cosmetic:
// a status event moves a session's state, and the sink behind it schedules a
// transcript read. So the sender has to prove it is a hook this user installed.
//
// This is a SEPARATE secret from the loopback bearer in loopbackIdentity.ts on
// purpose. That one spawns shells and writes the vault; a hook needs none of
// that, and a hook script sitting in ~/.claude/hooks is read by every agent the
// user runs. Leaking this token lets someone post status events, nothing more.
//
// The file is 0600 in the config directory, beside hook-port, and it is minted
// once and kept: a rotation on every boot would break the hooks of every
// session already running when the daemon restarts.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFile } from "./atomicWrite.js";

export function hookTokenFile(configDir: string): string {
  return path.join(configDir, "hook-token");
}

/** Marker the daemon greps for in an installed hook script to tell a script
 *  that knows about the token from one written before it shipped. Changing the
 *  spelling here re-arms the legacy upgrade path for every installed hook, so
 *  keep it stable. */
export const HOOK_TOKEN_MARKER = "CODECAST_HOOK_TOKEN";

/** Shell that leaves the token in $CODECAST_HOOK_TOKEN (empty when the daemon
 *  has never written one). Builtins only: a hook runs on every tool call, and
 *  one extra process per event is what blew Claude Code's hook timeout before. */
export const HOOK_TOKEN_READ = `
CODECAST_HOOK_TOKEN=
[ -f "$HOME/.codecast/hook-token" ] && IFS= read -r CODECAST_HOOK_TOKEN <"$HOME/.codecast/hook-token" 2>/dev/null
`;

export function readHookToken(configDir: string): string {
  try {
    return fs.readFileSync(hookTokenFile(configDir), "utf-8").trim();
  } catch {
    return "";
  }
}

/** The saved hook token, minting and persisting one on first boot. An
 *  unwritable config dir still yields a working in-memory token — the hooks
 *  then read an empty file and fall back to the on-disk status spool, which is
 *  the behaviour a machine without this file already had. */
export function loadOrCreateHookToken(configDir: string): string {
  const existing = readHookToken(configDir);
  if (existing) return existing;
  const minted = crypto.randomBytes(32).toString("hex");
  try {
    atomicWriteFile(hookTokenFile(configDir), minted, { mode: 0o600 });
  } catch {}
  return minted;
}

/** Constant-time compare. An empty expected token authenticates nobody: two
 *  zero-length buffers compare equal, and "no token loaded yet" is a state a
 *  caller can reach during boot. */
export function hookTokenMatches(presented: unknown, expected: string): boolean {
  if (typeof presented !== "string" || !presented || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** The bearer token on a request, or "". Header only: a browser cannot set
 *  Authorization on a cross-origin request without a preflight, and these
 *  routes answer no preflight, so requiring it here shuts the page vector even
 *  before the secret is compared. */
export function hookBearerToken(headers: { authorization?: string | string[] }): string {
  const raw = headers.authorization;
  const auth = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
}
