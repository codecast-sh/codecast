/**
 * Telling a person how to install a tool the CLI shells out to.
 *
 * tmux was the first such tool and grew the per-platform ladder below; ffmpeg
 * (`cast call snap`) needs the same answer, so the ladder lives here and both
 * read it. A package manager is looked up, never assumed: a Mac without
 * Homebrew gets "install Homebrew, then …" rather than a `brew` command that
 * fails, and a Linux box gets the manager it actually has.
 */

import { execSync } from "./proc.js";

/** PATH as a login shell would have it. Agents and the daemon often start
 *  with a bare PATH that lacks Homebrew, so a tool installed there would read
 *  as missing. */
export const TOOL_PATH = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].filter(Boolean).join(":");

function has(bin: string): boolean {
  try {
    execSync(`command -v ${bin}`, { stdio: "ignore", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

/** The command that installs `pkg` with a package manager this machine has,
 *  or null when there is none we know. Runnable as is. */
export function installCommandFor(pkg: string): string | null {
  if (process.platform === "darwin") return has("brew") ? `brew install ${pkg}` : null;
  if (process.platform === "linux") {
    for (const [bin, cmd] of [
      ["apt-get", `sudo apt-get install -y ${pkg}`],
      ["dnf", `sudo dnf install -y ${pkg}`],
      ["yum", `sudo yum install -y ${pkg}`],
      ["pacman", `sudo pacman -S --noconfirm ${pkg}`],
      ["apk", `sudo apk add ${pkg}`],
    ] as const) {
      if (has(bin)) return cmd;
    }
  }
  return null;
}

/** One sentence a person can act on: the install command when there is one,
 *  otherwise what to do first. `winget` is the package id on Windows, where
 *  a tool's id rarely matches its name. */
export function installHintFor(pkg: string, opts: { winget?: string } = {}): string {
  const cmd = installCommandFor(pkg);
  if (cmd) return `Install it with: ${cmd}`;
  if (process.platform === "darwin") return `Install Homebrew (https://brew.sh), then run: brew install ${pkg}`;
  if (process.platform === "win32" && opts.winget) return `Install it with: winget install ${opts.winget}`;
  return `Install ${pkg} with your system package manager.`;
}
