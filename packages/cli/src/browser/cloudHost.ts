/**
 * Cloud hosts that a remote browser can run on, and their on/off lifecycle.
 *
 * ## Why this exists, and why it is AWS rather than the Mac
 *
 * The original remote was a Scaleway Apple silicon Mac mini. It cannot scale to
 * zero: Apple's licensing imposes a 24-hour minimum lease, so a machine cannot
 * be deleted before then and there is no stop/start at all — you rent physical
 * hardware and pay until you delete it. Measured against Scaleway's published
 * price for the M1-M, that is about €75 a month to leave running, or a floor of
 * roughly €2.47 every time you create one. Creating per task is therefore WORSE
 * than leaving it up if a person needs a machine twice in a day.
 *
 * A Linux instance has no such floor. It stops in seconds, and a stopped
 * instance bills only for its disk — around a dollar a month against €75. And
 * nothing about browser automation needs macOS: Chrome on Linux is the same
 * Chrome speaking the same protocol, which was verified end to end by carrying
 * a live GitHub session from this Mac into a Chrome on EC2.
 *
 * So Macs are kept only for work that genuinely needs macOS, and the browser
 * runs on Linux.
 *
 * ## The shape
 *
 * `ensureUp` is the whole interface: given a host, make it reachable, whatever
 * that takes. Booting a stopped instance is an implementation detail the caller
 * should not have to know about — asking to send a session somewhere is the
 * same act whether the machine happens to be awake.
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { sshDestination, sshIdentity, type RemoteHost } from "../remote/session-move.js";
import { codecastPath } from "../codecastDir.js";
import { hostProvider, hostSleeps, isMacHost } from "../hosts/providers/registry.js";
import { HOST_TAILNET_COMMAND, localTailnet, readHostTailnet, tailnetDialAddress, type TailnetRecord } from "../cloud/tailnet.js";
import type { WakePhase } from "@codecast/shared/contracts";
import type { HostInspection } from "../hosts/providers/types.js";

export { AwsCliFailed, instanceNameTag } from "../hosts/providers/aws.js";

export type HostState = "running" | "stopped" | "pending" | "missing";

export interface CloudHost {
  /** Stable id: an EC2 instance id, or a Scaleway server uuid. */
  id: string;
  /** codecast: an EC2 machine in codecast's own account (`cast cloud`), woken and stopped through the backend. */
  provider: "aws" | "scaleway-mac" | "codecast";
  region: string;
  profile?: string;
  platform?: "linux" | "darwin";
  /** SSH user for this image. Ubuntu images use `ubuntu`, Scaleway Macs `m1`. */
  user: string;
  keyPath: string;
  /** Last known address. Re-read on every boot: a stopped instance loses it. */
  address?: string;
  /** The host's node on the laptop's tailnet, learned over SSH by ensureUp.
   * Dialed instead of `address` only while this laptop sees that node online
   * (cloud/tailnet.ts); absent when the host is not on a tailnet. */
  tailnet?: TailnetRecord;
  /** Stop the machine after this long with nothing using it. 0 disables. */
  idleStopMinutes?: number;
  /** Launched by autoscale (cloud/hostHeadroom): counts against the template's max_extra. */
  autoscaled?: boolean;
  /** The codecast device id of the daemon on the box, learned over SSH the
   * first time a session is placed there (cloud/prepare.ts). Lets the daemon
   * map a wake request (a device id) back to an instance it can boot. */
  deviceId?: string;
  /** The job this host's daemon is kept for (devices.reserved_for), as last read
   *  from the server by openCloudHosts. Automatic host picks skip it. */
  reservedFor?: string;
  /** The host's git device key (~/.codecast/git/id_ed25519.pub), as last read by the host git setup. */
  gitPubkey?: string;
  /** What the host's key could do against the origin last probed (cloud/hostGit.ts). */
  gitAccess?: HostGitAccessRecord;
  /** What a GitHub App installation token could do against the same repository, over https. */
  gitAppAccess?: HostGitAccessRecord;
  /** When a host with no push access last had its key added to GitHub automatically (cloud/prepare.ts). */
  gitAutoGrantAt?: number;
  /** The human turned the SSH agent bridge on (`cast hosts forward-agent`). Missing = off. */
  forwardAgent?: boolean;
  /** Laptop folders the human approved for this host (`cast hosts reach`), mounted there at the same path while both are up (cloud/reach.ts). */
  reach?: import("../cloud/reach.js").ReachFolder[];
  /** The idle watchdog version `cast hosts provision` last installed (provisionLinux.ts). */
  watchdogVersion?: number;
  /** Several people share this host, each with their own Linux user, logins
   * and peer daemon (browser/sharedHost.ts). Set by `cast hosts provision --shared`. */
  shared?: boolean;
  /** Refuse cookie carries into this host's browser (a host shared with
   * teammates). Default: allowed. Set by hand in hosts.json today; a CLI
   * switch must write it through patchHost. Read by cloud/browserSync.ts. */
  browserSync?: boolean;
  /** Allow a whole cookie jar carry (`cast browser sync --all` on the host)
   * into this host. Default: refused, because any process on the host can ask
   * for one, and the laptop cannot prove the listener is the managed Chrome.
   * Set by hand in hosts.json. Read by cloud/browserSync.ts. */
  browserSyncAll?: boolean;
  /** Sessions on this host drive the laptop's own Chrome while the laptop is
   *  up (cloud/browserLink.ts). Missing = on; `cast browser extension revoke
   *  --host` sets false, `cast browser extension link --host` sets true. */
  laptopBrowser?: boolean;
  /** Sessions on this host may drive this laptop's apps through `cast
   *  computer --on laptop` (computer/remoteGrant.ts). Missing = off; only the
   *  person grants it, on the laptop (`cast computer remote grant`). */
  laptopComputer?: import("../computer/remoteGrant.js").ComputerHostGrant;
}

