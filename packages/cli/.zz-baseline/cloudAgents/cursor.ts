/**
 * Cursor Cloud Agents (cursor.com/agents): the cloud agent adapter.
 *
 * The Cloud Agents API (api.cursor.com, v1) splits one agent into sequential
 * runs, one per prompt: GET /v1/agents lists them, each run's SSE stream
 * replays its assistant text and tool calls (kept 24h), and the v0
 * conversation endpoint keeps every prompt and reply as text for good. The
 * adapter merges the streams into one agent-wide log (kept in the mirror's
 * events.json, so it outlives the stream), follows a running run live, and
 * renders the transcript from the conversation and the log.
 *
 * The core (watcher.ts, sessions.ts) does the rest: the mirror under
 * ~/.codecast/cursor-cloud/<agent id>/, which the daemon syncs as a cursor
 * session (the mirror route every provider shares), and the create /
 * follow-up / cancel paths. The key is the user's
 * Cursor API key from the provider key store (`cast keys set cursor`).
 */
import { CLOUD_AGENT_PROVIDERS, isCloudAgentId } from "@codecast/shared/contracts";
import { CloudApiError, cloudApiVerdict, KeyedCloudApi, verifyCloudKey } from "./http.js";
import { collectPages } from "./poll.js";
import { CloudAgentStreams } from "./streams.js";
import { MirrorTranscript } from "./transcript.js";
import { CloudAgentSetupError, keyedCloudClient, type CloudAgentAdapter, type CloudAgentCreated, type CloudAgentGit, type KeyedCloudAdapterOptions, type CloudAgentHandle, type CloudAgentListItem, type CloudAgentMirror } from "./types.js";
import type { CloudAgentSession } from "./sessions.js";
import type { ProviderKeyVerdict } from "../providerKeyCrypto.js";

const CURSOR = CLOUD_AGENT_PROVIDERS.cursor;
/** Cursor links an agent by its bare id (`[Name](bc-…)`), which only its own app resolves. */
const AGENT_LINK = new RegExp(`\\]\\((${CURSOR.sessionIdPrefix}[0-9a-f-]{8,})\\)`, "g");
export const CURSOR_API_BASE = "https://api.cursor.com";
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

const KEPT_EVENTS: ReadonlySet<string> = new Set<CursorRunEvent["event"]>(["assistant", "tool_call", "result", "status", "turn_start", "turn_end", "step"]);

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

// ── API client ───────────────────────────────────────────────────────────────

/** Errors come as {error: {code, message}} (validation) or {code, message} (auth). */
export class CursorCloudApi extends KeyedCloudApi {
  constructor(key: string, fetchImpl: typeof fetch = fetch, base = CURSOR_API_BASE) {
    super(key, fetchImpl, base, "cursor cloud");
  }

  protected headers(): Record<string, string> {
    return { Authorization: `Basic ${Buffer.from(`${this.key}:`).toString("base64")}` };
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
  listRuns(agentId: string): Promise<CursorCloudRun[]> {
    return collectPages(async (cursor) => {
      const q = new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : {}) });
      const data = await this.request<{ items?: CursorCloudRun[]; nextCursor?: string }>("GET", `/v1/agents/${encodeURIComponent(agentId)}/runs?${q}`);
      return { items: data.items ?? [], next: data.nextCursor };
    });
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
   * A run's SSE stream: resolves once it is open, to its kept events as they
   * come until it ends. Despite the docs, a run's stream is the AGENT's event
   * stream from that run on: it carries every later turn too, each opened by
   * `turn_start` and closed by `turn_end`, with ids from one agent-wide
   * sequence (verified 2026-09-29). `lastEventId` resumes one cut short.
   * Throws 410 once it has expired.
   */
  async runEvents(agentId: string, runId: string, opts: { signal?: AbortSignal; lastEventId?: string } = {}): Promise<AsyncGenerator<CursorRunEvent>> {
    const frames = await this.events<Record<string, any>>("GET", `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/stream`, {
      headers: opts.lastEventId ? { "Last-Event-ID": opts.lastEventId } : {},
      signal: opts.signal,
      endEvent: "done",
    });
    return (async function* () {
      for await (const frame of frames) {
        const event = frame.event === "interaction_update" ? MARKERS[frame.data?.type] : frame.event;
        if (!event || !KEPT_EVENTS.has(event)) continue;
        yield { event: event as CursorRunEvent["event"], ...(frame.id ? { id: frame.id } : {}), data: frame.event === "interaction_update" ? {} : frame.data };
      }
    })();
  }

  /** Read a run's stream to its end, calling `onEvent` for each kept event. Resolves true when it saw a terminal `result`. */
  async streamRun(agentId: string, runId: string, onEvent: (e: CursorRunEvent) => void, opts: { signal?: AbortSignal; lastEventId?: string } = {}): Promise<boolean> {
    let sawResult = false;
    for await (const e of await this.runEvents(agentId, runId, opts)) {
      if (e.event === "result") sawResult = true;
      onEvent(e);
    }
    return sawResult;
  }
}

