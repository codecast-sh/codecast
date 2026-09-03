/**
 * Preparing the cloud host for a session: wake it, put the repo there, copy
 * the manifest's secret files, and acquire an isolated worktree ON the host.
 *
 * One function, `prepareCloudHost`, is shared by every way a session can land
 * on the box — `cast spawn --cloud`, `cast fork --cloud`, `--subagent --cloud`
 * and the web's "run in the cloud" (which a local daemon serves through
 * `cast cloud start`). Nothing here touches Convex: the transfer is SSH and
 * rsync, the same transport `cast remote move` uses. Placement (the Convex
 * side) is `cloud.placeConversation`, called by the entry points after this.
 *
 * The worktree is acquired by the HOST's own `cast ws acquire`, from the same
 * `.codecast/workspace.toml`, so install runs there and ports are probed on
 * the machine that will bind them — several spawns in one command get
 * distinct worktrees and non-colliding ports because the host allocates them.
 */

import { execFileSync } from "node:child_process";
import * as path from "node:path";
import {
  ensureUp,
  resolveCloudHost,
  toRemoteHost,
  upsertHost,
  type CloudHost,
} from "../browser/cloudHost.js";
import {
  copyGitignoredFiles,
  ensureRemoteRepo,
  gitEnv,
  gitSshUrl,
  shq,
  ssh,
  type RemoteHost,
} from "../remote/session-move.js";

export interface PreparedHost {
  cloud: CloudHost;
  host: RemoteHost;
  /** The codecast device id of the daemon on the box. */
  deviceId: string;
  /** The repo's main checkout on the box; worktrees hang under it. */
  repoPath: string;
}

export interface RemoteWorkspace {
  name: string;
  path: string;
  branch: string;
  ports: Record<string, number>;
  created: boolean;
}

type Progress = (message: string) => void;

/** Where the repo lives on the box: the same basename as the local checkout. */
export function remoteRepoPath(host: RemoteHost, localGitRoot: string): string {
  return path.posix.join(host.remoteBaseDir, path.basename(localGitRoot));
}

