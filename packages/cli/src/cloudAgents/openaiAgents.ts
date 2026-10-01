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
 * Progress streams (the core's CloudAgentStreams): the first message
 * creates the session with `stream: true`, a follow-up opens the session's
 * event stream before it is sent (streams never replay what they missed), and
 * a running session the mirror finds is followed the same way. Streamed items
 * and text land in the mirror's per-session record (events.json) and
 * re-render it live. When a turn ends, the saved turns and items are read
 * again and merged in (absorbSaved): their order is the record, and the
 * stream only adds what they never keep (a command cut off by a cancel).
 * Items are the Codex harness's own, so each renders as the app-server item
 * it is through threadItemToMessage, the parser local Codex sessions use.
 *
 * The sandbox clones without GitHub credentials, so a session on a private
 * repository is refused before it is created (nothing is billed), with the
 * repository card that says so.
 *
 * The core (watcher.ts, sessions.ts) does the rest, under
 * ~/.codecast/openai-agents/<session id>/, synced as a codex session.
 */
import { randomUUID } from "crypto";
import { CLOUD_AGENT_PROVIDERS } from "@codecast/shared/contracts";
import { threadItemToMessage, type ThreadItem } from "../codexAppServer.js";
import { shellEscapeForSh } from "../supervision.js";
import { CloudApiError, KeyedCloudApi, verifyCloudKey } from "./http.js";
import { collectPages, secondsToMs } from "./poll.js";
import { clonesAnonymously, type CloudAgentSession } from "./sessions.js";
import { CloudAgentStreams, type CloudStreamSpec } from "./streams.js";
import { isRunningTurnStatus, MirrorTranscript, turnError } from "./transcript.js";
import { CloudAgentSetupError, keyedCloudClient, type CloudAgentAdapter, type CloudAgentCreated, type CloudAgentHandle, type CloudAgentListItem, type CloudAgentMirror, type KeyedCloudAdapterOptions } from "./types.js";
import type { ProviderKeyVerdict } from "../providerKeyCrypto.js";

const AGENTS = CLOUD_AGENT_PROVIDERS.codex_api;
const OPENAI_API_BASE = "https://api.openai.com/v1";
/** Bump when the rendered transcript changes shape: every mirror re-renders once. */
const MIRROR_FORMAT = 4;
/** Progress streams, so polls only find sessions started elsewhere and settle ones no stream follows. */
const POLL_MS = 60_000;
const FAST_POLL_MS = 15_000;
/** Where the sandbox puts the session's repository. */
const WORKSPACE = "/workspace";
/** A stream with nothing to say for this long is closed; the mirror opens another while the session still runs. */
const STREAM_QUIET_MS = 10 * 60_000;
/** A stream open this long on a session the list calls idle, and quiet as long, is one the session will never use (its message never came). */
const STREAM_GRACE_MS = 30_000;
/**
 * How long creating a session may take to name it before the attempt is
 * given up. The next try first looks for the session this one may have
 * created anyway (the create key in its metadata).
 */
const CREATE_TIMEOUT_MS = 60_000;
/** How many of the newest sessions a retried create looks through for the one an earlier try created. */
const CREATED_LOOKBACK = 20;
/**
 * The reasoning effort sessions run with. Without one OpenAI uses the model's
 * default, which is none on the small models (gpt-5.4-mini): seen live, a
 * first turn that never got a shell call right and ended with no answer.
 */
const REASONING_EFFORT = "medium";
/** How many pages of a session's items (100 each) one read reaches back, newest first. */
const ITEM_PAGES = 20;
/**
 * OpenAI can delete a sandbox after this long without activity, and the
 * session then goes on in a fresh one: same environment id, none of the
 * files earlier turns made (seen live 2026-10-01, after 62 minutes idle).
 */
const SANDBOX_IDLE_S = 60 * 60;

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

/** Whether the session is running a turn now. */
function sessionRunning(s: AgentsSession): boolean {
  return s.status === "in_progress";
}

/**
 * The session as the record keeps it: only the fields codecast reads. The
 * API's copy also carries its agent's setup, its environment and its vaults,
 * which a session started outside codecast may fill with anything.
 */
function sessionRecord(s: AgentsSession): AgentsSession {
  const { title, repo } = s.metadata ?? {};
  return {
    id: s.id,
    status: s.status,
    created_at: s.created_at,
    ...(s.last_active_at !== undefined ? { last_active_at: s.last_active_at } : {}),
    ...(s.error !== undefined ? { error: s.error } : {}),
    ...(title || repo ? { metadata: { ...(title ? { title } : {}), ...(repo ? { repo } : {}) } } : {}),
    ...(s.agent?.model ? { agent: { model: s.agent.model } } : {}),
    ...(s.usage ? { usage: { total_tokens: s.usage.total_tokens } } : {}),
  };
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

/** Errors come as {error: {type, code, message}}. */
export class OpenAIAgentsApi extends KeyedCloudApi {
  constructor(key: string, fetchImpl: typeof fetch = fetch, base = OPENAI_API_BASE) {
    super(key, fetchImpl, base, "openai agents");
  }

  protected headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.key}`, "OpenAI-Beta": "agents=v1" };
  }

  /**
   * A request answered with the session's events. Resolves once the stream
   * is open (the API is listening from then on), to its events as they come,
   * until it ends or `signal` aborts it.
   */
  async openEvents(method: "GET" | "POST", p: string, body: unknown, signal: AbortSignal): Promise<AsyncGenerator<AgentsEvent>> {
    const frames = await this.events<AgentsEvent>(method, p, { body, signal });
    return (async function* () {
      for await (const frame of frames) yield frame.data;
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
  /** The session's turns, oldest first, reading back from the newest only as far as `known` (one the record already has settled). */
  turns(id: string, known: (t: AgentsTurn) => boolean = () => false): Promise<AgentsTurn[]> {
    return this.newestPages(`/agents/sessions/${encodeURIComponent(id)}/turns`, known);
  }
  /** The session's items, oldest first, reading back from the newest only as far as `known`. */
  items(id: string, known: (i: AgentsItem) => boolean = () => false): Promise<AgentsItem[]> {
    return this.newestPages(`/agents/sessions/${encodeURIComponent(id)}/items`, known);
  }
  /** Submit input events: a message, or a cancel. Answers 202 with nothing. */
  sendEvents(id: string, events: unknown[]): Promise<unknown> {
    return this.request("POST", `/agents/sessions/${encodeURIComponent(id)}/events`, { events });
  }

  /**
   * A session's list read newest first (a long session's newest work is what
   * a read must not miss), page by page until a page reaches one `known`
   * says the record already has settled, or ITEM_PAGES; oldest first.
   */
  private async newestPages<T>(p: string, known: (t: T) => boolean): Promise<T[]> {
    const newest = await collectPages<T>(async (after) => {
      const q = new URLSearchParams({ order: "desc", limit: "100", ...(after ? { after } : {}) });
      const data = await this.request<AgentsPage<T>>("GET", `${p}?${q}`);
      const items = data.data ?? [];
      return { items, next: data.has_more && data.last_id && !items.some(known) ? data.last_id : undefined };
    }, ITEM_PAGES);
    return newest.reverse();
  }
}

/**
 * Check an OpenAI key before it is stored, against what the lane needs: one
 * Agents API read (GET /v1/agents/sessions). The key is also the one every
 * client that reads OPENAI_API_KEY gets (opencode, pi), so only a key OpenAI
 * does not know (401 invalid_api_key) is refused. Any other refusal from the
 * Agents API is about this lane, not the key: a restricted key missing a
 * scope (OpenAI answers that with 401 too), a project without the beta (404,
 * 400), an account out of credit (429). That key is kept, and the verdict
 * says what it lacks here.
 */
export function verifyOpenAIAgentsKey(key: string, fetchImpl: typeof fetch = fetch): Promise<ProviderKeyVerdict> {
  return verifyCloudKey(AGENTS.vendor, async () => {
    try {
      await new OpenAIAgentsApi(key, fetchImpl).listSessions(1);
    } catch (err) {
      if (!(err instanceof CloudApiError && err.fromApi && err.status >= 400 && err.status < 500) || err.code === INVALID_KEY) throw err;
      const scope = err.status === 401 || err.status === 403 ? " Give it the Agents permission, read and write, on OpenAI's API keys page." : "";
      return { detail: `It can't run ${AGENTS.label} sessions yet (${err.message.replace(/\.$/, "")}).${scope}` };
    }
  });
}

