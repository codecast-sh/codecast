/**
 * The laptop side of a live mirror the web asked for: `cast remote sync` as a
 * daemon job (cloud_live_sync), one per mirrored cloud session, reported to
 * conversations.local_mirror.
 *
 * A job polls the host only while its session works. Every ssh round trip
 * counts as activity to the host's idle watchdog, so a mirror that polled an
 * idle session would keep the host awake, and billed, forever. Whether the
 * session works comes from Convex (its message count moving), which never
 * touches the host: a quiet session's mirror pauses and resumes by itself.
 *
 * Jobs survive a daemon restart (~/.codecast/live-syncs.json). A job ends
 * when the web stops it, when its session ends, or when the session leaves
 * the host (moved back to a laptop).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createWipSnapshot, snapshotTree } from "../wipSnapshot.js";
import { execFile } from "../proc.js";
import { promisify } from "node:util";
import type { RemoteHost } from "../remote/session-move.js";
import { ensureSyncWorktree, sshSyncDeps, syncTick, type SyncState, type SyncTickDeps } from "./liveSync.js";
import type { LocalMirrorStatus } from "@codecast/shared/contracts";

const execFileAsync = promisify(execFile);

export interface MirrorJobSpec {
  conversation_id: string;
  host_device_id: string;
  remote_cwd: string;
  local_root: string;
}

export interface MirrorReport {
  status: LocalMirrorStatus | "off";
  path?: string;
  last_sha?: string;
  last_landed_at?: number;
  changed?: number;
  files?: string[];
  error?: string;
}

export interface MirrorActivity { conversation_id: string; message_count: number; status: string; owner_device_id: string | null }

export interface LiveSyncJobsDeps {
  report: (conversationId: string, report: MirrorReport) => Promise<void>;
  activity: (conversationIds: string[]) => Promise<MirrorActivity[]>;
  hostFor: (hostDeviceId: string) => RemoteHost | null;
  log: (line: string) => void;
  jobsFile: string;
  /** Test seams. */
  tickDeps?: (spec: MirrorJobSpec, host: RemoteHost, dir: string) => SyncTickDeps;
  now?: () => number;
}

/** A session counts as working while its messages moved, or a change landed, this recently. */
export const MIRROR_ACTIVE_WINDOW_MS = 5 * 60_000;
export const MIRROR_TICK_MS = 3_000;
export const MIRROR_ACTIVITY_POLL_MS = 30_000;
const MIRROR_ERROR_BACKOFF_MS = 30_000;

interface Job {
  spec: MirrorJobSpec;
  dir?: string;
  state: SyncState;
  status: LocalMirrorStatus;
  lastCount?: number;
  activeAt: number;
  error?: string;
  nextTickAt: number;
}

export class LiveSyncJobs {
  private jobs = new Map<string, Job>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private activityAt = 0;
  private busy = false;

  constructor(private deps: LiveSyncJobsDeps) {}

  private now() { return this.deps.now?.() ?? Date.now(); }

  /** The daemon's cloud_live_sync command. */
  async handleCommand(args: MirrorJobSpec & { enable: boolean; overwrite?: boolean }): Promise<string> {
    if (!args.enable) { await this.stop(args.conversation_id); return "mirror stopped"; }
    const job = await this.start({ conversation_id: args.conversation_id, host_device_id: args.host_device_id, remote_cwd: args.remote_cwd, local_root: args.local_root });
    if (args.overwrite) await this.overwrite(job);
    return `mirroring into ${job.dir}`;
  }

  async start(spec: MirrorJobSpec): Promise<Job> {
    const existing = this.jobs.get(spec.conversation_id);
    const job: Job = existing ?? { spec, state: {}, status: "starting", activeAt: this.now(), nextTickAt: 0 };
    job.spec = spec;
    job.activeAt = this.now();
    job.nextTickAt = 0;
    if (!job.dir) {
      const name = `sync-${spec.conversation_id.slice(0, 7)}`;
      job.dir = await ensureSyncWorktree(spec.local_root, name);
    }
    this.jobs.set(spec.conversation_id, job);
    this.save();
    await this.setStatus(job, "starting", {});
    this.ensureTimer();
    return job;
  }

