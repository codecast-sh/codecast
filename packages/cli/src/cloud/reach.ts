/**
 * Reached folders: a laptop folder the human approved for a cloud host,
 * mounted on the host at the same path and read and edited there in place.
 * Nothing is copied: every read on the host is a request to this laptop, every
 * write lands in the laptop's own file, so there is one copy and nothing to
 * reconcile (the opposite trade from `cast sync`, which keeps two). The cost is
 * that the folder is there only while the laptop is awake and connected.
 *
 * One reach is one held ssh connection (cloud/heldConnection.ts) carrying
 * SFTP the "wrong" way round. The laptop runs its own sftp-server and pipes it
 * into `ssh host sshfs -o slave`: sshfs on the host speaks SFTP over its stdio
 * instead of dialing out, so the host never needs a route or a key to the
 * laptop, and the laptop decides what it serves.
 *
 * What it serves is confined by the kernel, not by sftp-server's goodwill:
 * sftp-server runs under a sandbox-exec profile that denies every file read
 * and write outside the approved folder (system libraries excepted), denies
 * the network and denies exec. A request for ~/.ssh, a symlink planted in the
 * folder that points out of it, a rename out of it: all fail on the laptop.
 * sftp-server's own -P refuses symlink and hardlink creation, so the host
 * cannot leave a link in the folder for the laptop's own tools to follow later.
 *
 * On the host the mountpoint is the laptop's path, so a path the human names
 * from the laptop means the same file on the host. Under the mount sits a
 * read-only directory holding one file, .cast-reach, that says the folder is
 * not connected: an agent that lists the folder while the laptop sleeps reads
 * why it is empty, and a write fails instead of landing on the host's disk
 * where the next mount would hide it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CloudHost } from "../browser/cloudHost.js";
import { shq, type RemoteHost } from "../remote/session-move.js";
import { codecastPath } from "../codecastDir.js";
import { heldSshArgs } from "./agentBridge.js";

export interface ReachFolder {
  /** Absolute laptop path as the human named it; also the mountpoint on the host. */
  path: string;
  /** Serve it read-only (sftp-server -R and a profile with no write rule). */
  readOnly?: boolean;
  addedAt: number;
}

/** The idle watchdog version that subtracts a reach's own connection from the ssh count. */
export const REACH_MIN_WATCHDOG = 3;
/** argv0 of the sshfs process on the host: the watchdog's anchored pgrep counts these. */
export const REACH_ARGV0 = "cast-reach";
/** The line the host prints on stderr once the folder is mounted. */
export const REACH_MOUNTED_LINE = "cast-reach: mounted";
/** The note left under every mountpoint, visible only while it is not mounted. */
export const REACH_NOTE = ".cast-reach";

/** How often the daemon checks reaches. A tick that finds every reach live costs nothing; only a down one probes its host (never waking it). */
export const REACH_TICK_MS = 15_000;

export const REACH_NO_SSHFS_EXIT = 4;
export const REACH_NO_MOUNTPOINT_EXIT = 5;
export const REACH_OCCUPIED_EXIT = 6;

const SFTP_SERVER = "/usr/libexec/sftp-server";
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** The refusal for a remote exit code that retrying cannot fix, or null. */
export function reachRefusal(code: number | null, hostId: string, mountpoint: string): string | null {
  if (code === REACH_NO_SSHFS_EXIT) return `the host has no sshfs — run cast hosts provision ${hostId}`;
  if (code === REACH_NO_MOUNTPOINT_EXIT) return `the host cannot create or write ${mountpoint} (no passwordless sudo?)`;
  if (code === REACH_OCCUPIED_EXIT) return `${mountpoint} already holds files on the host; move them away there, then cast hosts reach ${hostId} ${mountpoint} again`;
  return null;
}

export function reachKey(hostId: string, folder: string): string {
  return `${hostId}\0${folder}`;
}

/**
 * Why `cast hosts reach` must refuse this host, or null. A reach holds an ssh
 * connection for as long as it is on, so a watchdog that counts it would keep
 * the box awake and billing forever.
 */
export function reachHostRefusal(host: CloudHost): string | null {
  if (host.platform === "darwin" || host.provider === "scaleway-mac") return "reached folders need FUSE, which macOS hosts do not have yet; use a Linux host";
  if ((host.watchdogVersion ?? 0) < REACH_MIN_WATCHDOG) return `run \`cast hosts provision ${host.id}\` first: it installs sshfs and an idle watchdog that ignores the reach's own connection (its watchdog is version ${host.watchdogVersion ?? 1}, reach needs ${REACH_MIN_WATCHDOG})`;
  return null;
}

/**
 * The folder as the registry stores it: absolute, `~` expanded, an existing
 * directory, and narrower than a whole home or the filesystem root, both of
 * which would hand the host the laptop's keys and every other secret.
 */
