/**
 * OpenAI Agents API (platform.openai.com): the cloud agent adapter for the
 * public, managed Codex harness, driven with an OpenAI API key from Provider
 * Keys (`cast keys set openai`).
 *
 * A session (`sess_…`) runs in an OpenAI-hosted sandbox. When the codecast
 * session's folder is a GitHub checkout, the sandbox's setup clones that
 * repository (over public HTTPS: the sandbox has no GitHub credentials, so
 * it reaches public repositories and cannot push). Work happens in turns;
 * every API call carries the beta header `OpenAI-Beta: agents=v1`.
 *
 * Progress streams: the first message creates the session with
 * `stream: true`, a follow-up opens the session's event stream before it is
 * sent (streams never replay what they missed), and a running session the
 * mirror finds is followed the same way. Streamed items and text land in the
 * mirror's per-session record (events.json) and re-render it live. When a
 * turn ends, the saved turns and items are read again and merged in: they
 * are the record, and the stream only adds what they never keep (a command
 * cut off by a cancel). Items are the Codex harness's own, so each renders
 * as the app-server item it is through threadItemToMessage, the parser local
 * Codex sessions use.
 *
 * The core (watcher.ts, sessions.ts) does the rest, under
 * ~/.codecast/openai-agents/<session id>/, synced as a codex session.
 */
import { CLOUD_AGENT_PROVIDERS } from "@codecast/shared/contracts";
import { githubRepo } from "../cloud/gitOrigin.js";
import { threadItemToMessage, type ThreadItem } from "../codexAppServer.js";
import { readSse } from "../sse.js";
import { CloudApiError, requestCloudJson, requestCloudStream, verifyCloudKey } from "./http.js";
import { CLOUD_MAX_LIST_PAGES, repoOwnerName } from "./poll.js";
import { MirrorTranscript } from "./transcript.js";
import { CloudAgentBusyError, CloudAgentSetupError, errorText, logTag, type CloudAgentAdapter, type CloudAgentHandle, type CloudAgentListItem, type CloudAgentMirror } from "./types.js";
import type { CloudAgentSession } from "./sessions.js";

const AGENTS = CLOUD_AGENT_PROVIDERS.codex_api;
export const OPENAI_API_BASE = "https://api.openai.com/v1";
/** Bump when the rendered transcript changes shape: every mirror re-renders once. */
const MIRROR_FORMAT = 1;
/** Progress streams, so polls only find sessions started elsewhere and settle ones no stream follows. */
const POLL_MS = 60_000;
const FAST_POLL_MS = 15_000;
/** Where the sandbox puts the session's repository. */
const WORKSPACE = "/workspace";
/** A stream with nothing to say for this long is closed; the mirror opens another while the session still runs. */
const STREAM_QUIET_MS = 10 * 60_000;
/** A stream open this long on a session the list calls idle, and quiet as long, is one the session will never use (its message never came). */
const STREAM_GRACE_MS = 30_000;
/** A stream that ended this soon after opening waits before the next one, doubling up to STREAM_RETRY_MAX_MS. */
const STREAM_SHORT_MS = 5_000;
const STREAM_RETRY_MS = 2_000;
const STREAM_RETRY_MAX_MS = 60_000;
const TERMINAL_TURN_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

// ── Payloads (only the fields codecast reads) ────────────────────────────────

export interface AgentsSession {
  id: string;
  status: "idle" | "in_progress" | "requires_action" | "failed" | string;
  created_at: number;
  last_active_at?: number;
  /** The beta API's session error: a message, or null. */
  error?: string | null;
  metadata?: Record<string, string>;
  agent?: { model?: string };
  usage?: { total_tokens?: number } | null;
}

export interface AgentsTurn {
  id: string;
  /** Set on a subagent's turn: only the root agent's turns are the transcript. */
  subagent_id?: string | null;
  status: "queued" | "in_progress" | "completed" | "failed" | "cancelled" | string;
  created_at: number;
  started_at?: number | null;
  completed_at?: number | null;
  error?: { code?: string | null; message?: string | null } | null;
}