/** The code OpenAI answers a key it does not know with (wrong, revoked or deleted). */
const INVALID_KEY = "invalid_api_key";

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
  /**
   * Turns a saved read has seen ended: every item of theirs is in the record,
   * so a later read stops at them. A turn its stream saw end is not one yet
   * (an item whose end fell in a gap of the stream is only in the saved list).
   */
  readEnded: string[];
  /** Why the sandbox could not be set up, as the stream said it (the saved session only says it failed). */
  environmentError?: string;
  /** The last failure the stream reported. */
  streamError?: string;
}

export function emptyAgentsLog(raw?: any): AgentsSessionLog {
  return {
    ...(raw?.session ? { session: sessionRecord(raw.session) } : {}),
    turns: raw?.turns && typeof raw.turns === "object" ? raw.turns : {},
    items: Array.isArray(raw?.items) ? raw.items : [],
    at: raw?.at && typeof raw.at === "object" ? raw.at : {},
    readEnded: Array.isArray(raw?.readEnded) ? raw.readEnded.filter((id: unknown) => typeof id === "string") : [],
    ...(typeof raw?.environmentError === "string" ? { environmentError: raw.environmentError } : {}),
    ...(typeof raw?.streamError === "string" ? { streamError: raw.streamError } : {}),
  };
}

