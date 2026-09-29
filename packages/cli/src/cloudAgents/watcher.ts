/**
 * The mirror watcher every cloud agent provider shares. A cloud agent runs on
 * the vendor's machines, so no transcript lands on this machine: the watcher
 * polls the provider's list, mirrors each agent that moved into a transcript
 * file under ~/.codecast/<adapter dir>/<agent id>/ (transcript.ts), and emits
 * a transcript event for it. The daemon syncs every provider's mirror the
 * same way: the delta transcript pipeline (per-record sync, stub binding,
 * status from turn_ended) with a mirror ingest job, under the provider's
 * agent type. The file is rewritten whole on each change.
 *
 * Per agent it keeps: the version it was last mirrored at with nothing
 * running (state.json), the adapter's own record (events.json), meta.json
 * (cwd, title, url) and an optional notice.txt codecast adds under the first
 * prompt.
 */
import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import { isCloudAgentId } from "@codecast/shared/contracts";
import { atomicWriteFile } from "../atomicWrite.js";
import { githubRepo } from "../cloud/gitOrigin.js";
import { codecastPath } from "../codecastDir.js";
import { CLOUD_BACKFILL_MS, CLOUD_MAX_LIST_PAGES, cloudMirrorPlacement, PollCadence, repoOwnerName } from "./poll.js";
import { CloudApiError } from "./http.js";
import { setupErrorOf } from "./sessions.js";
import { mirrorMetaJson, readMetaJson } from "./transcript.js";
import { CloudAgentSetupError, errorText, logTag, type AnyCloudAgentAdapter, type CloudAgentGit, type CloudAgentHandle, type CloudAgentListItem, type CloudAgentMirror } from "./types.js";

/** How long polls stay fast after codecast starts an agent or sends it a message. */
const MOVED_FAST_MS = 10 * 60_000;
/** An agent whose mirror failed waits this long before the next try, doubling up to FAILED_MAX_MS: each try is an API call. */
const FAILED_BASE_MS = 60_000;
const FAILED_MAX_MS = 60 * 60_000;
/**
 * A running agent not mirrored for this long (five fast polls, at least three
 * minutes) is one this machine can no longer follow: signed out, gone, or
 * unreachable. Its session is let go rather than kept "working" by this
 * machine's heartbeat, and hosted again when a mirror reaches it.
 */
const UNFOLLOWED_POLLS = 5;
const UNFOLLOWED_MIN_MS = 3 * 60_000;

/** What the watcher emits for a mirrored transcript (the transcript watchers' event shape). */
export interface CloudAgentTranscriptEvent {
  sessionId: string;
  filePath: string;
  eventType: "add" | "change";
}

export interface CloudAgentWatcherOptions {
  /** Overrides the adapter's cadence (tests). */
  pollMs?: number;
  fastPollMs?: number;
  rootDir?: string;
  /** Import every agent on the account (the account's sync setting). Off,
   *  only the agents codecast started (and their children) are mirrored. */
  importAll?: () => boolean;
  /** Whether codecast started this agent. */
  isOwnAgent?: (agentId: string) => boolean;
  /** Whether codecast started any agent: with importAll off and none, a pass reads nothing and is skipped. */
  hasOwnAgents?: () => boolean;
  resolveRepoDir?: (repo: { owner: string; name: string }) => Promise<string | null>;
  now?: () => number;
  log?: (msg: string) => void;
}

interface AgentState {
  /** The agent's version (CloudAgentListItem.version) when it was last mirrored with nothing running. */
  updatedAt?: string;
  /** A child agent's parent, and what the parent called it. */
  parent?: string;
  description?: string;
  /** The branch it last pushed: announced again at start, since a settled agent is not mirrored again. */
  git?: CloudAgentGit;
  /** Running when last mirrored: mirrored by id until it settles, even once the list stops showing it. */
  running?: boolean;
}

export declare interface CloudAgentWatcher {
  on(event: "session", listener: (e: CloudAgentTranscriptEvent) => void): this;
  on(event: "git", listener: (g: CloudAgentGit) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "ready", listener: () => void): this;
  /** A running agent this machine can no longer follow (see UNFOLLOWED_POLLS): its session is let go. */
  on(event: "unfollowed", listener: (agentId: string) => void): this;
}

