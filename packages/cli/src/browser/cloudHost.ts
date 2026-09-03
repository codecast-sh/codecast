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

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { agentSpawnPath } from "../agentSpawnPath.js";
import type { RemoteHost } from "../remote/session-move.js";

export type HostState = "running" | "stopped" | "pending" | "missing";

export interface CloudHost {
  /** Stable id: an EC2 instance id, or a Scaleway server uuid. */
  id: string;
  provider: "aws" | "scaleway-mac";
  region: string;
  /** SSH user for this image. Ubuntu images use `ubuntu`, Scaleway Macs `m1`. */
  user: string;
  keyPath: string;
  /** Last known address. Re-read on every boot: a stopped instance loses it. */
  address?: string;
  /** Stop the machine after this long with nothing using it. 0 disables. */
  idleStopMinutes?: number;
  /** The codecast device id of the daemon on the box, learned over SSH the
   * first time a session is placed there (cloud/prepare.ts). Lets the daemon
   * map a wake request (a device id) back to an instance it can boot. */
  deviceId?: string;
}

/**
 * The registry entry for a host argument: an instance id, or the default
 * Linux host when none is named. Throws with the registration recipe when
 * nothing matches — a silent "first host" pick would boot the wrong machine.
 */
export function resolveCloudHost(hostArg?: string): CloudHost {
  const hosts = readHosts();
  const pick = hostArg
    ? hosts.find((h) => h.id === hostArg)
    : hosts.find((h) => h.provider === "aws") ?? hosts[0];
  if (!pick) {
    throw new Error(
      hostArg
        ? `no cloud host ${hostArg} is registered (cast hosts ls)`
        : "no cloud host is registered — cast hosts add <instance-id> --key <pem>, then cast hosts provision",
    );
  }
  return pick;
}

/** The registered host whose daemon is this device, if we have learned it. */
export function hostForDevice(deviceId: string): CloudHost | undefined {
  return readHosts().find((h) => h.deviceId === deviceId);
}

function registryPath(): string {
  return path.join(process.env.CODECAST_DIR || path.join(os.homedir(), ".codecast"), "browser", "hosts.json");
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

/** The aws CLI failed to RUN (not an AWS "no" — the binary or its execution). */
export class AwsCliFailed extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "AwsCliFailed";
  }
}

function aws(args: string[], region: string): any {
  try {
    const out = execFileSync("aws", [...args, "--region", region, "--output", "json"], {
      encoding: "utf-8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
      // agentSpawnPath, not process.env.PATH: under launchd the daemon gets a
      // bare system PATH, and a child that cannot find `aws` used to cascade
      // into "host no longer exists" (ENOENT → catch → "missing" → HostGone)
      // — a wrong diagnosis three layers from the cause. Seen live when the
      // web's "Move to Cloud Linux" ran this through the daemon.
      env: { ...process.env, PATH: agentSpawnPath(), AWS_PAGER: "" },
    });
    return out.trim() ? JSON.parse(out) : null;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string | Buffer };
    if (e.code === "ENOENT") {
      throw new AwsCliFailed("the aws CLI is not installed (or not on any known PATH) on this machine");
    }
    const stderr = String(e.stderr ?? "").trim();
    // The instance genuinely not existing is an ANSWER, not a failure —
    // callers map it to "missing". Everything else (bad credentials, expired
    // SSO, network) must surface as itself.
    if (/InvalidInstanceID\.NotFound/.test(stderr)) return null;
    throw new AwsCliFailed(stderr.split("\n")[0] || e.message || "aws CLI failed");
  }
}

function describeInstance(host: CloudHost): any {
  const r = aws(["ec2", "describe-instances", "--instance-ids", host.id], host.region);
  return r?.Reservations?.[0]?.Instances?.[0];
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
  if (host.provider !== "aws") return { state: "running", address: host.address };
  const inst = describeInstance(host);
  if (!inst) return { state: "missing" };
  const name = inst.State?.Name;
  const state: HostState =
    name === "running" ? "running" : name === "stopped" ? "stopped" : name === "terminated" ? "missing" : "pending";
  return { state, address: inst.PublicIpAddress };
}

