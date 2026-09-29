/**
 * Cursor Cloud Agents (cursor.com/agents) as a codecast session.
 *
 * A cloud agent runs in Cursor's VM against a GitHub repo, so no transcript
 * lands on this machine. The Cloud Agents API (api.cursor.com, v1) splits one
 * agent into sequential runs, one per prompt: GET /v1/agents lists them, each
 * run's SSE stream replays its assistant text and tool calls (kept 24h), and
 * the v0 conversation endpoint keeps every prompt and reply as text for good.
 *
 * The watcher mirrors each agent into a Cursor-format JSONL transcript under
 * ~/.codecast/cursor-cloud/<agent id>/, the same shape cursor-agent writes, and
 * emits the event the Cursor transcript watcher does, so the whole Cursor
 * pipeline (per-record delta sync, stub binding, status from turn_ended) runs
 * unchanged. Like cursor-agent it rewrites the file whole on each change.
 *
 * The write side (create an agent, follow-up runs, cancel) is CursorCloudApi,
 * driven by the daemon's start/deliver/escape paths. The key is the user's
 * Cursor API key from the provider key store (`cast keys set cursor`).
 */
import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import { CLIENT_ERROR_BANNER_PREFIX } from "@codecast/shared/contracts";
import { codecastPath } from "./codecastDir.js";
import { repoFromSourceUrl } from "./claudeCloud.js";
import { parseSseStream } from "./sse.js";
import type { CursorTranscriptEvent } from "./cursorTranscriptWatcher.js";

export const CURSOR_API_BASE = "https://api.cursor.com";
/** How far back the first sight of a cloud agent reaches. */
const BACKFILL_MS = 30 * 24 * 3600_000;
const MAX_LIST_PAGES = 5;
const RESULT_TEXT_MAX = 8_000;
/** Bump when the rendered transcript changes shape: every mirror re-renders once. */
const MIRROR_FORMAT = 4;

export type CursorRunStatus = "CREATING" | "RUNNING" | "FINISHED" | "ERROR" | "CANCELLED" | "EXPIRED";
export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(["FINISHED", "ERROR", "CANCELLED", "EXPIRED"]);

export interface CursorCloudAgent {
  id: string;
  name?: string;
  status: "ACTIVE" | "IDLE" | "ARCHIVED" | string;
  repos?: Array<{ url: string; startingRef?: string; prUrl?: string }>;
  url?: string;
  createdAt: string;
  updatedAt: string;
  latestRunId?: string;
}

export interface CursorCloudRun {
  id: string;
  agentId: string;
  status: CursorRunStatus | string;
  createdAt: string;
  updatedAt: string;
  result?: string;
  durationMs?: number;
}

/**
 * One kept stream event. `turn_start` / `turn_end` / `step` are the turn and
 * step markers the stream sends as interaction updates; deltas the transcript
 * never shows are dropped.
 */
export interface CursorRunEvent {
  event: "assistant" | "tool_call" | "result" | "status" | "turn_start" | "turn_end" | "step";
  /** Stream id. One agent-wide sequence: its leading digits are epoch milliseconds. */
  id?: string;
  data: Record<string, any>;
}

const MARKERS: Record<string, CursorRunEvent["event"]> = {
  "user-message-appended": "turn_start",
  "turn-ended": "turn_end",
  "step-started": "step",
};

export interface CursorConversationMessage {
  id: string;
  type: "user_message" | "assistant_message" | string;
  text: string;
}

export class CursorCloudApiError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string) {
    super(message);
  }
}

// ── API client ───────────────────────────────────────────────────────────────

