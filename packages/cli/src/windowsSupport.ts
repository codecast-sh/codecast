/**
 * The daemon does not support native Windows. Its session machinery assumes
 * tmux/sh/pgrep, and on a real user's machine it spawned a console window for
 * every background child (see proc.ts). WSL is the supported way to run
 * codecast on a Windows machine: the Windows installer (install.ps1) sets up
 * WSL and installs the normal Linux build inside it. Every path that would
 * start the daemon on native Windows refuses with one clear message.
 */
import * as fs from "fs";

export const WINDOWS_DAEMON_UNSUPPORTED_MESSAGE =
  "The codecast daemon does not run on native Windows.\n" +
  "On Windows, codecast runs inside WSL. In PowerShell, run:\n" +
  '  irm codecast.sh/install.ps1 | iex\n' +
  "If a previous install added an auto-start task, remove it with: cast setup --disable";

export function daemonSupportedOnPlatform(): boolean {
  return process.platform !== "win32";
}

/** True when this Linux process runs inside WSL. */
export function isWSL(): boolean {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return fs.readFileSync("/proc/version", "utf-8").toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

/**
 * The Task Scheduler command that starts the WSL daemon at Windows login:
 * a hidden PowerShell runs `wsl.exe -d <distro> -u <user> -- <cast> start`,
 * which boots the WSL VM and starts the daemon detached (`start` returns, the
 * window closes, the daemon keeps the VM alive). The command string passes
 * through schtasks, cmd, and PowerShell parsing, so components are restricted
 * to characters that survive all three unquoted; anything else returns null
 * and the caller skips Windows autostart. Pure for tests.
 */
export function buildWslAutostartTaskRun(distro: string, user: string, castBinary: string): string | null {
  for (const part of [distro, user, castBinary]) {
    if (!part || !/^[A-Za-z0-9._/-]+$/.test(part)) return null;
  }
  return `powershell.exe -NoProfile -WindowStyle Hidden -Command wsl.exe -d ${distro} -u ${user} -- ${castBinary} start`;
}
