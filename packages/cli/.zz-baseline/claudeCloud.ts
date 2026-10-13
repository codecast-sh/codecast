/**
 * Claude Code cloud sessions (claude.ai/code) as a transcript source.
 *
 * A cloud session runs Claude Code in Anthropic's sandbox, so no transcript
 * ever lands in ~/.claude/projects. Its history is served by the same API
 * `claude --teleport` reads: GET /v1/code/sessions lists the account's
 * sessions, GET /v1/code/sessions/<id>/events returns its events, each
 * carrying one stream-json message (the same user/assistant entries a local
 * transcript holds) and a monotonic sequence_num.
 *
 * The watcher mirrors each cloud session into an ordinary Claude JSONL file
 * under ~/.codecast/claude-cloud/<project dir>/<session uuid>.jsonl and emits
 * the same `session` event SessionWatcher does, so the whole Claude pipeline
 * (offsets, parser, conversation create, message sync) runs unchanged.
 *
 * It only reads the login Claude Code keeps: it never refreshes the token
 * (the daemon must not rotate a credential a live claude holds, see
 * ccLiveGate.ts). An expired token skips the poll until claude refreshes it.
 *
 * Bridge sessions (environment_kind "bridge") are remote-control mirrors of
 * local sessions whose transcripts already sync from disk; they are skipped.
 */
import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { readActiveCredentialAsync } from "./ccAccounts.js";
import { codecastPath } from "./codecastDir.js";
import { githubRepo } from "./cloud/gitOrigin.js";
import { CLOUD_BACKFILL_MS, CLOUD_MAX_LIST_PAGES, cloudMirrorPlacement, PollCadence, repoOwnerName } from "./cloudAgents/poll.js";
import { claudeProjectDirName } from "./projectPathResolver.js";
import type { SessionEvent } from "./sessionWatcher.js";

const API_BASE = "https://api.anthropic.com";
const PAGE_LIMIT = 100;
const MAX_EVENT_PAGES_PER_POLL = 50;
/** How long the poll stays fast after a send from codecast. */
const SEND_FAST_MS = 10 * 60_000;
/** How long it stays fast after it sees a session move. */
const CHANGE_FAST_MS = 2 * 60_000;
/** A move counts as activity only when the session's last event is this fresh. */
const RECENT_ACTIVITY_MS = 10 * 60_000;

export interface CloudSessionRow {
  id: string;
  title?: string | null;
  status?: string;
  worker_status?: string;
  environment_kind?: string;
  created_at: string;
  last_event_at?: string;
  config?: { model?: string; sources?: Array<{ type?: string; url?: string; revision?: string }> };
  external_metadata?: { current_branches?: Record<string, string> };
}

export interface CloudEvent {
  event_id: string;
  sequence_num: string | number;
  created_at: string;
  event_type?: string;
  payload: Record<string, any>;
}

interface CloudSessionState {
  /** Highest sequence_num already written to the mirror file. */
  seq: number;
  lastEventAt?: string;
  /** The Claude Code session uuid inside the sandbox; names the mirror file. */
  sessionId?: string;
  file?: string;
  /** uuid of the last line written, the parentUuid of the next one. */
  lastUuid?: string;
  /** The session's GitHub repo and branch, for the conversation's git fields. */
  remoteUrl?: string;
  gitBranch?: string;
}

type StateFile = { sessions: Record<string, CloudSessionState> };

/** `owner/name` from a git source URL, or null. */
export function repoFromSourceUrl(url: string | undefined): { owner: string; name: string } | null {
  return repoOwnerName(githubRepo(url)) ?? null;
}

/** The Claude Code session uuid the sandbox runs, read off any payload that carries it. */
export function innerSessionId(events: CloudEvent[]): string | undefined {
  for (const e of events) {
    const id = e.payload?.session_id;
    if (typeof id === "string" && id) return id;
  }
  return undefined;
}

/** A top-level user or assistant turn: what a local transcript holds. Subagent
 *  traffic (parent_tool_use_id set) lives in a separate file locally, and
 *  system/result/env events are session plumbing, not conversation. */
function isTranscriptTurn(e: CloudEvent): boolean {
  const p = e.payload;
  return !!p && (p.type === "user" || p.type === "assistant") && !p.parent_tool_use_id && !!p.message;
}

type LineContext = { sessionId: string; cwd: string; gitBranch?: string; parentUuid?: string };

