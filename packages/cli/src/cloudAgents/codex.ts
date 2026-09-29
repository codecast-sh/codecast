/**
 * Codex Cloud (chatgpt.com/codex): the cloud agent adapter.
 *
 * Codex Cloud has no public API. Its tasks are read and driven over the
 * private `chatgpt.com/backend-api/wham` API that OpenAI's own CLI uses
 * (verified live, docs/proposals/codex-cloud-spike-findings.md), with the
 * machine's own `codex login` from ~/.codex/auth.json. Codecast only READS
 * that login: refreshing it would rotate the refresh token out from under the
 * person's running codex, so an expired token is a "sign in to Codex" card.
 *
 * A task is a tree of turns (GET /tasks/{id}/turns): user turns, and
 * assistant turns chained to them by previous_turn_id, several per user turn
 * when it ran more than one attempt. The transcript follows the chain that
 * ends at the task's current turn. An assistant turn renders from its
 * `thread_events` (Codex app-server notifications, parsed by the same
 * threadItemToMessage codecast uses for local Codex) or, on tasks from before
 * those existed, from its `worklog` (ChatGPT messages: text, code sent to
 * `container.*` tools, their output). Its output items add the final answer
 * and the diff. Nothing streams: a running turn shows its latest event and
 * renders whole when it ends.
 *
 * The core (watcher.ts, sessions.ts) does the rest, under
 * ~/.codecast/codex-cloud/<task id>/, synced as a codex session.
 */
import * as fs from "fs";
import * as path from "path";
import { CLOUD_AGENT_PROVIDERS } from "@codecast/shared/contracts";
import { githubRepo } from "../cloud/gitOrigin.js";
import { decodeCodexAuth } from "../codexAuthDecode.js";
import { codexBackendHeadersFromAuth } from "../codexBackendUsage.js";
import { threadItemToMessage, type ThreadItem } from "../codexAppServer.js";
import { codexHome } from "../codexUsage.js";
import type { ParsedMessage, ToolCall } from "../parser.js";
import { splitPatches } from "../repoMirror.js";
import { CloudApiError, requestCloudJson } from "./http.js";
import { MirrorTranscript } from "./transcript.js";
import { CloudAgentBusyError, CloudAgentSetupError, errorText, type CloudAgentAdapter, type CloudAgentGit, type CloudAgentHandle, type CloudAgentListItem, type CloudAgentLogin, type CloudAgentLoginState, type CloudAgentMirror } from "./types.js";
import type { CloudAgentSession } from "./sessions.js";

const CODEX = CLOUD_AGENT_PROVIDERS.codex;
export const CODEX_CLOUD_API_BASE = "https://chatgpt.com/backend-api/wham";
/** Bump when the rendered transcript changes shape: every mirror re-renders once. */
const MIRROR_FORMAT = 2;
/** The same cadence the chatgpt.com web app polls a running task at; idle, a new task shows within five minutes. */
const POLL_MS = 5 * 60_000;
const FAST_POLL_MS = 30_000;
const ENVIRONMENTS_URL = "https://chatgpt.com/codex/settings/environments";
const TERMINAL_TURN_STATUSES: ReadonlySet<string> = new Set(["completed", "cancelled", "failed"]);

// ── Payloads (only the fields codecast reads) ────────────────────────────────

interface WhamContentPart { content_type?: string; text?: string; path?: string; line_range_start?: number | null; line_range_end?: number | null }
interface WhamOutputItem { type?: string; content?: WhamContentPart[]; pr_title?: string; pr_message?: string; output_diff?: { diff?: string } | null }
interface WhamWorklogMessage {
  id?: string;
  author?: { role?: string; name?: string | null };
  create_time?: number | null;
  content?: { content_type?: string; parts?: unknown[]; text?: string };
  recipient?: string | null;
  /** Set on the assistant's final answer. */
  end_turn?: boolean | null;
  metadata?: Record<string, unknown> | null;
}
interface WhamThreadEvent { method?: string; params?: { item?: { id?: string; type?: string }; completedAtMs?: number } }
interface WhamPullRequest { url?: string; number?: number; title?: string; head?: string; state?: string; head_repo_full_name?: string }