export class CloudAgentWatcher<Adapter extends AnyCloudAgentAdapter = AnyCloudAgentAdapter> extends EventEmitter {
  /** Fast while an agent runs or a reply to codecast is due, slow otherwise (the adapter's hints). */
  private readonly cadence: PollCadence;
  private inFlight = false;
  readonly rootDir: string;
  private readonly statePath: string;
  private readonly importAll: () => boolean;
  private readonly isOwnAgent: (agentId: string) => boolean;
  private readonly hasOwnAgents: () => boolean;
  private readonly resolveRepoDir: (repo: { owner: string; name: string }) => Promise<string | null>;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private state: { format?: number; agents: Record<string, AgentState> };
  private readonly data = new Map<string, unknown>();
  private readonly handles = new Map<string, CloudAgentHandle<unknown>>();
  private readonly renderTimers = new Map<string, NodeJS.Timeout>();
  private readonly mirroring = new Map<string, Promise<void>>();
  private readonly files = new RebuildableFiles();
  /** The setup problem polls were last skipped for, so it is logged once. */
  private skipped: string | undefined;
  /** Agents whose last mirror failed: how often in a row, and when the next try is due. */
  private readonly failing = new Map<string, { count: number; retryAt: number }>();
  /** Running agents, and when a mirror last reached each. */
  private readonly followed = new Map<string, number>();
  private readonly unfollowedAfterMs: number;
  /**
   * Agents whose next mirror is announced even when it changed nothing: ones
   * let go (hosted again), and after a format change every one on disk (each
   * is re-rendered by id; one that cannot be is announced as it is at the end
   * of the first pass, so its session is still hosted).
   */
  private readonly rehost = new Set<string>();
  private readonly staleOnDisk = new Set<string>();
  /**
   * What keeps this machine from reading the provider: found on the machine
   * (client(): no sign-in, run out), else in the provider's answer to the last
   * list (refused, turned off for the account).
   */
  private localSetup: CloudAgentSetupError | null = null;
  private remoteSetup: CloudAgentSetupError | null = null;

  constructor(readonly adapter: Adapter, opts: CloudAgentWatcherOptions = {}) {
    super();
    this.rootDir = opts.rootDir ?? codecastPath(adapter.spec.mirrorDir);
    this.statePath = path.join(this.rootDir, "state.json");
    this.importAll = opts.importAll ?? (() => true);
    this.isOwnAgent = opts.isOwnAgent ?? (() => false);
    this.hasOwnAgents = opts.hasOwnAgents ?? (() => true);
    this.resolveRepoDir = opts.resolveRepoDir ?? (async () => null);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.state = { format: adapter.mirrorFormat, agents: {} };
    const pollMs = opts.pollMs ?? adapter.pollMs ?? 30_000;
    const fastPollMs = opts.fastPollMs ?? adapter.fastPollMs ?? pollMs;
    this.unfollowedAfterMs = Math.max(UNFOLLOWED_POLLS * fastPollMs, UNFOLLOWED_MIN_MS);
    this.cadence = new PollCadence(() => this.poll(), { pollMs, fastPollMs, now: this.now });
  }

  /** What keeps this machine from reading the provider (no sign-in, expired, turned off for the account), or null. */
  get setupProblem(): CloudAgentSetupError | null {
    return this.localSetup ?? this.remoteSetup;
  }

  /** The provider's own verdict, from a list call or a sign-in check (null: it answered). */
  setRemoteSetup(problem: CloudAgentSetupError | null): void {
    this.remoteSetup = problem;
  }

  /** An API client from this machine's credentials, or null (logged once) while a setup problem stands in the way. */
  private client(): Exclude<ReturnType<Adapter["client"]>, CloudAgentSetupError> | null {
    const client = this.adapter.client();
    this.localSetup = client instanceof CloudAgentSetupError ? client : null;
    if (client instanceof CloudAgentSetupError) {
      if (this.skipped !== client.message) this.log(`${logTag(this.adapter)} not polling: ${client.message}`);
      this.skipped = client.message;
      return null;
    }
    if (this.skipped) this.log(`${logTag(this.adapter)} credentials found, polling`);
    this.skipped = undefined;
    return client;
  }

  transcriptPath(agentId: string): string {
    return path.join(this.rootDir, agentId, `${agentId}.jsonl`);
  }

