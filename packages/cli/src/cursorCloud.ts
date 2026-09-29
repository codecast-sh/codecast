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

/** One kept stream event. Deltas the transcript never shows are dropped. */
export interface CursorRunEvent {
  event: "assistant" | "tool_call" | "result" | "status";
  /** Stream id; its leading digits are the event's epoch milliseconds. */
  id?: string;
  data: Record<string, any>;
}

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
      const code = typeof json?.code === "string" ? json.code : undefined;
      throw new CursorCloudApiError(resp.status, code, `cursor cloud ${method} ${p.split("?")[0]} ${resp.status}${json?.message ? `: ${json.message}` : ""}`);
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
   * Read one run's SSE stream, calling `onEvent` for each kept event, until
   * the stream ends. Resolves true when it saw the run's terminal `result`.
   * A terminal run's stream replays from its start; `lastEventId` resumes one
   * cut short. Throws CursorCloudApiError 410 once the stream has expired.
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
        if (frame.event !== "assistant" && frame.event !== "tool_call" && frame.event !== "result" && frame.event !== "status") continue;
        let data: Record<string, any>;
        try { data = JSON.parse(frame.data); } catch { continue; }
        if (frame.event === "result") sawResult = true;
        onEvent({ event: frame.event, ...(frame.id ? { id: frame.id } : {}), data });
      }
    }
    return sawResult;
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

export interface TranscriptRunInput {
  run: CursorCloudRun;
  /** The run's kept stream events, or null when its stream is gone (expired). */
  events: CursorRunEvent[] | null;
}

/**
 * The agent's transcript in cursor-agent's JSONL shape, plus a `timestamp` per
 * record. Runs are prompts in order, so the nth user message of the v0
 * conversation is the nth run's prompt; a run whose stream expired falls back
 * to the conversation's replies between its prompt and the next.
 */
export function buildCursorCloudTranscript(runsInput: TranscriptRunInput[], conversation: CursorConversationMessage[]): string {
  const runs = [...runsInput].sort((a, b) => Date.parse(a.run.createdAt) - Date.parse(b.run.createdAt));
  // Conversation grouped as [prompt, replies[]] per run.
  const turns: Array<{ prompt?: string; replies: string[] }> = [];
  for (const m of conversation) {
    if (m.type === "user_message") turns.push({ prompt: m.text, replies: [] });
    else if (turns.length) turns[turns.length - 1].replies.push(m.text);
    else turns.push({ replies: [m.text] });
  }
  const lines: string[] = [];
  const push = (rec: Record<string, unknown>) => lines.push(JSON.stringify(rec));
  const text = (t: string) => ({ type: "text", text: t });

  runs.forEach(({ run, events }, i) => {
    const started = Date.parse(run.createdAt) || 0;
    const turn = turns[i];
    if (turn?.prompt !== undefined) push({ role: "user", timestamp: started, message: { content: [text(turn.prompt)] } });

    let clock = started;
    let pending = "";
    let wroteReply = false;
    const opened = new Set<string>();
    const flush = (extra: unknown[] = []) => {
      const content = [...(pending.trim() ? [text(pending.trim())] : []), ...extra];
      pending = "";
      if (!content.length) return;
      wroteReply = true;
      push({ role: "assistant", timestamp: clock, message: { content } });
    };
    if (events) {
      for (const e of events) {
        clock = eventClock(e, clock);
        if (e.event === "assistant" && typeof e.data.text === "string") pending += e.data.text;
        else if (e.event === "tool_call") {
          const use = cloudToolUse(e.data);
          if (!opened.has(use.id)) {
            opened.add(use.id);
            flush([{ type: "tool_use", ...use }]);
          }
          if (e.data.status === "completed") {
            const res = cloudToolResult(e.data);
            push({ role: "user", timestamp: clock, message: { content: [{ type: "tool_result", tool_use_id: use.id, content: res.content, ...(res.isError ? { is_error: true } : {}) }] } });
          }
        } else if (e.event === "result") {
          if (!pending.trim() && !wroteReply && typeof e.data.text === "string") pending = e.data.text;
          flush();
        }
      }
      flush();
    } else {
      for (const reply of turn?.replies ?? []) push({ role: "assistant", timestamp: clock, message: { content: [text(reply)] } });
      if (!turn?.replies.length && run.result) push({ role: "assistant", timestamp: clock, message: { content: [text(run.result)] } });
    }
    if (run.status === "ERROR" || run.status === "EXPIRED") {
      push({ role: "assistant", timestamp: Date.parse(run.updatedAt) || clock, message: { content: [text(`${CLIENT_ERROR_BANNER_PREFIX} Cursor Cloud run ${run.status.toLowerCase()}`)] } });
    }
    if (TERMINAL_RUN_STATUSES.has(run.status)) push({ type: "turn_ended", status: run.status.toLowerCase() });
  });
  return lines.length ? `${lines.join("\n")}\n` : "";
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
  resolveRepoDir?: (repo: { owner: string; name: string }) => Promise<string | null>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (msg: string) => void;
}

