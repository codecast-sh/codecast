/**
 * E2bBackend — SandboxBackend implementation backed by E2B (e2b.dev) cloud
 * sandboxes. Firecracker microVMs, ~150ms boot, typed TS SDK.
 *
 * Design:
 *   - The `e2b` npm package is NOT a hard dependency of this CLI. We
 *     dynamically import it at first use. Without the package installed,
 *     a clean error tells the user how to enable cloud backends.
 *   - E2B sandboxes are addressed by a sandbox id. We persist the
 *     name→sandboxId mapping in .codecast/workspaces/<name>/state.json so
 *     subsequent commands (exec, readFile) can re-attach.
 *   - Setup (install/generate/migrate) runs INSIDE the sandbox via
 *     sandbox.commands.run, not on the local machine.
 *
 * Credentials: E2B_API_KEY env var (or constructor option).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveManifest } from "../resolver.js";
import { allocatePorts, portsToEnv } from "../ports.js";
import {
  readState,
  deleteState,
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

/**
 * Minimal interface of what we need from the `e2b` SDK. Defined locally so
 * this file compiles without the package installed. At runtime we cast the
 * dynamic-import result to this shape.
 */
interface E2bSdk {
  Sandbox: {
    /** Create a new sandbox instance. Returns a sandbox connected to the cloud VM. */
    create(opts?: E2bSandboxCreateOpts): Promise<E2bSandbox>;
    /** Re-attach to an existing sandbox by id. */
    connect(sandboxId: string, opts?: { apiKey?: string }): Promise<E2bSandbox>;
  };
}

interface E2bSandboxCreateOpts {
  apiKey?: string;
  template?: string;
  timeoutMs?: number;
  envs?: Record<string, string>;
}