export class CursorCloudApi {
  constructor(private readonly key: string, private readonly fetchImpl: typeof fetch = fetch, private readonly base = CURSOR_API_BASE) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Basic ${Buffer.from(`${this.key}:`).toString("base64")}`, ...extra };
  }

  async request<T>(method: string, p: string, body?: unknown): Promise<T> {
    const resp = await this.fetchImpl(`${this.base}${p}`, {
      method,
      headers: this.headers(body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await resp.text();
    let json: any = undefined;
    try { json = text ? JSON.parse(text) : undefined; } catch {}
    if (!resp.ok) {
      // Errors come as {error: {code, message}} (validation) or {code, message} (auth).
      const body = json?.error && typeof json.error === "object" ? json.error : json;
      const code = typeof body?.code === "string" ? body.code : undefined;
      throw new CursorCloudApiError(resp.status, code, typeof body?.message === "string" && body.message ? body.message : `cursor cloud ${method} ${p.split("?")[0]} ${resp.status}`);
    }
    return json as T;
  }

  listAgents(limit = 100, cursor?: string): Promise<{ items: CursorCloudAgent[]; nextCursor?: string }> {
    const q = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) });
    return this.request("GET", `/v1/agents?${q}`);
  }
  getAgent(id: string): Promise<CursorCloudAgent> {
    return this.request("GET", `/v1/agents/${encodeURIComponent(id)}`);
  }
  createAgent(body: Record<string, unknown>): Promise<{ agent: CursorCloudAgent; run: CursorCloudRun }> {
    return this.request("POST", "/v1/agents", body);
  }
  createRun(agentId: string, text: string): Promise<{ run: CursorCloudRun }> {
    return this.request("POST", `/v1/agents/${encodeURIComponent(agentId)}/runs`, { prompt: { text } });
  }
  async listRuns(agentId: string): Promise<CursorCloudRun[]> {
    const out: CursorCloudRun[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const q = new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : {}) });
      const data = await this.request<{ items?: CursorCloudRun[]; nextCursor?: string }>("GET", `/v1/agents/${encodeURIComponent(agentId)}/runs?${q}`);
      out.push(...(data.items ?? []));
      if (!data.nextCursor) break;
      cursor = data.nextCursor;
    }
    return out;
  }
  getRun(agentId: string, runId: string): Promise<CursorCloudRun> {
    return this.request("GET", `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`);
  }
  cancelRun(agentId: string, runId: string): Promise<unknown> {
    return this.request("POST", `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/cancel`);
  }
  archive(agentId: string): Promise<unknown> {
    return this.request("POST", `/v1/agents/${encodeURIComponent(agentId)}/archive`);
  }
  /** Every prompt and reply as text. v0: the v1 surface has no conversation read. */
  async conversation(agentId: string): Promise<CursorConversationMessage[]> {
    const data = await this.request<{ messages?: CursorConversationMessage[] }>("GET", `/v0/agents/${encodeURIComponent(agentId)}/conversation`);
    return data.messages ?? [];
  }

  /**
   * Read a run's SSE stream, calling `onEvent` for each kept event, until the
   * stream ends. Resolves true when it saw a terminal `result`. Despite the
   * docs, a run's stream is the AGENT's event stream from that run on: it
   * carries every later turn too, each opened by `turn_start` and closed by
   * `turn_end`, with ids from one agent-wide sequence (verified 2026-09-29).
   * `lastEventId` resumes one cut short. Throws 410 once it has expired.
   */
  async streamRun(agentId: string, runId: string, onEvent: (e: CursorRunEvent) => void, opts: { signal?: AbortSignal; lastEventId?: string } = {}): Promise<boolean> {
    const resp = await this.fetchImpl(`${this.base}/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/stream`, {
      headers: this.headers({ Accept: "text/event-stream", ...(opts.lastEventId ? { "Last-Event-ID": opts.lastEventId } : {}) }),
      signal: opts.signal,
    });
    if (!resp.ok || !resp.body) {
      let code: string | undefined;
      try { code = (await resp.json())?.code; } catch {}
      throw new CursorCloudApiError(resp.status, code, `cursor cloud run stream ${resp.status}`);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawResult = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { frames, rest } = parseSseStream(buffer);
      buffer = rest;
      for (const frame of frames) {
        if (frame.event === "done") return sawResult;
        let data: Record<string, any>;
        try { data = JSON.parse(frame.data); } catch { continue; }
        const event = frame.event === "interaction_update" ? MARKERS[data.type] : frame.event;
        if (event !== "assistant" && event !== "tool_call" && event !== "result" && event !== "status" && event !== "turn_start" && event !== "turn_end" && event !== "step") continue;
        if (event === "result") sawResult = true;
        onEvent({ event, ...(frame.id ? { id: frame.id } : {}), data: frame.event === "interaction_update" ? {} : data });
      }
    }
    return sawResult;
  }
}

/**
 * Check a Cursor API key before it is stored: the account it belongs to, or
 * Cursor's reason for refusing it. A network failure is reported as such,
 * never as a bad key.
 */
export async function verifyCursorKey(key: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: true; account?: string } | { ok: false; error: string }> {
  try {
    const me = await new CursorCloudApi(key, fetchImpl).request<{ userEmail?: string; apiKeyName?: string }>("GET", "/v1/me");
    return { ok: true, account: me?.userEmail };
  } catch (err) {
    if (err instanceof CursorCloudApiError && (err.status === 401 || err.status === 403)) return { ok: false, error: `Cursor rejected this key: ${err.message}` };
    return { ok: false, error: `Couldn't reach Cursor to check the key: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── Transcript ───────────────────────────────────────────────────────────────

// Cloud tool names mapped onto the names cursor-agent's own transcripts use,
// so a cloud session reads like a local one. Unknown names pass through.
const TOOL_NAMES: Record<string, string> = {
  run_terminal_cmd: "Shell",
  read_file: "Read",
  edit_file: "Edit",
  search_replace: "Edit",
  write: "Write",
  delete_file: "Delete",
  list_dir: "LS",
  grep: "Grep",
  grep_search: "Grep",
  glob_file_search: "Glob",
  file_search: "Glob",
  codebase_search: "SemanticSearch",
  web_search: "WebSearch",
  todo_write: "TodoWrite",
  task: "Task",
};
// Plumbing the cloud attaches to every call; none of it is the call's input.
const TOOL_ARG_NOISE = new Set(["toolCallId", "conversationId", "requestId", "parsingResult", "simpleCommands", "fileOutputThresholdBytes", "timeoutBehavior", "hardTimeout", "closeStdin", "timeout"]);

export function cloudToolUse(data: Record<string, any>): { id: string; name: string; input: Record<string, unknown> } {
  const input: Record<string, unknown> = {};
  const args = data.args && typeof data.args === "object" ? data.args as Record<string, unknown> : {};
  for (const [k, v] of Object.entries(args)) {
    if (TOOL_ARG_NOISE.has(k)) continue;
    if (v === null || ["string", "number", "boolean"].includes(typeof v)) input[k] = v;
  }
  if (typeof input.path === "string" && input.file_path === undefined) input.file_path = input.path;
  return { id: String(data.callId ?? ""), name: TOOL_NAMES[data.name] ?? String(data.name ?? "tool"), input };
}

export function cloudToolResult(data: Record<string, any>): { content: string; isError: boolean } {
  const r = data.result;
  if (r === undefined) return { content: data.truncated?.result ? "(output too large to show)" : "", isError: false };
  const err = r?.error ?? r?.failure;
  const ok = r?.success ?? r;
  const text = err
    ? (typeof err === "string" ? err : err.message ?? err.stderr ?? JSON.stringify(err))
    : typeof ok === "string" ? ok
    : ok?.interleavedOutput ?? ok?.stdout ?? ok?.content ?? ok?.output ?? JSON.stringify(ok);
  const s = String(text ?? "");
  return { content: s.length > RESULT_TEXT_MAX ? `${s.slice(0, RESULT_TEXT_MAX)}\n… (truncated)` : s, isError: !!err };
}

function eventClock(e: CursorRunEvent, fallback: number): number {
  const ms = e.id ? parseInt(e.id, 10) : NaN;
  return Number.isFinite(ms) && ms > 1e12 ? ms : fallback;
}

/** Stream events merged across runs: one agent-wide log, deduped and in stream order. */
export function mergeEventLog(...logs: CursorRunEvent[][]): CursorRunEvent[] {
  const byId = new Map<string, CursorRunEvent>();
  for (const log of logs) for (const e of log) if (e.id) byId.set(`${e.id}|${e.event}|${e.event === "tool_call" ? `${e.data.callId}:${e.data.status}` : ""}`, e);
  const key = (id: string) => id.split("-").map(Number);
  return [...byId.values()].sort((a, b) => {
    const [a1, a2] = key(a.id!), [b1, b2] = key(b.id!);
    return a1 - b1 || a2 - b2;
  });
}

interface LogTurn { start?: number; events: CursorRunEvent[]; ended: boolean }

/** The log cut into turns at `turn_start`; a leading remainder is the tail of an earlier turn. */
function logTurns(log: CursorRunEvent[]): LogTurn[] {
  const turns: LogTurn[] = [];
  for (const e of log) {
    if (e.event === "turn_start") { turns.push({ start: eventClock(e, 0), events: [], ended: false }); continue; }
    if (!turns.length) turns.push({ events: [], ended: false });
    const t = turns[turns.length - 1];
    if (e.event === "turn_end") t.ended = true;
    else t.events.push(e);
  }
  // A stream opens on the step marker ahead of its turn's `turn_start`: nothing to render.
  if (turns[0] && turns[0].start === undefined && !turns[0].events.some((e) => e.event === "assistant" || e.event === "tool_call")) turns.shift();
  return turns;
}

function turnText(t: LogTurn): string {
  return t.events.filter((e) => e.event === "assistant").map((e) => e.data.text ?? "").join("");
}

export interface CursorCloudTranscriptInput {
  /** The v0 conversation: every prompt and reply, the only complete list of turns. */
  conversation: CursorConversationMessage[];
  /** The agent's merged stream log (see mergeEventLog); may cover only the latest turns. */
  log: CursorRunEvent[];
  /** Latest run, for the error banner and whether a stream-less last turn has ended. */
  latestRun?: CursorCloudRun;
  /** Clock for turns the log does not date. */
  createdAt: number;
  /** A line codecast adds under the first prompt (what the agent started from). */
  notice?: string;
}

/**
 * The agent's transcript in cursor-agent's JSONL shape, plus a `timestamp` per
 * record. Turns come from the conversation (a turn is a prompt, which may be
 * the agent's own notification, e.g. a forked worker reporting back). Each
 * turn the log also covers is rendered from the log instead: its text split
 * at step boundaries, its tool calls with their results. The log's turns are
 * the conversation's latest ones, so they are aligned from the end.
 */
export function buildCursorCloudTranscript(input: CursorCloudTranscriptInput): string {
  const turns: Array<{ prompt?: string; promptId?: string; replies: Array<{ id: string; text: string }> }> = [];
  for (const m of input.conversation) {
    if (m.type === "user_message") turns.push({ prompt: m.text, promptId: m.id, replies: [] });
    else if (turns.length) turns[turns.length - 1].replies.push({ id: m.id, text: m.text });
    else turns.push({ replies: [{ id: m.id, text: m.text }] });
  }
  const fromLog = logTurns(input.log);
  // Aligned from the end. The one exception is a turn the log has opened but
  // the conversation does not list yet: then the conversation's last reply is
  // in the log's second-to-last turn, and the log runs one turn ahead.
  let offset = turns.length - fromLog.length;
  const lastReply = turns[turns.length - 1]?.replies[0]?.text.trim().slice(0, 40);
  if (lastReply && fromLog.length > 1 && !turnText(fromLog[fromLog.length - 1]).includes(lastReply) && turnText(fromLog[fromLog.length - 2]).includes(lastReply)) offset++;
  const count = Math.max(turns.length, offset + fromLog.length);

  const lines: string[] = [];
  const push = (rec: Record<string, unknown>) => lines.push(JSON.stringify(rec));
  // Cursor links an agent by its bare id (`[Name](bc-…)`), which only its own app resolves.
  const text = (t: string) => ({ type: "text", text: t.replace(/\]\((bc-[0-9a-f-]{8,})\)/g, "](https://cursor.com/agents/$1)") });
  let clock = input.createdAt;
  // Calls already shown. A call can complete turns after it started (a forked
  // worker's `task` completes when the worker reports back): its result then
  // lands where it happened, under the call's one row.
  const opened = new Set<string>();

