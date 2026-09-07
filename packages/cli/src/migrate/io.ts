/**
 * The runner's real world: Convex over the CLI's api token, the cloud-host
 * registry + SSH transport the single-session move already uses, and git.
 * Everything runner.ts sequences goes through here; nothing here decides
 * order.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "../proc.js";
import { ensureUp, hostForDevice, readHosts, toRemoteHost, type CloudHost } from "../browser/cloudHost.js";
import { learnHostDeviceId } from "../cloud/prepare.js";
import { deviceId as localDeviceId } from "../remote/device.js";
import {
  convexClient,
  describeBackSync,
  describeVerification,
  moveNotice,
  readMoves,
  sendMoveNotice,
  writeMoves,
} from "../remote/cli.js";
import {
  cwdToSlug,
  ensureRemoteClaudeReady,
  gitEnv,
  gitSshUrl,
  isWorktree,
  pullSession,
  pushSession,
  refreshRemoteCredential,
  remoteHome,
  shq,
  ssh,
  verifyRemoteSync,
  type MoveResult,
  type RemoteHost,
} from "../remote/session-move.js";
import type { BeginResult, RunnerIo, TransferResult } from "./runner.js";

type Facts = Extract<BeginResult, { ok: true }>;

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

/** Two origins name the same repository: ignore protocol, user, .git and case. */
export function sameOrigin(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (s: string) =>
    s
      .trim()
      .replace(/^[a-z+]+:\/\//i, "")
      .replace(/^[^@/]+@/, "")
      .replace(/:(?=[^/])/, "/")
      .replace(/\.git\/?$/i, "")
      .replace(/\/+$/, "")
      .toLowerCase();
  if (!a || !b) return false;
  return norm(a) === norm(b);
}

/**
 * Where a session coming back from the cloud lands on this machine.
 *
 *  1. The path it left from, when this machine pushed it (remote-moves.json).
 *  2. Else a local checkout of the same repository — matched by origin URL,
 *     then by directory name — with the session's worktree under it:
 *       <root>/.codecast/worktrees/<name>   (a codecast worktree)
 *       <root>                              (the session ran in the main checkout)
 *
 * Returns the path and, when it must be created, the local repo root to
 * create it in. Pure over its inputs so the rule is testable.
 */
export function resolveLocalDestination(opts: {
  sessionId: string;
  remoteCwd: string;
  remoteOrigin: string | null;
  worktreeName: string | null;
  recordedLocalCwd: string | null;
  localRoots: Array<{ root: string; origin: string | null }>;
  exists: (p: string) => boolean;
}): { localCwd: string; createIn?: string } {
  if (opts.recordedLocalCwd && opts.exists(opts.recordedLocalCwd)) return { localCwd: opts.recordedLocalCwd };
  const remoteBase = path.posix.basename(opts.remoteCwd);
  const wtMatch = /^(.*)\/\.codecast\/worktrees\/([^/]+)$/.exec(opts.remoteCwd);
  const remoteRepoBase = wtMatch ? path.posix.basename(wtMatch[1]) : remoteBase;
  const byOrigin = opts.localRoots.filter((r) => sameOrigin(r.origin, opts.remoteOrigin));
  const byName = opts.localRoots.filter((r) => path.basename(r.root) === remoteRepoBase);
  const root = (byOrigin[0] ?? byName[0])?.root;
  if (!root) {
    throw new Error(
      `no local checkout of ${opts.remoteOrigin ?? remoteRepoBase} on this machine — clone it into a synced project root, then retry`,
    );
  }
  // The session ran in the main checkout on the host (a repo pushed whole by
  // `cast remote move`, or a cloud session placed on the host's main clone).
  if (!wtMatch && path.basename(root) === remoteBase) return { localCwd: root };
  const name = opts.worktreeName || (wtMatch ? wtMatch[2] : remoteBase);
  const localCwd = path.join(root, ".codecast", "worktrees", name);
  return opts.exists(localCwd) ? { localCwd } : { localCwd, createIn: root };
}

export function createRunnerIo(batchId: string, opts: { out?: (line: string) => void } = {}): RunnerIo & { ready(): Promise<void> } {
  const out = opts.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const log = (line: string) => out(`[${stamp()}] ${line}`);
  let client: any;
  let token = "";
  let api: any;
  const hosts = new Map<string, { cloud: CloudHost; host: RemoteHost }>();
  const credentialRefreshed = new Set<string>();
  const myDeviceId = localDeviceId();

  const ready = async () => {
    const c = await convexClient();
    client = c.client;
    token = c.token;
    api = c.api;
  };

  const listDevices = async (): Promise<any[]> => client.query(api.devices.listDevices, { api_token: token });

  const prepareHost = async (deviceId: string): Promise<{ cloud: CloudHost; host: RemoteHost }> => {
    const cached = hosts.get(deviceId);
    if (cached) return cached;
    let cloud = hostForDevice(deviceId);
    if (!cloud) {
      // The registry knows the host but has not learned its device id yet
      // (nothing was placed on it from this machine). Wake each unlearned host
      // once and ask.
      for (const h of readHosts().filter((h) => !h.deviceId)) {
        try {
          const up = await ensureUp(h, (m) => log(`  ${h.id}: ${m}`));
          const id = await learnHostDeviceId(up, toRemoteHost(up));
          if (id === deviceId) { cloud = { ...up, deviceId: id }; break; }
        } catch (err) {
          log(`  ${h.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    if (!cloud) {
      throw new Error(`this machine has no registered cloud host for device ${deviceId.slice(0, 8)} (cast hosts ls); only the machine that provisioned the host can move sessions to or from it`);
    }
    const up = await ensureUp(cloud, (m) => log(`  ${cloud!.id}: ${m}`));
    const host = toRemoteHost(up);
    const learned = await learnHostDeviceId(up, host);
    if (learned && learned !== deviceId) {
      throw new Error(`host ${up.id} reports device ${learned.slice(0, 8)}, not ${deviceId.slice(0, 8)} — the registry is stale (cast hosts ls)`);
    }
    const entry = { cloud: up, host };
    hosts.set(deviceId, entry);
    return entry;
  };

  const io: RunnerIo & { ready(): Promise<void> } = {
    ready,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log,
    deviceId: () => myDeviceId,

    loadBatch: () => client.query(api.sessionMigrations.runnerBatch, { api_token: token, batch_id: batchId, device_id: myDeviceId }),
    begin: (migrationId) => client.mutation(api.sessionMigrations.beginSession, { api_token: token, migration_id: migrationId, device_id: myDeviceId }),
    facts: (migrationId) => client.query(api.sessionMigrations.sessionFacts, { api_token: token, migration_id: migrationId }),
    report: async (migrationId, patch) => {
      await client.mutation(api.sessionMigrations.reportSession, { api_token: token, migration_id: migrationId, ...patch });
    },
    enqueueQuiesce: (migrationId, mode) => client.mutation(api.sessionMigrations.enqueueQuiesce, { api_token: token, migration_id: migrationId, mode }),
    commandStatus: (commandId) => client.query(api.sessionMigrations.commandStatus, { api_token: token, command_id: commandId }),
    finish: (migrationId, args) => client.mutation(api.sessionMigrations.finishSession, { api_token: token, migration_id: migrationId, ...args }),
    confirm: async (migrationId, ok, detail) => {
      await client.mutation(api.sessionMigrations.confirmSession, { api_token: token, migration_id: migrationId, ok, ...(detail ?? {}) });
    },
    fail: async (migrationId, error, cancelled) => {
      await client.mutation(api.sessionMigrations.failSession, { api_token: token, migration_id: migrationId, error, ...(cancelled ? { cancelled: true } : {}) });
    },
    sendNotice: (conversationId, text) => sendMoveNotice(client, api, token, conversationId, text),
    deviceOnline: async (deviceId) => {
      const devices = await listDevices();
      return !!devices.find((d: any) => d.device_id === deviceId)?.online;
    },

    prepareHost: async (deviceId) => { await prepareHost(deviceId); },

    transferToCloud: async (facts: Facts, o) => {
      const { host } = await prepareHost(facts.to_device_id);
      const move = await pushSession(facts.session_id, host, { skipTree: o.skipTree });
      ensureRemoteClaudeReady(host, move.remoteCwd);
      if (!credentialRefreshed.has(facts.to_device_id)) {
        refreshRemoteCredential(host);
        credentialRefreshed.add(facts.to_device_id);
      }
      const moves = readMoves();
      moves[facts.session_id] = move;
      writeMoves(moves);
      return {
        destinationPath: move.remoteCwd,
        gitRoot: isWorktree(move.localCwd) ? move.remoteCwd : undefined,
        sourcePath: `${move.localCwd}`,
        verification: describeVerification(move.verification),
        localCwd: move.localCwd,
      };
    },

    transferToLocal: async (facts: Facts) => {
      if (!facts.owner_device_id) throw new Error("the session has no owner device to pull from");
      const { host } = await prepareHost(facts.owner_device_id);
      const remoteCwd = facts.project_path;
      if (!remoteCwd || !remoteCwd.startsWith("/")) throw new Error(`the session's path on the host is unknown (${remoteCwd ?? "none"})`);
      const remoteProjectDir = path.posix.join(remoteHome(host), ".claude", "projects", cwdToSlug(remoteCwd));
      let remoteOrigin: string | null = null;
      let remoteBranch: string | null = null;
      try {
        remoteOrigin = ssh(host, `git -C ${shq(remoteCwd)} remote get-url origin 2>/dev/null || true`).trim() || null;
        remoteBranch = ssh(host, `git -C ${shq(remoteCwd)} rev-parse --abbrev-ref HEAD 2>/dev/null || true`).trim() || null;
      } catch { /* not a repo on the host: rsync fallback below */ }
      const me = (await listDevices()).find((d: any) => d.device_id === myDeviceId);
      const roots: string[] = Array.isArray(me?.local_project_roots) ? me.local_project_roots : [];
      const localRoots = roots
        .filter((r) => fs.existsSync(r))
        .map((root) => {
          let origin: string | null = null;
          try { origin = execFileSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf-8", stdio: "pipe" }).trim() || null; } catch { /* no origin */ }
          return { root, origin };
        });
      const dest = resolveLocalDestination({
        sessionId: facts.session_id,
        remoteCwd,
        remoteOrigin,
        worktreeName: facts.worktree_name,
        recordedLocalCwd: readMoves()[facts.session_id]?.localCwd ?? null,
        localRoots,
        exists: (p) => fs.existsSync(p),
      });
      if (dest.createIn) {
        if (!remoteBranch || remoteBranch === "HEAD") throw new Error("the session's worktree on the host is not on a branch; check it out there first");
        log(`  creating local worktree ${dest.localCwd} on ${remoteBranch} from the host`);
        const ref = `refs/codecast/migrate/${remoteBranch}`;
        execFileSync("git", ["-C", dest.createIn, "fetch", "--force", gitSshUrl(host, remoteCwd), `+refs/heads/${remoteBranch}:${ref}`], { env: gitEnv(host), stdio: "pipe" });
        fs.mkdirSync(path.dirname(dest.localCwd), { recursive: true });
        try {
          execFileSync("git", ["-C", dest.createIn, "worktree", "add", "-B", remoteBranch, dest.localCwd, ref], { stdio: "pipe" });
        } catch {
          // The branch is checked out elsewhere locally: detach at the same commit.
          execFileSync("git", ["-C", dest.createIn, "worktree", "add", "--detach", dest.localCwd, ref], { stdio: "pipe" });
        }
      }
      const move: MoveResult = { sessionId: facts.session_id, localCwd: dest.localCwd, remoteCwd, remoteProjectDir };
      const pulled = await pullSession(facts.session_id, host, move);
      if (!pulled.ff) throw new Error(`CONFLICT: ${pulled.reason}`);
      let verification = "synced via rsync (non-git directory)";
      let gitRoot: string | undefined;
      if (isWorktree(dest.localCwd)) {
        verification = describeBackSync(verifyRemoteSync(host, dest.localCwd, remoteCwd), pulled.backupRef);
        try { gitRoot = execFileSync("git", ["-C", dest.localCwd, "rev-parse", "--show-toplevel"], { encoding: "utf-8", stdio: "pipe" }).trim() || undefined; } catch { /* leave unset */ }
      }
      return { destinationPath: dest.localCwd, gitRoot, sourcePath: remoteCwd, verification };
    },

    notice: (facts: Facts, transfer: TransferResult) => {
      const entry = hosts.get(facts.direction === "to_cloud" ? facts.to_device_id : (facts.owner_device_id ?? ""));
      const hostName = entry ? `${entry.host.user}@${entry.host.address}` : null;
      return moveNotice({
        destination: facts.direction === "to_cloud" ? (hostName ?? facts.to_label ?? "the cloud host") : `${os.hostname()} (back on a local machine)`,
        newCwd: transfer.destinationPath,
        oldCwd: facts.direction === "to_cloud" ? `${transfer.sourcePath} on ${os.hostname()}` : `${transfer.sourcePath} on ${hostName ?? facts.owner_label ?? "the cloud host"}`,
        verification: transfer.verification,
      });
    },
  };
  return io;
}