export interface WhamTurn {
  id: string;
  type?: string;
  created_at?: number;
  previous_turn_id?: string | null;
  input_items?: Array<{ type?: string; content?: WhamContentPart[] }>;
  output_items?: WhamOutputItem[];
  worklog?: { messages?: WhamWorklogMessage[] } | null;
  thread_events?: { events?: WhamThreadEvent[] } | null;
  turn_status?: string | null;
  latest_event?: { text?: string | null } | null;
  attempt_placement?: number | null;
  sibling_turn_ids?: string[] | null;
  error?: unknown;
  branch_name?: string | null;
  pull_request_data?: WhamPullRequest | null;
  /** Carries the environment's env vars and secrets in plain text: only repo_map's repository names are ever read. */
  environment?: { repo_map?: Record<string, { repository_full_name?: string }> } | null;
}

export interface WhamTurns { current_turn_id?: string | null; turn_mapping?: Record<string, { turn?: WhamTurn }> }

export interface WhamTask {
  id: string;
  title?: string;
  created_at?: number;
  updated_at?: number;
  task_status_display?: {
    latest_turn_status_display?: { turn_id?: string; turn_status?: string | null; intent?: string | null } | null;
    branch_name?: string | null;
    initial_intent?: string | null;
  } | null;
  /** In the list. */
  pull_requests?: Array<{ assistant_turn_id?: string; pull_request?: WhamPullRequest }>;
  /** In GET /tasks/{id}. */
  external_pull_requests?: Array<{ assistant_turn_id?: string; pull_request?: WhamPullRequest }>;
}

/** An environment as codecast keeps it: never its env vars or secrets. */
export interface WhamEnvironment { id: string; label?: string; defaultBranch?: string; repos: string[] }

// ── API client ───────────────────────────────────────────────────────────────

export class CodexCloudApi {
  constructor(private readonly headers: Record<string, string>, private readonly fetchImpl: typeof fetch = fetch, private readonly base = CODEX_CLOUD_API_BASE) {}

  /** Errors come as {detail}, {detail: {type, message}} or {error: {message, type}}. */
  request<T>(method: string, p: string, body?: unknown): Promise<T> {
    return requestCloudJson<T>(this.fetchImpl, { method, url: `${this.base}${p}`, headers: this.headers, body, label: `codex cloud ${method} ${p.split("?")[0]}` });
  }