/**
 * Check a Cursor API key before it is stored: the account it belongs to, or
 * Cursor's reason for refusing it. A network failure is reported as such,
 * never as a bad key.
 */
export function verifyCursorKey(key: string, fetchImpl: typeof fetch = fetch): Promise<ProviderKeyVerdict> {
  return verifyCloudKey(CURSOR.vendor, async () => ({ account: (await new CursorCloudApi(key, fetchImpl).request<{ userEmail?: string }>("GET", "/v1/me"))?.userEmail }));
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

  const tx = new MirrorTranscript(input.createdAt, { linkify: (t) => t.replace(AGENT_LINK, `](${CURSOR.agentUrl("$1")})`), notice: input.notice });

  for (let i = 0; i < count; i++) {
    const turn = turns[i];
    const logged = i >= offset ? fromLog[i - offset] : undefined;
    tx.advanceTo(logged?.start);
    // Ids name what a row renders from (a conversation message, a stream
    // event, a call), so a row keeps its identity when a turn switches from
    // the conversation's text to the log's, or an earlier turn gains detail.
    tx.turn(turn?.promptId, turn?.prompt);

    if (logged && logged.events.some((e) => e.event === "assistant" || e.event === "tool_call")) {
      for (const e of logged.events) {
        if (e.event === "step") { tx.breakSegment(); continue; }
        if (e.event !== "assistant" && e.event !== "tool_call") continue;
        tx.clock = eventClock(e, tx.clock);
        if (e.event === "assistant" && typeof e.data.text === "string") {
          tx.appendText(e.id, e.data.text);
        } else if (e.event === "tool_call") {
          // A call can complete turns after it started (a forked worker's
          // `task` completes when the worker reports back): its result then
          // lands where it happened, under the call's one row.
          const use = cloudToolUse(e.data);
          tx.toolUse(use);
          if (e.data.status === "completed") {
            const res = cloudToolResult(e.data);
            tx.toolResult(use.id, res.content, res.isError);
          }
        }
      }
      tx.breakSegment();
    } else {
      for (const reply of turn?.replies ?? []) tx.assistant(reply.id, reply.text);
    }

    const isLast = i === count - 1;
    const run = input.latestRun;
    if (isLast && run && (run.status === "ERROR" || run.status === "EXPIRED")) {
      tx.error(`error-${run.id}`, `Cursor Cloud run ${run.status.toLowerCase()}`, Date.parse(run.updatedAt));
    }
    // Only the last turn can still be going: until its log closes it, or its run ends.
    if (!isLast || logged?.ended || !run || TERMINAL_RUN_STATUSES.has(run.status)) tx.turnEnded();
  }
  return tx.toString();
}