/** One saved or streamed item: a message, reasoning, a command, a tool call. */
export interface AgentsItem {
  type: string;
  id: string;
  turn_id?: string;
  status?: string | null;
  role?: "user" | "assistant";
  phase?: "commentary" | "final_answer" | null;
  content?: Array<{ type: string; text?: string; image_url?: string; encrypted_content?: string }>;
  summary?: Array<{ type?: string; text?: string }>;
  command?: string;
  cwd?: string | null;
  output?: unknown;
  exit_code?: number | null;
  duration_ms?: number | null;
  name?: string;
  server_label?: string;
  arguments?: unknown;
  error?: unknown;
  call_id?: string;
  title?: string | null;
  action?: { type?: string; query?: string | null; queries?: string[] | null; url?: string | null; pattern?: string | null } | null;
  agent_id?: string;
  sender_agent_id?: string;
  recipient_agent_id?: string;
  recipient_agent_ids?: string[];
}

/** One event from a session's stream. */
export interface AgentsEvent {
  type: string;
  session?: AgentsSession;
  session_id?: string;
  turn_id?: string | null;
  turn?: AgentsTurn;
  item?: AgentsItem;
  item_id?: string;
  content_index?: number;
  summary_index?: number;
  delta?: string;
  text?: string;
  environment?: { status?: string; error?: { message?: string; code?: string } | null };
  error?: { message?: string; code?: string | null } | null;
}

interface AgentsPage<T> { data?: T[]; has_more?: boolean; last_id?: string | null }

// ── API client ───────────────────────────────────────────────────────────────