  listTasks(limit = 20, cursor?: string): Promise<{ items?: WhamTask[]; cursor?: string | null }> {
    const q = new URLSearchParams({ limit: String(limit), task_filter: "current", ...(cursor ? { cursor } : {}) });
    return this.request("GET", `/tasks/list?${q}`);
  }
  task(id: string): Promise<{ task?: WhamTask }> {
    return this.request("GET", `/tasks/${encodeURIComponent(id)}`);
  }
  turns(id: string): Promise<WhamTurns> {
    return this.request("GET", `/tasks/${encodeURIComponent(id)}/turns`);
  }
  createTask(body: Record<string, unknown>): Promise<{ task?: { id?: string } }> {
    return this.request("POST", "/tasks", body);
  }
  cancel(id: string): Promise<unknown> {
    return this.request("POST", `/tasks/${encodeURIComponent(id)}/cancel`, {});
  }
  usage(): Promise<{ email?: string; plan_type?: string }> {
    return this.request("GET", "/usage");
  }
  /** The environments set up for a GitHub repository, stripped to what codecast keeps. */
  async environmentsForRepo(owner: string, name: string): Promise<WhamEnvironment[]> {
    const raw = await this.request<unknown>("GET", `/environments/by-repo/github/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
    return (Array.isArray(raw) ? raw : []).map(keptEnvironment).filter((e): e is WhamEnvironment => !!e);
  }
}

function keptEnvironment(raw: any): WhamEnvironment | null {
  if (!raw || typeof raw.id !== "string") return null;
  const repos = Object.values(raw.repo_map ?? {}) as Array<{ repository_full_name?: unknown; default_branch?: unknown }>;
  const branch = repos.find((r) => typeof r?.default_branch === "string")?.default_branch;
  return {
    id: raw.id,
    ...(typeof raw.label === "string" ? { label: raw.label } : {}),
    ...(typeof branch === "string" ? { defaultBranch: branch } : {}),
    repos: repos.map((r) => r?.repository_full_name).filter((n): n is string => typeof n === "string"),
  };
}

/** A prompt as the API takes it. */
function inputItems(text: string) {
  return [{ type: "message", role: "user", content: [{ content_type: "text", text }] }];
}

// ── Turns ────────────────────────────────────────────────────────────────────

export function isRunningTurnStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && !TERMINAL_TURN_STATUSES.has(status);
}

/** The id's own half: turn ids are `<task id>~<turn id>`. */
function turnKey(id: string): string {
  return id.slice(id.indexOf("~") + 1);
}

/**
 * The turns the task shows, oldest first: back from its current turn through
 * previous_turn_id, then on through any turn opened after it (a follow-up
 * the current pointer has not caught up with). Where a user turn has several
 * attempts, the one on the chain is the task's; else attempt 0.
 */
export function taskTurnChain(turns: WhamTurns): WhamTurn[] {
  const all = Object.values(turns.turn_mapping ?? {}).map((n) => n.turn).filter((t): t is WhamTurn => !!t?.id);
  const byId = new Map(all.map((t) => [t.id, t]));
  const byCreated = (a: WhamTurn, b: WhamTurn) => (a.created_at ?? 0) - (b.created_at ?? 0);
  const start = (turns.current_turn_id && byId.get(turns.current_turn_id)) || all.filter((t) => t.type === "assistant").sort(byCreated).at(-1) || all.sort(byCreated).at(-1);
  const chain: WhamTurn[] = [];
  const seen = new Set<string>();
  for (let t = start; t && !seen.has(t.id); t = t.previous_turn_id ? byId.get(t.previous_turn_id) : undefined) {
    seen.add(t.id);
    chain.unshift(t);
  }
  for (;;) {
    const last = chain.at(-1);
    const next = last && all.filter((t) => t.previous_turn_id === last.id && !seen.has(t.id))
      .sort((a, b) => (a.attempt_placement ?? 0) - (b.attempt_placement ?? 0) || byCreated(b, a))[0];
    if (!next) break;
    seen.add(next.id);
    chain.push(next);
  }
  return chain;
}

function contentText(parts: WhamContentPart[] | undefined): string {
  return (parts ?? []).map((p) => {
    if (p.content_type === "text" || p.content_type === undefined) return p.text ?? "";
    if (p.content_type === "repo_file_citation" && p.path) return ` \`${fileRef(p.path, p.line_range_start, p.line_range_end)}\``;
    return "";
  }).join("");
}

function fileRef(file: string, start?: number | string | null, end?: number | string | null): string {
  if (start === null || start === undefined || start === "") return file;
  return `${file}:${start}${end !== null && end !== undefined && end !== "" && String(end) !== String(start) ? `-${end}` : ""}`;
}

/**
 * Codex's inline citations: a file one (【F:README.md†L99】) reads as its
 * path and lines, spaced off the text so two in a row stay two code spans; a
 * terminal one (【a1b2c3†L1-L3】) points into a log the transcript does not
 * keep and is dropped.
 */
export function codexCitations(text: string): string {
  return text
    .replace(/【F:([^†】]+)†L(\d+)(?:-L(\d+))?】/g, (_m, file: string, a: string, b: string | undefined, at: number, all: string) => `${at > 0 && !/\s/.test(all[at - 1]) ? " " : ""}\`${fileRef(file, a, b)}\``)
    .replace(/【[^】]*】/g, "");
}

function errorOf(err: unknown): string | undefined {
  if (!err) return undefined;
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const e = err as Record<string, unknown>;
    return [e.message, e.detail, e.code].find((m): m is string => typeof m === "string" && !!m) ?? "no reason given";
  }
  return String(err);
}