/** One cloud event as a local transcript line, or null when a local transcript would not hold it. */
export function cloudEventToTranscriptLine(event: CloudEvent, ctx: LineContext): Record<string, unknown> | null {
  if (!isTranscriptTurn(event)) return null;
  const p = event.payload;
  const { session_id: _sid, parent_tool_use_id: _ptu, ...rest } = p;
  return {
    ...rest,
    parentUuid: ctx.parentUuid ?? null,
    isSidechain: false,
    uuid: typeof p.uuid === "string" && p.uuid ? p.uuid : event.event_id,
    timestamp: typeof p.timestamp === "string" && p.timestamp ? p.timestamp : event.created_at,
    sessionId: ctx.sessionId,
    cwd: ctx.cwd,
    ...(ctx.gitBranch ? { gitBranch: ctx.gitBranch } : {}),
    entrypoint: "claude-cloud",
  };
}

/**
 * Transcript lines for a run of events, plus how many events they consumed.
 *
 * A local transcript stamps every assistant line with its message's final
 * stop_reason, and the daemon's turn-state classifier reads it. Cloud events
 * stream each content block before the message ends, so theirs is null. It is
 * derived here: a message holding a tool call stopped for tool_use, and one
 * followed by a result or a new turn ended its turn. A trailing message whose
 * end has not arrived yet is held back (not consumed), so the next poll
 * re-reads it once its fate is known rather than writing a line that reads as
 * mid-stream forever.
 */
export function buildTranscriptLines(events: CloudEvent[], ctx: LineContext): { lines: Record<string, unknown>[]; consumed: number; parentUuid?: string } {
  const stopReason = new Map<number, string>();
  let holdFrom = events.length;
  for (let i = 0; i < events.length; i++) {
    const p = events[i].payload;
    if (!isTranscriptTurn(events[i]) || p.type !== "assistant" || p.message.stop_reason || stopReason.has(i)) continue;
    const id = p.message.id;
    const group = [i];
    let hasToolUse = false;
    let decided = false;
    for (let j = i; j < events.length; j++) {
      const q = events[j].payload;
      if (j > i && q?.type === "result") { decided = true; break; }
      if (!isTranscriptTurn(events[j])) continue;
      if (j > i && (q.type !== "assistant" || !id || q.message.id !== id)) { decided = true; break; }
      if (j > i) group.push(j);
      if (Array.isArray(q.message.content) && q.message.content.some((b: any) => b?.type === "tool_use")) hasToolUse = true;
    }
    if (!hasToolUse && !decided) { holdFrom = i; break; }
    for (const g of group) stopReason.set(g, hasToolUse ? "tool_use" : "end_turn");
  }

  const lines: Record<string, unknown>[] = [];
  let parentUuid = ctx.parentUuid;
  for (let i = 0; i < holdFrom; i++) {
    const line = cloudEventToTranscriptLine(events[i], { ...ctx, parentUuid });
    if (!line) continue;
    const reason = stopReason.get(i);
    if (reason) line.message = { ...(line.message as object), stop_reason: reason };
    lines.push(line);
    parentUuid = line.uuid as string;
  }
  return { lines, consumed: holdFrom, parentUuid };
}

/** A stable event uuid for a codecast message, so a retried delivery is a
 *  server-side duplicate rather than a second turn. */