/**
 * What the bill is made of: the instance type it runs as, and every GiB
 * attached to it. A stopped instance still answers both, which is the point —
 * its disk is the only thing it is still costing, and that is exactly what a
 * person wants to see before deciding to keep it registered.
 */
export function describeHostHardware(host: CloudHost): { instanceType?: string; volumeGiB?: number } {
  if (host.provider !== "aws") return {};
  const inst = describeInstance(host);
  if (!inst) return {};
  const vols = aws(
    ["ec2", "describe-volumes", "--filters", `Name=attachment.instance-id,Values=${host.id}`],
    host.region,
  );
  const sizes: number[] = (vols?.Volumes ?? []).map((v: any) => Number(v.Size) || 0);
  return {
    instanceType: inst.InstanceType,
    ...(sizes.length ? { volumeGiB: sizes.reduce((a, b) => a + b, 0) } : {}),
  };
}

/**
 * Make sure the host's security group admits SSH from wherever we are.
 *
 * The group used to pin port 22 to the laptop's /32. That failed twice in one
 * afternoon, and the second failure is the instructive one: on a mobile
 * network the address a web probe reports (checkip: 172.56.161.83) was NOT
 * the address the SSH flow left from (sshd saw 172.56.35.173) — carrier NAT
 * hands out egress addresses per flow, so no probe can learn the right /32
 * and the rule cannot be made to converge. Both times the symptom was an SSH
 * timeout that read as "the host is broken".
 *
 * So the rule is key-only SSH from anywhere — the ordinary EC2 posture. The
 * key is the boundary (the Ubuntu image ships with password auth off), and
 * nothing else on the box listens publicly: CDP and the screen stream bind to
 * loopback and are reached through that same SSH. Manual entries in the group
 * are left alone; only our own tagged rules are managed.
 */
const AUTO_RULE_TAG = "codecast-auto";
const ANYWHERE = "0.0.0.0/0";

export function healSecurityGroup(host: CloudHost, onProgress: (m: string) => void = () => {}): void {
  if (host.provider !== "aws") return;
  try {
    const r = aws(["ec2", "describe-instances", "--instance-ids", host.id], host.region);
    const groupId = r?.Reservations?.[0]?.Instances?.[0]?.SecurityGroups?.[0]?.GroupId;
    if (!groupId) return;

    const sg = aws(["ec2", "describe-security-groups", "--group-ids", groupId], host.region);
    const sshRules = (sg?.SecurityGroups?.[0]?.IpPermissions ?? []).filter(
      (p: any) => p.IpProtocol === "tcp" && p.FromPort === 22 && p.ToPort === 22,
    );
    const ranges: Array<{ CidrIp: string; Description?: string }> = sshRules.flatMap((p: any) => p.IpRanges ?? []);

    if (!ranges.some((x) => x.CidrIp === ANYWHERE)) {
      onProgress("allowing key-only SSH from anywhere (a pinned address cannot follow a laptop across networks)");
      aws(
        ["ec2", "authorize-security-group-ingress", "--group-id", groupId, "--ip-permissions",
         JSON.stringify([{ IpProtocol: "tcp", FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: ANYWHERE, Description: AUTO_RULE_TAG }] }])],
        host.region,
      );
    }
    // Retire the per-network /32s this code added before it learned better.
    const stale = ranges.filter((x) => x.Description === AUTO_RULE_TAG && x.CidrIp !== ANYWHERE);
    if (stale.length) {
      aws(
        ["ec2", "revoke-security-group-ingress", "--group-id", groupId, "--ip-permissions",
         JSON.stringify([{ IpProtocol: "tcp", FromPort: 22, ToPort: 22, IpRanges: stale.map((x) => ({ CidrIp: x.CidrIp })) }])],
        host.region,
      );
    }
  } catch {
    // Healing is best-effort: if the rule is already right, SSH works anyway,
    // and if AWS says no we will find out from the SSH wait loop's error.
  }
}