function secondsToMs(s: number | null | undefined): number | undefined {
  return typeof s === "number" && Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : undefined;
}

/** The turn's app-server items as messages, dated by when each completed; the prompt is the user turn's. */
function threadEventMessages(turn: WhamTurn): ParsedMessage[] {
  const out: ParsedMessage[] = [];
  for (const e of turn.thread_events?.events ?? []) {
    const item = e.method === "item/completed" ? e.params?.item : undefined;
    if (!item?.id || item.type === "userMessage") continue;
    const msg = threadItemToMessage(item as ThreadItem, e.params?.completedAtMs ?? 0);
    if (msg) out.push(msg);
  }
  return out;
}

const LEGACY_TOOL_NAMES: Record<string, string> = { "container.exec": "commandExecution", "container.feed_chars": "commandExecution" };

/** A worklog tool call's input: the command it ran, for the shell tools. */
function legacyToolCall(m: WhamWorklogMessage, id: string): ToolCall & { chars?: string } {
  const code = m.content?.text ?? "";
  let args: Record<string, unknown>;
  try {
    const parsed = JSON.parse(code);
    args = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { input: parsed };
  } catch {
    args = { input: code };
  }
  const recipient = m.recipient ?? "tool";
  if (recipient === "container.feed_chars") {
    const chars = typeof args.chars === "string" ? args.chars : "";
    return { id, name: "commandExecution", input: { command: chars.replace(/\n$/, "") }, chars };
  }
  if (recipient === "container.exec") {
    const cmd = Array.isArray(args.cmd) ? args.cmd.map(String) : typeof args.cmd === "string" ? [args.cmd] : [];
    const command = cmd.length === 3 && /^(ba|z)?sh$/.test(cmd[0]) && cmd[1] === "-lc" ? cmd[2] : cmd.join(" ");
    return { id, name: "commandExecution", input: { command, ...(typeof args.workdir === "string" ? { cwd: args.workdir } : {}) } };
  }
  return { id, name: LEGACY_TOOL_NAMES[recipient] ?? recipient, input: args };
}