interface E2bSandbox {
  readonly sandboxId: string;
  commands: {
    run(
      command: string,
      opts?: { cwd?: string; envs?: Record<string, string>; timeoutMs?: number },
    ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  };
  files: {
    read(path: string): Promise<string | Buffer>;
    write(path: string, data: string | Buffer): Promise<void>;
    makeDir(path: string): Promise<void>;
  };
  kill(): Promise<void>;
}

/** Load the SDK at runtime; throw a clear error if absent. */
async function loadE2bSdk(): Promise<E2bSdk> {
  try {
    // @ts-expect-error — optional dependency, may not be installed
    const mod = await import("e2b");
    return mod as unknown as E2bSdk;
  } catch (err) {
    throw new Error(
      `e2b backend requires the 'e2b' npm package. Install with 'bun add e2b' or 'npm install e2b'. (${(err as Error).message})`,
    );
  }
}

function requireApiKey(): string {
  const key = process.env.E2B_API_KEY;
  if (!key) {
    throw new Error(
      `E2B_API_KEY env var is not set. Sign up at https://e2b.dev/ and export E2B_API_KEY=...`,
    );
  }
  return key;
}

// --------------------------------------------------------------------------
// State adornment: E2B-specific fields stored alongside the standard
// PersistedWorkspaceState.
// --------------------------------------------------------------------------

interface E2bExtras {
  e2bSandboxId: string;
}

function readE2bState(repoRoot: string, name: string): (PersistedWorkspaceState & E2bExtras) | null {
  const s = readState(repoRoot, name);
  if (!s) return null;
  return s as PersistedWorkspaceState & E2bExtras;
}

// --------------------------------------------------------------------------
// Sandbox cache: keep a Sandbox handle alive across exec calls within one
// process. Re-create on cache miss.
// --------------------------------------------------------------------------

const sandboxCache = new Map<string, E2bSandbox>();

async function getOrConnectSandbox(sandboxId: string): Promise<E2bSandbox> {
  const cached = sandboxCache.get(sandboxId);
  if (cached) return cached;
  const sdk = await loadE2bSdk();
  const sb = await sdk.Sandbox.connect(sandboxId, { apiKey: requireApiKey() });
  sandboxCache.set(sandboxId, sb);
  return sb;
}

function evictSandbox(sandboxId: string) {
  sandboxCache.delete(sandboxId);
}

// --------------------------------------------------------------------------
// SandboxBackend implementation
// --------------------------------------------------------------------------

export const E2bBackend: SandboxBackend = {
  name: "e2b",

  async acquire(repoRoot, name, opts: AcquireOptions = {}): Promise<Workspace> {
    const manifest = resolveManifest(repoRoot);
    const existing = readE2bState(repoRoot, name);
    if (existing && existing.state === "ready" && existing.e2bSandboxId) {
      // Re-attach path: sandbox already exists.
      const ws: Workspace = {
        name: existing.name,
        path: existing.path,
        branch: existing.branch,
        resourceIndex: existing.resourceIndex,
        manifest: existing.manifest,
        ports: existing.ports,
        env: existing.env,
        state: existing.state,
      };
      return ws;
    }

    const sdk = await loadE2bSdk();
    const portAlloc = await allocatePorts(manifest, { noProbe: true, startIndex: 0 });
    const env: Record<string, string> = {
      ...manifest.env,
      ...portsToEnv(portAlloc.ports),
    };

    // Spin up the sandbox. We DON'T pass envs to create() because env may
    // need PORT_<NAME> values that depend on the sandbox's local network.
    const sandbox = await sdk.Sandbox.create({
      apiKey: requireApiKey(),
      template: opts.branch?.startsWith("e2b/") ? opts.branch.slice(4) : undefined,
      timeoutMs: 24 * 60 * 60 * 1000, // 24h max (E2B limit)
      envs: env,
    });
    sandboxCache.set(sandbox.sandboxId, sandbox);

    // Clone repo into /workspace on the sandbox. We use the local repo's
    // HEAD remote URL; if none, we tar up the repo and push it. For v1 the
    // simpler clone-from-origin path is sufficient.
    const workspacePath = `/workspace/${name}`;
    if (!opts.skipSetup) {
      // Clone fresh. The user may want to override the source URL via opt.
      const cloneUrl = await getRepoRemoteUrl(repoRoot);
      await sandbox.commands.run(`mkdir -p ${workspacePath}`);
      if (cloneUrl) {
        await sandbox.commands.run(`git clone ${cloneUrl} ${workspacePath}`);
      } else {
        // No remote — push a tarball.
        await pushRepoTarball(sandbox, repoRoot, workspacePath);
      }

      // Run setup commands inside sandbox CWD = workspacePath.
      for (const cmd of [
        ...manifest.setup.install,
        ...manifest.setup.generate,
        ...manifest.setup.migrate,
      ]) {
        const r = await sandbox.commands.run(cmd, { cwd: workspacePath, envs: env });
        if (r.exitCode !== 0) {
          throw new Error(
            `e2b setup '${cmd}' exited ${r.exitCode}\nstderr:\n${r.stderr}`,
          );
        }
      }
    }

    // Persist state including the sandbox id.
    const persisted: PersistedWorkspaceState & E2bExtras = {
      name,
      path: workspacePath,
      branch: opts.branch ?? `e2b/${name}`,
      resourceIndex: portAlloc.resourceIndex,
      state: "ready",
      manifest,
      ports: portAlloc.ports,
      env,
      updatedAt: new Date().toISOString(),
      e2bSandboxId: sandbox.sandboxId,
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
    const s = readE2bState(repoRoot, name);
    if (!s) return;
    if (s.e2bSandboxId) {
      try {
        const sandbox = await getOrConnectSandbox(s.e2bSandboxId);
        await sandbox.kill();
      } catch {
        /* sandbox may already be gone */
      }
      evictSandbox(s.e2bSandboxId);
    }
    deleteState(repoRoot, name);
  },

  async heal(_repoRoot, _name): Promise<Workspace> {
    throw new Error("e2b backend heal not yet implemented");
  },

  async validate(repoRoot, name): Promise<ContractResult> {
    const s = readE2bState(repoRoot, name);
    if (!s) throw new Error(`workspace '${name}' not found`);
    const checks: ContractCheck[] = [];
    checks.push({
      name: "sandbox-id",
      ok: !!s.e2bSandboxId,
      ...(s.e2bSandboxId ? {} : { reason: "no sandbox id" }),
    });
    if (s.e2bSandboxId) {
      try {
        const sandbox = await getOrConnectSandbox(s.e2bSandboxId);
        const r = await sandbox.commands.run("test -d " + JSON.stringify(s.path));
        checks.push({
          name: "workspace-dir",
          ok: r.exitCode === 0,
          ...(r.exitCode === 0 ? {} : { reason: "workspace dir missing in sandbox" }),
        });
      } catch (err) {
        checks.push({
          name: "sandbox-reachable",
          ok: false,
          reason: (err as Error).message,
        });
      }
    }
    return { ok: checks.every((c) => c.ok), checks };
  },

  async list(repoRoot): Promise<Workspace[]> {
    const dir = path.join(repoRoot, ".codecast/workspaces");
    if (!fs.existsSync(dir)) return [];
    const out: Workspace[] = [];
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith("_")) continue;
      const s = readE2bState(repoRoot, entry);
      if (s && s.e2bSandboxId) {
        out.push({
          name: s.name,
          path: s.path,
          branch: s.branch,
          resourceIndex: s.resourceIndex,
          manifest: s.manifest,
          ports: s.ports,
          env: s.env,
          state: s.state,
        });
      }
    }
    return out;
  },

