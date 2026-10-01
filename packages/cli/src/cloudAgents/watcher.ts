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
import { CLOUD_BACKFILL_MS, CLOUD_MAX_LIST_PAGES, cloudMirrorPlacement, doublingDelay, PollCadence, repoOwnerName } from "./poll.js";
import { cloudApiVerdict } from "./http.js";
import { cloudSetupErrorOf, type CloudAgentSession } from "./sessions.js";
import { mirrorMetaJson, readMetaJson } from "./transcript.js";
import { CloudAgentSetupError, errorText, logTag, type AnyCloudAgentAdapter, type CloudAgentGit, type CloudAgentHandle, type CloudAgentListItem, type CloudAgentMirror } from "./types.js";

/** One page of a provider's list, as the watcher reads it. */
type CloudAgentListPage = { items: CloudAgentListItem<unknown>[]; nextCursor?: string };

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
/**
 * Answers in a row the provider should never give codecast's reads
 * (cloudApiVerdict "unexpected"), with no read answered as expected between
 * them: the API changed, and the lane pauses as for a payload of the wrong
 * shape. An agent already failing on its own does not add to the run: its
 * answer is known to be its own.
 */
const UNEXPECTED_TO_PAUSE = 3;

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
  /** The agents codecast started: with importAll off, the only ones listed (none: a pass reads nothing and is skipped). */
  ownAgents?: () => ReadonlySet<string>;
  /** This machine's checkout of the repository an agent works on (where its session is placed), or null. */
  resolveRepoDir?: (repo: { owner: string; name: string }, agentId?: string) => Promise<string | null>;
  now?: () => number;
  /** `warn` for what someone should see in the server's logs: the lane paused or limited, and why. */
  log?: (msg: string, level?: "info" | "warn") => void;
}