export interface HostGitAccessRecord {
  origin: string;
  read: boolean;
  write: boolean;
  readonly?: boolean;
  checkedAt: number;
  error?: string;
}

/**
 * The registry entry for a host argument: an instance id, or the default
 * Linux host when none is named. Throws with the registration recipe when
 * nothing matches — a silent "first host" pick would boot the wrong machine.
 */
export function resolveCloudHost(hostArg?: string): CloudHost {
  const hosts = readHosts();
  if (hostArg) {
    const named = hosts.find((h) => h.id === hostArg);
    if (!named) throw new Error(`no cloud host ${hostArg} is registered (cast hosts ls)`);
    return named;
  }
  return defaultHostOf(hosts);
}

/** The default among hosts automatic placement may use: a Linux EC2 host, else the first. */
function defaultHostOf(hosts: CloudHost[]): CloudHost {
  const open = hosts.filter((h) => !h.reservedFor);
  const pick = open.find((h) => isEc2Host(h) && h.platform !== "darwin") ?? open[0];
  if (pick) return pick;
  throw new Error(
    hosts.length
      ? `every registered cloud host is reserved for one job (${hosts.map((h) => `${h.id}: ${h.reservedFor}`).join(", ")}); name one to use it anyway`
      : "no cloud host is registered — cast hosts add <instance-id> --key <pem>, then cast hosts provision",
  );
}

/**
 * The registered hosts automatic placement may use: those whose daemon is not
 * reserved for one job (devices.reserved_for). Reads the reservations from the
 * server and records each on its registry entry, so a laptop that cannot reach
 * the server decides from the last answer. A host named by hand skips this.
 */
