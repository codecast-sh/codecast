/**
 * MacMiniBackend — SandboxBackend against Scaleway Apple Silicon Mac hosts.
 *
 * Architecture (per docs/mac-backend.md):
 *   - One long-lived Scaleway Mac per codecast user (pool host).
 *   - Many workspaces per host as tart VMs.
 *   - SSH for exec, scp for file I/O.
 *   - Hourly billing; auto-stop on idle.
 *
 * This module deliberately does NOT install any SDK. Scaleway has no official
 * TS SDK; we call their HTTP API via fetch. SSH is shelled out to `ssh`.
 * tart is installed on the Mac host during first-provision.
 *
 * Credentials:
 *   - SCALEWAY_API_TOKEN
 *   - SCALEWAY_PROJECT_ID
 *   - per-host SSH keypair at ~/.codecast/scaleway/<host-id>/id_ed25519
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { resolveManifest } from "../resolver.js";
import { allocatePorts, portsToEnv } from "../ports.js";
import {
  deleteState,
  readState,
  writeState,
  type PersistedWorkspaceState,
} from "../contract.js";
import type {
  AcquireOptions,
  ContractCheck,
  ContractResult,
  Workspace,
} from "../types.js";
import type {
  ExecOptions,
  ExecResult,
  FileContent,
  SandboxBackend,
} from "./types.js";

const SCALEWAY_HOSTS_DIR = path.join(os.homedir(), ".codecast/scaleway");
const SCALEWAY_HOSTS_FILE = path.join(SCALEWAY_HOSTS_DIR, "hosts.json");
// fr-par-3 carries high stock of M1-M; fr-par-1 has the wider M2/M4 range.
const DEFAULT_ZONE = "fr-par-3";
// Scaleway commercial type names are like "M1-M", "M2-M", "M4-S" (NOT
// "mac-m1-m1"). M1-M is the cheapest macOS option and high-stock in fr-par-3.
const DEFAULT_TYPE = "M1-M";

// --------------------------------------------------------------------------
// Host metadata persisted locally
// --------------------------------------------------------------------------

interface ScalewayHostMeta {
  /** Scaleway server id. */
  id: string;
  /** Public IPv6 or IPv4 we SSH to. */
  address: string;
  /**
   * SSH username. Scaleway Apple Silicon servers use a family-based user
   * (e.g., "m1" for M1, "m2"/"m4" for newer) returned as ssh_username on the
   * create response — NOT root.
   */
  sshUsername: string;
  /** Last time any workspace activity touched this host. */
  lastUsedAt: string;
  /** Whether the host is currently stopped (still billable for storage, not compute). */
  stopped: boolean;
  /** Zone the host lives in. */
  zone: string;
  /** Commercial type (e.g., "M1-M", "M2-M", "M4-S"). */
  commercialType: string;
}

interface HostsFile {
  hosts: ScalewayHostMeta[];
}

function readHosts(): HostsFile {
  if (!fs.existsSync(SCALEWAY_HOSTS_FILE)) return { hosts: [] };
  try {
    return JSON.parse(fs.readFileSync(SCALEWAY_HOSTS_FILE, "utf-8")) as HostsFile;
  } catch {
    return { hosts: [] };
  }
}

function writeHosts(h: HostsFile): void {
  fs.mkdirSync(SCALEWAY_HOSTS_DIR, { recursive: true });
  const tmp = `${SCALEWAY_HOSTS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(h, null, 2));
  fs.renameSync(tmp, SCALEWAY_HOSTS_FILE);
}

function sshKeyPath(hostId: string): string {
  return path.join(SCALEWAY_HOSTS_DIR, hostId, "id_ed25519");
}

// --------------------------------------------------------------------------
// Scaleway API client (minimal, fetch-based)
// --------------------------------------------------------------------------

function requireToken(): string {
  // Scaleway authenticates API calls with the SECRET KEY in the X-Auth-Token
  // header (the access key is just the identifier). Accept either env name.
  const t = process.env.SCALEWAY_SECRET_KEY ?? process.env.SCALEWAY_API_TOKEN;
  if (!t) {
    throw new Error(
      `SCALEWAY_SECRET_KEY (or SCALEWAY_API_TOKEN) env var is not set. Get one at https://console.scaleway.com/iam/api-keys`,
    );
  }
  return t;
}