  start(): void {
    if (this.cadence.running) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, "utf-8"));
      if (parsed?.agents) this.state = parsed;
    } catch {}
    // Rendered by an older format: forget which agents are settled so each
    // re-renders, and announce each once re-rendered rather than as it stands
    // (a row's timestamp is set once).
    const staleFormat = this.state.format !== this.adapter.mirrorFormat;
    if (staleFormat) {
      for (const st of Object.values(this.state.agents)) delete st.updatedAt;
      this.state.format = this.adapter.mirrorFormat;
    }
    this.log(`${logTag(this.adapter)} watching (${Object.keys(this.state.agents).length} known agents)`);
    this.emit("ready");
    // The priming pass every transcript watcher makes: announce what is on
    // disk, since a file written just before a restart may never have synced
    // (the sync pipeline skips what it already has).
    for (const agentId of fs.existsSync(this.rootDir) ? fs.readdirSync(this.rootDir) : []) {
      if (!isCloudAgentId(this.adapter.spec, agentId) || !fs.existsSync(this.transcriptPath(agentId))) continue;
      if (staleFormat) this.staleOnDisk.add(agentId);
      else this.announce(agentId, "add");
    }
    for (const [id, st] of Object.entries(this.state.agents)) {
      if (st.git) this.emit("git", st.git);
      if (st.running) this.followed.set(id, this.now());
    }
    this.cadence.start();
  }

  stop(): void {
    this.cadence.stop();
    this.adapter.stop?.();
    for (const t of this.renderTimers.values()) clearTimeout(t);
    this.renderTimers.clear();
  }

  /** One pass: list agents, mirror the ones that moved. Never throws. */
  async poll(): Promise<void> {
    if (this.inFlight) return;
    this.letGoUnfollowed();
    const running = Object.values(this.state.agents).some((st) => st.running);
    // Nothing to import, nothing of codecast's to follow and nothing left to
    // settle or re-render: not even a list call.
    if (!this.importAll() && !this.hasOwnAgents() && !running && !this.staleOnDisk.size) {
      this.cadence.busy = false;
      // Still read the sign-in on disk (no call to the provider), so a machine
      // that signs in stops reporting it has none. A refusal the provider gave
      // is asked again with one list call per idle poll: nothing else would
      // learn that a new key, a new sign-in or an admin lifted it.
      const client = this.client();
      if (client && this.remoteSetup) {
        this.inFlight = true;
        try { await this.listPage(client); } catch (err) { this.emitError(err); } finally { this.inFlight = false; }
      }
      return;
    }
    const client = this.client();
    if (!client) { this.announceStale(); return; }
    this.inFlight = true;
    try {
      const horizon = this.now() - CLOUD_BACKFILL_MS;
      let cursor: string | undefined;
      let busy = false;
      const listed = new Set<string>();
      for (let page = 0; page < CLOUD_MAX_LIST_PAGES; page++) {
        const data = await this.listPage(client, cursor);
        let reachedHorizon = false;
        for (const item of data.items ?? []) {
          if (item.updatedAtMs < horizon) { reachedHorizon = true; continue; }
          if (!this.importAll() && !this.isOwnAgent(item.id)) continue;
          listed.add(item.id);
          if (item.active) busy = true;
          if (this.state.agents[item.id]?.updatedAt === item.version && !item.active) continue;
          await this.mirrorInPass(item.id, item.agent);
        }
        if (reachedHorizon || !data.nextCursor) break;
        cursor = data.nextCursor;
      }
      // Mirrored by id: children (the list does not show them; found through
      // their parent), an agent last seen running that the list no longer
      // shows (archived, past the pages read, its source turned off: it still
      // has to settle), and a mirror from an older format.
      const byId = new Set([...Object.keys(this.state.agents), ...this.staleOnDisk]);
      for (const id of byId) {
        if (listed.has(id)) continue;
        const st = this.state.agents[id];
        if (!(st?.parent && !st.updatedAt) && !st?.running && !this.staleOnDisk.has(id)) continue;
        await this.mirrorInPass(id);
        if (this.state.agents[id]?.running && !this.failing.has(id)) busy = true;
      }
      this.cadence.busy = busy;
    } catch (err) {
      this.emitError(err);
    } finally {
      this.inFlight = false;
      this.announceStale();
    }
  }

  /** One page of the provider's list; its answer is the provider's verdict on this machine's credentials. */
  private async listPage(client: NonNullable<ReturnType<CloudAgentWatcher<Adapter>["client"]>>, cursor?: string): Promise<{ items: CloudAgentListItem<unknown>[]; nextCursor?: string }> {
    try {
      const data = await this.adapter.listAgents(client, cursor);
      this.setRemoteSetup(null);
      return data;
    } catch (err) {
      const setup = setupErrorOf(this.adapter, err);
      if (setup) this.setRemoteSetup(setup);
      throw err;
    }
  }

  /** Let go of running agents no mirror has reached for too long (UNFOLLOWED_POLLS). */
  private letGoUnfollowed(): void {
    for (const [id, at] of this.followed) {
      if (this.now() - at <= this.unfollowedAfterMs) continue;
      this.followed.delete(id);
      this.rehost.add(id);
      this.log(`${logTag(this.adapter)} ${id} not reached for ${Math.round((this.now() - at) / 60_000)}m: letting its session go until it is`);
      this.emit("unfollowed", id);
    }
  }

  /** Mirrors from an older format a pass could not re-render: announced as they are, so their sessions are still hosted. */
  private announceStale(): void {
    for (const id of this.staleOnDisk) {
      this.staleOnDisk.delete(id);
      if (fs.existsSync(this.transcriptPath(id))) this.announce(id, "add");
    }
  }

  private announce(agentId: string, eventType: "add" | "change"): void {
    this.emit("session", { sessionId: agentId, filePath: this.transcriptPath(agentId), eventType });
  }

  /**
   * One agent's mirror inside a pass: its failure is reported and backed off,
   * and never keeps the agents listed after it from syncing.
   */
  private async mirrorInPass(agentId: string, known?: unknown): Promise<void> {
    const failed = this.failing.get(agentId);
    if (failed && this.now() < failed.retryAt) return;
    try {
      await this.mirror(agentId, known);
    } catch (err) {
      const st = this.state.agents[agentId];
      if (err instanceof CloudApiError && err.status === 404 && st?.running) {
        // Deleted while it ran: nothing is left to settle it by.
        delete st.running;
        this.followed.delete(agentId);
        this.emit("unfollowed", agentId);
        void this.saveState();
      }
      const count = (failed?.count ?? 0) + 1;
      this.failing.set(agentId, { count, retryAt: this.now() + Math.min(FAILED_BASE_MS * 2 ** (count - 1), FAILED_MAX_MS) });
      this.emitError(new Error(`${agentId}: ${errorText(err)}`));
    }
  }

  /** Poll fast for a while, starting with the next pass: the account just turned sync on, or the machine just signed in. */
  hurry(): void {
    this.cadence.hurry(MOVED_FAST_MS);
  }

  /** Mirror one agent now, after codecast created it or sent it a message; polls stay fast while its reply is due. */
  follow(agentId: string): Promise<void> {
    this.cadence.hurry(MOVED_FAST_MS);
    return this.mirrorNow(agentId);
  }

  private mirrorNow(agentId: string): Promise<void> {
    return this.mirror(agentId).catch((err) => this.emitError(err));
  }

  private emitError(err: unknown): void {
    this.emit("error", err instanceof Error ? err : new Error(String(err)));
  }

  private mirror(agentId: string, known?: unknown): Promise<void> {
    // One mirror per agent at a time; a request during one waits for it and runs after.
    const prior = this.mirroring.get(agentId) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(() => this.mirrorOnce(agentId, known));
    this.mirroring.set(agentId, next);
    return next.finally(() => { if (this.mirroring.get(agentId) === next) this.mirroring.delete(agentId); });
  }

  private async mirrorOnce(agentId: string, known?: unknown): Promise<void> {
    const client = this.client();
    if (!client) return;
    const result = await this.adapter.mirror(client, this.handle(agentId), known);
    if (!result) return;
    if (result.transcript) await this.write(agentId, result);
    const git = result.git && JSON.stringify(result.git) !== JSON.stringify(this.state.agents[agentId]?.git) ? result.git : undefined;
    if (git) this.emit("git", git);
    for (const child of result.children ?? []) {
      if (this.state.agents[child.agentId]?.parent) continue;
      this.state.agents[child.agentId] = { parent: agentId, description: child.description };
      void this.mirrorNow(child.agentId);
    }
    // The git the agent reports now: a branch it no longer names is not announced again at start.
    const { git: _prior, running: _wasRunning, ...st } = this.state.agents[agentId] ?? {};
    this.state.agents[agentId] = {
      ...st,
      updatedAt: result.running ? undefined : result.version,
      ...(result.running ? { running: true } : {}),
      ...(result.git ? { git: result.git } : result.git === undefined && _prior ? { git: _prior } : {}),
    };
    if (result.running) this.followed.set(agentId, this.now());
    else this.followed.delete(agentId);
    this.failing.delete(agentId);
    await Promise.all([this.saveState(), this.files.flushed(this.dataPath(agentId))]);
  }

  private async write(agentId: string, result: CloudAgentMirror): Promise<void> {
    const file = this.transcriptPath(agentId);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const st = this.state.agents[agentId];
    const cwd = await cloudMirrorPlacement(this.adapter.spec.mirrorDir, repoOwnerName(result.repo ?? githubRepo(result.repoUrl)), this.resolveRepoDir);
    const dir = path.dirname(file);
    const meta = mirrorMetaJson({ cwd, title: result.title, url: result.url, createdAtMs: result.createdAtMs, parentAgentId: st?.parent, description: st?.description }, await readMetaJson(dir), result.placeholderTitles);
    const metaPath = path.join(dir, "meta.json");
    const metaChanged = (await fs.promises.readFile(metaPath, "utf8").catch(() => "")) !== meta;
    if (metaChanged) await this.files.write(metaPath, meta);
    const existed = fs.existsSync(file);
    const transcriptChanged = !existed || (await fs.promises.readFile(file, "utf8").catch(() => "")) !== result.transcript;
    // A new title alone is news too: the session takes it. So is a mirror
    // owed an announcement (let go, or re-rendered after a format change).
    const owed = [this.staleOnDisk.delete(agentId), this.rehost.delete(agentId)].some(Boolean);
    if (!transcriptChanged && !metaChanged && !owed) return;
    if (transcriptChanged) await fs.promises.writeFile(file, result.transcript);
    this.announce(agentId, existed ? "change" : "add");
  }

  private scheduleRender(agentId: string): void {
    if (this.renderTimers.has(agentId)) return;
    this.renderTimers.set(agentId, setTimeout(() => {
      this.renderTimers.delete(agentId);
      void this.mirrorNow(agentId);
    }, 750));
  }

  private handle(agentId: string): CloudAgentHandle<unknown> {
    let h = this.handles.get(agentId);
    if (!h) {
      h = {
        agentId,
        data: () => this.agentData(agentId),
        save: () => this.saveData(agentId),
        notice: () => fs.promises.readFile(this.noticePath(agentId), "utf8").catch(() => undefined),
        scheduleRender: () => this.scheduleRender(agentId),
        follow: () => this.mirrorNow(agentId),
        log: this.log,
      };
      this.handles.set(agentId, h);
    }
    return h;
  }

  private noticePath(agentId: string): string {
    return path.join(this.rootDir, agentId, "notice.txt");
  }
  /** Record the line the agent's transcript opens with, under its first prompt. */
  setNotice(agentId: string, notice: string): void {
    try { atomicWriteFile(this.noticePath(agentId), notice); } catch {}
  }

  private dataPath(agentId: string): string {
    return path.join(this.rootDir, agentId, "events.json");
  }
  private agentData(agentId: string): unknown {
    if (!this.data.has(agentId)) {
      let raw: unknown;
      try { raw = JSON.parse(fs.readFileSync(this.dataPath(agentId), "utf8")); } catch {}
      this.data.set(agentId, this.adapter.loadData(raw));
    }
    return this.data.get(agentId);
  }
  /** The provider's own retention can be short; the record kept here is what outlives it. Awaited at the end of the pass. */
  private saveData(agentId: string): void {
    void this.files.write(this.dataPath(agentId), JSON.stringify(this.agentData(agentId))).catch((err) => this.log(`${logTag(this.adapter)} could not save ${agentId}: ${errorText(err)}`));
  }

  private saveState(): Promise<void> {
    return this.files.write(this.statePath, JSON.stringify(this.state), 0o600);
  }
}

