// Where Claude Code keeps its login on macOS, as a name rather than a literal.
//
// Until 2.1 there was one item for the machine: service "Claude Code-credentials".
// From 2.1 a session that sets CLAUDE_CONFIG_DIR reads a DIFFERENT item, whose
// service carries the first 8 hex chars of sha256 of the config dir path, and
// whose account is $USER unless the name has characters the keychain rule
// rejects. Verified on 2.1.263 (ct-49530): with CLAUDE_CONFIG_DIR pointed at an
// empty dir, claude reported "Not logged in" while the machine item held a live
// login, and authenticated off an item planted under the computed name — so the
// scoped item is not an addition to the old one, it REPLACES it for that
// session. A codecast that only knows the old name reads and writes a login the
// session never looks at.
//
// Claude hashes the env value exactly as spelled: /tmp/x and /private/tmp/x are
// two different items, and only the spelling in CLAUDE_CONFIG_DIR matched.
// Reads therefore try both spellings (a caller may hold the resolved path), and
// writes take the spelling they were given, which is the one the session set.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";

/** The machine-wide item, and the prefix every scoped item extends. */
export const LEGACY_CC_KEYCHAIN_SERVICE = "Claude Code-credentials";

// Claude Code refuses an account name outside this set (SSO logins like
// first@example.com) and stores the item under CC_KEYCHAIN_FALLBACK_ACCOUNT.
const ACCOUNT_PATTERN = /^[a-zA-Z0-9._-]+$/;
const CC_KEYCHAIN_FALLBACK_ACCOUNT = "claude-code-user";

export interface CcKeychainItem {
  service: string;
  /** The "acct" attribute Claude Code writes. Reads match on service alone (an
   * item created by an older build can carry an account our rule never
   * reproduces); writes need a name, and this is the one Claude Code expects. */
  account: string;
}

/** The config dir the session runs under, or undefined for the machine login. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.CLAUDE_CONFIG_DIR?.trim() || undefined;
}

/** The account name Claude Code stores its item under. */
export function ccKeychainAccount(env: NodeJS.ProcessEnv = process.env): string {
  let user: string;
  try {
    user = env.USER || env.USERNAME || os.userInfo().username;
  } catch {
    return CC_KEYCHAIN_FALLBACK_ACCOUNT;
  }
  return ACCOUNT_PATTERN.test(user) ? user : CC_KEYCHAIN_FALLBACK_ACCOUNT;
}

function scopedService(configDir: string): string {
  const digest = createHash("sha256").update(configDir.normalize("NFC")).digest("hex");
  return `${LEGACY_CC_KEYCHAIN_SERVICE}-${digest.slice(0, 8)}`;
}

/** The config dir as spelled, plus its resolved form when they differ. */
function configDirSpellings(configDir: string): string[] {
  try {
    const resolved = fs.realpathSync(configDir);
    if (resolved !== configDir) return [configDir, resolved];
  } catch {
    // A config dir that does not exist yet still names an item; keep the raw path.
  }
  return [configDir];
}

/**
 * Every item that may hold this session's login, best first. The machine item
 * comes last when a config dir is set (a machine that never ran a scoped claude
 * has only the old item) and is the only candidate when none is.
 */
export function ccKeychainReadItems(configDir = claudeConfigDir()): CcKeychainItem[] {
  const account = ccKeychainAccount();
  const services = configDir ? configDirSpellings(configDir).map(scopedService) : [];
  services.push(LEGACY_CC_KEYCHAIN_SERVICE);
  return [...new Set(services)].map((service) => ({ service, account }));
}

/**
 * The one item to write. A scoped session must NOT also get the machine item
 * updated: the two hold different accounts by design, so writing both would
 * overwrite the machine login with the session's.
 */
export function ccKeychainWriteItem(configDir = claudeConfigDir()): CcKeychainItem {
  return {
    service: configDir ? scopedService(configDir) : LEGACY_CC_KEYCHAIN_SERVICE,
    account: ccKeychainAccount(),
  };
}

/** `security` argv that reads one candidate's password. */
export function ccKeychainReadArgs(item: CcKeychainItem): string[] {
  return ["find-generic-password", "-s", item.service, "-w"];
}