export function normalizeReachFolder(input: string, home = os.homedir()): string {
  const expanded = input === "~" ? home : input.startsWith("~/") ? path.join(home, input.slice(2)) : input;
  const abs = path.resolve(expanded).replace(/\/+$/, "") || "/";
  let real: string;
  try { real = fs.realpathSync(abs); } catch { throw new Error(`${abs} does not exist on this laptop`); }
  if (!fs.statSync(real).isDirectory()) throw new Error(`${abs} is not a folder`);
  const realHome = (() => { try { return fs.realpathSync(home); } catch { return home; } })();
  if (real === "/" || real === realHome || realHome.startsWith(real + "/")) throw new Error(`${abs} is too broad: it holds your whole home folder. Reach a project or notes folder inside it`);
  const sensitive = [".ssh", ".gnupg", ".aws", ".codecast", "Library/Keychains"].map((p) => path.join(realHome, p));
  if (sensitive.some((s) => real === s || real.startsWith(s + "/"))) throw new Error(`${abs} holds credentials; it cannot be reached`);
  return abs;
}

function sbString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The sandbox profile sftp-server runs under. `(allow default)` keeps mach and
 * sysctl lookups working; every file rule after it narrows: no file at all,
 * then the system paths a process needs to start, metadata (stat, not
 * listing) for the folder's ancestors so its path resolves, and the folder
 * itself. Later rules win in SBPL, so the order is the meaning.
 */
export function reachSandboxProfile(realFolder: string, readOnly: boolean): string {
  const ancestors: string[] = [];
  for (let p = path.dirname(realFolder); p !== "/"; p = path.dirname(p)) ancestors.push(p);
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny process-exec)",
    `(allow process-exec (literal ${sbString(SFTP_SERVER)}))`,
    "(deny file-read* file-write*)",
    `(allow file-read* (literal "/") (subpath "/usr/lib") (subpath "/usr/libexec") (subpath "/System") (subpath "/private/var/db/dyld") (subpath "/private/var/db/timezone") (literal "/private/etc/localtime") (subpath "/dev"))`,
    `(allow file-write* (subpath "/dev"))`,
    ...(ancestors.length ? [`(allow file-read-metadata ${ancestors.map((a) => `(literal ${sbString(a)})`).join(" ")})`] : []),
    `(allow file-read* ${readOnly ? "" : "file-write* "}(subpath ${sbString(realFolder)}))`,
  ].join("\n");
}

/**
 * The host side, run by `bash -c` with the mountpoint, the laptop's path and
 * the laptop's name. It clears a mount a dead connection left behind, makes
 * the mountpoint (sudo for a path like /Users/<name> that the host lacks),
 * refuses one that holds anything but its own note, opens it for fusermount
 * and runs sshfs on this connection's stdio. When sshfs ends the mountpoint
 * goes back to read-only, so the note is all an agent sees until the laptop
 * returns.
 */
export const REACH_REMOTE_SCRIPT = `mp="$1"; src="$2"; laptop="$3"
command -v sshfs >/dev/null 2>&1 || exit ${REACH_NO_SSHFS_EXIT}
mounted() { if command -v findmnt >/dev/null 2>&1; then findmnt -n -M "$mp" >/dev/null 2>&1; else mount | grep -qF " on $mp "; fi; }
if mounted; then
  for pid in $(pgrep -f '^${REACH_ARGV0} :' 2>/dev/null); do
    case " $(ps -o args= -p "$pid" 2>/dev/null) " in *" $mp "*) kill -9 "$(ps -o ppid= -p "$pid" | tr -d ' ')" "$pid" 2>/dev/null;; esac
  done
  fusermount3 -uz "$mp" 2>/dev/null || fusermount -uz "$mp" 2>/dev/null || umount -f "$mp" 2>/dev/null
fi
if [ ! -d "$mp" ]; then
  mkdir -p "$mp" 2>/dev/null || { sudo -n mkdir -p "$mp" && sudo -n chown "$(id -u):$(id -g)" "$mp"; } || exit ${REACH_NO_MOUNTPOINT_EXIT}
fi
[ -O "$mp" ] || sudo -n chown "$(id -u):$(id -g)" "$mp" 2>/dev/null || exit ${REACH_NO_MOUNTPOINT_EXIT}
chmod u+w "$mp" || exit ${REACH_NO_MOUNTPOINT_EXIT}
[ -z "$(ls -A "$mp" | grep -vxF '${REACH_NOTE}')" ] || exit ${REACH_OCCUPIED_EXIT}
printf '%s\\n' "This folder is $src on $laptop, reached over ssh: its files live on that laptop and are read and written there in place." "It is not connected right now, so it is empty here. It comes back while that laptop is awake and its codecast daemon is running." "Nothing written here while it is disconnected is kept, so writes are refused." > "$mp/${REACH_NOTE}"
( i=0; while [ $i -lt 100 ]; do if mounted; then echo "${REACH_MOUNTED_LINE}" >&2; exit 0; fi; i=$((i+1)); sleep 0.2; done ) </dev/null >/dev/null &
(exec -a ${REACH_ARGV0} sshfs ":$src" "$mp" -f -o slave -o idmap=user -o dcache_timeout=2 -o dcache_stat_timeout=2 -o dcache_link_timeout=2 -o dcache_dir_timeout=2)
code=$?
chmod a-w "$mp" 2>/dev/null
exit $code`;