  for (let i = 0; i < count; i++) {
    const turn = turns[i];
    const logged = i >= offset ? fromLog[i - offset] : undefined;
    if (logged?.start) clock = Math.max(clock, logged.start);
    // Every record names a stable id (what it renders from), so a row keeps
    // its identity when a turn switches from the conversation's text to the
    // log's, or an earlier turn gains detail; ids never move between roles.
    if (turn?.prompt !== undefined) push({ role: "user", id: turn.promptId, timestamp: clock, message: { content: [text(turn.prompt)] } });
    if (i === 0 && input.notice) push({ role: "assistant", id: "notice-start", timestamp: clock, message: { content: [text(`ℹ ${input.notice}`)] } });

    if (logged && logged.events.some((e) => e.event === "assistant" || e.event === "tool_call")) {
      let pending = "";
      let pendingId: string | undefined;
      // A record is dated by its first event, never by when it was flushed: a
      // row's timestamp is fixed at its first sync, and a turn's trailing step
      // marker already belongs to the next turn.
      let pendingAt = clock;
      const flush = (extra: unknown[] = [], id?: string) => {
        const content = [...(pending.trim() ? [text(pending.trim())] : []), ...extra];
        const recordId = id ?? (pendingId ? `seg-${pendingId}` : undefined);
        const at = pendingId ? pendingAt : clock;
        pending = "";
        pendingId = undefined;
        if (content.length) push({ role: "assistant", id: recordId, timestamp: at, message: { content } });
      };
      for (const e of logged.events) {
        if (e.event === "step") { flush(); continue; }
        if (e.event !== "assistant" && e.event !== "tool_call") continue;
        clock = eventClock(e, clock);
        if (e.event === "assistant" && typeof e.data.text === "string") {
          if (!pendingId) { pendingId = e.id; pendingAt = clock; }
          pending += e.data.text;
        } else if (e.event === "tool_call") {
          const use = cloudToolUse(e.data);
          if (!opened.has(use.id)) {
            opened.add(use.id);
            flush([{ type: "tool_use", ...use }], `use-${use.id}`);
          } else {
            flush();
          }
          if (e.data.status === "completed") {
            const res = cloudToolResult(e.data);
            push({ role: "user", id: `result-${use.id}`, timestamp: clock, message: { content: [{ type: "tool_result", tool_use_id: use.id, content: res.content, ...(res.isError ? { is_error: true } : {}) }] } });
          }
        }
      }
      flush();
    } else {
      for (const reply of turn?.replies ?? []) push({ role: "assistant", id: reply.id, timestamp: clock, message: { content: [text(reply.text)] } });
    }

    const isLast = i === count - 1;
    const run = input.latestRun;
    if (isLast && run && (run.status === "ERROR" || run.status === "EXPIRED")) {
      push({ role: "assistant", id: `error-${run.id}`, timestamp: Date.parse(run.updatedAt) || clock, message: { content: [text(`${CLIENT_ERROR_BANNER_PREFIX} Cursor Cloud run ${run.status.toLowerCase()}`)] } });
    }
    // Only the last turn can still be going: until its log closes it, or its run ends.
    if (!isLast || logged?.ended || !run || TERMINAL_RUN_STATUSES.has(run.status)) push({ type: "turn_ended", status: "success" });
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/** Forked workers a transcript's `task` calls started: their agent ids and descriptions. */
export function forkedWorkers(log: CursorRunEvent[]): Array<{ agentId: string; description?: string }> {
  const out = new Map<string, string | undefined>();
  for (const e of log) {
    const id = e.event === "tool_call" && e.data.name === "task" ? e.data.args?.agentId : undefined;
    if (typeof id === "string" && id.startsWith("bc-")) out.set(id, typeof e.data.args?.description === "string" ? e.data.args.description : undefined);
  }
  return [...out].map(([agentId, description]) => ({ agentId, description }));
}

/** `https://github.com/o/r` from any GitHub remote form, or null. */
export function githubHttpsUrl(remote: string | undefined): string | null {
  const repo = repoFromSourceUrl(remote?.trim());
  return repo ? `https://github.com/${repo.owner}/${repo.name}` : null;
}

// ── Mirror watcher ───────────────────────────────────────────────────────────

export interface CursorCloudWatcherOptions {
  pollMs?: number;
  rootDir?: string;
  readKey: () => string | null;
  /** Import every cloud agent on the account (the account's cursor_cloud_sync
   *  setting). Off, only the agents codecast started (and their forked
   *  workers) are mirrored. */
  importAll?: () => boolean;
  /** Whether codecast started this agent. */
  isOwnAgent?: (agentId: string) => boolean;
  resolveRepoDir?: (repo: { owner: string; name: string }) => Promise<string | null>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (msg: string) => void;
}

interface AgentState {
  /** The agent's updatedAt when it was last mirrored with every run settled. */
  updatedAt?: string;
  /** A forked worker's parent agent, and what the parent's task call called it. */
  parent?: string;
  description?: string;
}

/** What a mirror keeps per agent on disk: its merged stream log and the runs already read to the end. */
interface AgentLog { events: CursorRunEvent[]; readRuns: string[] }

/** The branch (and pull request) the agent last pushed, from its runs. */
export interface CursorCloudGit { agentId: string; repoUrl?: string; branch?: string; prUrl?: string }

/** The agent's newest pushed branch: its runs' `git` (per agent, not per run) or a `result` event's. */
export function latestCursorGit(agentId: string, runs: Array<CursorCloudRun & { git?: { branches?: Array<{ repoUrl?: string; branch?: string; prUrl?: string }> } }>, log: CursorRunEvent[]): CursorCloudGit | null {
  const fromLog = [...log].reverse().find((e) => e.event === "result" && e.data.git?.branches?.length)?.data.git.branches;
  const fromRuns = [...runs].reverse().find((r) => r.git?.branches?.length)?.git?.branches;
  const b = (fromLog ?? fromRuns)?.at(-1);
  if (!b?.branch && !b?.prUrl) return null;
  return { agentId, ...(b.repoUrl ? { repoUrl: b.repoUrl.startsWith("http") ? b.repoUrl : `https://${b.repoUrl}` } : {}), ...(b.branch ? { branch: b.branch } : {}), ...(b.prUrl ? { prUrl: b.prUrl } : {}) };
}

export declare interface CursorCloudWatcher {
  on(event: "session", listener: (e: CursorTranscriptEvent) => void): this;
  on(event: "git", listener: (g: CursorCloudGit) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "ready", listener: () => void): this;
}

export class CursorCloudWatcher extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private readonly pollMs: number;
  readonly rootDir: string;
  private readonly statePath: string;
  private readonly readKey: () => string | null;
  private readonly importAll: () => boolean;
  private readonly isOwnAgent: (agentId: string) => boolean;
  private readonly resolveRepoDir: (repo: { owner: string; name: string }) => Promise<string | null>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private state: { format?: number; agents: Record<string, AgentState> } = { format: MIRROR_FORMAT, agents: {} };
  /** Live runs being followed, by run id. */
  private readonly followers = new Map<string, AbortController>();
  private readonly logs = new Map<string, AgentLog>();
  private readonly renderTimers = new Map<string, NodeJS.Timeout>();
  private readonly mirroring = new Map<string, Promise<void>>();
  private readonly lastGit = new Map<string, string>();

  constructor(opts: CursorCloudWatcherOptions) {
    super();
    this.pollMs = opts.pollMs ?? 30_000;
    this.rootDir = opts.rootDir ?? codecastPath("cursor-cloud");
    this.statePath = path.join(this.rootDir, "state.json");
    this.readKey = opts.readKey;
    this.importAll = opts.importAll ?? (() => true);
    this.isOwnAgent = opts.isOwnAgent ?? (() => false);
    this.resolveRepoDir = opts.resolveRepoDir ?? (async () => null);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  api(): CursorCloudApi | null {
    const key = this.readKey();
    return key ? new CursorCloudApi(key, this.fetchImpl) : null;
  }

  transcriptPath(agentId: string): string {
    return path.join(this.rootDir, agentId, `${agentId}.jsonl`);
  }

  start(): void {
    if (this.timer) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, "utf-8"));
      if (parsed?.agents) this.state = parsed;
    } catch {}
    // Rendered by an older format: forget which agents are settled so each
    // re-renders, and announce nothing stale (a row's timestamp is set once).
    const staleFormat = this.state.format !== MIRROR_FORMAT;
    if (staleFormat) {
      for (const st of Object.values(this.state.agents)) delete st.updatedAt;
      this.state.format = MIRROR_FORMAT;
    }
    this.emit("ready");
    // The priming pass every transcript watcher makes: announce what is on
    // disk, since a file written just before a restart may never have synced
    // (the sync pipeline skips what it already has).
    for (const agentId of staleFormat || !fs.existsSync(this.rootDir) ? [] : fs.readdirSync(this.rootDir)) {
      const file = this.transcriptPath(agentId);
      if (agentId.startsWith("bc-") && fs.existsSync(file)) this.emit("session", { sessionId: agentId, filePath: file, eventType: "add" });
    }
    this.timer = setInterval(() => { void this.poll(); }, this.pollMs);
    setImmediate(() => { void this.poll(); });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const c of this.followers.values()) c.abort();
    this.followers.clear();
    for (const t of this.renderTimers.values()) clearTimeout(t);
    this.renderTimers.clear();
  }

  /** One pass: list agents, mirror the ones that moved. Never throws. */
  async poll(): Promise<void> {
    if (this.inFlight) return;
    const api = this.api();
    if (!api) return;
    this.inFlight = true;
    try {
      const horizon = this.now() - BACKFILL_MS;
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const data = await api.listAgents(100, cursor);
        let reachedHorizon = false;
        for (const agent of data.items ?? []) {
          if (Date.parse(agent.updatedAt) < horizon) { reachedHorizon = true; continue; }
          if (!this.importAll() && !this.isOwnAgent(agent.id)) continue;
          if (this.state.agents[agent.id]?.updatedAt === agent.updatedAt && agent.status !== "ACTIVE") continue;
          await this.mirror(agent.id, agent);
        }
        if (reachedHorizon || !data.nextCursor) break;
        cursor = data.nextCursor;
      }
      // Forked workers are not listed; they are found through their parent and revisited here.
      for (const [id, st] of Object.entries(this.state.agents)) {
        if (!st.parent || st.updatedAt) continue;
        await this.mirror(id);
      }
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.inFlight = false;
    }
  }

  /** Mirror one agent now (after codecast created it or sent it a run). */
  follow(agentId: string): Promise<void> {
    return this.mirror(agentId).catch((err) => { this.emit("error", err instanceof Error ? err : new Error(String(err))); });
  }

  private mirror(agentId: string, known?: CursorCloudAgent): Promise<void> {
    // One mirror per agent at a time; a request during one waits for it and runs after.
    const prior = this.mirroring.get(agentId) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(() => this.mirrorOnce(agentId, known));
    this.mirroring.set(agentId, next);
    return next.finally(() => { if (this.mirroring.get(agentId) === next) this.mirroring.delete(agentId); });
  }

  private async mirrorOnce(agentId: string, known?: CursorCloudAgent): Promise<void> {
    const api = this.api();
    if (!api) return;
    const agent = known ?? await api.getAgent(agentId);
    const runs = (await api.listRuns(agentId)).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const log = this.agentLog(agentId);
    // Each finished run's stream is read once, to its end. Streams overlap (a
    // run's stream runs on through later turns) and merge by event id; an
    // early run's stream can also be empty, so none stands in for another.
    for (const run of runs) {
      if (!TERMINAL_RUN_STATUSES.has(run.status) || log.readRuns.includes(run.id)) continue;
      await this.readStream(api, agentId, run);
      log.readRuns.push(run.id);
    }
    const active = runs.filter((r) => !TERMINAL_RUN_STATUSES.has(r.status));
    for (const run of active) this.startFollower(api, agent, run);
    this.saveLog(agentId);

    await this.render(agent, runs[runs.length - 1], api);
    const git = latestCursorGit(agentId, runs, log.events);
    if (git && JSON.stringify(git) !== this.lastGit.get(agentId)) {
      this.lastGit.set(agentId, JSON.stringify(git));
      this.emit("git", git);
    }
    for (const worker of forkedWorkers(log.events)) {
      if (this.state.agents[worker.agentId]?.parent) continue;
      this.state.agents[worker.agentId] = { parent: agentId, description: worker.description };
      void this.follow(worker.agentId);
    }
    this.state.agents[agentId] = { ...this.state.agents[agentId], updatedAt: active.length ? undefined : agent.updatedAt };
    await this.saveState();
  }

  /** Read a finished run's stream to its end into the agent's log. An expired one adds nothing. */
  private async readStream(api: CursorCloudApi, agentId: string, run: CursorCloudRun): Promise<void> {
    const events: CursorRunEvent[] = [];
    try {
      await api.streamRun(agentId, run.id, (e) => events.push(e), { signal: AbortSignal.timeout(120_000) });
    } catch (err) {
      if (err instanceof CursorCloudApiError && (err.status === 410 || err.status === 404)) return;
      throw err;
    }
    const log = this.agentLog(agentId);
    log.events = mergeEventLog(log.events, events);
  }

  private startFollower(api: CursorCloudApi, agent: CursorCloudAgent, run: CursorCloudRun): void {
    if (this.followers.has(run.id)) return;
    const controller = new AbortController();
    this.followers.set(run.id, controller);
    void (async () => {
      let lastEventId: string | undefined;
      for (let attempt = 0; attempt < 20 && !controller.signal.aborted; attempt++) {
        try {
          const ended = await api.streamRun(agent.id, run.id, (e) => {
            if (e.id) lastEventId = e.id;
            const log = this.agentLog(agent.id);
            log.events = mergeEventLog(log.events, [e]);
            this.scheduleRender(agent.id);
          }, { signal: controller.signal, lastEventId });
          if (ended) break;
        } catch (err) {
          if (controller.signal.aborted) return;
          if (err instanceof CursorCloudApiError && (err.status === 410 || err.status === 404)) break;
          this.log(`cursor cloud ${agent.id} run ${run.id} stream dropped: ${err instanceof Error ? err.message : String(err)}`);
        }
        await new Promise((r) => setTimeout(r, Math.min(30_000, 1_000 * 2 ** attempt)));
      }
      this.followers.delete(run.id);
      if (!controller.signal.aborted) await this.follow(agent.id);
    })();
  }

  private scheduleRender(agentId: string): void {
    if (this.renderTimers.has(agentId)) return;
    this.renderTimers.set(agentId, setTimeout(() => {
      this.renderTimers.delete(agentId);
      void this.follow(agentId);
    }, 750));
  }

  private async render(agent: CursorCloudAgent, latestRun: CursorCloudRun | undefined, api: CursorCloudApi): Promise<void> {
    const conversation = await api.conversation(agent.id).catch(() => [] as CursorConversationMessage[]);
    const notice = await fs.promises.readFile(this.noticePath(agent.id), "utf8").catch(() => undefined);
    const content = buildCursorCloudTranscript({ conversation, log: this.agentLog(agent.id).events, latestRun, createdAt: Date.parse(agent.createdAt) || 0, notice });
    if (!content) return;
    const file = this.transcriptPath(agent.id);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const st = this.state.agents[agent.id];
    const cwd = await this.placement(agent);
    const meta = JSON.stringify({ cwd, title: agent.name, url: agent.url, createdAtMs: Date.parse(agent.createdAt) || undefined, cloud: true, ...(st?.parent ? { parentAgentId: st.parent, description: st.description } : {}) });
    const metaPath = path.join(path.dirname(file), "meta.json");
    if ((await fs.promises.readFile(metaPath, "utf8").catch(() => "")) !== meta) await fs.promises.writeFile(metaPath, meta);
    const existed = fs.existsSync(file);
    if (existed && (await fs.promises.readFile(file, "utf8").catch(() => "")) === content) return;
    await fs.promises.writeFile(file, content);
    this.emit("session", { sessionId: agent.id, filePath: file, eventType: existed ? "change" : "add" });
  }

  /** Where the agent's session belongs locally: the checkout of its repo, else a stable placeholder. */
  private async placement(agent: CursorCloudAgent): Promise<string> {
    const repo = repoFromSourceUrl(agent.repos?.[0]?.url);
    const local = repo ? await this.resolveRepoDir(repo).catch(() => null) : null;
    if (local) return local;
    return repo ? `/cursor-cloud/${repo.owner}/${repo.name}` : "/cursor-cloud";
  }

  private noticePath(agentId: string): string {
    return path.join(this.rootDir, agentId, "notice.txt");
  }
  /** Record the line the agent's transcript opens with (see CursorCloudTranscriptInput.notice). */
  setNotice(agentId: string, notice: string): void {
    try {
      fs.mkdirSync(path.dirname(this.noticePath(agentId)), { recursive: true });
      fs.writeFileSync(this.noticePath(agentId), notice);
    } catch {}
  }

  private logPath(agentId: string): string {
    return path.join(this.rootDir, agentId, "events.json");
  }
  private agentLog(agentId: string): AgentLog {
    let log = this.logs.get(agentId);
    if (!log) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.logPath(agentId), "utf8"));
        log = { events: Array.isArray(parsed?.events) ? parsed.events : [], readRuns: Array.isArray(parsed?.readRuns) ? parsed.readRuns : [] };
      } catch {
        log = { events: [], readRuns: [] };
      }
      this.logs.set(agentId, log);
    }
    return log;
  }
  /** The stream expires after a day; the log kept here is what outlives it. */
  private saveLog(agentId: string): void {
    try {
      fs.mkdirSync(path.dirname(this.logPath(agentId)), { recursive: true });
      fs.writeFileSync(this.logPath(agentId), JSON.stringify(this.agentLog(agentId)));
    } catch {}
  }

  /** Write-then-rename, so a crash mid-write never leaves a torn state file. */
  private async saveState(): Promise<void> {
    await fs.promises.mkdir(this.rootDir, { recursive: true });
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(this.state), { mode: 0o600 });
    await fs.promises.rename(tmp, this.statePath);
  }
}
