/**
 * The laptop side of a sync the web or an agent asked for: `cast remote
 * sync` as a daemon job (cloud_live_sync), one per synced cloud session,
 * reported to conversations.local_mirror.
 *
 * A job talks to the host only while it has a reason to. Every ssh round
 * trip counts as activity to the host's idle watchdog, so a job that polled
 * an idle session would keep the host awake, and billed, forever. It ticks
 * while its session works (its message count moving in Convex, which never
 * touches the host) and for a few minutes after. While the session idles it
 * reads only the laptop copy, which is local and free, and ticks once when
 * that copy changed and the host is awake anyway.
 *
 * Jobs and the state they last agreed on survive a daemon restart
 * (~/.codecast/live-syncs.json). A job ends when the web stops it, when its
 * session ends, or when the session leaves the host.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createWipSnapshot } from "../wipSnapshot.js";
import { execFile } from "../proc.js";
import { promisify } from "node:util";
import type { RemoteHost } from "../remote/session-move.js";
import { ensureSyncWorktree, resolveConflicts, sshHostSide, syncTick, type HostSide, type SyncState, type TickResult } from "./liveSync.js";
import { runSide, type Skipped, type SnapshotResult, type SyncScope } from "./syncSide.js";
import type { LocalMirrorMode, LocalMirrorStatus, MirrorResolve, SyncSkipped } from "@codecast/shared/contracts";

const execFileAsync = promisify(execFile);

export interface MirrorJobSpec {
  conversation_id: string;
  host_device_id: string;
  remote_cwd: string;
  local_root: string;
  mode?: LocalMirrorMode;
}

export interface MirrorReport {
  status: LocalMirrorStatus | "off";
  path?: string;
  mode?: LocalMirrorMode;
  last_sha?: string;
  last_landed_at?: number;
  changed?: number;
  to_laptop?: number;
  to_host?: number;
  files?: string[];
  conflicts?: string[];
  skipped?: SyncSkipped[];
  skipped_count?: number;
  error?: string;
}

export interface MirrorActivity { conversation_id: string; message_count: number; status: string; owner_device_id: string | null; host_online?: boolean }

export interface LiveSyncJobsDeps {
  report: (conversationId: string, report: MirrorReport) => Promise<void>;
  activity: (conversationIds: string[]) => Promise<MirrorActivity[]>;
  hostFor: (hostDeviceId: string) => RemoteHost | null;
  log: (line: string) => void;
  jobsFile: string;
  /** The person's always/never patterns for this repo. */
  scopeFor?: (spec: MirrorJobSpec) => SyncScope | undefined;
  /** Test seams. */
  hostSide?: (spec: MirrorJobSpec, host: RemoteHost, dir: string, scope?: SyncScope) => HostSide;
  now?: () => number;
}

/** A session counts as working while its messages moved, or a change landed, this recently. */
export const MIRROR_ACTIVE_WINDOW_MS = 5 * 60_000;
export const MIRROR_TICK_MS = 3_000;
export const MIRROR_ACTIVITY_POLL_MS = 30_000;
/** While the session idles, how often the laptop copy is read for edits of its own. */
export const MIRROR_LAPTOP_CHECK_MS = 15_000;
const MIRROR_RETRY_MS = 1_000;
const MIRROR_ERROR_BACKOFF_MS = 30_000;
const SKIPPED_REPORTED = 20;

interface Job {
  spec: MirrorJobSpec;
  dir?: string;
  state: SyncState;
  status: LocalMirrorStatus;
  lastCount?: number;
  activeAt: number;
  hostOnline: boolean;
  laptopCheckAt: number;
  error?: string;
  nextTickAt: number;
  hostSkipped: Skipped[];
  laptopSkipped: Skipped[];
  skippedKey?: string;
  lastLandedAt?: number;
}

interface SavedJob { spec: MirrorJobSpec; state?: SyncState }

export class LiveSyncJobs {
  private jobs = new Map<string, Job>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private activityAt = 0;
  private running: Promise<void> | null = null;