export async function openCloudHosts(): Promise<CloudHost[]> {
  const hosts = readHosts();
  if (hosts.some((h) => h.deviceId)) {
    try {
      const { convexClient } = await import("../remote/convexClient.js");
      const cc = await convexClient({ timeoutMs: 5000 });
      const devices: Array<{ device_id: string; reserved_for?: string }> = await cc.client.query(cc.api.devices.listDevices, { api_token: cc.token });
      const reserved = new Map(devices.map((d) => [d.device_id, d.reserved_for?.trim() || undefined]));
      for (const h of hosts) {
        if (!h.deviceId || !reserved.has(h.deviceId)) continue;
        const now = reserved.get(h.deviceId);
        if (h.reservedFor !== now) patchHost(h.id, { reservedFor: now });
        h.reservedFor = now;
      }
    } catch {
      // The server is out of reach: the reservations last recorded stand.
    }
  }
  return hosts.filter((h) => !h.reservedFor);
}

/** resolveCloudHost with no host named, from fresh reservations. */
export async function defaultCloudHost(): Promise<CloudHost> {
  await openCloudHosts();
  return defaultHostOf(readHosts());
}

/** The registered host whose daemon is this device, if we have learned it. */
export function hostForDevice(deviceId: string): CloudHost | undefined {
  return readHosts().find((h) => h.deviceId === deviceId);
}

function registryPath(): string {
  return codecastPath("browser", "hosts.json");
}

/** Where the host registry lives, for a reader that re-reads it only when it changed. */
export const registryFile = registryPath;

/** The lock every field-level registry write takes (patchHost). Exported for tests. */
export function registryLockPath(): string {
  return `${registryPath()}.lock`;
}

export function readHosts(): CloudHost[] {
  try {
    return JSON.parse(fs.readFileSync(registryPath(), "utf-8")).hosts ?? [];
  } catch {
    return [];
  }
}

export function writeHosts(hosts: CloudHost[]): void {
  const p = registryPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ hosts }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
}

export function upsertHost(host: CloudHost): void {
  const hosts = readHosts().filter((h) => h.id !== host.id);
  hosts.push(host);
  writeHosts(hosts);
}

const LOCK_RETRIES = 50;
const LOCK_RETRY_MS = 20;
const LOCK_STALE_MS = 5_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Change ONLY the named fields of one registry entry, under a lock.
 *
 * Every other writer used to spread an entry it read at entry time, and
 * `ensureUp` reads its entry before a boot wait of up to three minutes plus
 * the ssh wait: a `cast hosts forward-agent --off` typed during that window
 * was silently reverted to on by the address write that followed, and a
 * fresh gitAccess dropped the same way. Re-reading inside a `wx` lockfile
 * and merging only the patch removes the lost-update window rather than
 * narrowing it. Returns the merged entry, or undefined (and writes nothing)
 * when no entry has that id.
 */
export function patchHost(id: string, patch: Partial<CloudHost>): CloudHost | undefined {
  const p = registryPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const lock = registryLockPath();
  let fd: number | undefined;
  for (let attempt = 0; fd === undefined; attempt++) {
    try {
      fd = fs.openSync(lock, "wx", 0o600);
      fs.writeSync(fd, String(process.pid));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lock); continue; }
      } catch { continue; /* vanished: retry immediately */ }
      if (attempt >= LOCK_RETRIES) throw new Error(`host registry is locked (${lock}) — retry in a moment`);
      sleepSync(LOCK_RETRY_MS);
    }
  }
  try {
    const hosts = readHosts();
    const i = hosts.findIndex((h) => h.id === id);
    if (i === -1) return undefined;
    const merged = { ...hosts[i]!, ...patch } as CloudHost & Record<string, unknown>;
    // An explicit `undefined` in the patch clears the field (gitPubkey when the host lost its key).
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete merged[k];
    hosts[i] = merged;
    writeHosts(hosts);
    return merged;
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(lock); } catch { /* broken by another waiter */ }
  }
}

/** An EC2 machine, in the person's account or codecast's: it has a state, sleeps and wakes. */
export function isEc2Host(host: Pick<CloudHost, "provider">): boolean {
  return hostSleeps(host);
}

