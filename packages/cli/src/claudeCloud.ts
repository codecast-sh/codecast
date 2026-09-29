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
import { readActiveCredentialAsync } from "./ccAccounts.js";
import { codecastPath } from "./codecastDir.js";
import { claudeProjectDirName } from "./projectPathResolver.js";
import { atomicWriteFile } from "./atomicWrite.js";
import type { SessionEvent } from "./sessionWatcher.js";

const API_BASE = "https://api.anthropic.com";
const PAGE_LIMIT = 100;
/** How far back the first sight of a cloud session reaches. */
const BACKFILL_MS = 30 * 24 * 3600_000;
const MAX_LIST_PAGES = 5;
const MAX_EVENT_PAGES_PER_POLL = 50;

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
}

type StateFile = { sessions: Record<string, CloudSessionState> };

/** `owner/name` from a git source URL, or null. */
export function repoFromSourceUrl(url: string | undefined): { owner: string; name: string } | null {
  if (!url) return null;
  const m = url.match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], name: m[2] } : null;
}

/** The Claude Code session uuid the sandbox runs, read off any payload that carries it. */
export function innerSessionId(events: CloudEvent[]): string | undefined {
  for (const e of events) {
    const id = e.payload?.session_id;
    if (typeof id === "string" && id) return id;
  }
  return undefined;
}

/**
 * One cloud event as a local transcript line, or null when a local transcript
 * would not hold it. Only top-level user and assistant turns are kept:
 * subagent traffic (parent_tool_use_id set) lives in a separate file locally,
 * and system/result/env events are session plumbing, not conversation.
 */
export function cloudEventToTranscriptLine(
  event: CloudEvent,
  ctx: { sessionId: string; cwd: string; gitBranch?: string; parentUuid?: string },
): Record<string, unknown> | null {
  const p = event.payload;
  if (!p || (p.type !== "user" && p.type !== "assistant")) return null;
  if (p.parent_tool_use_id) return null;
  if (!p.message) return null;
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

export interface ClaudeCloudWatcherOptions {
  pollMs?: number;
  rootDir?: string;
  statePath?: string;
  /** Local checkout for a repo name, or null. The daemon passes its resolver. */
  resolveRepoDir?: (repo: { owner: string; name: string }) => string | null;
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
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private readonly pollMs: number;
  readonly rootDir: string;
  private readonly statePath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly readToken: () => Promise<string | null>;
  private readonly resolveRepoDir: (repo: { owner: string; name: string }) => string | null;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private state: StateFile = { sessions: {} };

  constructor(opts: ClaudeCloudWatcherOptions = {}) {
    super();
    this.pollMs = opts.pollMs ?? 30_000;
    this.rootDir = opts.rootDir ?? codecastPath("claude-cloud");
    this.statePath = opts.statePath ?? path.join(this.rootDir, "state.json");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.readToken = opts.readToken ?? defaultReadToken;
    this.resolveRepoDir = opts.resolveRepoDir ?? (() => null);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  start(): void {
    if (this.timer) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, "utf-8"));
      if (parsed?.sessions) this.state = parsed;
    } catch {}
    this.emit("ready");
    this.timer = setInterval(() => { void this.poll(); }, this.pollMs);
    setImmediate(() => { void this.poll(); });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass: list sessions, mirror the ones that moved. Never throws. */
  async poll(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const token = await this.readToken();
      if (!token) return;
      const rows = await this.listSessions(token);
      for (const row of rows) {
        const known = this.state.sessions[row.id];
        if (known && known.lastEventAt === row.last_event_at) continue;
        await this.mirrorSession(token, row);
      }
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.inFlight = false;
    }
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
    const horizon = this.now() - BACKFILL_MS;
    const out: CloudSessionRow[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
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
  private placement(row: CloudSessionRow): { cwd: string; gitBranch?: string } {
    const source = row.config?.sources?.find((s) => s.type === "git_repository");
    const repo = repoFromSourceUrl(source?.url);
    const branches = row.external_metadata?.current_branches ?? {};
    const gitBranch = repo ? branches[`${repo.owner}/${repo.name}`] ?? source?.revision : undefined;
    const local = repo ? this.resolveRepoDir(repo) : null;
    if (local) return { cwd: local, gitBranch };
    const placeholder = repo ? `/claude-cloud/${repo.owner}/${repo.name}` : `/claude-cloud/${row.id}`;
    return { cwd: placeholder, gitBranch };
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

    const { cwd, gitBranch } = this.placement(row);
    const file = st.file ?? path.join(this.rootDir, claudeProjectDirName(cwd), `${sessionId}.jsonl`);

    let parentUuid = st.lastUuid;
    const lines: string[] = [];
    if (!st.file && row.title) lines.push(JSON.stringify({ type: "summary", summary: row.title, leafUuid: null }));
    for (const e of events) {
      const line = cloudEventToTranscriptLine(e, { sessionId, cwd, gitBranch, parentUuid });
      if (!line) continue;
      lines.push(JSON.stringify(line));
      parentUuid = line.uuid as string;
    }

    if (lines.length > 0) {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.appendFile(file, lines.join("\n") + "\n");
    }
    this.state.sessions[row.id] = { seq: cursor, lastEventAt: row.last_event_at, sessionId, file, lastUuid: parentUuid };
    await fs.promises.mkdir(this.rootDir, { recursive: true });
    atomicWriteFile(this.statePath, JSON.stringify(this.state, null, 2), { mode: 0o600 });

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
