/**
 * Preparing the cloud host for a session: wake it, put the repo there, copy
 * the manifest's secret files, and acquire an isolated worktree ON the host.
 *
 * One function, `prepareCloudHost`, is shared by every way a session can land
 * on the box — `cast spawn --cloud`, `cast fork --cloud`, `--subagent --cloud`
 * and the web's "run in the cloud" (which a local daemon serves through
 * `cast cloud start`). Nothing here touches Convex: the transfer uses the
 * same SSH transport as `cast remote move`. Placement (the Convex
 * side) is `cloud.placeConversation`, called by the entry points after this.
 *
 * The worktree is acquired by the HOST's own `cast ws acquire`, from the same
 * `.codecast/workspace.toml`, so install runs there and ports are probed on
 * the machine that will bind them — several spawns in one command get
 * distinct worktrees and non-colliding ports because the host allocates them.
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import {
  ensureUp,
  resolveCloudHost,
  toRemoteHost,
  upsertHost,
  type CloudHost,
} from "../browser/cloudHost.js";
import {
  shq,
  ssh,
  sshBase,
  type RemoteHost,
} from "../remote/session-move.js";
import { cloudCopyFiles, stageCloudInputs, refreshRemoteCheckout } from "./transfer.js";
export { refreshRemoteCheckout } from "./transfer.js";

export interface PreparedHost {
  cloud: CloudHost;
  host: RemoteHost;
  /** The codecast device id of the daemon on the box. */
  deviceId: string;
  /** The repo's main checkout on the box; worktrees hang under it. */
  repoPath: string;
  localGitRoot: string;
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

/**
 * Everything a session needs before it can be placed on the host.
 */
export async function prepareCloudHost(opts: {
  hostArg?: string;
  localGitRoot: string;
  onProgress?: Progress;
}): Promise<PreparedHost> {
  const log = opts.onProgress ?? (() => {});
  cloudCopyFiles(opts.localGitRoot);
  const cloud = resolveCloudHost(opts.hostArg);
  const up = await ensureUp(cloud, log);
  const host = toRemoteHost(up);
  const deviceId = await learnHostDeviceId(up, host);
  if (!deviceId) {
    throw new Error(`${up.id} runs no codecast daemon — provision it first: cast hosts provision ${up.id}`);
  }
  const repoPath = remoteRepoPath(host, opts.localGitRoot);
  refreshRemoteCheckout(host, opts.localGitRoot, repoPath, log);
  return { cloud: { ...up, deviceId }, host, deviceId, repoPath, localGitRoot: opts.localGitRoot };
}

/**
 * Acquire a worktree on the host with ITS `cast ws acquire --json`. Install
 * runs there (minutes on a cold node_modules), so the timeout is generous.
 */
export function acquireRemoteWorkspace(host: RemoteHost, repoPath: string, name: string, localGitRoot: string): RemoteWorkspace {
  const inputRoot = stageCloudInputs(host, localGitRoot, repoPath, name);
  const result = spawnSync("ssh", [...sshBase(host), `${host.user}@${host.address}`,
      `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:$PATH"; export CODECAST_CLOUD_WORKSPACE=1; cd ${shq(repoPath)} && cast ws acquire ${shq(name)} --input-root ${shq(inputRoot)} --skip-pool --json`,
  ], { encoding: "utf-8", stdio: "pipe", env: process.env, timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`cast ws acquire ${name} failed on the host (${result.signal ?? `exit ${result.status}`}); workspace retained for inspection`);
  }
  return parseAcquireOutput(name, result.stdout);
}

/**
 * The workspace from `cast ws acquire --json` output. Install output may
 * precede the JSON line (bun prints to stdout), so the LAST line that looks
 * like JSON is the answer. A broken contract is an error, not a workspace.
 */
export function parseAcquireOutput(name: string, out: string): RemoteWorkspace {
  const line = out.trim().split("\n").reverse().find((l) => l.trimStart().startsWith("{"));
  if (!line) throw new Error(`cast ws acquire ${name} printed no JSON on the host`);
  let ws;
  try {
    ws = JSON.parse(line);
  } catch {
    throw new Error(`cast ws acquire ${name} printed invalid JSON on the host`);
  }
  if (ws.name !== name) throw new Error(`cast ws acquire ${name} returned a different workspace`);
  if (ws.state !== "ready" || ws.contract?.ok !== true || !Array.isArray(ws.contract.failures) || ws.contract.failures.length > 0) {
    throw new Error(`workspace ${name} on the host is broken: ready state and a successful contract are required`);
  }
  if (typeof ws.path !== "string" || !ws.path.startsWith("/") || ws.path === "/"
    || /[\x00-\x1f\x7f\\]/.test(ws.path) || path.posix.normalize(ws.path) !== ws.path
    || typeof ws.branch !== "string" || !ws.branch.trim() || /[\x00-\x20\x7f]/.test(ws.branch)
    || typeof ws.created !== "boolean" || !ws.ports || typeof ws.ports !== "object" || Array.isArray(ws.ports)
    || Object.values(ws.ports).some((port) => typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error(`cast ws acquire ${name} returned invalid workspace fields`);
  }
  return { name: ws.name, path: ws.path, branch: ws.branch, ports: ws.ports, created: ws.created };
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