export function describeInstance(host: CloudHost): any {
  return hostProvider(host).describe(host);
}

/**
 * What the provider says about this machine right now.
 *
 * "missing" means AWS ANSWERED and the instance is not there. An aws CLI that
 * could not run at all propagates as AwsCliFailed instead — collapsing the two
 * made a daemon without `aws` on PATH report a healthy host as terminated,
 * and the resulting HostGone advice ("remove it with hosts rm") would have
 * had the user delete a perfectly good registration.
 */
export function hostState(host: CloudHost): { state: HostState; address?: string } {
  return hostProvider(host).state(host);
}

/**
 * Everything `cast hosts ls` needs about one machine, in as few AWS calls as
 * it can be had: state and address and the bill, from a single
 * describe-instances plus one describe-volumes.
 *
 * The call count is the point. Measured from a laptop on a slow route, each
 * AWS call took forty to seventy seconds, so asking three times what could be
 * asked twice is a minute of a person waiting for a listing. `hostState` stays
 * separate and cheap for the hot paths (waking, moving a session) that need
 * the state and nothing else.
 *
 * A volumes call that fails only costs the disk size: the rest of the answer
 * still returns, and the caller prints the size as unknown.
 */
export function inspectHost(host: CloudHost): HostInspection {
  return hostProvider(host).inspect(host);
}

/**
 * Make a host reachable, starting it if it is asleep.
 *
 * A booted instance gets a NEW public address, so the registry is rewritten
 * every time rather than trusted — a cached address from the last run points at
 * whatever machine has it now, which is the kind of mistake that only shows up
 * as someone else's server answering your SSH.
 */
