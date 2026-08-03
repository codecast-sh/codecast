/**
 * The daemon does not support Windows yet. Its session machinery assumes
 * tmux/sh/pgrep, and on a real user's machine it spawned a console window for
 * every background child (see proc.ts). Until there is a native Windows mode,
 * every path that would start the daemon refuses with one clear message.
 * WSL is the supported way to run codecast on a Windows machine.
 */
export const WINDOWS_DAEMON_UNSUPPORTED_MESSAGE =
  "The codecast daemon does not run on native Windows yet.\n" +
  "Install codecast inside WSL instead: https://learn.microsoft.com/windows/wsl/install\n" +
  "If a previous install added an auto-start task, remove it with: cast setup --disable";

export function daemonSupportedOnPlatform(): boolean {
  return process.platform !== "win32";
}