  constructor(private deps: LiveSyncJobsDeps) {}

  private now() { return this.deps.now?.() ?? Date.now(); }

  /** The daemon's cloud_live_sync command. */
  async handleCommand(args: MirrorJobSpec & { enable: boolean; overwrite?: boolean; resolve?: MirrorResolve }): Promise<string> {
    if (!args || typeof args.conversation_id !== "string" || typeof args.enable !== "boolean") throw new Error("cloud_live_sync needs conversation_id and enable");
    if (args.enable && (!args.host_device_id || !args.remote_cwd || !args.local_root)) throw new Error("cloud_live_sync needs host_device_id, remote_cwd and local_root to start");
    if (args.mode && args.mode !== "two_way" && args.mode !== "from_cloud") throw new Error(`unknown mode ${args.mode}`);
    if (!args.enable) { await this.stop(args.conversation_id); return "sync stopped"; }
    const existing = this.jobs.get(args.conversation_id);
    const job = await this.start({
      conversation_id: args.conversation_id, host_device_id: args.host_device_id, remote_cwd: args.remote_cwd, local_root: args.local_root,
      mode: args.mode ?? existing?.spec.mode ?? "two_way",
    });
    if (args.overwrite) await this.overwrite(job);
    if (args.resolve) {
      await this.resolve(job, args.resolve);
      return `kept the ${args.resolve.keep === "laptop" ? "laptop's" : "cloud's"} version`;
    }
    return `syncing with ${job.dir}`;
  }

  async start(spec: MirrorJobSpec, state?: SyncState): Promise<Job> {
    const existing = this.jobs.get(spec.conversation_id);
    const job: Job = existing ?? { spec, state: state ?? {}, status: "starting", activeAt: this.now(), hostOnline: true, laptopCheckAt: 0, nextTickAt: 0, hostSkipped: [], laptopSkipped: [] };
    const modeChanged = !!existing && existing.spec.mode !== spec.mode;
    job.spec = spec;
    job.activeAt = this.now();
    job.nextTickAt = 0;
    if (!job.dir) job.dir = await ensureSyncWorktree(spec.local_root, `sync-${spec.conversation_id.slice(0, 7)}`);
    // Leaving watch-only after an edit there: that edit is now a change to send.
    if (modeChanged && job.status === "local_edit") job.status = "starting";
    this.jobs.set(spec.conversation_id, job);
    this.save();
    if (!existing) await this.setStatus(job, "starting", {});
    else if (modeChanged) await this.deps.report(spec.conversation_id, { status: job.status, path: job.dir, mode: spec.mode ?? "two_way" });
    this.ensureTimer();
    return job;
  }

  async stop(conversationId: string, reason?: string): Promise<void> {
    this.jobs.delete(conversationId);
    this.save();
    // Always: the web shows "stopping" until it hears this, whether or not a job was running here.
    await this.deps.report(conversationId, { status: "off" });
    if (reason) this.deps.log(`[MIRROR] ${conversationId.slice(0, 7)} stopped: ${reason}`);
    if (!this.jobs.size && this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Watch-only's "overwrite with the host's": park the edits made here under a backup ref, then let the host's land over them. */
  private async overwrite(job: Job): Promise<void> {
    if (!job.dir) return;
    const snap = await createWipSnapshot(job.dir);
    if (snap) await execFileAsync("git", ["-C", job.dir, "update-ref", `refs/codecast/backup/mirror-${this.now()}`, snap.sha]);
    job.state.base = (await runSide<SnapshotResult>({ op: "snapshot", cwd: job.dir, scope: this.scope(job) })).tree;
    job.status = "starting";
    this.save();
  }

  private scope(job: Job): SyncScope | undefined { return this.deps.scopeFor?.(job.spec); }

  private hostSide(job: Job): HostSide | null {
    const host = this.deps.hostFor(job.spec.host_device_id);
    if (!host) return null;
    return (this.deps.hostSide ?? ((spec, h, dir, scope) => sshHostSide(h, spec.remote_cwd, spec.conversation_id, dir, scope, this.deps.log)))(job.spec, host, job.dir!, this.scope(job));
  }

  /** A person's pick for files changed on both sides. */
  private async resolve(job: Job, r: MirrorResolve): Promise<void> {
    const host = this.hostSide(job);
    if (!host) throw new Error("this laptop does not manage that cloud host (cast hosts ls)");
    await this.serialized(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const out = await resolveConflicts(job.dir!, job.state, host, r.keep, r.paths, this.scope(job));
        if ("resolved" in out) break;
      }
      this.save();
      job.activeAt = this.now();
      job.nextTickAt = 0;
      await this.tick(job, this.now());
    });
  }