/** A worklog tool reply's text: a terminal's lines (as many as survive a cut-off reply), else as sent. */
function legacyToolOutput(m: WhamWorklogMessage): string {
  const raw = m.content?.content_type === "execution_output" ? m.content.text ?? "" : (m.content?.parts ?? []).map((p) => typeof p === "string" ? p : "").join("\n");
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.output)) return parsed.output.map(String).join("\n");
    return raw;
  } catch {}
  const lines = /^\{"type": ?"terminal_output".*?"output": ?\[(.*)$/s.exec(raw)?.[1];
  if (lines === undefined) return raw;
  return [...lines.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((q) => { try { return JSON.parse(`"${q[1]}"`) as string; } catch { return q[1]; } }).join("\n");
}

/**
 * A worklog (tasks from before thread_events) as the same messages Codex's
 * own items become: narration as text (the running commentary the worklog
 * marks as reasoning as thinking), each tool call with its reply as one
 * commandExecution row. A shell read with no input (feed_chars with no
 * chars, waiting on output) adds its output to the command before it.
 */
export function legacyWorklogMessages(messages: WhamWorklogMessage[], idPrefix: string): ParsedMessage[] {
  const out: ParsedMessage[] = [];
  const openCalls = new Map<string, ParsedMessage>();
  let lastCommand: ParsedMessage | undefined;
  let clock = 0;
  messages.forEach((m, i) => {
    const role = m.author?.role;
    const at = secondsToMs(m.create_time) ?? clock;
    clock = at;
    const id = `${idPrefix}:${m.id ?? i}`;
    const ct = m.content?.content_type;
    if (role === "assistant" && ct === "text") {
      const text = (m.content?.parts ?? []).filter((p): p is string => typeof p === "string").join("\n").trim();
      if (!text) return;
      const reasoning = m.metadata?.reasoning_status === "is_reasoning";
      out.push({ uuid: id, role: "assistant", content: reasoning ? "" : codexCitations(text), timestamp: at, ...(reasoning ? { thinking: text } : {}) });
      return;
    }
    if (role === "assistant" && m.recipient && m.recipient !== "all") {
      const call = legacyToolCall(m, id);
      const isRead = m.recipient === "container.feed_chars" && !call.chars?.trim();
      if (isRead && lastCommand) { openCalls.set(m.recipient, lastCommand); return; }
      const { chars: _chars, ...toolCall } = call;
      const msg: ParsedMessage = { uuid: id, role: "assistant", content: "", timestamp: at, toolCalls: [toolCall] };
      out.push(msg);
      openCalls.set(m.recipient, msg);
      if (toolCall.name === "commandExecution") lastCommand = msg;
      return;
    }
    if (role === "tool" || ct === "execution_output") {
      const msg = openCalls.get(m.author?.name ?? "") ?? [...openCalls.values()].at(-1);
      const call = msg?.toolCalls?.[0];
      if (!msg || !call) return;
      const text = legacyToolOutput(m);
      const prior = msg.toolResults?.[0]?.content;
      msg.toolResults = [{ toolUseId: call.id, content: prior ? `${prior}\n${text}` : text }];
      openCalls.delete(m.author?.name ?? "");
    }
  });
  return out;
}

/** A diff as the fileChange row every Codex diff renders as (threadItemToMessage). */
function diffMessage(id: string, diff: string, at: number): ParsedMessage | null {
  const patches = splitPatches(diff);
  if (!patches.size) return null;
  const item: ThreadItem = { type: "fileChange", id, status: "completed", changes: [...patches].map(([file, patch]) => ({ path: file, kind: "update", diff: patch })) };
  return threadItemToMessage(item, at);
}

export interface CodexCloudTranscriptInput {
  turns: WhamTurns;
  /** Clock for anything the payload does not date. */
  createdAt: number;
  notice?: string;
  /** The task's pull requests, to link the one a turn opened. */
  pullRequests?: Array<{ assistant_turn_id?: string; pull_request?: WhamPullRequest }>;
}

/**
 * The task's transcript in the mirror format (transcript.ts). Record ids are
 * `<turn>:<item>`, and every record is dated by the payload (a user turn's
 * created_at, an item's completedAtMs, a worklog message's create_time), so a
 * re-render never moves or duplicates a row.
 */
export function buildCodexCloudTranscript(input: CodexCloudTranscriptInput): string {
  const tx = new MirrorTranscript(input.createdAt, { linkify: codexCitations, notice: input.notice });
  for (const turn of taskTurnChain(input.turns)) {
    const key = turnKey(turn.id);
    tx.advanceTo(secondsToMs(turn.created_at));
    if (turn.type === "user") {
      tx.turn(key, contentText(turn.input_items?.flatMap((i) => i.content ?? [])));
      continue;
    }
    tx.turn(undefined, undefined);
    const attempts = (turn.sibling_turn_ids?.length ?? 0) + 1;
    if (attempts > 1) {
      tx.assistant(`${key}:attempts`, `ℹ Codex Cloud ran ${attempts} attempts at this; this is attempt ${(turn.attempt_placement ?? 0) + 1}, the one the task keeps. The others are on chatgpt.com/codex.`);
    }
    const events = threadEventMessages(turn);
    const worklog = turn.worklog?.messages ?? [];
    const body = events.length ? events : legacyWorklogMessages(worklog, key);
    for (const m of body) tx.message({ ...m, uuid: events.length ? `${key}:${m.uuid}` : m.uuid });
    // The answer, when the turn's own log says it (an app-server agentMessage, a
    // worklog's end_turn message, both with citations), is not repeated from the
    // output items, which carry the same text without them.
    const answered = events.length
      ? events.some((m) => m.role === "assistant" && !!m.content && !m.toolCalls?.length)
      : worklog.some((m) => m.end_turn === true && m.author?.role === "assistant" && m.content?.content_type === "text");

    const outputs = turn.output_items ?? [];
    const answer = outputs.find((o) => o.type === "message");
    if (answer && !answered) {
      const text = contentText(answer.content).trim();
      if (text) tx.assistant(`${key}:answer`, text);
    }
    const pr = outputs.find((o) => o.type === "pr");
    const diff = outputs.find((o) => o.type === "follow_up_diff")?.output_diff?.diff ?? pr?.output_diff?.diff;
    if (pr?.pr_title || diff) {
      const opened = turn.pull_request_data?.url ? turn.pull_request_data : input.pullRequests?.find((p) => p.assistant_turn_id === turn.id)?.pull_request;
      const title = pr?.pr_title ? `**${pr.pr_title}**` : "**Changes**";
      const link = opened?.url ? ` · [pull request #${opened.number ?? ""}](${opened.url})` : "";
      tx.assistant(`${key}:pr`, `${title}${link}${pr?.pr_message ? `\n\n${pr.pr_message}` : ""}`);
      const change = diff ? diffMessage(`${key}:diff`, diff, tx.clock) : null;
      if (change) tx.message(change);
    }

    if (isRunningTurnStatus(turn.turn_status)) {
      const text = turn.latest_event?.text?.trim();
      if (text) tx.assistant(`${key}:progress`, `ℹ ${text}`, secondsToMs(turn.created_at) ?? tx.clock);
      continue;
    }
    if (turn.turn_status === "failed") tx.error(`${key}:error`, `Codex Cloud turn failed: ${errorOf(turn.error) ?? "no reason given"}`);
    else if (turn.turn_status === "cancelled") tx.assistant(`${key}:cancelled`, "ℹ Cancelled.");
    tx.turnEnded();
  }
  return tx.toString();
}

/** The GitHub repository a task works on, from its environment (names only). */
export function taskRepo(chain: WhamTurn[]): string | undefined {
  for (const t of [...chain].reverse()) {
    const name = Object.values(t.environment?.repo_map ?? {}).map((r) => r?.repository_full_name).find((n): n is string => typeof n === "string" && n.includes("/"));
    if (name) return name;
    if (t.pull_request_data?.head_repo_full_name) return t.pull_request_data.head_repo_full_name;
  }
  return undefined;
}

/** The branch the task last pushed (its pull request's head), else the branch it worked on. */
export function taskGit(taskId: string, task: WhamTask | undefined, chain: WhamTurn[], repo: string | undefined): CloudAgentGit | null {
  const prs = task?.pull_requests ?? task?.external_pull_requests ?? [];
  const onChain = new Set(chain.map((t) => t.id));
  const pr = [...chain].reverse().map((t) => t.pull_request_data).find((p) => p?.url)
    ?? [...prs].reverse().find((p) => p.assistant_turn_id && onChain.has(p.assistant_turn_id))?.pull_request
    ?? prs.at(-1)?.pull_request;
  const current = [...chain].reverse().find((t) => t.type === "assistant");
  const branch = pr?.head ?? current?.branch_name ?? task?.task_status_display?.branch_name ?? undefined;
  if (!branch && !pr?.url) return null;
  return { agentId: taskId, ...(repo ? { repoUrl: `https://github.com/${repo}` } : {}), ...(branch ? { branch } : {}), ...(pr?.url ? { prUrl: pr.url } : {}) };
}

function taskVersion(task: WhamTask): string {
  const latest = task.task_status_display?.latest_turn_status_display;
  return `${task.updated_at ?? ""}|${latest?.turn_id ?? ""}|${latest?.turn_status ?? ""}`;
}

// ── Adapter ──────────────────────────────────────────────────────────────────

export interface CodexCloudAdapterOptions {
  /** ~/.codex/auth.json (or CODECAST_CODEX_HOME's), or null when there is none. Read only, never written. */
  readAuth?: () => string | null;
  /** Run the machine's own `codex login` where it can open the browser (a utility tmux pane). */
  runLogin?: (argv: string[]) => Promise<void>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** The machine's Codex login, read as it is on disk. */
function readCodexAuthFile(): string | null {
  try { return fs.readFileSync(path.join(codexHome(), "auth.json"), "utf8"); } catch { return null; }
}

export class CodexCloudAdapter implements CloudAgentAdapter<CodexCloudApi, WhamTask, Record<string, never>> {
  readonly spec = CODEX;
  readonly mirrorFormat = MIRROR_FORMAT;
  readonly pollMs = POLL_MS;
  readonly fastPollMs = FAST_POLL_MS;
  readonly login: CloudAgentLogin;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly readAuth: () => string | null;

  constructor(private readonly opts: CodexCloudAdapterOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.readAuth = opts.readAuth ?? readCodexAuthFile;
    this.login = { check: () => this.checkLogin(), start: () => this.startLogin() };
  }

  client(): CodexCloudApi | CloudAgentSetupError {
    const raw = this.readAuth();
    const summary = decodeCodexAuth(raw);
    const headers = raw && summary.usable ? codexBackendHeadersFromAuth(raw) : null;
    if (!headers) return CloudAgentSetupError.credentialsMissing(this);
    if (summary.access_expires_at && summary.access_expires_at <= this.now()) {
      return CloudAgentSetupError.credentialsRejected(this, `the sign-in expired ${new Date(summary.access_expires_at).toISOString().slice(0, 10)}, and codecast never refreshes it: sign in to Codex again`);
    }
    return new CodexCloudApi(headers, this.fetchImpl);
  }

  loadData(): Record<string, never> {
    return {};
  }

  async listAgents(api: CodexCloudApi, cursor?: string): Promise<{ items: CloudAgentListItem<WhamTask>[]; nextCursor?: string }> {
    const data = await api.listTasks(20, cursor);
    const items = (data.items ?? []).filter((t) => typeof t?.id === "string");
    return {
      items: items.map((task) => ({
        id: task.id,
        updatedAtMs: secondsToMs(task.updated_at) ?? secondsToMs(task.created_at) ?? 0,
        version: taskVersion(task),
        active: isRunningTurnStatus(task.task_status_display?.latest_turn_status_display?.turn_status),
        agent: task,
      })),
      nextCursor: items.length && data.cursor ? data.cursor : undefined,
    };
  }

  async mirror(api: CodexCloudApi, handle: CloudAgentHandle<Record<string, never>>, known: WhamTask | undefined): Promise<CloudAgentMirror> {
    const taskId = handle.agentId;
    const [turns, task] = await Promise.all([api.turns(taskId), known ? Promise.resolve(known) : api.task(taskId).then((r) => r.task)]);
    const chain = taskTurnChain(turns);
    const createdAt = secondsToMs(task?.created_at) ?? secondsToMs(chain[0]?.created_at) ?? 0;
    const pullRequests = task?.pull_requests ?? task?.external_pull_requests;
    const repo = taskRepo(chain);
    return {
      transcript: buildCodexCloudTranscript({ turns, createdAt, notice: await handle.notice(), pullRequests }),
      title: task?.title,
      url: CODEX.agentUrl(taskId),
      createdAtMs: createdAt,
      repo,
      version: task ? taskVersion(task) : `${turns.current_turn_id ?? ""}|${chain.at(-1)?.turn_status ?? ""}`,
      running: chain.some((t) => t.type === "assistant" && isRunningTurnStatus(t.turn_status)),
      git: taskGit(taskId, task, chain, repo),
    };
  }

  async create(api: CodexCloudApi, session: CloudAgentSession, content: string): Promise<{ agentId: string; url?: string }> {
    const repo = githubRepo(session.repoUrl);
    if (!repo) throw CloudAgentSetupError.repoUnreachable(this, "Codex Cloud works on a GitHub repository, and this session's folder has no GitHub remote");
    const [owner, name] = repo.split("/");
    const envs = await api.environmentsForRepo(owner, name);
    const env = envs[0];
    if (!env) throw CloudAgentSetupError.repoUnreachable(this, `Codex Cloud has no environment for ${repo}. Create one at ${ENVIRONMENTS_URL}`);
    const created = await api.createTask({
      new_task: { environment_id: env.id, branch: session.startingRef ?? env.defaultBranch ?? "main", run_environment_in_qa_mode: false },
      input_items: inputItems(content),
    });
    const agentId = created.task?.id;
    if (!agentId) throw new Error("Codex Cloud created no task");
    return { agentId, url: CODEX.agentUrl(agentId) };
  }

  /** A follow-up continues the task's current turn, in the mode the task runs in (ask or code). */
  async followUp(api: CodexCloudApi, taskId: string, content: string): Promise<void> {
    const [turns, task] = await Promise.all([api.turns(taskId), api.task(taskId).then((r) => r.task).catch(() => undefined)]);
    const last = taskTurnChain(turns).at(-1);
    if (!last || last.type !== "assistant" || isRunningTurnStatus(last.turn_status)) throw new CloudAgentBusyError(CODEX.label);
    const status = task?.task_status_display;
    const ask = (status?.latest_turn_status_display?.intent ?? status?.initial_intent) === "qa";
    await api.createTask({ follow_up: { task_id: taskId, turn_id: last.id, run_environment_in_qa_mode: ask }, input_items: inputItems(content) });
  }

  async cancel(api: CodexCloudApi, taskId: string): Promise<string | null> {
    const running = taskTurnChain(await api.turns(taskId)).some((t) => t.type === "assistant" && isRunningTurnStatus(t.turn_status));
    if (!running) return null;
    await api.cancel(taskId);
    return `task ${taskId}`;
  }

  /** A repository Codex Cloud cannot reach, or a workspace with Codex Cloud turned off (a 401 is the core's rule). */
  setupErrorOf(err: unknown, session: CloudAgentSession): CloudAgentSetupError | null {
    if (!(err instanceof CloudApiError) || err.status !== 403) return null;
    if (err.code === "repo_not_accessible") {
      const repo = githubRepo(session.repoUrl) ?? "this repository";
      return CloudAgentSetupError.repoUnreachable(this, `Codex Cloud can't reach ${repo} (${err.message}). Connect it to an environment at ${ENVIRONMENTS_URL}`);
    }
    return CloudAgentSetupError.accessDenied(this, workspaceDisabled(err.message));
  }

  /** The machine's Codex sign-in, checked with Codex: the account and plan, or why it cannot run cloud tasks. */
  private async checkLogin(): Promise<CloudAgentLoginState> {
    const client = this.client();
    const summary = decodeCodexAuth(this.readAuth());
    if (client instanceof CloudAgentSetupError) {
      return client.kind === "key_missing" ? { state: "signed_out" } : { state: "expired", ...(summary.email ? { account: summary.email } : {}) };
    }
    const [usage, list] = await Promise.allSettled([client.usage(), client.listTasks(1)]);
    const failure = [list, usage].find((r): r is PromiseRejectedResult => r.status === "rejected")?.reason;
    if (failure instanceof CloudApiError && failure.status === 401) return { state: "expired", ...(summary.email ? { account: summary.email } : {}) };
    if (list.status === "rejected" && list.reason instanceof CloudApiError && list.reason.status === 403) {
      return { state: "disabled", detail: workspaceDisabled(list.reason.message), ...(summary.email ? { account: summary.email } : {}) };
    }
    if (list.status === "rejected") return { state: "unreachable", detail: errorText(list.reason) };
    const u = usage.status === "fulfilled" ? usage.value : undefined;
    const account = u?.email ?? summary.email;
    const plan = u?.plan_type ?? summary.plan;
    return { state: "signed_in", ...(account ? { account } : {}), ...(plan ? { plan } : {}) };
  }

  private async startLogin(): Promise<void> {
    if (!this.opts.runLogin) throw new Error("this codecast cannot run codex login");
    await this.opts.runLogin(["codex", "login"]);
  }
}

function workspaceDisabled(reason: string): string {
  return `Codex Cloud is not enabled for this ChatGPT workspace (${reason}). A workspace admin can turn on "Use Codex in the cloud" for your role in the workspace's Codex settings`;
}
