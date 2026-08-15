/**
 * Driving a Chrome that runs on another Mac.
 *
 * The shape was settled in docs/mac-backend.md: the CLI stays here, the browser
 * runs there, and CDP travels over an SSH port forward. That is worth being
 * deliberate about, because the alternative — running the agent on the remote
 * and copying a profile up to it — is what forces the credential problem into
 * its worst form. With the driver local, the cookies never need to be written
 * to the remote disk at all: they are decrypted here and injected into the
 * remote browser's memory through the tunnel, and the Keychain secret that
 * would decrypt everything else never leaves this machine.
 *
 * The remote profile is deliberately EMPTY. It gains exactly the logins the
 * work uses, when the work uses them (see credentials.ts), so a rented host
 * never holds a copy of your whole browsing identity.
 */

import { execFileSync } from "node:child_process";
import { spawn } from "../proc.js";
import { setTimeout as sleep } from "node:timers/promises";
import { isCdpAlive } from "./cdp.js";
import type { RemoteHost } from "../remote/session-move.js";

/** The profile the remote browser uses. Never a copy of ours. */
const REMOTE_PROFILE = "~/.codecast/browser-profile";
const REMOTE_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function sshArgs(host: RemoteHost): string[] {
  return [
    "-i", host.keyPath,
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=20",
    "-o", "BatchMode=yes",
  ];
}

/** Run one command on the remote and return its stdout. */
export function remoteExec(host: RemoteHost, command: string, timeoutMs = 30_000): string {
  return execFileSync("ssh", [...sshArgs(host), `${host.user}@${host.address}`, command], {
    encoding: "utf-8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export class RemoteUnreachable extends Error {
  constructor(host: RemoteHost, detail: string) {
    super(
      `cannot reach ${host.user}@${host.address}: ${detail}\n` +
        `  The key at ${host.keyPath} was rejected or the host is down.\n` +
        `  If the Mac was reimaged, its authorized_keys no longer has this key — add\n` +
        `  ${host.keyPath}.pub through the Scaleway console, then try again.`,
    );
    this.name = "RemoteUnreachable";
  }
}

export interface RemoteBrowser {
  /** Loopback port on THIS machine that tunnels to the remote CDP port. */
  localPort: number;
  remotePort: number;
  /** The `ssh -N -L` process holding the tunnel open. */
  sshPid: number;
  chromeVersion: string;
}

/**
 * Start Chrome on the remote and tunnel its CDP port to loopback here.
 *
 * Headless, because a machine reached over SSH usually has no window server
 * session to draw into, and a Chrome that cannot open a window exits without
 * ever binding its debugging port — a failure that looks like a network problem
 * and is not.
 */
export async function startRemoteBrowser(
  host: RemoteHost,
  opts: { localPort: number; remotePort?: number; windowSize?: { width: number; height: number } },
): Promise<RemoteBrowser> {
  const remotePort = opts.remotePort ?? 9222;

  let chromeVersion: string;
  try {
    chromeVersion = remoteExec(host, `"${REMOTE_CHROME}" --version 2>/dev/null || echo MISSING`);
  } catch (err) {
    throw new RemoteUnreachable(host, (err as Error).message.split("\n")[0]);
  }
  if (chromeVersion.includes("MISSING")) {
    throw new Error(
      `Google Chrome is not installed on ${host.address}.\n` +
        `  Install it there first:  ssh ${host.user}@${host.address} 'brew install --cask google-chrome'`,
    );
  }

  // Clear any Chrome left holding the profile: a second launch against a locked
  // user-data-dir forwards its arguments to the running instance and exits, so
  // the new debugging port is silently dropped.
  remoteExec(host, `pkill -f 'user-data-dir=${REMOTE_PROFILE}' 2>/dev/null; true`).valueOf();
  await sleep(1000);

  const size = opts.windowSize ?? { width: 1440, height: 900 };
  const launch =
    `mkdir -p ${REMOTE_PROFILE} && nohup "${REMOTE_CHROME}" ` +
    `--remote-debugging-port=${remotePort} --remote-debugging-address=127.0.0.1 ` +
    `--user-data-dir=${REMOTE_PROFILE} --headless=new ` +
    `--window-size=${size.width},${size.height} ` +
    `--no-first-run --no-default-browser-check --disable-sync ` +
    `about:blank > /tmp/cast-browser.log 2>&1 & echo $!`;
  const remotePid = remoteExec(host, launch);

  // Bind the remote CDP port to loopback here. `-N` runs no command, so the
  // process exists only to hold the forward open.
  const tunnel = spawn(
    "ssh",
    [...sshArgs(host), "-N", "-L", `${opts.localPort}:127.0.0.1:${remotePort}`, `${host.user}@${host.address}`],
    { stdio: ["ignore", "ignore", "ignore"], detached: true },
  );
  tunnel.unref();
  if (!tunnel.pid) throw new Error("could not start the SSH tunnel");

  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (await isCdpAlive(opts.localPort)) {
      return { localPort: opts.localPort, remotePort, sshPid: tunnel.pid, chromeVersion };
    }
    await sleep(400);
  }
  try {
    process.kill(tunnel.pid, "SIGTERM");
  } catch {
    /* ignore */
  }
  const log = remoteExec(host, `tail -5 /tmp/cast-browser.log 2>/dev/null || true`).slice(0, 400);
  throw new Error(
    `the remote Chrome (pid ${remotePid}) never answered on port ${remotePort}.` +
      (log ? `\n  Its log said:\n  ${log.split("\n").join("\n  ")}` : ""),
  );
}

/** Close the tunnel and stop the remote browser. */
export async function stopRemoteBrowser(host: RemoteHost, sshPid?: number): Promise<void> {
  if (sshPid) {
    try {
      process.kill(sshPid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  try {
    // Wipe the profile as well: it holds cookies this machine sent, and a
    // rented host should not keep them once the work is over.
    remoteExec(host, `pkill -f 'user-data-dir=${REMOTE_PROFILE}' 2>/dev/null; rm -rf ${REMOTE_PROFILE}; true`, 20_000);
  } catch {
    /* the host may already be unreachable; nothing else to do */
  }
}