  /** Jobs that were running when the daemon last stopped, with the state they had agreed on. */
  async resumeAll(): Promise<void> {
    let saved: Array<SavedJob | MirrorJobSpec> = [];
    try { saved = JSON.parse(fs.readFileSync(this.deps.jobsFile, "utf-8")); } catch { return; }
    for (const row of saved) {
      const { spec, state } = "spec" in row ? row : { spec: row, state: undefined };
      try { await this.start(spec, state); } catch (err) { await this.stop(spec.conversation_id, `could not resume: ${String(err)}`); }
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.deps.jobsFile), { recursive: true });
    const rows: SavedJob[] = [...this.jobs.values()].map((j) => ({ spec: j.spec, state: j.state }));
    const tmp = `${this.deps.jobsFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rows, null, 2));
    fs.renameSync(tmp, this.deps.jobsFile);
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.pass(); }, 1_000);
    (this.timer as any).unref?.();
  }

  private skippedReport(job: Job): Pick<MirrorReport, "skipped" | "skipped_count"> | null {
    const skipped: SyncSkipped[] = [
      ...job.hostSkipped.slice(0, SKIPPED_REPORTED).map((s) => ({ ...s, side: "cloud" as const })),
      ...job.laptopSkipped.slice(0, SKIPPED_REPORTED).map((s) => ({ ...s, side: "laptop" as const })),
    ];
    const key = JSON.stringify(skipped);
    if (key === job.skippedKey) return null;
    job.skippedKey = key;
    return { skipped, skipped_count: job.hostSkipped.length + job.laptopSkipped.length };
  }

  private async setStatus(job: Job, status: LocalMirrorStatus, extra: Omit<MirrorReport, "status">): Promise<void> {
    const skipped = this.skippedReport(job);
    const changed = job.status !== status || extra.last_landed_at !== undefined || extra.error !== job.error || !!skipped || extra.conflicts !== undefined;
    job.status = status;
    job.error = extra.error;
    if (changed || status === "starting") await this.deps.report(job.spec.conversation_id, { status, path: job.dir, mode: job.spec.mode ?? "two_way", ...extra, ...(skipped ?? {}) });
  }

  /** One pass at a time: a caller that finds one running waits for it, then runs its own. */
  private async serialized<T>(fn: () => Promise<T>): Promise<T> {
    while (this.running) await this.running;
    const run = fn();
    this.running = run.then(() => undefined, () => undefined).finally(() => { this.running = null; });
    return run;
  }

  /** One pass over every job: the Convex activity poll when due, then a tick for each job whose time has come. */
  async pass(): Promise<void> {
    return this.serialized(() => this.passOnce());
  }

  private async passOnce(): Promise<void> {
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
          job.hostOnline = row.host_online !== false;
        }
      }
    }
    for (const job of [...this.jobs.values()]) {
      if (job.status === "local_edit" || now < job.nextTickAt) continue;
      if (now - job.activeAt > MIRROR_ACTIVE_WINDOW_MS && job.status !== "starting") {
        if (!(await this.laptopMoved(job, now))) {
          if (job.status !== "paused" && job.status !== "conflict") await this.setStatus(job, "paused", {});
          continue;
        }
      }
      await this.tick(job, now);
    }
  }

  /**
   * While the session idles: did the laptop copy change, with the host awake
   * to take it? Reads only the laptop, so a quiet pair costs the host nothing.
   */
  private async laptopMoved(job: Job, now: number): Promise<boolean> {
    if ((job.spec.mode ?? "two_way") !== "two_way" || !job.hostOnline || !job.state.base || now < job.laptopCheckAt) return false;
    job.laptopCheckAt = now + MIRROR_LAPTOP_CHECK_MS;
    try {
      const tree = (await runSide<SnapshotResult>({ op: "snapshot", cwd: job.dir!, scope: this.scope(job) })).tree;
      return tree !== job.state.base;
    } catch { return false; }
  }

  /** Tick one session now (an agent's `cast sync pull` or `push`), whatever its activity. */
  async syncNow(conversationId: string): Promise<TickResult> {
    const job = this.jobs.get(conversationId);
    if (!job) throw new Error("no sync is running for that session");
    return this.serialized(async () => {
      job.activeAt = this.now();
      let r = await this.tick(job, this.now());
      for (let i = 0; i < 3 && r?.kind === "retry"; i++) r = await this.tick(job, this.now());
      return r ?? { kind: "idle" };
    });
  }

  /** What status shows for a session: its job's state, or nothing. */
  describe(conversationId: string): { dir: string; mode: LocalMirrorMode; status: LocalMirrorStatus; conflicts: string[]; hostSkipped: Skipped[]; laptopSkipped: Skipped[]; lastLandedAt?: number; spec: MirrorJobSpec } | null {
    const job = this.jobs.get(conversationId);
    if (!job?.dir) return null;
    return { dir: job.dir, mode: job.spec.mode ?? "two_way", status: job.status, conflicts: job.state.conflicts ?? [], hostSkipped: job.hostSkipped, laptopSkipped: job.laptopSkipped, lastLandedAt: job.lastLandedAt, spec: job.spec };
  }

  private async tick(job: Job, now: number): Promise<TickResult | null> {
    const host = this.hostSide(job);
    if (!host) { await this.setStatus(job, "error", { error: "this laptop does not manage that cloud host (cast hosts ls)" }); job.nextTickAt = now + MIRROR_ERROR_BACKOFF_MS; return null; }
    try {
      const r = await syncTick(job.dir!, job.state, host, {
        mode: job.spec.mode, scope: this.scope(job), name: job.spec.conversation_id,
        onHost: (s) => { job.hostSkipped = s.skipped; },
        onLaptop: (s) => { job.laptopSkipped = s.skipped; },
      });
      job.nextTickAt = now + (r.kind === "retry" ? MIRROR_RETRY_MS : MIRROR_TICK_MS);
      if (r.kind === "synced" || r.kind === "conflict") {
        job.activeAt = now;
        job.lastLandedAt = now;
        this.save();
        const counts = { last_landed_at: now, changed: r.toLaptop.length + r.toHost.length, to_laptop: r.toLaptop.length, to_host: r.toHost.length };
        if (r.kind === "conflict") await this.setStatus(job, "conflict", { ...counts, conflicts: r.paths });
        else await this.setStatus(job, "live", { ...counts, conflicts: [] });
      } else if (r.kind === "local_edit") {
        await this.setStatus(job, "local_edit", { files: r.files });
      } else if (r.kind === "idle") {
        const want = job.state.conflicts?.length ? "conflict" : "live";
        if (job.status !== want) await this.setStatus(job, want, want === "conflict" ? { conflicts: job.state.conflicts } : {});
        else await this.setStatus(job, want, {}); // carries a skipped list that changed, and nothing otherwise
      }
      return r;
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 300);
      job.nextTickAt = now + MIRROR_ERROR_BACKOFF_MS;
      if (job.error !== msg) this.deps.log(`[MIRROR] ${job.spec.conversation_id.slice(0, 7)}: ${msg}`);
      await this.setStatus(job, "error", { error: msg });
      return null;
    }
  }
}