/**
 * The laptop side, run by `bash -c` with the profile, the folder, the -R flag
 * (or "") and then the ssh argv. A fifo closes the loop between the two
 * processes, so the bytes never pass through this daemon (Bun's child-to-child
 * pipes cut long streams). Killing the process group ends both; either one
 * ending makes the other read EOF and exit, and sshfs unmounts on the host.
 */
export const REACH_LAPTOP_SCRIPT = `set -o pipefail
profile="$1"; folder="$2"; ro="$3"; shift 3
f=$(mktemp -u "\${TMPDIR:-/tmp}/cast-reach.XXXXXX") && mkfifo -m 600 "$f" || exit 1
trap 'rm -f "$f"' EXIT
${SANDBOX_EXEC} -p "$profile" ${SFTP_SERVER} -d "$folder" -P symlink,hardlink $ro < "$f" | ssh "$@" > "$f"`;

/**
 * Run on the host once a folder is no longer reached: the mountpoint and its
 * note go, so nothing there keeps promising a folder that is not coming back.
 * It waits out an unmount still in progress, and leaves a mountpoint that is
 * mounted again or holds anything else.
 */
export const REACH_REMOVE_SCRIPT = `mp="$1"
[ -d "$mp" ] || exit 0
mounted() { if command -v findmnt >/dev/null 2>&1; then findmnt -n -M "$mp" >/dev/null 2>&1; else mount | grep -qF " on $mp "; fi; }
i=0; while mounted && [ $i -lt 75 ]; do sleep 0.2; i=$((i+1)); done
mounted && exit 0
[ -z "$(ls -A "$mp" | grep -vxF '${REACH_NOTE}')" ] || exit 0
chmod u+w "$mp" && rm -f "$mp/${REACH_NOTE}"
rmdir "$mp" 2>/dev/null || sudo -n rmdir "$mp"`;

/** argv for `ssh`: remove a no-longer-reached folder's mountpoint on the host. */
export function reachRemoveArgs(host: RemoteHost, mountpoint: string): string[] {
  return heldSshArgs(host, `bash -c ${shq(REACH_REMOVE_SCRIPT)} ${REACH_ARGV0} ${shq(mountpoint)}`);
}

/** argv for `bash` on the laptop: one reach of `folder` onto `host`. */
export function reachLaptopArgs(host: RemoteHost, folder: ReachFolder, realFolder: string, laptopName: string): string[] {
  const remote = `bash -c ${shq(REACH_REMOTE_SCRIPT)} ${REACH_ARGV0} ${shq(folder.path)} ${shq(realFolder)} ${shq(laptopName)}`;
  return [
    "-c", REACH_LAPTOP_SCRIPT, REACH_ARGV0,
    reachSandboxProfile(realFolder, folder.readOnly === true), realFolder, folder.readOnly ? "-R" : "",
    ...heldSshArgs(host, remote),
  ];
}

// ---------------------------------------------------------------------------
// Live state, written by the daemon and read by `cast hosts reach`.
// ---------------------------------------------------------------------------

export type ReachState = "mounted" | "connecting" | "waiting" | "refused" | "missing" | "unreachable";

export interface ReachStatusEntry { state: ReachState; detail?: string; since: number }
export interface ReachStatus { updatedAt: number; hosts: Record<string, Record<string, ReachStatusEntry>> }

export function reachStatusPath(): string {
  return codecastPath("reach-status.json");
}

export function readReachStatus(p = reachStatusPath()): ReachStatus | null {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")) as ReachStatus; } catch { return null; }
}

export function writeReachStatus(status: ReachStatus, p = reachStatusPath()): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(status, null, 2));
  fs.renameSync(tmp, p);
}

/** One line per reached folder for `cast hosts reach` and `cast hosts ls`. */
export function reachLine(folder: ReachFolder, entry: ReachStatusEntry | undefined, statusAgeMs: number | null): string {
  const ro = folder.readOnly ? " (read-only)" : "";
  if (!entry || statusAgeMs === null || statusAgeMs > 3 * 60_000) return `${folder.path}${ro}: approved — the daemon has not reported on it (is it running?)`;
  const what: Record<ReachState, string> = {
    mounted: "mounted on the host",
    connecting: "connecting",
    waiting: "disconnected, retrying",
    refused: "refused",
    missing: "missing on this laptop",
    unreachable: "host asleep or unreachable — mounts when it is up",
  };
  return `${folder.path}${ro}: ${what[entry.state]}${entry.detail ? ` — ${entry.detail}` : ""}`;
}
