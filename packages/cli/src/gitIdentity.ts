/**
 * A per-device git identity, so ANY machine can be granted repo access through
 * the product instead of hand-run SSH surgery.
 *
 * The flow this enables (the productized version of the m1 bring-up):
 *
 *   1. The git-plane sweep finds a repo whose fetch fails with an AUTH error —
 *      the machine has no credential for the rendezvous remote.
 *   2. This module mints the device a keypair (once, lazily) and the daemon
 *      publishes the PUBLIC key with its heartbeat. A public key is not a
 *      secret — same stance as the device's provider-key ECDH pubkey.
 *   3. The web devices page renders the repo as "needs access" with the pubkey
 *      and where to paste it (GitHub → SSH keys, or a repo deploy key).
 *   4. Nothing else is required: the sweep keeps retrying on its cadence, the
 *      grant makes the next fetch succeed, the card turns green, and retired
 *      work-sync pushes resurrect automatically.
 *
 * The device key is a FALLBACK identity, never a replacement: git runs with
 * the user's own credentials first (their agent, helpers, config), and the
 * device key is tried only after the default identity fails with an auth
 * error. Whichever identity worked is remembered per repo for the daemon's
 * lifetime so pushes and fetches stay on it without re-probing.
 */

import { execFile } from "./proc.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_DIR = path.join(os.homedir(), ".codecast", "git");
const KEY_PATH = path.join(GIT_DIR, "id_ed25519");

export type GitIdentity = "default" | "device";

/** repo root -> identity that last worked there. Process-lifetime memory. */
const identityByRoot = new Map<string, GitIdentity>();

export function deviceGitKeyPath(): string {
  return KEY_PATH;
}

/** The device's public git key, or undefined when none has been minted yet.
 * Read per call (no cache): the file is tiny and a freshly minted key must
 * reach the very next heartbeat. */
export function deviceGitPubkey(): string | undefined {
  try {
    return fs.readFileSync(`${KEY_PATH}.pub`, "utf-8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Mint the device keypair if absent; returns the public key. The comment names
 * the device so the key is recognizable in a GitHub key list years later.
 */
export async function ensureDeviceGitKey(deviceLabel: string): Promise<string | undefined> {
  const existing = deviceGitPubkey();
  if (existing) return existing;
  try {
    fs.mkdirSync(GIT_DIR, { recursive: true, mode: 0o700 });
    const comment = `codecast-${deviceLabel.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60)}`;
    await execFileAsync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", comment, "-f", KEY_PATH, "-q"], {
      timeout: 20_000,
    });
    return deviceGitPubkey();
  } catch {
    // A machine without ssh-keygen simply reports no pubkey; the web card
    // falls back to naming the gap instead of showing a key.
    return undefined;
  }
}

/** Environment that forces git onto the device identity for one invocation. */
export function deviceKeyEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_SSH_COMMAND: `ssh -i ${KEY_PATH} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20`,
  };
}

/**
 * The environment a git network operation in `root` should run with: the
 * device identity where it is the one that worked, the user's own otherwise.
 */
export function gitEnvFor(root: string): NodeJS.ProcessEnv | undefined {
  return identityByRoot.get(root) === "device" ? deviceKeyEnv() : undefined;
}

export function recordIdentity(root: string, identity: GitIdentity): void {
  identityByRoot.set(root, identity);
}

export function identityFor(root: string): GitIdentity | undefined {
  return identityByRoot.get(root);
}

/** Test hook. */
export function resetGitIdentityState(): void {
  identityByRoot.clear();
}

/**
 * Does this stderr say "you are not allowed", as opposed to "the network or
 * remote is broken"? Only auth failures justify switching identities; network
 * failures must stay on the default identity and simply retry later.
 * "Repository not found" is included deliberately: GitHub reports unauthorized
 * private repos exactly that way rather than admitting they exist.
 */
export function isGitAuthError(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    s.includes("permission denied") ||
    s.includes("authentication failed") ||
    s.includes("could not read username") ||
    s.includes("could not read password") ||
    s.includes("repository not found") ||
    s.includes("access denied") ||
    s.includes("permission to") ||
    s.includes("403")
  );
}

/** Can the device SSH key even help with this remote? (An https remote
 * authenticates with tokens, not SSH keys.) */
export function isSshRemote(url: string | undefined): boolean {
  if (!url) return false;
  return url.startsWith("git@") || url.startsWith("ssh://");
}