/**
 * The mirror's per-pass files (state.json, events.json, meta.json). A live
 * agent rewrites them every render (~750ms), so each write is a temp file
 * renamed over the target, off the event loop and without fsync: a reader
 * never sees a torn file, and a write lost to a crash is redone by the next
 * pass. Writes to one path land in order, and a write queued behind another
 * lands only the latest content.
 */
class RebuildableFiles {
  private readonly queued = new Map<string, { content: string; done: Promise<void> }>();
  private readonly writing = new Map<string, Promise<void>>();

  write(file: string, content: string, mode?: number): Promise<void> {
    const queued = this.queued.get(file);
    if (queued) { queued.content = content; return queued.done; }
    const entry = { content, done: Promise.resolve() };
    this.queued.set(file, entry);
    entry.done = this.flushed(file).then(async () => {
      this.queued.delete(file);
      const tmp = `${file}.tmp`;
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(tmp, entry.content, mode === undefined ? undefined : { mode });
      await fs.promises.rename(tmp, file);
    });
    const settled = entry.done.catch(() => {});
    this.writing.set(file, settled);
    void settled.then(() => { if (this.writing.get(file) === settled) this.writing.delete(file); });
    return entry.done;
  }

  /** Resolves once every write queued for the file so far has landed (or failed). */
  flushed(file: string): Promise<void> {
    return this.writing.get(file) ?? Promise.resolve();
  }
}
