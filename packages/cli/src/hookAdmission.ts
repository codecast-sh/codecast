// Who may post to the daemon's loopback hook routes, and how an installed hook
// written before those routes needed a token gets upgraded.
//
// /hook/status and /hook/statusline take a secret now (hookIdentity.ts). Every
// hook script this CLI installs reads it from ~/.codecast/hook-token and sends
// it as a bearer header. The scripts already on a user's disk do not, and they
// keep running until something rewrites them: a session started this morning
// executes ~/.claude/hooks/codecast-status.sh on every tool call, whatever
// version of cast is installed now.
//
// So the compatibility window is defined by the scripts on disk, not by a date.
// While a codecast-owned hook script that predates the token is installed, a
// tokenless post is still accepted — refusing it would lose real status, since
// the old script reads any HTTP answer as delivery and never falls back to the
// spool. The first such post also rewrites those scripts from the constants
// this build carries, so the window closes on the next event rather than on
// the user's next update. Once every installed script carries the marker, a
// tokenless post is refused outright and does nothing.

import * as fs from "node:fs";
import * as path from "node:path";
import { HOOK_TOKEN_MARKER, hookBearerToken, hookTokenMatches } from "./hookIdentity.js";
import { withHarnessCause, writeHarnessFile } from "./harness.js";
import { CODECAST_STATUS_HOOK } from "./statusHook.js";
import { USER_PROMPT_HOOK } from "./userPromptHook.js";
import { CODECAST_STATUSLINE_HOOK, STATUSLINE_HOOK_FILE } from "./statuslineHook.js";

/** The codecast-owned scripts that post to a hook route. Keys are file names
 *  under ~/.claude/hooks; values are what this build would install. */
export function tokenCarryingHookScripts(): Record<string, string> {
  return {
    "codecast-status.sh": CODECAST_STATUS_HOOK,
    "codecast-prompt.sh": USER_PROMPT_HOOK,
    // Not a hook but the same deal: Claude Code runs it per turn and it posts
    // the account's live usage to /hook/statusline.
    [STATUSLINE_HOOK_FILE]: CODECAST_STATUSLINE_HOOK,
  };
}

function hooksDir(home: string): string {
  return path.join(home, ".claude", "hooks");
}

/** True when no installed codecast hook script predates the token — i.e. the
 *  legacy grace below is over on this machine. A script that is absent counts
 *  as upgraded: it posts nothing. */
export function installedHooksCarryToken(home: string): boolean {
  for (const name of Object.keys(tokenCarryingHookScripts())) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(hooksDir(home), name), "utf-8");
    } catch {
      continue;
    }
    if (!text.includes(HOOK_TOKEN_MARKER)) return false;
  }
  return true;
}

/**
 * Rewrite the installed codecast hook scripts from this build's constants.
 * Only overwrites a file that already exists and already carries the codecast
 * banner: the daemon upgrades its own scripts, it never installs new ones or
 * touches a script somebody else put there. Returns the names it rewrote.
 */
export function refreshInstalledHookScripts(home: string): string[] {
  const rewritten: string[] = [];
  for (const [name, script] of Object.entries(tokenCarryingHookScripts())) {
    const file = path.join(hooksDir(home), name);
    try {
      const current = fs.readFileSync(file, "utf-8");
      if (current === script) continue;
      if (!current.includes("codecast")) continue;
      withHarnessCause({ why: "hook script upgraded to send the daemon's hook token", automatic: true }, () =>
        writeHarnessFile(file, script, "hooks", { mode: 0o755, executable: true }));
      rewritten.push(name);
    } catch {}
  }
  return rewritten;
}

export type HookAdmission =
  | { ok: true; legacy: boolean }
  | { ok: false; reason: "no-token" | "bad-token" };

export interface HookAdmissionOptions {
  /** The daemon's hook secret. Empty means nothing can authenticate. */
  token: string;
  /** Whether a tokenless post is still accepted — see the module comment. */
  legacyAllowed: () => boolean;
}

/**
 * The whole admission decision for one hook request. A wrong token is refused
 * whatever the legacy state: only the ABSENCE of a token can be an old script.
 */
export function admitHookRequest(
  headers: { authorization?: string | string[] },
  opts: HookAdmissionOptions,
): HookAdmission {
  const presented = hookBearerToken(headers);
  if (!presented) {
    return opts.legacyAllowed() ? { ok: true, legacy: true } : { ok: false, reason: "no-token" };
  }
  if (!hookTokenMatches(presented, opts.token)) return { ok: false, reason: "bad-token" };
  return { ok: true, legacy: false };
}

/**
 * The legacy grace as the daemon uses it: answers from a cached reading of the
 * installed scripts, and the first tokenless post triggers one rewrite so the
 * next event carries a token. Re-reads the scripts after a rewrite so the
 * grace ends within the same boot.
 */
export function createLegacyHookGrace(opts: {
  home: string;
  log: (msg: string) => void;
}): { allowed: () => boolean } {
  let cached: boolean | null = null;
  let refreshed = false;
  return {
    allowed(): boolean {
      if (cached === null) cached = !installedHooksCarryToken(opts.home);
      if (!cached) return false;
      if (!refreshed) {
        refreshed = true;
        const names = refreshInstalledHookScripts(opts.home);
        opts.log(
          names.length
            ? `[HOOK] upgraded installed hook scripts to the authenticated route: ${names.join(", ")}`
            : `[HOOK] a hook script from before the authenticated route posted and could not be upgraded in place; run \`cast install\``,
        );
        if (names.length) cached = !installedHooksCarryToken(opts.home);
      }
      return true;
    },
  };
}