  async exec(repoRoot, name, command, opts: ExecOptions = {}): Promise<ExecResult> {
    const s = readE2bState(repoRoot, name);
    if (!s) throw new Error(`workspace '${name}' not found`);
    if (!s.e2bSandboxId) throw new Error(`workspace '${name}' has no sandbox id`);
    const sandbox = await getOrConnectSandbox(s.e2bSandboxId);
    const cwd = opts.cwd ? `${s.path}/${opts.cwd}` : s.path;
    const start = Date.now();
    const r = await sandbox.commands.run(command, {
      cwd,
      envs: { ...s.env, ...(opts.env ?? {}) },
      timeoutMs: opts.timeoutMs,
    });
    return {
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode,
      durationMs: Date.now() - start,
    };
  },

  async readFile(repoRoot, name, relativePath): Promise<Buffer> {
    const s = readE2bState(repoRoot, name);
    if (!s) throw new Error(`workspace '${name}' not found`);
    if (!s.e2bSandboxId) throw new Error(`workspace '${name}' has no sandbox id`);
    const sandbox = await getOrConnectSandbox(s.e2bSandboxId);
    const content = await sandbox.files.read(`${s.path}/${relativePath}`);
    return Buffer.isBuffer(content) ? content : Buffer.from(content);
  },

  async writeFile(repoRoot, name, relativePath, content: FileContent): Promise<void> {
    const s = readE2bState(repoRoot, name);
    if (!s) throw new Error(`workspace '${name}' not found`);
    if (!s.e2bSandboxId) throw new Error(`workspace '${name}' has no sandbox id`);
    const sandbox = await getOrConnectSandbox(s.e2bSandboxId);
    const fullPath = `${s.path}/${relativePath}`;
    // Ensure parent dir exists in the sandbox.
    const parent = fullPath.split("/").slice(0, -1).join("/");
    if (parent) await sandbox.files.makeDir(parent);
    await sandbox.files.write(fullPath, content);
  },
};

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

import { execSync } from "node:child_process";

function getRepoRemoteUrl(repoRoot: string): string | null {
  try {
    return execSync("git config --get remote.origin.url", {
      cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

async function pushRepoTarball(
  sandbox: E2bSandbox,
  repoRoot: string,
  destPath: string,
): Promise<void> {
  // Create a tarball of the repo (excluding .codecast/worktrees/ and node_modules).
  const tar = execSync(
    `tar --exclude=.codecast/worktrees --exclude=node_modules --exclude=target -cz -C ${JSON.stringify(repoRoot)} .`,
    { encoding: "buffer" as BufferEncoding, maxBuffer: 1024 * 1024 * 1024 },
  ) as unknown as Buffer;
  await sandbox.files.write(`/tmp/repo.tgz`, tar);
  await sandbox.commands.run(
    `mkdir -p ${destPath} && tar -xzf /tmp/repo.tgz -C ${destPath} && rm /tmp/repo.tgz`,
  );
}