/** Forked workers a transcript's `task` calls started: their agent ids and descriptions. */
export function forkedWorkers(log: CursorRunEvent[]): Array<{ agentId: string; description?: string }> {
  const out = new Map<string, string | undefined>();
  for (const e of log) {
    const id = e.event === "tool_call" && e.data.name === "task" ? e.data.args?.agentId : undefined;
    if (typeof id === "string" && isCloudAgentId(CURSOR, id)) out.set(id, typeof e.data.args?.description === "string" ? e.data.args.description : undefined);
  }
  return [...out].map(([agentId, description]) => ({ agentId, description }));
}

// ── Adapter ──────────────────────────────────────────────────────────────────

/** What the mirror keeps per agent (events.json): its merged stream log and the runs already read to the end. */
export interface CursorAgentLog { events: CursorRunEvent[]; readRuns: string[] }

/** A repo URL as Cursor gives it, which may lack its scheme. */
function cursorRepoUrl(url: string): string {
  return url.startsWith("http") ? url : `https://${url}`;
}

/** The agent's newest pushed branch: its runs' `git` (per agent, not per run) or a `result` event's. */
export function latestCursorGit(agentId: string, runs: Array<CursorCloudRun & { git?: { branches?: Array<{ repoUrl?: string; branch?: string; prUrl?: string }> } }>, log: CursorRunEvent[]): CloudAgentGit | null {
  const fromLog = [...log].reverse().find((e) => e.event === "result" && e.data.git?.branches?.length)?.data.git.branches;
  const fromRuns = [...runs].reverse().find((r) => r.git?.branches?.length)?.git?.branches;
  const b = (fromLog ?? fromRuns)?.at(-1);
  if (!b?.branch && !b?.prUrl) return null;
  return { agentId, ...(b.repoUrl ? { repoUrl: cursorRepoUrl(b.repoUrl) } : {}), ...(b.branch ? { branch: b.branch } : {}), ...(b.prUrl ? { prUrl: b.prUrl } : {}) };
}

export class CursorCloudAdapter implements CloudAgentAdapter<CursorCloudApi, CursorCloudAgent, CursorAgentLog> {
  readonly spec = CURSOR;
  readonly mirrorFormat = MIRROR_FORMAT;
  /** Live runs being followed, by run id. */
  readonly streams = new CloudAgentStreams<CursorRunEvent, CursorAgentLog>(this);
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: KeyedCloudAdapterOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  client(): CursorCloudApi | CloudAgentSetupError {
    return keyedCloudClient(this, this.opts.readKey, (key) => new CursorCloudApi(key, this.fetchImpl));
  }

  loadData(raw: any): CursorAgentLog {
    return { events: Array.isArray(raw?.events) ? raw.events : [], readRuns: Array.isArray(raw?.readRuns) ? raw.readRuns : [] };
  }

  async listAgents(api: CursorCloudApi, cursor?: string): Promise<{ items: CloudAgentListItem<CursorCloudAgent>[]; nextCursor?: string }> {
    const data = await api.listAgents(100, cursor);
    return { items: (data.items ?? []).map((agent) => ({ id: agent.id, updatedAtMs: Date.parse(agent.updatedAt), version: agent.updatedAt, active: agent.status === "ACTIVE", agent })), nextCursor: data.nextCursor };
  }

  async mirror(api: CursorCloudApi, handle: CloudAgentHandle<CursorAgentLog>, known: CursorCloudAgent | undefined): Promise<CloudAgentMirror> {
    const agentId = handle.agentId;
    const agent = known ?? await api.getAgent(agentId);
    const runs = (await api.listRuns(agentId)).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const log = handle.data();
    // Each finished run's stream is read once, to its end. Streams overlap (a
    // run's stream runs on through later turns) and merge by event id; an
    // early run's stream can also be empty, so none stands in for another.
    for (const run of runs) {
      if (!TERMINAL_RUN_STATUSES.has(run.status) || log.readRuns.includes(run.id)) continue;
      await this.readStream(api, handle, run);
      log.readRuns.push(run.id);
    }
    const active = runs.filter((r) => !TERMINAL_RUN_STATUSES.has(r.status));
    for (const run of active) this.startFollower(api, handle, run);
    handle.save();

    const conversation = await api.conversation(agentId).catch(() => [] as CursorConversationMessage[]);
    const transcript = buildCursorCloudTranscript({ conversation, log: log.events, latestRun: runs[runs.length - 1], createdAt: Date.parse(agent.createdAt) || 0, notice: await handle.notice() });
    return {
      transcript,
      title: agent.name,
      url: agent.url,
      createdAtMs: Date.parse(agent.createdAt),
      repoUrl: agent.repos?.[0]?.url ? cursorRepoUrl(agent.repos[0].url) : undefined,
      version: agent.updatedAt,
      running: active.length > 0,
      // No branch in the runs it can still read is unknown, not none: a Cursor agent that once reported one can stop listing it.
      git: latestCursorGit(agentId, runs, log.events) ?? undefined,
      children: forkedWorkers(log.events),
    };
  }