function requireProject(): string {
  const p = process.env.SCALEWAY_PROJECT_ID;
  if (!p) {
    throw new Error(
      `SCALEWAY_PROJECT_ID env var is not set. Find it at https://console.scaleway.com/project/settings`,
    );
  }
  return p;
}

// The apple-silicon API returns the server object FLAT (not wrapped in a
// `server` key, unlike some other Scaleway products). status goes
// starting → ready; ssh_username is the family user (e.g. "m1").
interface ScalewayServerResponse {
  id: string;
  name: string;
  ip: string;
  ssh_username: string;
  status: string;
  type: string;
  zone: string;
}

async function scalewayApi<T>(
  method: "GET" | "POST" | "DELETE" | "PATCH",
  pathName: string,
  body?: unknown,
): Promise<T> {
  const url = `https://api.scaleway.com${pathName}`;
  const res = await fetch(url, {
    method,
    headers: {
      "X-Auth-Token": requireToken(),
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Scaleway API ${method} ${pathName} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

/** Provision a fresh M1 Mac host. Returns when the host is in 'ready' state. */
async function provisionHost(opts?: {
  zone?: string;
  commercialType?: string;
}): Promise<ScalewayHostMeta> {
  const zone = opts?.zone ?? DEFAULT_ZONE;
  const commercialType = opts?.commercialType ?? DEFAULT_TYPE;

  // NOTE: Apple's macOS licensing mandates a 24-hour minimum lease for cloud
  // Macs (minimum_lease_duration=86400s on all macOS server types). Creating
  // a host commits to ~24h of billing even if released immediately. This is
  // an Apple constraint, identical across AWS/Scaleway/MacStadium — not a
  // provider quirk. Provision deliberately; reuse the host across many
  // workspaces within the 24h window.
  const created = await scalewayApi<ScalewayServerResponse>(
    "POST",
    `/apple-silicon/v1alpha1/zones/${zone}/servers`,
    {
      name: `codecast-${Date.now()}`,
      type: commercialType,
      project_id: requireProject(),
    },
  );
  const id = created.id;
  const sshUsername = created.ssh_username || "m1";
  // Poll until ready (can take 8-15 min).
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 15_000));
    const status = await scalewayApi<ScalewayServerResponse>(
      "GET",
      `/apple-silicon/v1alpha1/zones/${zone}/servers/${id}`,
    );
    if (status.status === "ready") {
      const meta: ScalewayHostMeta = {
        id,
        address: status.ip,
        sshUsername: status.ssh_username || sshUsername,
        zone,
        commercialType,
        lastUsedAt: new Date().toISOString(),
        stopped: false,
      };
      const file = readHosts();
      file.hosts.push(meta);
      writeHosts(file);
      return meta;
    }
    if (status.status === "error") {
      throw new Error(`Scaleway provisioning failed: server status='error'`);
    }
  }
  throw new Error(`Scaleway host ${id} did not reach 'ready' within timeout`);
}

async function startHost(meta: ScalewayHostMeta): Promise<void> {
  await scalewayApi(
    "POST",
    `/apple-silicon/v1alpha1/zones/${meta.zone}/servers/${meta.id}/action`,
    { action: "start" },
  );
  meta.stopped = false;
  const f = readHosts();
  const idx = f.hosts.findIndex((h) => h.id === meta.id);
  if (idx >= 0) f.hosts[idx] = meta;
  writeHosts(f);
}

async function stopHost(meta: ScalewayHostMeta): Promise<void> {
  await scalewayApi(
    "POST",
    `/apple-silicon/v1alpha1/zones/${meta.zone}/servers/${meta.id}/action`,
    { action: "poweroff" },
  );
  meta.stopped = true;
  const f = readHosts();
  const idx = f.hosts.findIndex((h) => h.id === meta.id);
  if (idx >= 0) f.hosts[idx] = meta;
  writeHosts(f);
}

async function destroyHost(meta: ScalewayHostMeta): Promise<void> {
  await scalewayApi(
    "DELETE",
    `/apple-silicon/v1alpha1/zones/${meta.zone}/servers/${meta.id}`,
  );
  const f = readHosts();
  f.hosts = f.hosts.filter((h) => h.id !== meta.id);
  writeHosts(f);
  // Remove local keypair dir.
  const keyDir = path.dirname(sshKeyPath(meta.id));
  if (fs.existsSync(keyDir)) fs.rmSync(keyDir, { recursive: true, force: true });
}

/** Find a usable host, provision one if needed. */
async function ensureHost(): Promise<ScalewayHostMeta> {
  const f = readHosts();
  const reusable = f.hosts.find((h) => !h.stopped);
  if (reusable) {
    reusable.lastUsedAt = new Date().toISOString();
    writeHosts(f);
    return reusable;
  }
  const stoppedHost = f.hosts.find((h) => h.stopped);
  if (stoppedHost) {
    await startHost(stoppedHost);
    return stoppedHost;
  }
  return provisionHost();
}

// --------------------------------------------------------------------------
// SSH + tart exec helpers
// --------------------------------------------------------------------------

interface SshTarget {
  host: ScalewayHostMeta;
  /** VM name on the host (tart VM). Optional; if absent we run on the host itself. */
  vm?: string;
}

function sshExec(
  target: SshTarget,
  command: string,
  opts: { stdin?: string; envs?: Record<string, string>; timeoutMs?: number } = {},
): { stdout: string; stderr: string; exitCode: number | null } {
  const ssh = "ssh";
  // Scaleway Apple Silicon uses a family-based SSH user (e.g. "m1"), not root.
  const user = target.host.sshUsername || "m1";
  const args: string[] = [
    "-i", sshKeyPath(target.host.id),
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "UserKnownHostsFile=" + path.join(SCALEWAY_HOSTS_DIR, target.host.id, "known_hosts"),
    `${user}@${target.host.address}`,
  ];
  // Run inside tart VM if target.vm provided.
  let remoteCmd = command;
  if (opts.envs) {
    const envStr = Object.entries(opts.envs)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ");
    remoteCmd = `${envStr} ${remoteCmd}`;
  }
  if (target.vm) {
    remoteCmd = `tart ssh ${JSON.stringify(target.vm)} -- bash -lc ${JSON.stringify(remoteCmd)}`;
  } else {
    remoteCmd = `bash -lc ${JSON.stringify(remoteCmd)}`;
  }
  args.push(remoteCmd);
  const r = spawnSync(ssh, args, {
    encoding: "utf-8",
    input: opts.stdin,
    timeout: opts.timeoutMs,
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.status };
}

// --------------------------------------------------------------------------
// State adornment: Mac-specific fields stored alongside the standard state.
// --------------------------------------------------------------------------

interface MacExtras {
  macHostId: string;
  macVmName: string;
}

function readMacState(repoRoot: string, name: string): (PersistedWorkspaceState & MacExtras) | null {
  const s = readState(repoRoot, name);
  if (!s) return null;
  return s as PersistedWorkspaceState & MacExtras;
}

// --------------------------------------------------------------------------
// SandboxBackend implementation
// --------------------------------------------------------------------------

export const MacMiniBackend: SandboxBackend = {
  name: "mac",

  async acquire(repoRoot, name, opts: AcquireOptions = {}): Promise<Workspace> {
    requireToken();
    requireProject();
    const manifest = resolveManifest(repoRoot);

    const existing = readMacState(repoRoot, name);
    if (existing && existing.state === "ready") {
      return {
        name: existing.name,
        path: existing.path,
        branch: existing.branch,
        resourceIndex: existing.resourceIndex,
        manifest: existing.manifest,
        ports: existing.ports,
        env: existing.env,
        state: existing.state,
      };
    }

    const host = await ensureHost();
    const vmName = `ws-${name}`;
    const portAlloc = await allocatePorts(manifest, { noProbe: true });

    // Create a tart VM from the codecast base image. The base image is
    // expected to be pre-pulled on the host (during host provisioning); if
    // missing, we pull it now.
    sshExec(
      { host },
      `command -v tart >/dev/null 2>&1 || brew install cirruslabs/cli/tart`,
    );
    sshExec({ host }, `tart pull ghcr.io/cirruslabs/macos-sonoma-base:latest`);
    sshExec({ host }, `tart clone macos-sonoma-base ${JSON.stringify(vmName)}`);
    sshExec({ host }, `tart run --no-graphics ${JSON.stringify(vmName)} &`);
    // Wait for VM SSH to become reachable.
    for (let i = 0; i < 30; i++) {
      const r = sshExec({ host, vm: vmName }, "echo ready");
      if (r.exitCode === 0) break;
      await new Promise((res) => setTimeout(res, 2_000));
    }

    // Inside the VM: git clone the repo, run setup.
    const workspacePath = `/Users/admin/work/${name}`;
    const target = { host, vm: vmName };
    sshExec(target, `mkdir -p ${workspacePath}`);

    const cloneUrl = (() => {
      try {
        return execSync("git config --get remote.origin.url", {
          cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
        }).trim() || null;
      } catch { return null; }
    })();
    if (cloneUrl) {
      sshExec(target, `git clone ${cloneUrl} ${workspacePath}`);
    } else {
      throw new Error("mac backend: no git remote.origin.url to clone from (local-only repos not yet supported)");
    }

    if (!opts.skipSetup) {
      const envStrings = { ...manifest.env, ...portsToEnv(portAlloc.ports) };
      for (const cmd of [
        ...manifest.setup.install,
        ...manifest.setup.generate,
        ...manifest.setup.migrate,
      ]) {
        const r = sshExec(target, `cd ${workspacePath} && ${cmd}`, { envs: envStrings });
        if (r.exitCode !== 0) {
          throw new Error(
            `mac setup '${cmd}' exited ${r.exitCode}\nstderr:\n${r.stderr}`,
          );
        }
      }
    }

    const env = { ...manifest.env, ...portsToEnv(portAlloc.ports) };
    const persisted: PersistedWorkspaceState & MacExtras = {
      name,
      path: workspacePath,
      branch: opts.branch ?? `mac/${name}`,
      resourceIndex: portAlloc.resourceIndex,
      state: "ready",
      manifest,
      ports: portAlloc.ports,
      env,
      updatedAt: new Date().toISOString(),
      macHostId: host.id,
      macVmName: vmName,
    };
    writeState(repoRoot, persisted);

    return {
      name,
      path: workspacePath,
      branch: persisted.branch,
      resourceIndex: portAlloc.resourceIndex,
      manifest,
      ports: portAlloc.ports,
      env,
      state: "ready",
    };
  },

  async release(repoRoot, name): Promise<void> {
    const s = readMacState(repoRoot, name);
    if (!s) return;
    const hosts = readHosts();
    const host = hosts.hosts.find((h) => h.id === s.macHostId);
    if (host) {
      sshExec({ host }, `tart stop ${JSON.stringify(s.macVmName)}`);
      sshExec({ host }, `tart delete ${JSON.stringify(s.macVmName)}`);
      host.lastUsedAt = new Date().toISOString();
      writeHosts(hosts);
    }
    deleteState(repoRoot, name);
  },

  async heal(_repoRoot, _name): Promise<Workspace> {
    throw new Error("mac backend heal not yet implemented");
  },

  async validate(repoRoot, name): Promise<ContractResult> {
    const s = readMacState(repoRoot, name);
    if (!s) throw new Error(`workspace '${name}' not found`);
    const checks: ContractCheck[] = [];
    const hosts = readHosts();
    const host = hosts.hosts.find((h) => h.id === s.macHostId);
    checks.push({
      name: "host-tracked",
      ok: !!host,
      ...(host ? {} : { reason: "host id missing from local hosts.json" }),
    });
    if (host && !host.stopped) {
      const r = sshExec({ host, vm: s.macVmName }, "echo ok");
      checks.push({
        name: "vm-reachable",
        ok: r.exitCode === 0,
        ...(r.exitCode === 0 ? {} : { reason: r.stderr || "ssh to VM failed" }),
      });
    }
    return { ok: checks.every((c) => c.ok), checks };
  },

  async list(repoRoot): Promise<Workspace[]> {
    const dir = path.join(repoRoot, ".codecast/workspaces");
    if (!fs.existsSync(dir)) return [];
    const out: Workspace[] = [];
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith("_")) continue;
      const s = readMacState(repoRoot, entry);
      if (s && s.macHostId) {
        out.push({
          name: s.name, path: s.path, branch: s.branch,
          resourceIndex: s.resourceIndex, manifest: s.manifest,
          ports: s.ports, env: s.env, state: s.state,
        });
      }
    }
    return out;
  },

  async exec(repoRoot, name, command, opts: ExecOptions = {}): Promise<ExecResult> {
    const s = readMacState(repoRoot, name);
    if (!s) throw new Error(`workspace '${name}' not found`);
    const hosts = readHosts();
    const host = hosts.hosts.find((h) => h.id === s.macHostId);
    if (!host) throw new Error(`host ${s.macHostId} not in local registry`);
    const cwd = opts.cwd ? `${s.path}/${opts.cwd}` : s.path;
    const start = Date.now();
    const r = sshExec(
      { host, vm: s.macVmName },
      `cd ${cwd} && ${command}`,
      {
        stdin: opts.stdin,
        envs: { ...s.env, ...(opts.env ?? {}) },
        timeoutMs: opts.timeoutMs,
      },
    );
    return {
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode,
      durationMs: Date.now() - start,
    };
  },

  async readFile(repoRoot, name, relativePath): Promise<Buffer> {
    const s = readMacState(repoRoot, name);
    if (!s) throw new Error(`workspace '${name}' not found`);
    const hosts = readHosts();
    const host = hosts.hosts.find((h) => h.id === s.macHostId);
    if (!host) throw new Error(`host ${s.macHostId} not in local registry`);
    const tmp = path.join(os.tmpdir(), `mac-rf-${Date.now()}`);
    try {
      // scp host:vm path is not directly supported; we cat through ssh.
      const r = sshExec(
        { host, vm: s.macVmName },
        `cat ${JSON.stringify(`${s.path}/${relativePath}`)}`,
      );
      if (r.exitCode !== 0) throw new Error(`readFile failed: ${r.stderr}`);
      fs.writeFileSync(tmp, r.stdout);
      return fs.readFileSync(tmp);
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  },

  async writeFile(repoRoot, name, relativePath, content: FileContent): Promise<void> {
    const s = readMacState(repoRoot, name);
    if (!s) throw new Error(`workspace '${name}' not found`);
    const hosts = readHosts();
    const host = hosts.hosts.find((h) => h.id === s.macHostId);
    if (!host) throw new Error(`host ${s.macHostId} not in local registry`);
    // Pipe content through ssh+tart into a file write.
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
    // Ensure parent dir exists.
    const parent = `${s.path}/${relativePath}`.split("/").slice(0, -1).join("/");
    sshExec({ host, vm: s.macVmName }, `mkdir -p ${JSON.stringify(parent)}`);
    const r = sshExec(
      { host, vm: s.macVmName },
      `cat > ${JSON.stringify(`${s.path}/${relativePath}`)}`,
      { stdin: buf.toString("binary") },
    );
    if (r.exitCode !== 0) throw new Error(`writeFile failed: ${r.stderr}`);
  },
};

// --------------------------------------------------------------------------
// Lifecycle helpers (exported so a future daemon-side maintainer can call)
// --------------------------------------------------------------------------

/** Stop any host idle longer than thresholdMs to pause hourly billing. */
export async function autoStopIdleHosts(thresholdMs: number = 30 * 60 * 1000): Promise<void> {
  const hosts = readHosts();
  for (const h of hosts.hosts) {
    if (h.stopped) continue;
    const idle = Date.now() - new Date(h.lastUsedAt).getTime();
    if (idle >= thresholdMs) {
      await stopHost(h);
    }
  }
}

/** Permanently destroy hosts idle longer than thresholdMs (default 24h). */
export async function autoDestroyOldHosts(thresholdMs: number = 24 * 60 * 60 * 1000): Promise<void> {
  const hosts = readHosts();
  for (const h of hosts.hosts) {
    const idle = Date.now() - new Date(h.lastUsedAt).getTime();
    if (idle >= thresholdMs) {
      await destroyHost(h);
    }
  }
}