/** The box's codecast device id, read from its own `cast remote hosts` line. */
export function readHostDeviceId(host: RemoteHost): string | undefined {
  try {
    const line = ssh(host, "cast remote hosts 2>/dev/null | head -1", 60_000);
    return /\(([0-9a-f-]{8,})\)/.exec(line)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * The device id for a host, from the registry when already learned, else
 * over SSH — and then remembered, so the daemon can map a wake request (which
 * names a device) back to the instance it must boot.
 */
export async function learnHostDeviceId(cloud: CloudHost, host: RemoteHost): Promise<string | undefined> {
  if (cloud.deviceId) return cloud.deviceId;
  const deviceId = readHostDeviceId(host);
  if (deviceId) upsertHost({ ...cloud, deviceId });
  return deviceId;
}

/** The branch origin/HEAD points at locally, or "main". */
function defaultBranch(localGitRoot: string): string {
  try {
    const ref = execFileSync("git", ["-C", localGitRoot, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return ref.replace(/^origin\//, "") || "main";
  } catch {
    return "main";
  }
}

/**
 * Make the host's checkout exist and sit on origin/<default branch>.
 *
 * Missing → bundle clone over scp with origin repaired to the real URL
 * (ensureRemoteRepo). Present → fetch on the host; when the host cannot reach
 * origin (no git key there yet), push the laptop's origin/<branch> to the
 * host's remote-tracking ref over SSH instead, which needs nothing but the
 * host key we already hold. Then check the branch out at that tip.
 *
 * A dirty checkout is never reset: `cast remote move` lands moved sessions
 * at the same path, and a hard reset there would erase their uncommitted
 * work. Worktrees then branch from the current HEAD, and the caller is told.
 */
export function refreshRemoteCheckout(
  host: RemoteHost,
  localGitRoot: string,
  repoPath: string,
  onProgress: Progress = () => {},
): { branch: string; head: string; reset: boolean } {
  ensureRemoteRepo(host, localGitRoot, repoPath);
  const branch = defaultBranch(localGitRoot);
  let fetched = false;
  try {
    ssh(host, `cd ${shq(repoPath)} && git fetch -q origin ${shq(branch)}`, 300_000);
    fetched = true;
  } catch {
    onProgress(`host cannot reach origin — sending origin/${branch} from here`);
    execFileSync(
      "git",
      ["-C", localGitRoot, "push", "-q", "--force", gitSshUrl(host, repoPath),
       `refs/remotes/origin/${branch}:refs/remotes/origin/${branch}`],
      { env: gitEnv(host), stdio: "pipe" },
    );
  }
  const dirty = ssh(host, `cd ${shq(repoPath)} && git status --porcelain | wc -l`).trim() !== "0";
  if (dirty) {
    onProgress(`${repoPath} has uncommitted changes — left as is; worktrees branch from its current HEAD`);
  } else {
    ssh(host, `cd ${shq(repoPath)} && git checkout -q -B ${shq(branch)} ${shq(`origin/${branch}`)}`);
  }
  const head = ssh(host, `cd ${shq(repoPath)} && git rev-parse HEAD`).trim();
  onProgress(`checkout at ${head.slice(0, 8)}${fetched ? "" : " (via laptop)"}${dirty ? "" : ` on ${branch}`}`);
  return { branch, head, reset: !dirty };
}

/**
 * Everything a session needs before it can be placed on the host. Idempotent
 * and cheap on a warm host: the wake is a no-op, the fetch is incremental and
 * the file copy is rsync.
 */
export async function prepareCloudHost(opts: {
  hostArg?: string;
  localGitRoot: string;
  onProgress?: Progress;
}): Promise<PreparedHost> {
  const log = opts.onProgress ?? (() => {});
  const cloud = resolveCloudHost(opts.hostArg);
  const up = await ensureUp(cloud, log);
  const host = toRemoteHost(up);
  const deviceId = await learnHostDeviceId(up, host);
  if (!deviceId) {
    throw new Error(`${up.id} runs no codecast daemon — provision it first: cast hosts provision ${up.id}`);
  }
  const repoPath = remoteRepoPath(host, opts.localGitRoot);
  refreshRemoteCheckout(host, opts.localGitRoot, repoPath, log);
  copyGitignoredFiles(host, opts.localGitRoot, repoPath);
  return { cloud: { ...up, deviceId }, host, deviceId, repoPath };
}

/**
 * Acquire a worktree on the host with ITS `cast ws acquire --json`. Install
 * runs there (minutes on a cold node_modules), so the timeout is generous.
 */
export function acquireRemoteWorkspace(host: RemoteHost, repoPath: string, name: string): RemoteWorkspace {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error(`worktree name ${JSON.stringify(name)} — use letters, digits, dot, dash, underscore`);
  }
  let out: string;
  try {
    out = ssh(host, `cd ${shq(repoPath)} && cast ws acquire ${shq(name)} --json`, 15 * 60_000);
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const tail = String(e.stderr ?? e.stdout ?? e.message ?? "").trim().split("\n").slice(-4).join(" | ");
    throw new Error(`cast ws acquire ${name} failed on the host: ${tail}`);
  }
  const line = out.trim().split("\n").reverse().find((l) => l.startsWith("{"));
  if (!line) throw new Error(`cast ws acquire ${name} printed no JSON on the host:\n${out.slice(-400)}`);
  const ws = JSON.parse(line) as RemoteWorkspace & { state: string; contract?: { ok: boolean; failures: unknown[] } | null };
  if (ws.contract && !ws.contract.ok) {
    throw new Error(`workspace ${name} on the host is broken: ${JSON.stringify(ws.contract.failures)}`);
  }
  return { name: ws.name, path: ws.path, branch: ws.branch, ports: ws.ports ?? {}, created: ws.created };
}

/** A worktree name nobody has to think about: cloud-<6 hex>. */
export function freshWorktreeName(): string {
  return `cloud-${Math.random().toString(16).slice(2, 8)}`;
}

/**
 * The host's daemon has said hello since it booted. "Running" and "online"
 * are two clocks (the instance is up seconds before systemd starts the
 * daemon and it heartbeats), and a start routed at an offline device queues
 * in a 5-minute command TTL — so the entry points wait here first.
 */
export async function waitForDeviceOnline(
  client: any,
  api: any,
  token: string,
  deviceId: string,
  onProgress: Progress = () => {},
  timeoutMs = 150_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let said = false;
  for (;;) {
    const devices = await client.query(api.devices.listDevices, { api_token: token });
    const d = (devices as Array<{ device_id: string; online: boolean }>).find((x) => x.device_id === deviceId);
    if (d?.online) return;
    if (Date.now() > deadline) throw new Error(`the daemon on device ${deviceId.slice(0, 8)} never came online`);
    if (!said) { onProgress("waiting for the host's daemon to come online…"); said = true; }
    await new Promise((r) => setTimeout(r, 5000));
  }
}