  /** Read a finished run's stream to its end into the agent's log. An expired one adds nothing. */
  private async readStream(api: CursorCloudApi, handle: CloudAgentHandle<CursorAgentLog>, run: CursorCloudRun): Promise<void> {
    const events: CursorRunEvent[] = [];
    try {
      await api.streamRun(handle.agentId, run.id, (e) => events.push(e), { signal: AbortSignal.timeout(120_000) });
    } catch (err) {
      if (cloudApiVerdict(err, { oneAgent: true }) === "gone") return;
      throw err;
    }
    const log = handle.data();
    log.events = mergeEventLog(log.events, events);
  }

  /** Follow a running run's stream live, resuming one cut short, until its result; then the agent is mirrored again. */
  private startFollower(api: CursorCloudApi, handle: CloudAgentHandle<CursorAgentLog>, run: CursorCloudRun): void {
    let lastEventId: string | undefined;
    let sawResult = false;
    this.streams.follow(run.id, {
      open: (signal) => api.runEvents(handle.agentId, run.id, { signal, lastEventId }),
      apply: (e, log) => {
        if (e.id) lastEventId = e.id;
        if (e.event === "result") sawResult = true;
        log.events = mergeEventLog(log.events, [e]);
      },
      finished: () => sawResult,
      gone: (err) => cloudApiVerdict(err, { oneAgent: true }) === "gone",
      reconnects: 20,
    }, { handle });
  }

  async create(api: CursorCloudApi, session: CloudAgentSession, content: string): Promise<CloudAgentCreated> {
    const { agent } = await api.createAgent({
      prompt: { text: content },
      ...(session.model ? { model: { id: session.model } } : {}),
      ...(session.repoUrl ? { repos: [{ url: session.repoUrl, ...(session.startingRef ? { startingRef: session.startingRef } : {}) }] } : {}),
    });
    return { agentId: agent.id, url: agent.url };
  }

  /** A follow-up run. Cursor answers 409 while a run is going: the core holds the message. */
  async followUp(api: CursorCloudApi, agentId: string, content: string): Promise<void> {
    await api.createRun(agentId, content);
  }

  async cancel(api: CursorCloudApi, agentId: string): Promise<string | null> {
    const runs = await api.listRuns(agentId);
    const active = runs.find((r) => !TERMINAL_RUN_STATUSES.has(r.status));
    if (!active) return null;
    await api.cancelRun(agentId, active.id);
    return `run ${active.id}`;
  }

  /** A repository Cursor cannot reach (a rejected key is the core's rule). */
  setupErrorOf(err: unknown, session?: CloudAgentSession): CloudAgentSetupError | null {
    if (!(err instanceof CloudApiError)) return null;
    if (err.status === 400 && err.code === "validation_error" && /repositor|branch/i.test(err.message)) {
      return CloudAgentSetupError.repoUnreachable(this, session, err.message.replace(/\.$/, ""), `Give Cursor's GitHub app access to it at ${this.spec.repoAccessUrl}`);
    }
    return null;
  }

  verifyKey(key: string) {
    return verifyCursorKey(key, this.fetchImpl);
  }
}