interface AgentState {
  /** The agent's updatedAt when it was last mirrored with every run settled. */
  updatedAt?: string;
}

export declare interface CursorCloudWatcher {
  on(event: "session", listener: (e: CursorTranscriptEvent) => void): this;
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
  private readonly resolveRepoDir: (repo: { owner: string; name: string }) => Promise<string | null>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private state: { agents: Record<string, AgentState> } = { agents: {} };
  /** Live runs being followed, by run id. */
  private readonly followers = new Map<string, AbortController>();
  /** Kept events of runs this process has read, by run id. */
  private readonly runEvents = new Map<string, CursorRunEvent[]>();
  private readonly renderTimers = new Map<string, NodeJS.Timeout>();
  private readonly mirroring = new Map<string, Promise<void>>();

  constructor(opts: CursorCloudWatcherOptions) {
    super();
    this.pollMs = opts.pollMs ?? 30_000;
    this.rootDir = opts.rootDir ?? codecastPath("cursor-cloud");
    this.statePath = path.join(this.rootDir, "state.json");
    this.readKey = opts.readKey;
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
    this.emit("ready");
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
          if (this.state.agents[agent.id]?.updatedAt === agent.updatedAt && agent.status !== "ACTIVE") continue;
          await this.mirror(agent.id, agent);
        }
        if (reachedHorizon || !data.nextCursor) break;
        cursor = data.nextCursor;
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
    const runs = await api.listRuns(agentId);
    let settled = true;
    for (const run of runs) {
      const followed = this.runEvents.get(run.id);
      if (followed && !this.followers.has(run.id) && TERMINAL_RUN_STATUSES.has(run.status)) {
        if (!fs.existsSync(this.runCachePath(agentId, run.id))) this.writeRunCache(agentId, run.id, followed);
        continue;
      }
      const cached = TERMINAL_RUN_STATUSES.has(run.status) ? this.readRunCache(agentId, run.id) : null;
      if (cached) { this.runEvents.set(run.id, cached); continue; }
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        await this.readStream(api, agentId, run);
      } else {
        settled = false;
        this.startFollower(api, agent, run);
      }
    }
    await this.render(agent, runs, api);
    this.state.agents[agentId] = { updatedAt: settled ? agent.updatedAt : undefined };
    await this.saveState();
  }

  /** Read a finished run's whole stream once; an expired one keeps null (the transcript falls back to the conversation). */
  private async readStream(api: CursorCloudApi, agentId: string, run: CursorCloudRun): Promise<void> {
    const events: CursorRunEvent[] = [];
    try {
      await api.streamRun(agentId, run.id, (e) => events.push(e), { signal: AbortSignal.timeout(60_000) });
      this.runEvents.set(run.id, events);
      this.writeRunCache(agentId, run.id, events);
    } catch (err) {
      if (err instanceof CursorCloudApiError && (err.status === 410 || err.status === 404)) {
        this.writeRunCache(agentId, run.id, null);
        return;
      }
      throw err;
    }
  }

  private startFollower(api: CursorCloudApi, agent: CursorCloudAgent, run: CursorCloudRun): void {
    if (this.followers.has(run.id)) return;
    const controller = new AbortController();
    this.followers.set(run.id, controller);
    const events = this.runEvents.get(run.id) ?? [];
    this.runEvents.set(run.id, events);
    void (async () => {
      let lastEventId: string | undefined;
      for (let attempt = 0; attempt < 20 && !controller.signal.aborted; attempt++) {
        try {
          const ended = await api.streamRun(agent.id, run.id, (e) => {
            if (e.id) lastEventId = e.id;
            events.push(e);
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

  private async render(agent: CursorCloudAgent, runs: CursorCloudRun[], api: CursorCloudApi): Promise<void> {
    const conversation = await api.conversation(agent.id).catch(() => [] as CursorConversationMessage[]);
    const content = buildCursorCloudTranscript(runs.map((run) => ({ run, events: this.runEvents.get(run.id) ?? null })), conversation);
    if (!content) return;
    const file = this.transcriptPath(agent.id);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const cwd = await this.placement(agent);
    const meta = JSON.stringify({ cwd, title: agent.name, url: agent.url, createdAtMs: Date.parse(agent.createdAt) || undefined, cloud: true });
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

  private runCachePath(agentId: string, runId: string): string {
    return path.join(this.rootDir, agentId, "runs", `${runId}.json`);
  }
  private readRunCache(agentId: string, runId: string): CursorRunEvent[] | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.runCachePath(agentId, runId), "utf8"));
      return Array.isArray(parsed?.events) ? parsed.events : null;
    } catch {
      return null;
    }
  }
  private writeRunCache(agentId: string, runId: string, events: CursorRunEvent[] | null): void {
    try {
      fs.mkdirSync(path.dirname(this.runCachePath(agentId, runId)), { recursive: true });
      fs.writeFileSync(this.runCachePath(agentId, runId), JSON.stringify({ events }));
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
