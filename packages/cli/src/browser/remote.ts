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
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "../proc.js";
import { setTimeout as sleep } from "node:timers/promises";
import { isCdpAlive } from "./cdp.js";
import type { RemoteHost } from "../remote/session-move.js";

/** The profile the remote browser uses. Never a copy of ours. */
const REMOTE_PROFILE = "~/.codecast/browser-profile";

/**
 * Where Chrome lives, and what it needs, on each kind of remote.
 *
 * Linux is not just a different path. A headless Chrome on a small cloud box
 * needs two flags it never needs on a desktop: `--no-sandbox`, because the
 * kernel namespaces it wants are often unavailable in a stock cloud image, and
 * `--disable-dev-shm-usage`, because /dev/shm defaults to 64MB there and Chrome
 * dies silently when it fills. Measured on a t3.small: without the second flag
 * the process starts, never opens its debugging port, and writes nothing to its
 * log — which reads as a network problem and is not.
 */
const REMOTE_TARGETS = {
  darwin: {
    binary: '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"',
    extraArgs: "",
  },
  linux: {
    binary: "google-chrome",
    extraArgs: "--no-sandbox --disable-dev-shm-usage ",
  },
} as const;

export type RemoteOs = keyof typeof REMOTE_TARGETS;

/** Ask the remote what it is, so we launch the right binary with the right flags. */
export function detectRemoteOs(host: RemoteHost): RemoteOs {
  const uname = remoteExec(host, "uname -s", 20_000).trim().toLowerCase();
  return uname.includes("darwin") ? "darwin" : "linux";
}

/**
 * SSH options shared by every call to a host.
 *
 * Two of these are load-bearing rather than tidiness:
 *
 * `IdentitiesOnly` stops ssh offering every key in the agent before the one we
 * asked for. Beyond being wrong, it burns the server's MaxAuthTries budget and
 * turns a good key into an authentication failure — which is exactly how the
 * Scaleway Mac was misdiagnosed as having rejected our key when it had not.
 *
 * `ControlMaster` reuses ONE connection for the several commands a launch
 * makes. Opening a fresh TCP connection per command was failing intermittently
 * with a bare exit 255 and no stderr, and it is slower for no reason: the
 * multiplexed calls run over a socket that is already authenticated.
 */