export class OpenAIAgentsApi {
  constructor(private readonly key: string, private readonly fetchImpl: typeof fetch = fetch, private readonly base = OPENAI_API_BASE) {}

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.key}`, "OpenAI-Beta": "agents=v1" };
  }

  /** Errors come as {error: {type, code, message}}. */
  request<T>(method: string, p: string, body?: unknown): Promise<T> {
    return requestCloudJson<T>(this.fetchImpl, { method, url: `${this.base}${p}`, headers: this.headers(), body, label: `openai agents ${method} ${p.split("?")[0]}` });
  }

  /**
   * A request answered with the session's events. Resolves once the stream
   * is open (the API is listening from then on), to its events as they come,
   * until it ends or `signal` aborts it.
   */
  async openEvents(method: "GET" | "POST", p: string, body: unknown, signal: AbortSignal): Promise<AsyncGenerator<AgentsEvent>> {
    const stream = await requestCloudStream(this.fetchImpl, { method, url: `${this.base}${p}`, headers: this.headers(), body, label: `openai agents ${method} ${p.split("?")[0]} stream`, signal });
    return (async function* () {
      for await (const frame of readSse(stream)) {
        try { yield JSON.parse(frame.data) as AgentsEvent; } catch {}
      }
    })();
  }
  /** The session's event stream from now on (streams never replay what they missed). */
  sessionEvents(id: string, signal: AbortSignal): Promise<AsyncGenerator<AgentsEvent>> {
    return this.openEvents("GET", `/agents/sessions/${encodeURIComponent(id)}/events?stream=true`, undefined, signal);
  }

  listSessions(limit = 50, after?: string): Promise<AgentsPage<AgentsSession>> {
    const q = new URLSearchParams({ limit: String(limit), order: "desc", ...(after ? { after } : {}) });
    return this.request("GET", `/agents/sessions?${q}`);
  }
  session(id: string): Promise<AgentsSession> {
    return this.request("GET", `/agents/sessions/${encodeURIComponent(id)}`);
  }
  turns(id: string): Promise<AgentsTurn[]> {
    return this.allPages(`/agents/sessions/${encodeURIComponent(id)}/turns`);
  }
  items(id: string): Promise<AgentsItem[]> {
    return this.allPages(`/agents/sessions/${encodeURIComponent(id)}/items`);
  }
  /** Submit input events: a message, or a cancel. Answers 202 with nothing. */
  sendEvents(id: string, events: unknown[]): Promise<unknown> {
    return this.request("POST", `/agents/sessions/${encodeURIComponent(id)}/events`, { events });
  }

  /** Every page of a session's list, oldest first. */
  private async allPages<T>(p: string): Promise<T[]> {
    const out: T[] = [];
    let after: string | undefined;
    for (let page = 0; page < CLOUD_MAX_LIST_PAGES * 4; page++) {
      const q = new URLSearchParams({ order: "asc", limit: "100", ...(after ? { after } : {}) });
      const data = await this.request<AgentsPage<T>>("GET", `${p}?${q}`);
      out.push(...(data.data ?? []));
      if (!data.has_more || !data.last_id) break;
      after = data.last_id;
    }
    return out;
  }
}

/**
 * Check an OpenAI key before it is stored. The key is the one every client
 * that reads OPENAI_API_KEY gets too, so the check is that OpenAI knows it
 * (GET /v1/models), not what it may do: a key restricted away from listing
 * models (403) is still a key, and one without the Agents API's permissions
 * is refused in OpenAI's words on the session that needed them.
 */
export function verifyOpenAIAgentsKey(key: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: true; account?: string } | { ok: false; error: string }> {
  return verifyCloudKey("OpenAI", async () => {
    try {
      await new OpenAIAgentsApi(key, fetchImpl).request("GET", "/models");
    } catch (err) {
      if (!(err instanceof CloudApiError && err.status === 403)) throw err;
    }
  });
}

function messageInput(text: string) {
  return [{ role: "user", content: [{ type: "input_text", text }] }];
}

// ── The session's record (events.json) ───────────────────────────────────────

/**
 * What the mirror keeps per session: its root agent's turns, and every item
 * seen in order (saved ones, and ones only the stream showed), each with the
 * time it was first seen, which dates its record for good.
 */
export interface AgentsSessionLog {
  session?: AgentsSession;
  turns: Record<string, AgentsTurn>;
  items: AgentsItem[];
  at: Record<string, number>;
  /** Why the sandbox could not be set up, as the stream said it (the saved session only says it failed). */
  environmentError?: string;
  /** The last failure the stream reported. */
  streamError?: string;
}

export function emptyAgentsLog(raw?: any): AgentsSessionLog {
  return {
    ...(raw?.session ? { session: raw.session } : {}),
    turns: raw?.turns && typeof raw.turns === "object" ? raw.turns : {},
    items: Array.isArray(raw?.items) ? raw.items : [],
    at: raw?.at && typeof raw.at === "object" ? raw.at : {},
    ...(typeof raw?.environmentError === "string" ? { environmentError: raw.environmentError } : {}),
    ...(typeof raw?.streamError === "string" ? { streamError: raw.streamError } : {}),
  };
}

function findItem(log: AgentsSessionLog, id: string | undefined): AgentsItem | undefined {
  if (!id) return undefined;
  for (let i = log.items.length - 1; i >= 0; i--) if (log.items[i].id === id) return log.items[i];
  return undefined;
}

/** Add a copy of an item (streamed text then grows the copy), or replace the one with its id where it stands; a new one is dated `at`. */
function upsertItem(log: AgentsSessionLog, given: AgentsItem, at?: number): void {
  const item = structuredClone(given);
  const prior = findItem(log, item.id);
  if (prior) log.items[log.items.indexOf(prior)] = item;
  else log.items.push(item);
  if (at !== undefined) log.at[item.id] ??= at;
}

function textPart(item: AgentsItem, index = 0): { type: string; text?: string } {
  item.content ??= [];
  while (item.content.length <= index) item.content.push({ type: "output_text", text: "" });
  return item.content[index];
}

function summaryPart(item: AgentsItem, index = 0): { type?: string; text?: string } {
  item.summary ??= [];
  while (item.summary.length <= index) item.summary.push({ type: "summary_text", text: "" });
  return item.summary[index];
}

/** Fold one streamed event into the session's record. Pure but for `log`. */
export function applyAgentsEvent(log: AgentsSessionLog, e: AgentsEvent, now: number): void {
  if (e.session) log.session = e.session;
  if (e.turn?.id) log.turns[e.turn.id] = e.turn;
  switch (e.type) {
    case "agent.session.turn.item.added":
    case "agent.session.turn.item.done":
      if (e.item?.id) upsertItem(log, e.item, now);
      return;
    case "agent.session.turn.output_text.delta": {
      const item = findItem(log, e.item_id);
      if (item && e.delta) { const part = textPart(item, e.content_index); part.text = (part.text ?? "") + e.delta; }
      return;
    }
    case "agent.session.turn.output_text.done": {
      const item = findItem(log, e.item_id);
      if (item && typeof e.text === "string") textPart(item, e.content_index).text = e.text;
      return;
    }
    case "agent.session.turn.reasoning_summary_text.delta": {
      const item = findItem(log, e.item_id);
      if (item && e.delta) { const part = summaryPart(item, e.summary_index); part.text = (part.text ?? "") + e.delta; }
      return;
    }
    case "agent.session.turn.reasoning_summary_text.done": {
      const item = findItem(log, e.item_id);
      if (item && typeof e.text === "string") summaryPart(item, e.summary_index).text = e.text;
      return;
    }
    case "agent.output.command_execution_output.delta": {
      const item = findItem(log, e.item_id);
      if (item && e.delta) item.output = `${typeof item.output === "string" ? item.output : ""}${e.delta}`;
      return;
    }
    case "agent.session.environment.failed":
      if (e.environment?.error?.message) log.environmentError = e.environment.error.message;
      return;
    case "error":
      if (e.error?.message) log.streamError = e.error.message;
      return;
  }
}

function secondsToMs(s: number | null | undefined): number | undefined {
  return typeof s === "number" && Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : undefined;
}

/** The root agent's turns, oldest first. */
function rootTurns(log: AgentsSessionLog): AgentsTurn[] {
  return Object.values(log.turns).filter((t) => !t.subagent_id).sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
}

/**
 * Merge what the API saved: its turns, and its items over the ones streamed
 * (an item it saved replaces the streamed copy where that stands; one only
 * the stream showed stays). An item never seen before is dated by its turn's
 * start, one millisecond after the item before it in that turn.
 */
export function absorbSaved(log: AgentsSessionLog, turns: AgentsTurn[], items: AgentsItem[]): void {
  for (const t of turns) log.turns[t.id] = t;
  for (const item of items) upsertItem(log, item);
  const last = new Map<string, number>();
  for (const item of log.items) {
    const turn = item.turn_id ? log.turns[item.turn_id] : undefined;
    const start = secondsToMs(turn?.created_at) ?? secondsToMs(log.session?.created_at) ?? 0;
    const prev = last.get(item.turn_id ?? "") ?? start - 1;
    log.at[item.id] ??= Math.max(start, prev + 1);
    last.set(item.turn_id ?? "", log.at[item.id]);
  }
}

// ── Transcript ───────────────────────────────────────────────────────────────

function texts(item: AgentsItem, type: string): string {
  return (item.content ?? []).filter((c) => c.type === type && typeof c.text === "string").map((c) => c.text!).join("");
}

function asText(v: unknown): string {
  return typeof v === "string" ? v : v === null || v === undefined ? "" : JSON.stringify(v);
}

function parsedArgs(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return v; }
}

/** The subagent tools the harness records, by item type: delegation reads as Codex's collab calls do. */
const SUBAGENT_TOOLS: Record<string, string> = {
  create_subagent_call: "spawnAgent",
  send_subagent_input_call: "sendInput",
  resume_subagent_call: "resumeAgent",
  wait_for_subagents_call: "wait",
  interrupt_subagent_call: "interruptAgent",
  close_subagent_call: "closeAgent",
};

/**
 * An Agents API item as the Codex app-server item it is (the managed harness
 * is Codex): a message, reasoning, a command, an MCP call, a web search, a
 * function or computer-use call, a subagent call. `outputs`: function results
 * by call id. Null for what the transcript does not show.
 */
export function agentsItemToThreadItem(item: AgentsItem, outputs: Map<string, string>): ThreadItem | null {
  const status = item.status ?? "completed";
  switch (item.type) {
    case "message":
      if (item.role === "user") return { type: "userMessage", id: item.id, content: [{ type: "text", text: texts(item, "input_text") }] };
      return { type: "agentMessage", id: item.id, text: texts(item, "output_text"), phase: item.phase ?? null };
    case "reasoning":
      return { type: "reasoning", id: item.id, content: [], summary: (item.summary ?? []).map((s) => s.text ?? "").filter(Boolean) };
    case "command_execution":
      return { type: "commandExecution", id: item.id, command: item.command ?? "", ...(item.cwd ? { cwd: item.cwd } : {}), status, aggregatedOutput: asText(item.output), exitCode: item.exit_code ?? null, durationMs: item.duration_ms ?? null };
    case "mcp_call":
      return {
        type: "mcpToolCall", id: item.id, server: item.server_label ?? "mcp", tool: item.name ?? "tool", arguments: parsedArgs(item.arguments), status,
        result: item.output === null || item.output === undefined ? null : { content: Array.isArray(item.output) ? item.output : [item.output] },
        error: item.error ? { message: asText(item.error) } : null,
      };
    case "web_search_call": {
      const a = item.action;
      return { type: "webSearch", id: item.id, query: a?.query ?? a?.queries?.join(", ") ?? a?.url ?? a?.pattern ?? "" };
    }
    case "function_call": {
      const out = item.call_id ? outputs.get(item.call_id) : undefined;
      return { type: "dynamicToolCall", id: item.id, tool: item.name ?? "function", arguments: parsedArgs(item.arguments), status, ...(out !== undefined ? { contentItems: [{ type: "inputText", text: out }] } : {}) };
    }
    case "computer_use_call":
      return { type: "dynamicToolCall", id: item.id, tool: "computer_use", arguments: item.title ? { title: item.title } : {}, status };
    default: {
      const tool = SUBAGENT_TOOLS[item.type];
      if (!tool) return null;
      const receivers = item.recipient_agent_ids ?? (item.recipient_agent_id ? [item.recipient_agent_id] : []);
      return { type: "collabAgentToolCall", id: item.id, tool, status, senderThreadId: item.sender_agent_id ?? item.agent_id ?? "", receiverThreadIds: receivers, prompt: texts(item, "output_text") || null };
    }
  }
}

/**
 * Why the sandbox failed to set up, when the stream said: a clone is the
 * usual cause, and the sandbox clones without GitHub credentials.
 */
function setupNote(log: AgentsSessionLog): string {
  if (!log.environmentError) return "";
  const repo = log.session?.metadata?.repo;
  return ` The sandbox could not be set up (${log.environmentError}).${repo ? ` Its setup clones ${repo} from GitHub without credentials, so it reaches public repositories only.` : ""}`;
}

function isRunningTurn(turn: AgentsTurn): boolean {
  return !TERMINAL_TURN_STATUSES.has(turn.status);
}

export interface AgentsTranscriptInput {
  log: AgentsSessionLog;
  /** Clock for anything the payload does not date. */
  createdAt: number;
  notice?: string;
}

/**
 * The session's transcript in the mirror format (transcript.ts): each root
 * turn's items in the order they came, each record id'd by its item and
 * dated when it was first seen, so a re-render never moves or duplicates a
 * row. A running turn's items show as they stream (a command still running
 * has no result yet); an ended turn says how it ended.
 */
export function buildAgentsTranscript(input: AgentsTranscriptInput): string {
  const { log } = input;
  const tx = new MirrorTranscript(input.createdAt, { notice: input.notice });
  const outputs = new Map<string, string>();
  for (const item of log.items) if (item.type === "function_call_output" && item.call_id) outputs.set(item.call_id, asText(item.output));
  const byTurn = new Map<string, AgentsItem[]>();
  for (const item of log.items) if (item.turn_id) byTurn.set(item.turn_id, [...(byTurn.get(item.turn_id) ?? []), item]);
  const turns = rootTurns(log);
  for (const turn of turns) {
    tx.advanceTo(secondsToMs(turn.created_at));
    for (const item of byTurn.get(turn.id) ?? []) {
      const thread = agentsItemToThreadItem(item, outputs);
      const m = thread && threadItemToMessage(thread, log.at[item.id] ?? tx.clock);
      if (!m) continue;
      // A command or call still running has no result yet.
      if (item.status === "in_progress") delete m.toolResults;
      tx.message(m);
    }
    if (isRunningTurn(turn)) continue;
    const ended = secondsToMs(turn.completed_at) ?? tx.clock;
    if (turn.status === "failed") tx.error(`${turn.id}:error`, `${AGENTS.label} turn failed: ${turn.error?.message || turn.error?.code || log.streamError || "no reason given"}.${setupNote(log)}`, ended);
    else if (turn.status === "cancelled") tx.note(`${turn.id}:cancelled`, "Cancelled.", ended);
    tx.turnEnded();
  }
  const session = log.session;
  if (session?.status === "failed" && !turns.some((t) => t.status === "failed")) {
    tx.error("session:error", `${AGENTS.label} session failed: ${session.error || log.streamError || "no reason given"}.${setupNote(log)}`);
    tx.turnEnded();
  }
  return tx.toString();
}

function sessionVersion(s: AgentsSession): string {
  // last_active_at does not move as turns run (verified 2026-10-01); the token count does.
  return `${s.status}|${s.usage?.total_tokens ?? 0}|${s.last_active_at ?? ""}`;
}

// ── Live streams ─────────────────────────────────────────────────────────────

/**
 * One session's event stream. Opened before the session has a mirror handle
 * (create, a follow-up), it keeps what arrives until the mirror attaches.
 */
class SessionStream {
  readonly controller = new AbortController();
  readonly openedAt: number;
  lastEventAt: number;
  ended = false;
  private handle?: CloudAgentHandle<AgentsSessionLog>;
  private readonly buffer: Array<{ e: AgentsEvent; at: number }> = [];

  constructor(private readonly now: () => number) {
    this.openedAt = this.lastEventAt = now();
  }

  get attached(): boolean {
    return !!this.handle;
  }

  /** Give the stream its mirror handle: what it kept lands now. True on the first attach. */
  attach(handle: CloudAgentHandle<AgentsSessionLog>): boolean {
    if (this.handle) return false;
    this.handle = handle;
    for (const { e, at } of this.buffer.splice(0)) applyAgentsEvent(handle.data(), e, at);
    return true;
  }

  push(e: AgentsEvent): void {
    this.lastEventAt = this.now();
    if (!this.handle) { this.buffer.push({ e, at: this.lastEventAt }); return; }
    applyAgentsEvent(this.handle.data(), e, this.lastEventAt);
    this.handle.save();
    this.handle.scheduleRender();
  }

  /** Mirror the session from the API again (the stream ended). */
  follow(): void {
    void this.handle?.follow();
  }

  log(msg: string): void {
    this.handle?.log(msg);
  }
}

/** A root turn's end, or the session's: what a stream follows a turn until. */
function endsTurn(e: AgentsEvent): boolean {
  if (e.type === "agent.session.failed") return true;
  return (e.type === "agent.session.turn.completed" || e.type === "agent.session.turn.failed" || e.type === "agent.session.turn.cancelled") && !e.turn?.subagent_id;
}

// ── Adapter ──────────────────────────────────────────────────────────────────

export interface OpenAIAgentsAdapterOptions {
  /** The OpenAI API key on this machine, or null. */
  readKey: () => string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export class OpenAIAgentsAdapter implements CloudAgentAdapter<OpenAIAgentsApi, AgentsSession, AgentsSessionLog> {
  readonly spec = AGENTS;
  readonly mirrorFormat = MIRROR_FORMAT;
  readonly pollMs = POLL_MS;
  readonly fastPollMs = FAST_POLL_MS;
  readonly steersRunningTurn = true;
  /** Live streams by session id. */
  private readonly streams = new Map<string, SessionStream>();
  /** Sessions whose stream keeps ending as soon as it opens: when the next may open, and how long the wait after that is. */
  private readonly streamRetry = new Map<string, { at: number; waitMs: number }>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: OpenAIAgentsAdapterOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  client(): OpenAIAgentsApi | CloudAgentSetupError {
    const key = this.opts.readKey();
    return key ? new OpenAIAgentsApi(key, this.fetchImpl) : CloudAgentSetupError.credentialsMissing(this);
  }

  loadData(raw: unknown): AgentsSessionLog {
    return emptyAgentsLog(raw);
  }

  async listAgents(api: OpenAIAgentsApi, cursor?: string): Promise<{ items: CloudAgentListItem<AgentsSession>[]; nextCursor?: string }> {
    const page = await api.listSessions(50, cursor);
    const sessions = (page.data ?? []).filter((s) => typeof s?.id === "string");
    return {
      items: sessions.map((s) => ({ id: s.id, updatedAtMs: secondsToMs(s.last_active_at) ?? secondsToMs(s.created_at) ?? 0, version: sessionVersion(s), active: s.status === "in_progress", agent: s })),
      nextCursor: page.has_more && page.last_id ? page.last_id : undefined,
    };
  }

  /**
   * Render the session. While a stream follows it, from the record the stream
   * keeps (no API read); otherwise, and when a stream first attaches, the
   * saved turns and items are read and merged in. A running session no stream
   * follows gets one.
   */
  async mirror(api: OpenAIAgentsApi, handle: CloudAgentHandle<AgentsSessionLog>, known: AgentsSession | undefined): Promise<CloudAgentMirror> {
    const id = handle.agentId;
    const log = handle.data();
    const session = known ?? await api.session(id);
    let stream = this.streams.get(id);
    // A stream left open on a session that went idle without using it (a message that never arrived).
    if (stream && !stream.ended && session.status !== "in_progress" && this.now() - stream.openedAt > STREAM_GRACE_MS && this.now() - stream.lastEventAt > STREAM_GRACE_MS) {
      stream.controller.abort();
      this.streams.delete(id);
      stream = undefined;
    }
    const firstAttach = stream ? stream.attach(handle) : false;
    if (stream?.ended) { this.streams.delete(id); stream = undefined; }
    if (!stream || firstAttach) {
      const [turns, items] = await Promise.all([api.turns(id), api.items(id)]);
      log.session = session;
      absorbSaved(log, turns, items);
    }
    // While a stream follows it, the stream's own session events are newer than a listed copy.
    log.session ??= session;
    const running = session.status === "in_progress" || rootTurns(log).some(isRunningTurn);
    if (running && !this.streams.has(id)) this.followRunning(api, handle);
    handle.save();
    const createdAt = secondsToMs(session.created_at) ?? 0;
    return {
      transcript: buildAgentsTranscript({ log, createdAt, notice: await handle.notice() }),
      title: session.metadata?.title || undefined,
      createdAtMs: createdAt,
      repo: session.metadata?.repo || undefined,
      version: sessionVersion(session),
      running,
      // The sandbox has no GitHub credentials: the session pushes no branch.
      git: null,
    };
  }

  stop(): void {
    for (const s of this.streams.values()) s.controller.abort();
    this.streams.clear();
  }

  /** Open the stream of a running session the mirror found, unless one just kept ending as soon as it opened. */
  private followRunning(api: OpenAIAgentsApi, handle: CloudAgentHandle<AgentsSessionLog>): void {
    const retry = this.streamRetry.get(handle.agentId);
    if (retry && this.now() < retry.at) return;
    const stream = new SessionStream(this.now);
    stream.attach(handle);
    void this.run(handle.agentId, stream, api.sessionEvents(handle.agentId, stream.controller.signal));
  }

  /**
   * Follow a session's events until its turn ends, the stream ends or goes
   * quiet, or the adapter stops; then the session is mirrored from the API
   * again (which opens another stream if it still runs).
   */
  private async run(sessionId: string, stream: SessionStream, opening: Promise<AsyncGenerator<AgentsEvent>>): Promise<void> {
    this.streams.set(sessionId, stream);
    let quiet: NodeJS.Timeout | undefined;
    const armQuiet = () => {
      if (quiet) clearTimeout(quiet);
      quiet = setTimeout(() => stream.controller.abort(), STREAM_QUIET_MS);
    };
    let events: AsyncGenerator<AgentsEvent> | undefined;
    let saw = false;
    try {
      armQuiet();
      events = await opening;
      for await (const e of events) {
        saw = true;
        armQuiet();
        stream.push(e);
        if (endsTurn(e)) break;
      }
    } catch (err) {
      if (!stream.controller.signal.aborted) stream.log(`${logTag(this)} ${sessionId} stream dropped: ${errorText(err)}`);
    } finally {
      if (quiet) clearTimeout(quiet);
      stream.controller.abort();
    }
    stream.ended = true;
    // Stopped with the adapter, or replaced: nothing more for this stream to do.
    if (this.streams.get(sessionId) !== stream) return;
    // One the mirror has not attached yet stays, for it to take what it kept.
    if (stream.attached) this.streams.delete(sessionId);
    const short = !saw && this.now() - stream.openedAt < STREAM_SHORT_MS;
    if (short) {
      const waitMs = Math.min((this.streamRetry.get(sessionId)?.waitMs ?? STREAM_RETRY_MS / 2) * 2, STREAM_RETRY_MAX_MS);
      this.streamRetry.set(sessionId, { at: this.now() + waitMs, waitMs });
    } else this.streamRetry.delete(sessionId);
    stream.follow();
  }

  /**
   * A new session with the first message, streamed from the start. Its setup
   * clones the session's GitHub repository when it has one (the sandbox works
   * in /workspace/<name>), and its model is the launch's or the provider's
   * default. Resolves once the API names the session; the rest of the stream
   * is the session's live progress.
   */
  async create(api: OpenAIAgentsApi, session: CloudAgentSession, content: string): Promise<{ agentId: string; url?: string }> {
    const repo = repoOwnerName(githubRepo(session.repoUrl));
    const ref = session.startingRef;
    const dir = repo ? `${WORKSPACE}/${repo.name}` : WORKSPACE;
    const where = repo
      ? `Cloned ${repo.owner}/${repo.name}${ref ? ` at \`${ref}\`` : " (its default branch)"} into an OpenAI-hosted sandbox, which can't push to GitHub.`
      : "Started in an empty OpenAI-hosted sandbox: this session's folder has no GitHub remote to clone.";
    session.notice = [session.notice, where].filter(Boolean).join(" ");
    const stream = new SessionStream(this.now);
    const events = await api.openEvents("POST", "/agents/sessions", {
      agent: {
        model: session.model || AGENTS.defaultModel,
        ...(repo ? { instructions: `The repository ${repo.owner}/${repo.name} is checked out at ${dir}; work there. This sandbox has no GitHub credentials: leave your changes in the working tree and say what you changed.` } : {}),
      },
      environment: {
        type: "openai_hosted",
        ...(repo ? { setup_commands: [{ command: `git clone --depth 50 ${ref ? `--branch ${shellQuote(ref)} ` : ""}https://github.com/${repo.owner}/${repo.name}.git ${shellQuote(repo.name)}`, cwd: WORKSPACE }] } : {}),
      },
      input: content,
      metadata: { source: "codecast", ...(repo ? { repo: `${repo.owner}/${repo.name}` } : {}) },
      stream: true,
    }, stream.controller.signal);
    // The stream opens with the session it created.
    let created: AgentsEvent | undefined;
    try {
      for (let i = 0; i < 20 && !created; i++) {
        const next = await events.next();
        if (next.done) break;
        stream.push(next.value);
        if (next.value.type === "agent.session.created") created = next.value;
      }
    } catch (err) {
      stream.controller.abort();
      throw err;
    }
    const agentId = created?.session?.id;
    if (!agentId) {
      stream.controller.abort();
      throw new Error(`${AGENTS.label} created no session`);
    }
    void this.run(agentId, stream, Promise.resolve(events));
    return { agentId };
  }

  /**
   * A follow-up: it starts a turn on an idle session and steers a running
   * one. The session's stream opens first (streams never replay what they
   * missed), unless one already follows it.
   */
  async followUp(api: OpenAIAgentsApi, agentId: string, content: string): Promise<void> {
    let opened: SessionStream | undefined;
    if (!this.streams.has(agentId)) {
      opened = new SessionStream(this.now);
      const opening = api.sessionEvents(agentId, opened.controller.signal);
      void this.run(agentId, opened, opening);
      // Listening before the message goes out. A stream that fails to open leaves the message to go out anyway: the mirror reads what the turn saved.
      await opening.catch(() => {});
    }
    try {
      await api.sendEvents(agentId, [{ type: "agent.session.input.message", input: messageInput(content) }]);
    } catch (err) {
      if (opened) { opened.controller.abort(); if (this.streams.get(agentId) === opened) this.streams.delete(agentId); }
      // The running turn cannot take more input (active_turn_not_steerable): held until it ends.
      if (err instanceof CloudApiError && err.status === 409) throw new CloudAgentBusyError(AGENTS.label);
      throw err;
    }
  }

  /** Cancel the running turn; the session and its work stay. */
  async cancel(api: OpenAIAgentsApi, agentId: string): Promise<string | null> {
    const session = await api.session(agentId);
    if (session.status !== "in_progress") return null;
    await api.sendEvents(agentId, [{ type: "agent.session.input.cancel" }]);
    return "the running turn";
  }

  verifyKey(key: string) {
    return verifyOpenAIAgentsKey(key, this.fetchImpl);
  }
}