  async stop(conversationId: string, reason?: string): Promise<void> {
    const job = this.jobs.get(conversationId);
    this.jobs.delete(conversationId);
    this.save();
    if (job || reason) await this.deps.report(conversationId, { status: "off" });
    if (reason) this.deps.log(`[MIRROR] ${conversationId.slice(0, 7)} stopped: ${reason}`);
    if (!this.jobs.size && this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** The web's "overwrite with the host's": park the edits made in the mirror under a backup ref, then land over them. */
  private async overwrite(job: Job): Promise<void> {
    if (!job.dir) return;
    const snap = await createWipSnapshot(job.dir);
    if (snap) await execFileAsync("git", ["-C", job.dir, "update-ref", `refs/codecast/backup/mirror-${this.now()}`, snap.sha]);
    job.state.tree = await snapshotTree(job.dir);
    job.state.sha = undefined;
    job.status = "starting";
  }

  /** Jobs that were running when the daemon last stopped. */
  async resumeAll(): Promise<void> {
    let specs: MirrorJobSpec[] = [];
    try { specs = JSON.parse(fs.readFileSync(this.deps.jobsFile, "utf-8")); } catch { return; }
    for (const spec of specs) {
      try { await this.start(spec); } catch (err) { await this.stop(spec.conversation_id, `could not resume: ${String(err)}`); }
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.deps.jobsFile), { recursive: true });
    fs.writeFileSync(this.deps.jobsFile, JSON.stringify([...this.jobs.values()].map((j) => j.spec), null, 2));
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.pass(); }, 1_000);
    (this.timer as any).unref?.();
  }

  private async setStatus(job: Job, status: LocalMirrorStatus, extra: Omit<MirrorReport, "status">): Promise<void> {
    const changed = job.status !== status || extra.last_sha !== undefined || extra.error !== job.error;
    job.status = status;
    job.error = extra.error;
    if (changed || status === "starting") await this.deps.report(job.spec.conversation_id, { status, path: job.dir, ...extra });
  }

  /** One pass over every job: the Convex activity poll when due, then a tick for each active job whose time has come. */
  async pass(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.now();
      if (now - this.activityAt >= MIRROR_ACTIVITY_POLL_MS) {
        this.activityAt = now;
        const rows = await this.deps.activity([...this.jobs.keys()]).catch(() => null);
        if (rows) {
          const byId = new Map(rows.map((r) => [r.conversation_id, r]));
          for (const job of [...this.jobs.values()]) {
            const row = byId.get(job.spec.conversation_id);
            if (!row) { await this.stop(job.spec.conversation_id, "session gone"); continue; }
            if (row.owner_device_id !== job.spec.host_device_id) { await this.stop(job.spec.conversation_id, "session left the cloud host"); continue; }
            if (row.status === "completed") { await this.stop(job.spec.conversation_id, "session ended"); continue; }
            if (job.lastCount !== undefined && row.message_count !== job.lastCount) job.activeAt = now;
            job.lastCount = row.message_count;
          }
        }
      }
      for (const job of [...this.jobs.values()]) {
        if (job.status === "local_edit" || now < job.nextTickAt) continue;
        if (now - job.activeAt > MIRROR_ACTIVE_WINDOW_MS && job.status !== "starting") {
          if (job.status !== "paused") await this.setStatus(job, "paused", {});
          continue;
        }
        await this.tick(job, now);
      }
    } finally {
      this.busy = false;
    }
  }

  private async tick(job: Job, now: number): Promise<void> {
    const host = this.deps.hostFor(job.spec.host_device_id);
    if (!host) { await this.setStatus(job, "error", { error: "this laptop does not manage that cloud host (cast hosts ls)" }); job.nextTickAt = now + MIRROR_ERROR_BACKOFF_MS; return; }
    const deps = (this.deps.tickDeps ?? ((spec, h, dir) => sshSyncDeps(h, spec.remote_cwd, spec.conversation_id, dir)))(job.spec, host, job.dir!);
    try {
      const r = await syncTick(job.dir!, job.state, deps);
      job.nextTickAt = now + MIRROR_TICK_MS;
      if (r.landed) {
        job.activeAt = now;
        await this.setStatus(job, "live", { last_sha: r.sha, last_landed_at: now, changed: r.changed.length });
      } else if (r.reason === "local-edit") {
        await this.setStatus(job, "local_edit", { files: r.files });
      } else if (job.status !== "live") {
        await this.setStatus(job, "live", {});
      }
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 300);
      job.nextTickAt = now + MIRROR_ERROR_BACKOFF_MS;
      if (job.error !== msg) this.deps.log(`[MIRROR] ${job.spec.conversation_id.slice(0, 7)}: ${msg}`);
      await this.setStatus(job, "error", { error: msg });
    }
  }
}