export async function ensureUp(
  host: CloudHost,
  onProgress: (msg: string) => void = () => {},
  // Where the boot is, for a person watching it (WAKE_PHASES): a session
  // waiting on this host shows each one as it passes.
  onPhase: (phase: WakePhase) => void = () => {},
): Promise<CloudHost> {
  const provider = hostProvider(host);
  if (!provider.start) return host;

  const { address, wasRunning } = await provider.start(host, { onProgress, onPhase });

  // Running is not the same as accepting SSH: sshd comes up seconds later, and
  // a connection attempted in that window fails in a way that reads as a key
  // problem rather than a timing one.
  //
  // The probe gets a LONG leash and opens a ControlMaster. On a lossy mobile
  // network a handshake that normally takes two seconds was measured at 36 —
  // a 20s kill made every probe "fail" while a bare ssh by hand worked, which
  // is indistinguishable from the host being down. Paying the slow handshake
  // once and parking it in a control socket also means the transfer commands
  // that follow reuse the authenticated connection instead of re-rolling the
  // same dice.
  // The tailnet when this laptop sees the host's node online there, else the
  // public address. A tailnet dial that fails once drops to public for the
  // rest of this wait: the tailnet is an optimisation, never the only way in.
  let dial = tailnetDialAddress(host.tailnet) ?? address;
  const socketFor = (a: string) => path.join(os.tmpdir(), `cast-ssh-${host.user}-${a.replace(/[^\w.]/g, "_")}`);
  let socket = socketFor(dial);
  // Evict a wedged master first. A master whose link died silently (mobile
  // network flap) still owns the socket, and every client that attaches to
  // it hangs — measured: a fresh ssh took 2.6s while the multiplexed probe
  // timed out at 60s against the same host. Only a master that fails a quick
  // round trip is evicted: `-O exit` ends a HEALTHY master too, and with it
  // every transfer riding it (the daemon's mirror push died with a silent
  // exit 255 each time a spawn woke the same host, 2026-09-29).
  const masterRunning = spawnSync("ssh", ["-o", `ControlPath=${socket}`, "-O", "check", sshDestination({ ...host, address: dial })], { timeout: 5_000, stdio: "ignore" }).status === 0;
  if (masterRunning) {
    const answered = spawnSync("ssh", ["-o", `ControlPath=${socket}`, "-o", "ControlMaster=no", "-o", "BatchMode=yes", sshDestination({ ...host, address: dial }), "true"], { timeout: 10_000, stdio: "ignore" }).status === 0;
    if (!answered) spawnSync("ssh", ["-o", `ControlPath=${socket}`, "-O", "exit", sshDestination({ ...host, address: dial })], { timeout: 5_000, stdio: "ignore" });
  }
  // A host's first boot from a machine image streams its disk in from the
  // snapshot: cloud-init finished at 140s on 2026-09-29, past the old 150s.
  // A host that was already running has booted: if it does not answer within
  // a slow handshake or two its OS is gone (AWS "impaired", 2026-10-24), and a
  // caller with a fallback (cloud-first spawns) should not wait 6 minutes for it.
  const sshDeadline = Date.now() + (wasRunning ? 90_000 : host.platform === "darwin" ? 25 * 60_000 : 6 * 60_000);
  for (;;) {
    try {
      execFileSync(
        "ssh",
        [...sshIdentity(host), "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=accept-new",
         "-o", "ConnectTimeout=10", "-o", "BatchMode=yes",
         // Keepalives on the MASTER: without them a dead link is never
         // noticed and the socket stays wedged for ControlPersist's lifetime.
         "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
         "-o", "ControlMaster=auto", "-o", `ControlPath=${socket}`, "-o", "ControlPersist=120",
         sshDestination({ ...host, address: dial }), "true"],
        { timeout: 60_000, stdio: "ignore" },
      );
      break;
    } catch {
      if (dial !== address) {
        onProgress(`tailnet address ${dial} did not answer; using ${address}`);
        tailnetFailedAt.set(dial, Date.now());
        dial = address;
        socket = socketFor(dial);
        continue;
      }
      if (Date.now() > sshDeadline) throw new Error(`${host.id} is running but never accepted SSH at ${address}`);
      onProgress("waiting for it to accept connections…");
      onPhase("ssh_wait");
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  // Learn the host's tailnet node over the connection just made, so the next
  // dial can prefer it (or stop preferring it, once the host leaves). A laptop
  // with no tailnet of its own could not use the answer, so it does not ask.
  onPhase("ssh_up");
  const tailnet = localTailnet() ? learnHostTailnet(host, dial, socket) : host.tailnet;

  // Only these fields: a field-level patch under the registry lock, so a
  // toggle or a git-access record written during the boot wait survives.
  patchHost(host.id, { address, tailnet });
  return { ...host, address, tailnet };
}

/**
 * The host's own tailnet record, read over the control socket ensureUp just
 * opened. An ssh that fails keeps what was recorded: a hiccup is not proof
 * the host left the tailnet.
 */
function learnHostTailnet(host: CloudHost, dial: string, socket: string): TailnetRecord | undefined {
  const r = spawnSync("ssh", [...sshIdentity(host), "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
    "-o", "ControlMaster=auto", "-o", `ControlPath=${socket}`, "-o", "ControlPersist=120",
    sshDestination({ ...host, address: dial }), HOST_TAILNET_COMMAND], { encoding: "utf-8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? readHostTailnet(r.stdout) : host.tailnet;
}

/** Put a host to sleep. This is what makes idle cost nothing. */
export function stopHost(host: CloudHost): void {
  hostProvider(host).stop(host);
}

/**
 * The hosts answering SSH right now, as RemoteHosts at the address that
 * answered: every registered cloud host with a last-known address (through
 * reachableRemoteHost, so the tailnet then public), plus `also` (the Scaleway
 * Macs, public only). For flows that must NEVER wake a sleeping box: a
 * stopped instance has released its IP, so the probe is both the liveness
 * check and the staleness filter.
 */
export async function reachableRemoteHosts(also: RemoteHost[] = [], reach = sshReachable): Promise<RemoteHost[]> {
  const [cloud, extra] = await Promise.all([
    Promise.all(readHosts().filter((h) => h.address).map((h) => reachableRemoteHost(h, { toRemoteHost, sshReachable: reach }))),
    Promise.all(also.map(async (h) => ((await reach(h)) ? h : null))),
  ]);
  return [...cloud, ...extra].filter((h): h is RemoteHost => h !== null);
}

/**
 * The first address of a host that answers SSH: its tailnet IP when the
 * laptop sees the node online there, then its public address. A tailnet that
 * claims the node but does not carry the connection costs one probe, never
 * the connection.
 */
export async function reachableRemoteHost(
  host: CloudHost,
  deps: { toRemoteHost: (h: CloudHost) => RemoteHost; sshReachable: (h: RemoteHost) => Promise<boolean> },
): Promise<RemoteHost | null> {
  const first = deps.toRemoteHost(host);
  if (await deps.sshReachable(first)) return first;
  if (!host.address || first.address === host.address) return null;
  const pub = deps.toRemoteHost({ ...host, tailnet: undefined });
  return (await deps.sshReachable(pub)) ? pub : null;
}

/** Does anything answer SSH there right now? Cheap, no AWS API call. */
export function sshReachable(host: RemoteHost, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: host.address, port: 22 });
    const done = (up: boolean) => { sock.destroy(); resolve(up); };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(timeoutMs, () => done(false));
  });
}