interface AgentState {
  /** The agent's version (CloudAgentListItem.version) when it was last mirrored with nothing running. */
  updatedAt?: string;
  /** A child agent's parent, and what the parent called it. */
  parent?: string;
  description?: string;
  /** A branch's fork point: the record in the parent's transcript it forks at. */
  forkAt?: string;
  /** The branch it last pushed, or null for none: announced again at start, since a settled agent is not mirrored again. Absent while unknown. */
  git?: CloudAgentGit | null;
  /** Running when last mirrored: mirrored by id until it settles, even once the list stops showing it. */
  running?: boolean;
  /** Deleted on the provider (a read of it answered 404): its mirror stays as it is, and it is never read by id again. */
  gone?: boolean;
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
  private readonly ownAgents: () => ReadonlySet<string>;
  private readonly resolveRepoDir: (repo: { owner: string; name: string }, agentId?: string) => Promise<string | null>;
  private readonly now: () => number;
  private readonly log: (msg: string, level?: "info" | "warn") => void;
  private state: { format?: number; agents: Record<string, AgentState> };
  private readonly data = new Map<string, unknown>();
  private readonly handles = new Map<string, CloudAgentHandle<unknown>>();
  private readonly renderTimers = new Map<string, NodeJS.Timeout>();
  private readonly mirroring = new Map<string, Promise<void>>();
  private readonly files = new RebuildableFiles();
  /** The setup problem polls were last skipped for, so it is logged once. */
  private skipped: string | undefined;
  /**
   * Agents whose last mirror failed: how often in a row, and when the next
   * try is due. `own`: its answers broke while other agents read as expected
   * (probe()), so its breaks no longer pause the lane.
   */
  private readonly failing = new Map<string, { count: number; retryAt: number; own?: boolean }>();
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
   * (client(): no sign-in, run out), else in the provider's answers (refused,
   * turned off for the account, changed, limited). While the provider's
   * stands, the lane is paused: a pass only checks again (`probeAt`: when; the
   * agent whose read broke, when one did), and the first check answered as
   * expected resumes it.
   */
  private localSetup: CloudAgentSetupError | null = null;
  private remote: { problem: CloudAgentSetupError; probeAt: number; agentId?: string; tries: number } | null = null;
  /**
   * A limit a send or an action met (its kind pauses only on a read): sends
   * wait, reads go on, and the machine reports it until it lapses (`until`)
   * or a message goes out (sent()).
   */
  private sendHold: { problem: CloudAgentSetupError; until: number } | null = null;
  /** Unexpected answers in a row (UNEXPECTED_TO_PAUSE). */
  private unexpected = 0;

  constructor(readonly adapter: Adapter, opts: CloudAgentWatcherOptions = {}) {
    super();
    this.rootDir = opts.rootDir ?? codecastPath(adapter.spec.mirrorDir);
    this.statePath = path.join(this.rootDir, "state.json");
    this.importAll = opts.importAll ?? (() => true);
    this.ownAgents = opts.ownAgents ?? (() => new Set());
    this.resolveRepoDir = opts.resolveRepoDir ?? (async () => null);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.state = { format: adapter.mirrorFormat, agents: {} };
    const pollMs = opts.pollMs ?? adapter.pollMs ?? 30_000;
    const fastPollMs = opts.fastPollMs ?? adapter.fastPollMs ?? pollMs;
    this.unfollowedAfterMs = Math.max(UNFOLLOWED_POLLS * fastPollMs, UNFOLLOWED_MIN_MS);
    this.cadence = new PollCadence(() => this.poll(), { pollMs, fastPollMs, now: this.now });
  }

  /** What keeps this machine from reading or sending to the provider (no sign-in, expired, turned off for the account, a limit), or null. */
  get setupProblem(): CloudAgentSetupError | null {
    const held = this.sendHold && this.now() < this.sendHold.until ? this.sendHold.problem : null;
    return this.localSetup ?? this.remote?.problem ?? held;
  }

  /** A message went out: a limit an earlier send met has lifted. */
  sent(): void {
    this.sendHold = null;
  }

  /**
   * The provider's own verdict on the lane (null: it answered as expected,
   * and the lane runs). `agentId`: the agent whose read broke, checked again
   * before the lane resumes; a verdict of the same kind that names none (a
   * send's) keeps the one already named. The check waits as its kind says
   * (CLOUD_AGENT_SETUP_POLICY's `lane`).
   */
  setRemoteSetup(problem: CloudAgentSetupError | null, agentId?: string): void {
    const prior = this.remote;
    if (!problem) {
      this.remote = null;
      this.unexpected = 0;
      if (prior) this.log(`${logTag(this.adapter)} ${this.adapter.spec.label} answers again: syncing resumed`);
      return;
    }
    const again = prior?.problem.kind === problem.kind ? prior : null;
    const tries = again ? again.tries + 1 : 0;
    this.remote = { problem, agentId: agentId ?? again?.agentId, tries, probeAt: this.now() + problem.policy.lane(problem, tries) };
    if (prior?.problem.message !== problem.message) this.log(`${logTag(this.adapter)} paused: ${problem.message}${problem.detail ? ` (${problem.detail})` : ""}`, "warn");
  }

  /**
   * A failed call's verdict (cloudSetupErrorOf), the one rule for the
   * mirror's reads, sends and the header's actions: returned for the
   * caller's card. Whether it pauses the lane is its kind's (pausesLane); a
   * limit met by a send or an action holds sends only (sendHold). A read
   * (`read`) whose answer no rule names adds to the run of unexpected
   * answers (UNEXPECTED_TO_PAUSE).
   */
  async report(client: unknown, err: unknown, from: { agentId?: string; session?: CloudAgentSession; read?: boolean } = {}): Promise<CloudAgentSetupError | null> {
    const problem = await cloudSetupErrorOf(this.adapter, client, err, from.session);
    if (problem) {
      if (this.pausesLane(problem, err, from)) this.setRemoteSetup(problem, problem.policy.tracksAgent ? from.agentId : undefined);
      else if (!from.read && problem.policy.pauses === "read") this.sendHold = { problem, until: problem.resetsAt ?? this.now() + problem.recheckMs };
      return problem;
    }
    const ownFailure = !!from.agentId && this.failing.has(from.agentId);
    if (!from.read || cloudApiVerdict(err, { oneAgent: !!from.agentId }) !== "unexpected" || ownFailure || ++this.unexpected < UNEXPECTED_TO_PAUSE) return null;
    const changed = CloudAgentSetupError.changed(this.adapter, `${UNEXPECTED_TO_PAUSE} answers in a row it does not expect, the last: ${errorText(err)}`);
    this.setRemoteSetup(changed, from.agentId);
    return changed;
  }

  /**
   * Whether a verdict pauses the lane, by its kind's `pauses`: the list's
   * always. One agent's never pauses it when that agent alone is refused (a
   * 403 on it: the credentials read the rest), or when it breaks again after
   * its breaks were found to be its own (`own`).
   */
  private pausesLane(problem: CloudAgentSetupError, err: unknown, from: { agentId?: string; read?: boolean }): boolean {
    if (from.read && !from.agentId) return true;
    if (from.agentId && (cloudApiVerdict(err, { oneAgent: true }) === "denied" || (problem.policy.tracksAgent && this.failing.get(from.agentId)?.own))) return false;
    const { pauses } = problem.policy;
    return pauses === "any" || (pauses === "read" && !!from.read);
  }

  /**
   * One read of the provider, judged (report): answered as expected, the
   * unexpected run ends. A read of one agent (`agentId`) that answers 404
   * finds it deleted on the provider: it is marked gone, and the read
   * resolves undefined.
   */
  private read<T>(client: unknown, fn: () => Promise<T>): Promise<T>;
  private read<T>(client: unknown, fn: () => Promise<T>, agentId: string): Promise<T | undefined>;
  private async read<T>(client: unknown, fn: () => Promise<T>, agentId?: string): Promise<T | undefined> {
    try {
      const out = await fn();
      this.unexpected = 0;
      return out;
    } catch (err) {
      if (agentId && cloudApiVerdict(err, { oneAgent: true }) === "gone") {
        this.markGone(agentId);
        return undefined;
      }
      await this.report(client, err, { agentId, read: true });
      throw err;
    }
  }

  /**
   * Check a paused lane: the list, and the agent whose read broke (mirrored
   * as any pass would). The lane resumes when the list answers as expected
   * and that agent's read does not pause it again; an agent that still fails
   * on its own goes back to its own backoff. One that still breaks the same
   * way is tried against another listed agent: when that one reads as
   * expected, the break is the first one's alone, which waits on its own
   * (`own`, with a warn naming it) while the lane resumes. A failure that
   * changes nothing waits the same delay again. Resolves the list's first
   * page and the agents read (the pass that follows reads neither again), or
   * null while the lane stays paused.
   */
  private async probe(client: NonNullable<ReturnType<CloudAgentWatcher<Adapter>["client"]>>): Promise<{ page: CloudAgentListPage; read: Set<string> } | null> {
    const remote = this.remote;
    if (!remote) return null;
    this.inFlight = true;
    try {
      const page = await this.listPage(client);
      const read = new Set<string>();
      let standing = remote;
      const agentId = remote.agentId;
      if (agentId) {
        read.add(agentId);
        await this.mirror(agentId, undefined, true).catch((err) => this.failed(agentId, err));
        const broke = this.remote;
        if (broke !== standing) {
          const other = broke?.agentId === agentId ? page.items.find((item) => item.id !== agentId && !this.state.agents[item.id]?.gone) : undefined;
          if (!broke || !other) return null;
          read.add(other.id);
          const readsClean = await this.mirror(other.id, other.agent, true).then(() => true, (err) => { this.failed(other.id, err); return false; });
          if (!readsClean || this.remote !== broke || this.state.agents[other.id]?.gone) return null;
          this.isolate(agentId, broke.problem);
          standing = broke;
        }
      }
      if (this.remote !== standing) return null;
      this.setRemoteSetup(null);
      return { page, read };
    } catch {
      if (this.remote === remote) remote.probeAt = this.now() + remote.problem.policy.lane(remote.problem, remote.tries);
      return null;
    } finally {
      this.inFlight = false;
    }
  }

  /** An agent whose answers break while others read as expected: it waits on its own backoff, and its breaks no longer pause the lane. */
  private isolate(agentId: string, problem: CloudAgentSetupError): void {
    const failing = this.failing.get(agentId);
    if (failing) failing.own = true;
    this.log(`${logTag(this.adapter)} ${agentId} still can't be read (${problem.detail ?? problem.message}) while other agents can: syncing resumed, and it retries on its own`, "warn");
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
      // No branch is announced too: it clears a session that carries a stale one.
      if (st.git !== undefined) this.emit("git", st.git ?? { agentId: id });
      if (st.running) this.followed.set(id, this.now());
    }
    this.cadence.start();
  }

  /** Stop polling and following. Resolves once the mirrors already under way have written what they read. */
  async stop(): Promise<void> {
    this.cadence.stop();
    this.adapter.streams?.stop();
    for (const t of this.renderTimers.values()) clearTimeout(t);
    this.renderTimers.clear();
    await Promise.allSettled([...this.mirroring.values()]);
  }

  /** One pass: list agents, mirror the ones that moved; while the lane is paused, only a check when one is due. Never throws. */
  async poll(): Promise<void> {
    if (this.inFlight) return;
    this.letGoUnfollowed();
    const running = Object.values(this.state.agents).some((st) => st.running);
    // Nothing to import, nothing of codecast's to follow and nothing left to
    // settle or re-render: not even a list call. The sign-in on disk is still
    // read (no call to the provider), so a machine that signs in stops
    // reporting it has none; and a lane the provider paused is still checked
    // when due, since nothing else would learn that a new key, a new sign-in,
    // an admin or a fixed API lifted it.
    const importAll = this.importAll();
    const own = this.ownAgents();
    const idle = !importAll && !own.size && !running && !this.staleOnDisk.size;
    if (idle) this.cadence.busy = false;
    const client = this.client();
    if (!client) { this.announceStale(); return; }
    let probed: Awaited<ReturnType<CloudAgentWatcher<Adapter>["probe"]>> = null;
    if (this.remote) {
      this.cadence.busy = false;
      if (this.now() < this.remote.probeAt || !(probed = await this.probe(client))) { this.announceStale(); return; }
    }
    if (idle) return;
    this.inFlight = true;
    try {
      const horizon = this.now() - CLOUD_BACKFILL_MS;
      let cursor: string | undefined;
      let busy = false;
      const listed = new Set<string>();
      // Without import, the list is read for codecast's own agents only: once each has been seen, the pages after hold none.
      const unseen = importAll ? null : new Set([...own].filter((id) => !this.state.agents[id]?.gone));
      for (let page = 0; page < CLOUD_MAX_LIST_PAGES; page++) {
        // The check that resumed the lane read the first page already.
        const data = page === 0 && probed ? probed.page : await this.listPage(client, cursor);
        let reachedHorizon = false;
        for (const item of data.items ?? []) {
          if (item.updatedAtMs < horizon) {
            // A list by last change ends at the horizon. One by creation goes on, and of the old agents reads
            // only one running now or one mirrored before that moved since.
            if (!this.adapter.listedByCreation) { reachedHorizon = true; continue; }
            const st = this.state.agents[item.id];
            if (!item.active && !(st && st.updatedAt !== item.version)) continue;
          }
          if (unseen && !own.has(item.id)) continue;
          unseen?.delete(item.id);
          listed.add(item.id);
          if (item.active) busy = true;
          if (probed?.read.has(item.id) || (this.state.agents[item.id]?.updatedAt === item.version && !item.active)) continue;
          await this.mirrorInPass(item.id, item.agent);
          // A read that paused the lane ends the pass: nothing more is read until a check passes.
          if (this.remote) return;
        }
        if (reachedHorizon || !data.nextCursor || unseen?.size === 0) break;
        cursor = data.nextCursor;
      }
      // Mirrored by id: children (the list does not show them; found through
      // their parent), an agent last seen running that the list no longer
      // shows (archived, past the pages read, its source turned off: it still
      // has to settle), and a mirror from an older format.
      const byId = new Set([...Object.keys(this.state.agents), ...this.staleOnDisk]);
      for (const id of byId) {
        // Listed, or mirrored right now (a child its parent just handed what it read): not read again.
        if (listed.has(id) || probed?.read.has(id) || this.mirroring.has(id)) continue;
        const st = this.state.agents[id];
        if (st?.gone) continue;
        if (!(st?.parent && !st.updatedAt) && !st?.running && !this.staleOnDisk.has(id)) continue;
        await this.mirrorInPass(id);
        if (this.remote) return;
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

  /** One page of the provider's list, judged (read()). */
  private listPage(client: NonNullable<ReturnType<CloudAgentWatcher<Adapter>["client"]>>, cursor?: string): Promise<CloudAgentListPage> {
    return this.read(client, () => this.adapter.listAgents(client, cursor));
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
    const failing = this.failing.get(agentId);
    if (failing && this.now() < failing.retryAt) return;
    try {
      await this.mirror(agentId, known);
    } catch (err) {
      this.failed(agentId, err);
    }
  }

  /** An agent whose read failed on its own: reported, and not read again until its backoff (FAILED_BASE_MS, doubling) is up. */
  private failed(agentId: string, err: unknown): void {
    const prior = this.failing.get(agentId);
    const count = (prior?.count ?? 0) + 1;
    this.failing.set(agentId, { ...prior, count, retryAt: this.now() + doublingDelay(FAILED_BASE_MS, FAILED_MAX_MS, count - 1) });
    this.emitError(new Error(`${agentId}: ${errorText(err)}`));
  }

  /**
   * The agent was deleted on the provider: its mirror and session stay as
   * they are, and it is not read again (a deleted one that ran is let go:
   * nothing is left to settle it by).
   */
  private markGone(agentId: string): void {
    const { running, ...st } = this.state.agents[agentId] ?? {};
    this.state.agents[agentId] = { ...st, gone: true };
    this.followed.delete(agentId);
    this.failing.delete(agentId);
    if (running) this.emit("unfollowed", agentId);
    this.log(`${logTag(this.adapter)} ${agentId} is gone on ${this.adapter.spec.label}: keeping its mirror as it is`);
    void this.saveState();
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

  private mirrorNow(agentId: string, known?: unknown): Promise<void> {
    return this.mirror(agentId, known).catch((err) => this.emitError(err));
  }

  /** Whether the agent was running when a mirror last reached it (not one let go): a follow-up now would find it busy. */
  isRunning(agentId: string): boolean {
    return !!this.state.agents[agentId]?.running && this.followed.has(agentId);
  }

  private emitError(err: unknown): void {
    this.emit("error", err instanceof Error ? err : new Error(String(err)));
  }

  /** `probing`: a paused lane's check (probe()), the one read it allows. */
  private mirror(agentId: string, known?: unknown, probing = false): Promise<void> {
    // One mirror per agent at a time; a request during one waits for it and runs after.
    const prior = this.mirroring.get(agentId) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(() => this.mirrorOnce(agentId, known, probing));
    this.mirroring.set(agentId, next);
    return next.finally(() => { if (this.mirroring.get(agentId) === next) this.mirroring.delete(agentId); });
  }

  private async mirrorOnce(agentId: string, known: unknown, probing: boolean): Promise<void> {
    const client = this.client();
    // A paused lane reads nothing but its checks (probe()).
    if (!client || (this.remote && !probing)) return;
    const result = await this.read(client, () => this.adapter.mirror(client, this.handle(agentId), known), agentId);
    // Deleted on the provider: marked gone by the read.
    if (result === undefined) return;
    if (!result) {
      // A child its parent no longer has: forgotten, or every pass would read it again.
      if (this.state.agents[agentId]?.parent) {
        delete this.state.agents[agentId];
        await this.saveState();
      }
      return;
    }
    if (result.transcript) await this.write(agentId, result);
    const priorGit = this.state.agents[agentId]?.git;
    if (result.git !== undefined && JSON.stringify(result.git) !== JSON.stringify(priorGit)) this.emit("git", result.git ?? { agentId });
    for (const child of result.children ?? []) {
      const prior = this.state.agents[child.agentId];
      // Mirrored once when found; a child that says when it moves, again whenever it did.
      if (prior?.parent && (child.version === undefined || prior.updatedAt === child.version)) continue;
      this.state.agents[child.agentId] = { ...prior, parent: agentId, description: child.description, ...(child.forkAt ? { forkAt: child.forkAt } : {}) };
      void this.mirrorNow(child.agentId, child.known);
    }
    // The git the agent reports now (kept while the adapter cannot tell): a branch it no longer names is not announced again at start.
    const { git: _git, running: _wasRunning, gone: _gone, ...st } = this.state.agents[agentId] ?? {};
    const git = result.git !== undefined ? result.git : priorGit;
    this.state.agents[agentId] = {
      ...st,
      updatedAt: result.running ? undefined : result.version,
      ...(result.running ? { running: true } : {}),
      ...(git !== undefined ? { git } : {}),
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
    const cwd = await cloudMirrorPlacement(this.adapter.spec.mirrorDir, repoOwnerName(result.repo ?? githubRepo(result.repoUrl)), (repo) => this.resolveRepoDir(repo, agentId));
    const dir = path.dirname(file);
    const meta = mirrorMetaJson({ cwd, title: result.title, url: result.url, createdAtMs: result.createdAtMs, parentAgentId: st?.parent, description: st?.description, forkAt: st?.forkAt, archived: result.archived }, await readMetaJson(dir), result.placeholderTitles);
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