export function cloudEventUuid(messageId: string): string {
  const h = createHash("sha256").update(`codecast-cloud:${messageId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface ClaudeCloudWatcherOptions {
  pollMs?: number;
  /** Interval while a cloud turn runs or right after a send. */
  fastPollMs?: number;
  rootDir?: string;
  statePath?: string;
  /** Local checkout for a repo name, or null. The daemon passes its resolver. */
  resolveRepoDir?: (repo: { owner: string; name: string }) => Promise<string | null>;
  fetchImpl?: typeof fetch;
  readToken?: () => Promise<string | null>;
  now?: () => number;
  log?: (msg: string) => void;
}

async function defaultReadToken(): Promise<string | null> {
  const raw = await readActiveCredentialAsync();
  if (!raw) return null;
  try {
    const oauth = JSON.parse(raw)?.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    if (typeof oauth.expiresAt === "number" && oauth.expiresAt < Date.now()) return null;
    return oauth.accessToken;
  } catch {
    return null;
  }
}

export class ClaudeCloudWatcher extends EventEmitter {
  /** Fast while a cloud turn runs (busy), or a message was just sent or a
   *  session just moved, so more is likely on its way; slow otherwise. */
  private readonly cadence: PollCadence;
  private inFlight = false;
  readonly rootDir: string;
  private readonly statePath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly readToken: () => Promise<string | null>;
  private readonly resolveRepoDir: (repo: { owner: string; name: string }) => Promise<string | null>;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private state: StateFile = { sessions: {} };

  constructor(opts: ClaudeCloudWatcherOptions = {}) {
    super();
    this.rootDir = opts.rootDir ?? codecastPath("claude-cloud");
    this.statePath = opts.statePath ?? path.join(this.rootDir, "state.json");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.readToken = opts.readToken ?? defaultReadToken;
    this.resolveRepoDir = opts.resolveRepoDir ?? (async () => null);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.cadence = new PollCadence(() => this.poll(), { pollMs: opts.pollMs ?? 30_000, fastPollMs: opts.fastPollMs ?? 3_000, now: this.now });
  }

  start(): void {
    if (this.cadence.running) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, "utf-8"));
      if (parsed?.sessions) this.state = parsed;
    } catch {}
    this.emit("ready");
    this.cadence.start();
  }

  stop(): void {
    this.cadence.stop();
  }

  /** The cloud session a mirrored transcript belongs to, or undefined for a local one. */
  cloudSessionFor(sessionId: string): { cloudId: string; remoteUrl?: string; gitBranch?: string } | undefined {
    // Off means off: with the account setting turned off, a cloud
    // conversation neither takes sends nor lends its repo, since no reply
    // would sync back.
    if (!this.cadence.running) return undefined;
    for (const [cloudId, st] of Object.entries(this.state.sessions)) {
      if (st.sessionId === sessionId) return { cloudId, remoteUrl: st.remoteUrl, gitBranch: st.gitBranch };
    }
    return undefined;
  }

  /**
   * Send a user turn to a cloud session: the call `claude --cloud <id> -p`
   * makes. The event id is the message uuid, so a retried send is a server
   * duplicate, not a second turn. The turn syncs back through the poll like
   * any other event; polling goes fast until the reply is expected in.
   */
  async sendUserMessage(cloudId: string, content: string, uuid: string): Promise<void> {
    const token = await this.readToken();
    if (!token) throw new Error("no usable Claude login on this machine; run claude to sign in");
    const payload = { uuid, session_id: cloudId, type: "user", parent_tool_use_id: null, message: { role: "user", content } };
    const resp = await this.fetchImpl(`${API_BASE}/v1/code/sessions/${encodeURIComponent(cloudId)}/events`, {
      method: "POST",
      headers: { ...this.headers(token), "Content-Type": "application/json" },
      body: JSON.stringify({ events: [{ event_type: "user", payload }] }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`claude cloud send ${resp.status}: ${detail.slice(0, 300)}`);
    }
    this.cadence.hurry(SEND_FAST_MS);
  }

  /** One pass: list sessions, mirror the ones that moved. Never throws. */
  async poll(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const token = await this.readToken();
      if (!token) return;
      const rows = await this.listSessions(token);
      this.cadence.busy = rows.some((r) => r.worker_status === "running" || r.worker_status === "requires_action");
      for (const row of rows) {
        const known = this.state.sessions[row.id];
        if (known && known.lastEventAt === row.last_event_at) continue;
        // A session that just moved (a turn started on claude.ai, or one
        // settled and its person is likely typing the next) keeps the poll
        // fast for a while. The recency test keeps a first-run backfill of
        // old sessions from counting as activity.
        const at = Date.parse(row.last_event_at ?? "");
        if (Number.isFinite(at) && this.now() - at < RECENT_ACTIVITY_MS) this.cadence.hurry(CHANGE_FAST_MS);
        await this.mirrorSession(token, row);
      }
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.inFlight = false;
    }
  }

  /** Write-then-rename, so a crash mid-write never leaves a torn state file. */
  private async saveState(): Promise<void> {
    await fs.promises.mkdir(this.rootDir, { recursive: true });
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    await fs.promises.rename(tmp, this.statePath);
  }

  private headers(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01", Accept: "application/json" };
  }

  private async getJson(token: string, url: string): Promise<any> {
    const resp = await this.fetchImpl(url, { headers: this.headers(token), signal: AbortSignal.timeout(20_000) });
    if (!resp.ok) throw new Error(`claude cloud ${new URL(url).pathname} ${resp.status}`);
    return resp.json();
  }

  /** Cloud sessions active inside the backfill window, most recent first. */
  private async listSessions(token: string): Promise<CloudSessionRow[]> {
    const horizon = this.now() - CLOUD_BACKFILL_MS;
    const out: CloudSessionRow[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < CLOUD_MAX_LIST_PAGES; page++) {
      const q = new URLSearchParams({ limit: String(PAGE_LIMIT), ...(cursor ? { cursor } : {}) });
      const data = await this.getJson(token, `${API_BASE}/v1/code/sessions?${q}`);
      const rows: CloudSessionRow[] = Array.isArray(data?.data) ? data.data : [];
      let reachedHorizon = false;
      for (const row of rows) {
        const at = Date.parse(row.last_event_at ?? row.created_at);
        if (Number.isFinite(at) && at < horizon) { reachedHorizon = true; continue; }
        if (row.environment_kind === "bridge") continue;
        out.push(row);
      }
      if (reachedHorizon || !data?.next_cursor || rows.length === 0) break;
      cursor = data.next_cursor;
    }
    return out;
  }

  /** Where the session's transcript belongs locally: the checkout of its repo, else a stable placeholder. */
  private async placement(row: CloudSessionRow): Promise<{ cwd: string; gitBranch?: string; remoteUrl?: string }> {
    const source = row.config?.sources?.find((s) => s.type === "git_repository");
    const repo = repoFromSourceUrl(source?.url);
    const branches = row.external_metadata?.current_branches ?? {};
    const gitBranch = repo ? branches[`${repo.owner}/${repo.name}`] ?? source?.revision : undefined;
    const remoteUrl = repo ? `https://github.com/${repo.owner}/${repo.name}` : undefined;
    // A session seeded from a local bundle names no repo at all; those share one project.
    return { cwd: await cloudMirrorPlacement("claude-cloud", repo, this.resolveRepoDir), gitBranch, remoteUrl };
  }

  private async mirrorSession(token: string, row: CloudSessionRow): Promise<void> {
    const st: CloudSessionState = this.state.sessions[row.id] ?? { seq: 0 };
    const events: CloudEvent[] = [];
    let cursor = st.seq;
    for (let page = 0; page < MAX_EVENT_PAGES_PER_POLL; page++) {
      const q = new URLSearchParams({ limit: String(PAGE_LIMIT), sort_order: "asc", ...(cursor ? { cursor: String(cursor) } : {}) });
      const data = await this.getJson(token, `${API_BASE}/v1/code/sessions/${encodeURIComponent(row.id)}/events?${q}`);
      const batch: CloudEvent[] = Array.isArray(data?.data) ? data.data : [];
      for (const e of batch) {
        const n = Number(e.sequence_num);
        if (Number.isFinite(n) && n > cursor) { events.push(e); cursor = n; }
      }
      if (!data?.next_cursor || batch.length === 0) break;
    }

    const sessionId = st.sessionId ?? innerSessionId(events);
    // The sandbox's first event (the prompt) precedes Claude Code starting, so
    // no uuid exists yet. Wait for it rather than invent one: the next poll
    // re-reads from the same cursor.
    if (!sessionId) return;

    const { cwd, gitBranch, remoteUrl } = await this.placement(row);
    const file = st.file ?? path.join(this.rootDir, claudeProjectDirName(cwd), `${sessionId}.jsonl`);

    const built = buildTranscriptLines(events, { sessionId, cwd, gitBranch, parentUuid: st.lastUuid });
    const lines = built.lines.map((l) => JSON.stringify(l));
    const consumedSeq = built.consumed > 0 ? Number(events[built.consumed - 1].sequence_num) : st.seq;
    const parentUuid = built.parentUuid;

    if (lines.length > 0) {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.appendFile(file, lines.join("\n") + "\n");
    }
    // A held-back tail leaves lastEventAt unset, so the next poll re-reads it
    // even if the session goes quiet before its result lands.
    const complete = built.consumed === events.length;
    this.state.sessions[row.id] = { seq: consumedSeq, lastEventAt: complete ? row.last_event_at : undefined, sessionId, file, lastUuid: parentUuid, remoteUrl, gitBranch };
    await this.saveState();

    if (lines.length > 0) {
      this.log(`claude cloud ${row.id}: ${lines.length} line(s) -> ${file}`);
      const event: SessionEvent = {
        sessionId,
        filePath: file,
        eventType: st.file ? "change" : "add",
        projectPath: path.basename(path.dirname(file)),
      };
      this.emit("session", event);
    }
  }
}
