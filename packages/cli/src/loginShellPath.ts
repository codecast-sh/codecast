// The user's login shell PATH, for processes launchd starts. A LaunchAgent
// inherits launchd's bare PATH (/usr/bin:/bin:/usr/sbin:/sbin), so the daemon
// and every agent it starts miss what the user's shell profile adds: Homebrew,
// nvm, asdf, mise, a custom prefix. `cast start` captures the PATH an
// interactive login shell ends up with and records it in the config dir; the
// daemon launcher (supervision.ts) puts it ahead of the inherited PATH before
// it execs the daemon, so a new shell setup reaches the daemon on its next
// start without rewriting the launcher.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "./proc.js";
import { defaultConfigDir } from "./config/configDir.js";

export const LOGIN_PATH_FILENAME = "login-path";
const MARK = "__CAST_LOGIN_PATH__";
const CAPTURE_TIMEOUT_MS = 5_000;
/** A capture this fresh is reused: the autostart pass runs on every daemon boot. */
const REFRESH_MS = 60 * 60 * 1000;

/** The PATH between the markers, or null. Profiles print banners, so only the marked line counts. */
export function parseCapturedPath(stdout: string): string | null {
  const m = stdout.match(new RegExp(`${MARK}(.*?)${MARK}`));
  const value = m?.[1]?.trim();
  return value && value.includes("/") ? value : null;
}

/** Run the user's shell as an interactive login shell and read back its PATH. */
export function captureLoginShellPath(shell = os.userInfo().shell || process.env.SHELL): string | null {
  if (!shell || process.platform === "win32") return null;
  const result = spawnSync(shell, ["-ilc", `printf '%s%s%s\\n' ${MARK} "$PATH" ${MARK}`], {
    encoding: "utf8",
    timeout: CAPTURE_TIMEOUT_MS,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "ignore"],
    // TERM=dumb quiets prompt themes; TMUX set keeps an rc file that attaches
    // tmux in every interactive shell from doing it here.
    env: { ...process.env, TERM: "dumb", TMUX: process.env.TMUX || "codecast-login-path" },
  });
  return parseCapturedPath(String(result.stdout ?? ""));
}

/** Capture and record the login shell PATH, at most hourly. Never throws. */
export function recordLoginShellPath(dir = defaultConfigDir(), capture = captureLoginShellPath): void {
  const file = path.join(dir, LOGIN_PATH_FILENAME);
  try {
    if (Date.now() - fs.statSync(file).mtimeMs < REFRESH_MS) return;
  } catch {}
  try {
    const value = capture();
    if (!value) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `${value}\n`, { mode: 0o600 });
  } catch {}
}