export class HostGone extends Error {
  constructor(host: CloudHost) {
    super(
      `host ${host.id} no longer exists (terminated, or deleted outside codecast).\n` +
        `  Remove it with: cast hosts rm ${host.id}`,
    );
    this.name = "HostGone";
  }
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
): Promise<CloudHost> {
  if (host.provider !== "aws") return host;

  let { state, address } = hostState(host);
  if (state === "missing") throw new HostGone(host);

  if (state === "stopped") {
    onProgress(`starting ${host.id} — it was stopped, which is why it costs nothing when idle`);
    aws(["ec2", "start-instances", "--instance-ids", host.id], host.region);
    state = "pending";
  }

  const deadline = Date.now() + 180_000;
  while (state !== "running") {
    if (Date.now() > deadline) throw new Error(`${host.id} did not reach "running" within 3 minutes`);
    await new Promise((r) => setTimeout(r, 4000));
    ({ state, address } = hostState(host));
    if (state === "missing") throw new HostGone(host);
  }

  if (!address) throw new Error(`${host.id} is running but has no public address`);

  healSecurityGroup(host, onProgress);

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
  const socket = path.join(os.tmpdir(), `cast-ssh-${host.user}-${address.replace(/[^\w.]/g, "_")}`);
  // Evict a wedged master first. A master whose link died silently (mobile
  // network flap) still owns the socket, and every client that attaches to
  // it hangs — measured: a fresh ssh took 2.6s while the multiplexed probe
  // timed out at 60s against the same host. `-O exit` is a no-op when the
  // master is healthy or absent.
  try {
    execFileSync("ssh", ["-o", `ControlPath=${socket}`, "-O", "exit", `${host.user}@${address}`], {
      timeout: 5_000, stdio: "ignore",
    });
  } catch { /* no master to evict */ }
  const sshDeadline = Date.now() + 150_000;
  for (;;) {
    try {
      execFileSync(
        "ssh",
        ["-i", host.keyPath, "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=accept-new",
         "-o", "ConnectTimeout=10", "-o", "BatchMode=yes",
         // Keepalives on the MASTER: without them a dead link is never
         // noticed and the socket stays wedged for ControlPersist's lifetime.
         "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
         "-o", "ControlMaster=auto", "-o", `ControlPath=${socket}`, "-o", "ControlPersist=120",
         `${host.user}@${address}`, "true"],
        { timeout: 60_000, stdio: "ignore" },
      );
      break;
    } catch {
      if (Date.now() > sshDeadline) throw new Error(`${host.id} is running but never accepted SSH at ${address}`);
      onProgress("waiting for it to accept connections…");
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  const updated = { ...host, address };
  upsertHost(updated);
  return updated;
}

/** Put a host to sleep. This is what makes idle cost nothing. */
export function stopHost(host: CloudHost): void {
  if (host.provider !== "aws") {
    throw new Error(
      `${host.id} is an Apple silicon Mac and cannot be stopped — Apple's licensing has a 24-hour ` +
        `minimum lease, so the only "off" is deleting it. Use the Scaleway console.`,
    );
  }
  aws(["ec2", "stop-instances", "--instance-ids", host.id], host.region);
}

/**
 * The cloud hosts as RemoteHosts, using their last-known addresses — for
 * flows that must NEVER wake a sleeping box (the daemon's credential push).
 * A stopped instance has released its IP, so a quick TCP probe of port 22
 * (sshReachable) is both the liveness check and the staleness filter.
 */
export function listCloudRemoteHosts(): RemoteHost[] {
  return readHosts()
    .filter((h) => h.address)
    .map((h) => toRemoteHost(h));
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

/** The RemoteHost shape the SSH helpers already speak. */
export function toRemoteHost(host: CloudHost): RemoteHost {
  if (!host.address) throw new Error(`host ${host.id} has no address — start it first`);
  return {
    address: host.address,
    user: host.user,
    keyPath: host.keyPath,
    remoteBaseDir: `/home/${host.user}/work`,
    homeDir: `/home/${host.user}`,
  };
}