/**
 * The RemoteHost shape the SSH helpers already speak, at the address to dial:
 * the host's tailnet IP while this laptop sees its node online there
 * (cloud/tailnet.ts), else its public address.
 */
export function toRemoteHost(host: CloudHost): RemoteHost {
  if (!host.address) throw new Error(`host ${host.id} has no address — start it first`);
  const home = isMacHost(host) ? `/Users/${host.user}` : `/home/${host.user}`;
  return {
    address: tailnetDialAddress(host.tailnet) ?? host.address,
    user: host.user,
    keyPath: host.keyPath,
    remoteBaseDir: `${home}/work`,
    homeDir: home,
  };
}

const TAILNET_SHUN_MS = 5 * 60_000;
const tailnetFailedAt = new Map<string, number>();

/**
 * toRemoteHost for a caller that dials again and again (a 3 s live-sync tick)
 * and cannot afford a probe each time: a tailnet address that failed lately
 * gives way to the public address until TAILNET_SHUN_MS has passed.
 */
export function dialRemoteHost(host: CloudHost, now = Date.now()): RemoteHost {
  const first = toRemoteHost(host);
  const failed = tailnetFailedAt.get(first.address);
  return failed !== undefined && now - failed < TAILNET_SHUN_MS ? toRemoteHost({ ...host, tailnet: undefined }) : first;
}

/** A dial through dialRemoteHost failed: when it went over the tailnet, use public for a while. True when the next dial moves. */
export function noteDialFailure(host: CloudHost, now = Date.now()): boolean {
  const dialed = dialRemoteHost(host, now).address;
  if (!host.address || dialed === host.address) return false;
  tailnetFailedAt.set(dialed, now);
  return true;
}

const SSH_CONNECT_FAILURE = /ssh: connect to host|Connection timed out|Operation timed out|No route to host|Network is unreachable/i;

/** An error from a dial through dialRemoteHost: when ssh never reached the host over the tailnet, shun it. True when a retry would dial elsewhere. */
export function noteDialError(host: CloudHost | null | undefined, err: unknown, now = Date.now()): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return !!host?.address && SSH_CONNECT_FAILURE.test(msg) && noteDialFailure(host, now);
}

/** The address that answers ssh now (tailnet, then public), for a one-shot command; the usual address when neither answers. */
export async function probedRemoteHost(host: CloudHost, reach = sshReachable): Promise<RemoteHost> {
  return (await reachableRemoteHost(host, { toRemoteHost, sshReachable: reach })) ?? toRemoteHost(host);
}

export function resetDialFailuresForTests(): void {
  tailnetFailedAt.clear();
}