function sshArgs(host: RemoteHost): string[] {
  const socket = path.join(os.tmpdir(), `cast-ssh-${host.user}-${host.address.replace(/[^\w.]/g, "_")}`);
  return [
    "-i", host.keyPath,
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=20",
    "-o", "BatchMode=yes",
    // Keepalives so a master whose link died is torn down instead of
    // wedging every later client (see ensureUp in cloudHost.ts).
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${socket}`,
    "-o", "ControlPersist=60",
  ];
}

/**
 * Run one command on the remote and return its stdout.
 *
 * execFileSync throws a generic "Command failed" whose message omits the
 * remote's own stderr, so a failure here arrives with nothing to act on — an
 * empty error that could equally be a bad key, a missing binary, or a timeout.
 * Re-throwing with stderr and the exit status attached is the difference
 * between a debuggable failure and a guess.
 */
export function remoteExec(host: RemoteHost, command: string, timeoutMs = 30_000): string {
  try {
    return execFileSync("ssh", [...sshArgs(host), `${host.user}@${host.address}`, command], {
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    const e = err as { stderr?: string | Buffer; status?: number; signal?: string; message?: string };
    const stderr = (e.stderr ? String(e.stderr) : "").trim();
    const why = e.signal === "SIGTERM" ? `timed out after ${timeoutMs}ms` : `exit ${e.status ?? "?"}`;
    throw new Error(`ssh ${host.user}@${host.address}: ${why}${stderr ? ` — ${stderr.split("\n")[0]}` : ""}`);
  }
}

/**
 * Start something on the remote without waiting for it to finish.
 *
 * `spawn` rather than `execFileSync` because we genuinely do not want the exit
 * code — see the call site. Errors are swallowed for the same reason: the only
 * meaningful failure signal is the service not coming up, which the caller
 * checks directly.
 */
function launchDetached(host: RemoteHost, command: string): void {
  const child = spawn("ssh", [...sshArgs(host), "-n", `${host.user}@${host.address}`, command], {
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });
  child.on("error", () => {});
  child.unref();
}

/**
 * Copy one local file to a path on the remote (used for the cast bundles).
 * Rides the multiplexed connection: on a lossy uplink a fresh scp handshake
 * timed out at 5 minutes for an 8MB file, while the already-authenticated
 * master moved the bytes fine. Ten minutes because the bundles are the only
 * big thing that ever travels this way.
 */
export function scpTo(host: RemoteHost, localPath: string, remotePath: string): void {
  execFileSync(
    "scp",
    [...sshArgs(host), localPath, `${host.user}@${host.address}:${remotePath}`],
    { timeout: 600_000, stdio: ["ignore", "ignore", "pipe"] },
  );
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
  os: RemoteOs;
  /** The X display Chrome renders into, when the host has one (live view). */
  display?: string;
}

/**
 * Start Chrome on the remote and tunnel its CDP port to loopback here.
 *
 * On a provisioned Linux host Chrome renders into the Xvfb display so the
 * live-view stream can see it. Anywhere else it runs headless: a machine
 * reached over SSH usually has no window server session to draw into, and a
 * Chrome that cannot open a window exits without ever binding its debugging
 * port — a failure that looks like a network problem and is not.
 */
export async function startRemoteBrowser(
  host: RemoteHost,
  opts: { localPort: number; remotePort?: number; windowSize?: { width: number; height: number } },
): Promise<RemoteBrowser> {
  const remotePort = opts.remotePort ?? 9222;

  let os: RemoteOs;
  let chromeVersion: string;
  try {
    os = detectRemoteOs(host);
    chromeVersion = remoteExec(host, `${REMOTE_TARGETS[os].binary} --version 2>/dev/null || echo MISSING`);
  } catch (err) {
    throw new RemoteUnreachable(host, (err as Error).message.split("\n")[0]);
  }
  if (chromeVersion.includes("MISSING")) {
    const install =
      os === "darwin"
        ? "brew install --cask google-chrome"
        : "wget -qO /tmp/c.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && sudo apt-get install -y /tmp/c.deb";
    throw new Error(
      `Google Chrome is not installed on ${host.address}.\n` +
        `  Install it there first:  ssh ${host.user}@${host.address} '${install}'`,
    );
  }

  // Clear any Chrome left holding the profile: a second launch against a locked
  // user-data-dir forwards its arguments to the running instance and exits, so
  // the new debugging port is silently dropped.
  //
  // Two traps in one line. `pkill -f` matches whole command lines, INCLUDING the
  // shell running this very command — so a literal pattern makes the remote kill
  // its own session and the call comes back as a bare ssh exit 255. The bracket
  // around the first letter is the usual guard: `[b]rowser-profile` matches
  // Chrome's command line but not the pattern's own text. And the path must be
  // expanded here, because a tilde inside quotes never expands remotely, so the
  // old pattern could not have matched Chrome even when it ran.
  const profileGlob = REMOTE_PROFILE.replace("~/", "").replace("browser-profile", "[b]rowser-profile");
  remoteExec(host, `pkill -f "${profileGlob}" 2>/dev/null; true`);
  await sleep(1000);

  const size = opts.windowSize ?? { width: 1440, height: 900 };
  const t = REMOTE_TARGETS[os];

  // Prefer a real (virtual) display over headless when the host has one. A
  // provisioned Linux box runs Xvfb on :99 precisely so that Chrome's pixels
  // exist somewhere the live-view stream can capture — headless Chrome renders
  // to nowhere and x11grab would show an empty desktop. The probe is the X
  // socket itself: if Xvfb is up, its unix socket exists.
  let display = "";
  if (os === "linux") {
    try {
      const disp = remoteExec(host, `[ -S /tmp/.X11-unix/X99 ] && echo :99 || true`, 15_000);
      if (disp === ":99") display = disp;
    } catch { /* no display service — fall back to headless */ }
  }
  const mode = display
    ? `env DISPLAY=${display} ` // set for the launch below via prefix
    : "";
  const headlessFlag = display ? `--window-position=0,0 ` : `--headless=new `;

  const launch =
    `rm -rf ${REMOTE_PROFILE} && mkdir -p ${REMOTE_PROFILE} && setsid nohup ${mode}${t.binary} ` +
    `--remote-debugging-port=${remotePort} --remote-debugging-address=127.0.0.1 ` +
    `--user-data-dir=${REMOTE_PROFILE} ${headlessFlag}${t.extraArgs}` +
    `--window-size=${size.width},${size.height} ` +
    `--no-first-run --no-default-browser-check --disable-sync ` +
    `about:blank > /tmp/cast-browser.log 2>&1 < /dev/null &`;
  // Fire and forget, deliberately.
  //
  // ssh does not return until every descriptor on the session channel is
  // closed, and a backgrounded Chrome keeps one open however carefully it is
  // detached — measured: `setsid nohup chrome … >log 2>&1 </dev/null &` starts
  // Chrome, which binds its port correctly, and STILL leaves ssh hanging until
  // it is killed. Waiting on the exit code would therefore always fail on a
  // launch that worked. The exit code tells us nothing anyway: whether the
  // browser came up is answered by polling CDP through the tunnel below, which
  // is the only evidence that actually matters.
  launchDetached(host, launch);

  // Bind the remote CDP port to loopback here. `-N` runs no command, so the
  // process exists only to hold the forward open.
  const tunnel = spawn(
    "ssh",
    [
      // NOT the multiplexed args. The tunnel has to outlive this CLI process,
      // and a forward that rides the shared master dies with it — the browser
      // then looks "not running" on the very next command, having worked
      // perfectly a second earlier. Short exec calls want multiplexing; a
      // long-lived forward wants a connection of its own.
      "-i", host.keyPath,
      "-o", "IdentitiesOnly=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ConnectTimeout=20",
      "-o", "BatchMode=yes",
      // Notice a dead peer instead of holding a tunnel to nothing.
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=3",
      "-N",
      // Bind the near end to IPv4 explicitly. Left to itself ssh may listen on
      // [::1] only, and every probe of 127.0.0.1 then misses a tunnel that is
      // working perfectly — which looks exactly like the remote being down.
      "-L", `127.0.0.1:${opts.localPort}:127.0.0.1:${remotePort}`,
      // Fail loudly if the port is taken rather than running a tunnel to nowhere.
      "-o", "ExitOnForwardFailure=yes",
      `${host.user}@${host.address}`,
    ],
    { stdio: ["ignore", "ignore", "ignore"], detached: true },
  );
  tunnel.unref();
  if (!tunnel.pid) throw new Error("could not start the SSH tunnel");

  // Generous: the tunnel is a fresh SSH handshake, and on a lossy network one
  // was measured at 36s — a 40s cap then reported "Chrome never answered"
  // while Chrome's own log showed it listening. The wait costs nothing when
  // the network is fine; CDP answers within a second or two.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await isCdpAlive(opts.localPort)) {
      return { localPort: opts.localPort, remotePort, sshPid: tunnel.pid, chromeVersion, os, display: display || undefined };
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
    `the remote Chrome never answered on port ${remotePort}.` +
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