function findItem(log: AgentsSessionLog, id: string | undefined): AgentsItem | undefined {
  if (!id) return undefined;
  for (let i = log.items.length - 1; i >= 0; i--) if (log.items[i].id === id) return log.items[i];
  return undefined;
}

/**
 * Add a streamed copy of an item (streamed text then grows the copy), or
 * replace the one with its id where it stands; a new one is dated `at`. A
 * command's output the stream showed stays when its final copy has none (a
 * command a cancel cut off is saved without it).
 */
function upsertItem(log: AgentsSessionLog, given: AgentsItem, at: number): void {
  const item = structuredClone(given);
  const prior = findItem(log, item.id);
  if (prior && (item.output === null || item.output === undefined) && typeof prior.output === "string" && prior.output) item.output = prior.output;
  if (prior) log.items[log.items.indexOf(prior)] = item;
  else log.items.push(item);
  log.at[item.id] ??= at;
}

/** An item that will not change again (any status but in_progress). */
function itemSettled(item: AgentsItem): boolean {
  return item.status !== "in_progress";
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
  if (e.session) log.session = sessionRecord(e.session);
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

/** The root agent's turns, oldest first. */
function rootTurns(log: AgentsSessionLog): AgentsTurn[] {
  return Object.values(log.turns).filter((t) => !t.subagent_id).sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
}

/**
 * Merge what the API saved into the record, never moving it backwards.
 *
 * Turns: a saved turn replaces the kept one, unless the kept one already
 * ended and the saved copy (read earlier) still runs.
 *
 * Items, per turn: what the record already holds keeps its order (the
 * order rows were first shown in, which is when each started; the saved list
 * orders by completion, so a command run in the background comes after the
 * words said while it ran). An item only the saved list has (one a reopened
 * stream missed) goes right after the saved item before it. A saved item
 * replaces the kept copy, unless the kept one is settled and the saved one is
 * not; an item only the stream showed (a command a cancel cut off) stays. An
 * item seen for the first time is dated between its neighbours: one
 * millisecond after the item before it (the turn's start for the first),
 * below the next dated one, so a gap fills in where it happened.
 *
 * `live`: turns a stream followed from before they began; their saved items
 * wait until the turn ends (the stream shows them as they happen, and dates
 * them when they did).
 */
export function absorbSaved(log: AgentsSessionLog, turns: AgentsTurn[], items: AgentsItem[], live: ReadonlySet<string> = new Set()): void {
  for (const t of turns) {
    const kept = log.turns[t.id];
    if (!isRunningTurn(t) && !log.readEnded.includes(t.id)) log.readEnded.push(t.id);
    if (kept && !isRunningTurn(kept) && isRunningTurn(t)) continue;
    log.turns[t.id] = t;
  }
  const byTurn = new Map<string, AgentsItem[]>();
  for (const item of items) {
    if (!item.turn_id || live.has(item.turn_id)) continue;
    byTurn.set(item.turn_id, [...(byTurn.get(item.turn_id) ?? []), item]);
  }
  for (const [turnId, saved] of byTurn) {
    const kept = log.items.filter((i) => i.turn_id === turnId);
    const keptIds = new Set(kept.map((i) => i.id));
    const savedById = new Map(saved.map((i) => [i.id, i]));
    // Items only the saved list has, by the kept item the saved list puts before them ("" for none).
    const after = new Map<string, AgentsItem[]>();
    let anchor = "";
    for (const s of saved) {
      if (keptIds.has(s.id)) anchor = s.id;
      else after.set(anchor, [...(after.get(anchor) ?? []), structuredClone(s)]);
    }
    const merged: AgentsItem[] = [...(after.get("") ?? [])];
    for (const k of kept) {
      const s = savedById.get(k.id);
      merged.push(s && !(itemSettled(k) && !itemSettled(s)) ? structuredClone(s) : k);
      merged.push(...(after.get(k.id) ?? []));
    }
    const start = secondsToMs(log.turns[turnId]?.created_at) ?? secondsToMs(log.session?.created_at) ?? 0;
    let prev = start - 1;
    merged.forEach((item, k) => {
      if (log.at[item.id] === undefined) {
        const next = merged.slice(k + 1).map((i) => log.at[i.id]).find((at) => at !== undefined);
        log.at[item.id] = next === undefined ? prev + 1 : Math.max(prev, Math.min(prev + 1, next - 1));
      }
      prev = log.at[item.id];
    });
    log.items = [...log.items.filter((i) => i.turn_id !== turnId), ...merged];
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

/** What a command a cancel cut off shows when none of its output reached codecast. */
const STOPPED_COMMAND = "(stopped before it finished; no output reached codecast)";

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
    case "command_execution": {
      // OpenAI keeps no output for a command a cancel cut off; what the stream showed of it is all there is.
      const output = asText(item.output) || (status === "incomplete" ? STOPPED_COMMAND : "");
      return { type: "commandExecution", id: item.id, command: item.command ?? "", ...(item.cwd ? { cwd: item.cwd } : {}), status, aggregatedOutput: output, exitCode: item.exit_code ?? null, durationMs: item.duration_ms ?? null };
    }
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
  return isRunningTurnStatus(turn.status);
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
  turns.forEach((turn, i) => {
    tx.advanceTo(secondsToMs(turn.created_at));
    const prior = turns[i - 1];
    const idle = prior ? turn.created_at - (prior.completed_at ?? prior.created_at) : 0;
    if (idle > SANDBOX_IDLE_S) tx.note(`${turn.id}:idle`, `This turn came ${Math.floor(idle / 3600)}h+ after the last one ended. OpenAI can delete a sandbox after an hour without activity, so files from earlier turns may be gone.`);
    const items = byTurn.get(turn.id) ?? [];
    for (const item of items) {
      const thread = agentsItemToThreadItem(item, outputs);
      const m = thread && threadItemToMessage(thread, log.at[item.id] ?? tx.clock);
      if (!m) continue;
      // A command or call still running has no result yet.
      if (!itemSettled(item)) delete m.toolResults;
      tx.message(m);
    }
    if (isRunningTurn(turn)) return;
    // What the agent said to the person, as opposed to its working notes (commentary).
    const answered = items.some((i) => i.type === "message" && i.role === "assistant" && i.phase !== "commentary" && !!texts(i, "output_text").trim());
    tx.endTurn(turn.id, { status: turn.status, label: AGENTS.label, reason: `${turnError(turn.error, log.streamError)}.${setupNote(log)}`, at: secondsToMs(turn.completed_at), answered });
  });
  const session = log.session;
  if (session?.status === "failed" && !turns.some((t) => t.status === "failed")) {
    tx.error("session:error", `${AGENTS.label} session failed: ${turnError(session.error, log.streamError)}.${setupNote(log)}`);
    tx.turnEnded();
  }
  return tx.toString();
}

function sessionVersion(s: AgentsSession): string {
  // last_active_at does not move as turns run (verified 2026-10-01); the token count does.
  return `${s.status}|${s.usage?.total_tokens ?? 0}|${s.last_active_at ?? ""}`;
}

// ── Live streams ─────────────────────────────────────────────────────────────

/** A root turn's end, or the session's: what a stream follows a turn until. */
function endsTurn(e: AgentsEvent): boolean {
  if (e.type === "agent.session.failed") return true;
  return (e.type === "agent.session.turn.completed" || e.type === "agent.session.turn.failed" || e.type === "agent.session.turn.cancelled") && !e.turn?.subagent_id;
}

/** How a session's stream is followed: its events fold into the record until its turn ends, or it goes quiet. */
function sessionStream(open: CloudStreamSpec<AgentsEvent, AgentsSessionLog>["open"]): CloudStreamSpec<AgentsEvent, AgentsSessionLog> {
  return {
    open,
    apply: (e, log, at) => { applyAgentsEvent(log, e, at); return endsTurn(e) ? "end" : undefined; },
    quietMs: STREAM_QUIET_MS,
  };
}

/**
 * The session a create's stream names, once it names one. Throws OpenAI's
 * reason when the stream says the start failed instead.
 */
function createdSession(e: AgentsEvent): string | undefined {
  if (e.type === "agent.session.created") return e.session?.id;
  if (e.type === "error" || e.type === "agent.session.failed") throw new Error(`${AGENTS.label} could not start the session: ${turnError(e.error ?? e.session?.error)}`);
  return undefined;
}

/** The metadata key a create tags its session with, so a retry finds a session an earlier try created without hearing back. */
const CREATE_KEY = "codecast_create";

// ── Adapter ──────────────────────────────────────────────────────────────────

export interface OpenAIAgentsAdapterOptions extends KeyedCloudAdapterOptions {
  now?: () => number;
}

export class OpenAIAgentsAdapter implements CloudAgentAdapter<OpenAIAgentsApi, AgentsSession, AgentsSessionLog> {
  readonly spec = AGENTS;
  readonly mirrorFormat = MIRROR_FORMAT;
  readonly pollMs = POLL_MS;
  readonly fastPollMs = FAST_POLL_MS;
  readonly steersRunningTurn = true;
  /** Sessions list newest created first, and last_active_at never moves (verified 2026-10-01). */
  readonly listedByCreation = true;
  /** Live streams by session id. */
  readonly streams: CloudAgentStreams<AgentsEvent, AgentsSessionLog>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: OpenAIAgentsAdapterOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.streams = new CloudAgentStreams(this, { now: this.now });
  }

  client(): OpenAIAgentsApi | CloudAgentSetupError {
    return keyedCloudClient(this, this.opts.readKey, (key) => new OpenAIAgentsApi(key, this.fetchImpl));
  }

  loadData(raw: unknown): AgentsSessionLog {
    return emptyAgentsLog(raw);
  }

  async listAgents(api: OpenAIAgentsApi, cursor?: string): Promise<{ items: CloudAgentListItem<AgentsSession>[]; nextCursor?: string }> {
    const page = await api.listSessions(50, cursor);
    const sessions = (page.data ?? []).filter((s) => typeof s?.id === "string");
    return {
      items: sessions.map((s) => ({ id: s.id, updatedAtMs: secondsToMs(s.created_at) ?? 0, version: sessionVersion(s), active: sessionRunning(s), agent: s })),
      nextCursor: page.has_more && page.last_id ? page.last_id : undefined,
    };
  }

  /**
   * Render the session. While a stream follows it, from the record the stream
   * keeps (no API read). Otherwise, and when a stream first attaches, the
   * saved turns and items are read (back to what the record already has
   * settled) and merged in. A running session no stream follows gets one.
   */
  async mirror(api: OpenAIAgentsApi, handle: CloudAgentHandle<AgentsSessionLog>, known: AgentsSession | undefined): Promise<CloudAgentMirror> {
    const id = handle.agentId;
    const log = handle.data();
    const { first, live } = this.streams.attach(id, handle);
    let stream = live;
    // The stream's own session events keep the record's copy current.
    const session = known ?? (stream && !first && log.session ? log.session : await api.session(id));
    // A stream left open on a session that went idle without using it (a message that never arrived).
    if (stream && !sessionRunning(session) && this.now() - stream.openedAt > STREAM_GRACE_MS && this.now() - stream.lastEventAt > STREAM_GRACE_MS) {
      this.streams.drop(id, stream);
      stream = undefined;
    }
    if (!stream || first) {
      // What a saved read already saw ended is not read again: those turns, and their items.
      const settled = new Set(log.readEnded);
      const [turns, items] = await Promise.all([
        api.turns(id, (t) => settled.has(t.id)),
        api.items(id, (i) => !!i.turn_id && settled.has(i.turn_id)),
      ]);
      // A stream opened before its turn began (a create, a follow-up) shows that turn whole. The record
      // is the only copy of what the saved lists drop (a command a cancel cut off): never rebuild it from them alone.
      absorbSaved(log, turns, items, stream ? new Set(turns.filter(isRunningTurn).map((t) => t.id)) : undefined);
      if (!stream) log.session = sessionRecord(session);
    }
    log.session ??= sessionRecord(session);
    const running = sessionRunning(session) || rootTurns(log).some(isRunningTurn);
    if (running && !this.streams.has(id)) this.streams.follow(id, sessionStream((signal) => api.sessionEvents(id, signal)), { handle });
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

  /**
   * A new session with the first message, streamed from the start. Its setup
   * clones the session's GitHub repository when it has one (the sandbox works
   * in /workspace/<name>), once GitHub confirms anyone may clone it: a
   * private one is held with the repository card before anything is billed.
   * Its model is the launch's or the provider's default. Resolves once the
   * API names the session; the rest of the stream is its live progress. A
   * retry first takes the session an earlier try created without hearing
   * back, so a slow start is never billed twice.
   */
  async create(api: OpenAIAgentsApi, session: CloudAgentSession, content: string): Promise<CloudAgentCreated> {
    const { repo } = session;
    if (repo && (await clonesAnonymously(repo, this.fetchImpl)) === false) {
      throw CloudAgentSetupError.repoUnreachable(this, session, "the sandbox clones without GitHub credentials, and GitHub refuses an anonymous clone: the repository is private", `Codex Cloud on your ChatGPT plan reaches private repositories: start this message there instead, or make the repository public. See ${AGENTS.repoAccessUrl}`);
    }
    const ref = session.startingRef;
    const dir = repo ? `${WORKSPACE}/${repo.name}` : WORKSPACE;
    const notice = repo
      ? `Clones ${repo.owner}/${repo.name}${ref ? ` at \`${ref}\`` : " (its default branch)"} into an OpenAI-hosted sandbox, which can't push to GitHub.`
      : "Started in an empty OpenAI-hosted sandbox: this session's folder has no GitHub remote to clone.";
    const earlier = session.createKey ? (await api.listSessions(CREATED_LOOKBACK)).data?.find((s) => s.metadata?.[CREATE_KEY] === session.createKey) : undefined;
    if (earlier) return { agentId: earlier.id, notice };
    session.createKey ??= randomUUID();
    const body = {
      agent: {
        model: session.model || AGENTS.defaultModel,
        reasoning: { effort: REASONING_EFFORT },
        ...(repo ? { instructions: `The repository ${repo.owner}/${repo.name} is checked out at ${dir}; work there. This sandbox has no GitHub credentials: leave your changes in the working tree and say what you changed.` } : {}),
      },
      environment: {
        type: "openai_hosted",
        ...(repo ? { setup_commands: [{ command: `git clone --depth 50 ${ref ? `--branch ${shellEscapeForSh(ref)} ` : ""}https://github.com/${repo.owner}/${repo.name}.git ${shellEscapeForSh(repo.name)}`, cwd: WORKSPACE }] } : {}),
      },
      input: content,
      metadata: { source: "codecast", [CREATE_KEY]: session.createKey, ...(repo ? { repo: `${repo.owner}/${repo.name}` } : {}) },
      stream: true,
    };
    const agentId = await this.streams.start(
      { ...sessionStream((signal) => api.openEvents("POST", "/agents/sessions", body, signal)), openMs: CREATE_TIMEOUT_MS },
      createdSession,
    );
    return { agentId, notice };
  }

  /**
   * A follow-up: it starts a turn on an idle session and steers a running
   * one. The session's stream opens first (streams never replay what they
   * missed), unless one already follows it. A conflict (a turn that takes no
   * more input) is the core's to hold.
   */
  async followUp(api: OpenAIAgentsApi, agentId: string, content: string): Promise<void> {
    const opened = this.streams.has(agentId) ? undefined : this.streams.follow(agentId, sessionStream((signal) => api.sessionEvents(agentId, signal)));
    // Listening before the message goes out. A stream that fails to open leaves the message to go out anyway: the mirror reads what the turn saved.
    await opened?.opened;
    try {
      await api.sendEvents(agentId, [{ type: "agent.session.input.message", input: messageInput(content) }]);
    } catch (err) {
      if (opened) this.streams.drop(agentId, opened);
      throw err;
    }
  }

  /** Cancel the running turn; the session and its work stay. */
  async cancel(api: OpenAIAgentsApi, agentId: string): Promise<string | null> {
    if (!sessionRunning(await api.session(agentId))) return null;
    await api.sendEvents(agentId, [{ type: "agent.session.input.cancel" }]);
    return "the running turn";
  }

  verifyKey(key: string) {
    return verifyOpenAIAgentsKey(key, this.fetchImpl);
  }
}
