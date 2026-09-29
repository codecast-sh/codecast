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
import { mirrorMetaJson } from "./transcript.js";
import { CloudAgentSetupError, errorText, logTag, type AnyCloudAgentAdapter, type CloudAgentGit, type CloudAgentHandle, type CloudAgentMirror } from "./types.js";

/** How long polls stay fast after codecast starts an agent or sends it a message. */
const MOVED_FAST_MS = 10 * 60_000;

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
}

export declare interface CloudAgentWatcher {
  on(event: "session", listener: (e: CloudAgentTranscriptEvent) => void): this;
  on(event: "git", listener: (g: CloudAgentGit) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "ready", listener: () => void): this;
}

export class CloudAgentWatcher<Adapter extends AnyCloudAgentAdapter = AnyCloudAgentAdapter> extends EventEmitter {
  /** Fast while an agent runs or a reply to codecast is due, slow otherwise (the adapter's hints). */
  private readonly cadence: PollCadence;
  private inFlight = false;
  readonly rootDir: string;
  private readonly statePath: string;
  private readonly importAll: () => boolean;
  private readonly isOwnAgent: (agentId: string) => boolean;
  private readonly resolveRepoDir: (repo: { owner: string; name: string }) => Promise<string | null>;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private state: { format?: number; agents: Record<string, AgentState> };
  private readonly data = new Map<string, unknown>();
  private readonly handles = new Map<string, CloudAgentHandle<unknown>>();
  private readonly renderTimers = new Map<string, NodeJS.Timeout>();
  private readonly mirroring = new Map<string, Promise<void>>();
  private readonly lastGit = new Map<string, string>();
  private readonly files = new RebuildableFiles();
  /** The setup problem polls were last skipped for, so it is logged once. */
  private skipped: string | undefined;

  constructor(readonly adapter: Adapter, opts: CloudAgentWatcherOptions = {}) {
    super();
    this.rootDir = opts.rootDir ?? codecastPath(adapter.spec.mirrorDir);
    this.statePath = path.join(this.rootDir, "state.json");
    this.importAll = opts.importAll ?? (() => true);
    this.isOwnAgent = opts.isOwnAgent ?? (() => false);
    this.resolveRepoDir = opts.resolveRepoDir ?? (async () => null);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.state = { format: adapter.mirrorFormat, agents: {} };
    const pollMs = opts.pollMs ?? adapter.pollMs ?? 30_000;
    this.cadence = new PollCadence(() => this.poll(), { pollMs, fastPollMs: opts.fastPollMs ?? adapter.fastPollMs ?? pollMs, now: this.now });
  }

  /** An API client from this machine's credentials, or null (logged once) while a setup problem stands in the way. */
  private client(): Exclude<ReturnType<Adapter["client"]>, CloudAgentSetupError> | null {
    const client = this.adapter.client();
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
    // re-renders, and announce nothing stale (a row's timestamp is set once).
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
    for (const agentId of staleFormat || !fs.existsSync(this.rootDir) ? [] : fs.readdirSync(this.rootDir)) {
      const file = this.transcriptPath(agentId);
      if (isCloudAgentId(this.adapter.spec, agentId) && fs.existsSync(file)) this.emit("session", { sessionId: agentId, filePath: file, eventType: "add" });
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
    const client = this.client();
    if (!client) return;
    this.inFlight = true;
    try {
      const horizon = this.now() - CLOUD_BACKFILL_MS;
      let cursor: string | undefined;
      let busy = false;
      for (let page = 0; page < CLOUD_MAX_LIST_PAGES; page++) {
        const data = await this.adapter.listAgents(client, cursor);
        let reachedHorizon = false;
        for (const item of data.items ?? []) {
          if (item.updatedAtMs < horizon) { reachedHorizon = true; continue; }
          if (!this.importAll() && !this.isOwnAgent(item.id)) continue;
          if (item.active) busy = true;
          if (this.state.agents[item.id]?.updatedAt === item.version && !item.active) continue;
          await this.mirror(item.id, item.agent);
        }
        if (reachedHorizon || !data.nextCursor) break;
        cursor = data.nextCursor;
      }
      this.cadence.busy = busy;
      // Children are not listed; they are found through their parent and revisited here.
      for (const [id, st] of Object.entries(this.state.agents)) {
        if (!st.parent || st.updatedAt) continue;
        await this.mirror(id);
      }
    } catch (err) {
      this.emitError(err);
    } finally {
      this.inFlight = false;
    }
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
    if (result.git && JSON.stringify(result.git) !== this.lastGit.get(agentId)) {
      this.lastGit.set(agentId, JSON.stringify(result.git));
      this.emit("git", result.git);
    }
    for (const child of result.children ?? []) {
      if (this.state.agents[child.agentId]?.parent) continue;
      this.state.agents[child.agentId] = { parent: agentId, description: child.description };
      void this.mirrorNow(child.agentId);
    }
    this.state.agents[agentId] = { ...this.state.agents[agentId], updatedAt: result.running ? undefined : result.version };
    await Promise.all([this.saveState(), this.files.flushed(this.dataPath(agentId))]);
  }

  private async write(agentId: string, result: CloudAgentMirror): Promise<void> {
    const file = this.transcriptPath(agentId);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const st = this.state.agents[agentId];
    const cwd = await cloudMirrorPlacement(this.adapter.spec.mirrorDir, repoOwnerName(result.repo ?? githubRepo(result.repoUrl)), this.resolveRepoDir);
    const meta = mirrorMetaJson({ cwd, title: result.title, url: result.url, createdAtMs: result.createdAtMs, parentAgentId: st?.parent, description: st?.description });
    const metaPath = path.join(path.dirname(file), "meta.json");
    if ((await fs.promises.readFile(metaPath, "utf8").catch(() => "")) !== meta) await this.files.write(metaPath, meta);
    const existed = fs.existsSync(file);
    if (existed && (await fs.promises.readFile(file, "utf8").catch(() => "")) === result.transcript) return;
    await fs.promises.writeFile(file, result.transcript);
    this.emit("session", { sessionId: agentId, filePath: file, eventType: existed ? "change" : "add" });
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
