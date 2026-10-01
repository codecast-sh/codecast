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
import { CLOUD_AGENT_BRANCH_SEPARATOR, CLOUD_AGENT_PROVIDERS, cloudAgentRootId } from "@codecast/shared/contracts";
import { githubRepo } from "../cloud/gitOrigin.js";
import { readActiveCodexAuth } from "../codexAccounts.js";
import { codexAccessExpired, decodeCodexAuth } from "../codexAuthDecode.js";
import { codexBackendHeadersFromAuth, codexBackendRequest, parseBackendUsageResponse, requestCodexBackendUsage } from "../codexBackendUsage.js";
import { threadItemToMessage, type ThreadItem } from "../codexAppServer.js";
import type { ParsedMessage } from "../parser.js";
import { splitPatches } from "../repoMirror.js";
import { CloudApiError, cloudApiErrorOf } from "./http.js";
import { repoOwnerName } from "./poll.js";
import { MirrorTranscript } from "./transcript.js";
import { CloudAgentBusyError, CloudAgentSetupError, type CloudAgentAdapter, type CloudAgentApplyPlan, type CloudAgentGit, type CloudAgentHandle, type CloudAgentListItem, type CloudAgentLogin, type CloudAgentLoginCommand, type CloudAgentMirror } from "./types.js";
import type { CloudAgentSession } from "./sessions.js";

const CODEX = CLOUD_AGENT_PROVIDERS.codex;
/** Bump when the rendered transcript changes shape (or what a mirror records): every mirror re-renders once. */
const MIRROR_FORMAT = 10;
/** The same cadence the chatgpt.com web app polls a running task at; idle, a new task shows within five minutes. */
const POLL_MS = 5 * 60_000;
const FAST_POLL_MS = 30_000;
/** The title a task has until Codex names it: not a name, so the session is titled by its prompt until the real one comes. */
const PLACEHOLDER_TITLE = "New task";
/** The statuses of a turn still running; any other status, one the spike never saw included, has ended. */
const RUNNING_TURN_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress"]);

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
interface WhamThreadEvent { method?: string; params?: { item?: { id?: string; type?: string; server?: string }; completedAtMs?: number } }
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
  /** not_created, creating, created (or failed) after POST .../pr. */
  pull_request_status?: string | null;
  pull_request_data?: WhamPullRequest | null;
  /** Carries the environment's env vars and secrets in plain text: only repo_map's repository names are ever read. */
  environment?: { repo_map?: Record<string, { repository_full_name?: string }> } | null;
}

export interface WhamTurns { current_turn_id?: string | null; turn_mapping?: Record<string, { turn?: WhamTurn }> }

export interface WhamTask {
  id: string;
  title?: string;
  /** False while the title is still the placeholder ("New task"). */
  has_generated_title?: boolean;
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
  /** Archived (POST .../archive): out of the current list, still readable by id. */
  archived?: boolean | null;
}

/** An environment as codecast keeps it: never its env vars or secrets. */
export interface WhamEnvironment { id: string; label?: string; machineId?: string; pinned?: boolean; defaultBranch?: string; repos: string[] }

// ── API client ───────────────────────────────────────────────────────────────

export class CodexCloudApi {
  constructor(private readonly headers: Record<string, string>, private readonly fetchImpl: typeof fetch = fetch) {}

  /** Errors come as {detail}, {detail: {type, message}} or {error: {message, type}}. */
  request<T>(method: string, p: string, body?: unknown): Promise<T> {
    return codexBackendRequest<T>(this.headers, method, p, { body, fetchImpl: this.fetchImpl });
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
  /** One turn, with its pull request's status. */
  turn(id: string, turnId: string): Promise<{ turn?: WhamTurn }> {
    return this.request("GET", `/tasks/${encodeURIComponent(id)}/turns/${encodeURIComponent(turnId)}`);
  }
  cancel(id: string): Promise<unknown> {
    return this.request("POST", `/tasks/${encodeURIComponent(id)}/cancel`, {});
  }
  /** Archive the task (hidden from the current list), or bring it back. */
  archive(id: string, archived: boolean): Promise<unknown> {
    return this.request("POST", `/tasks/${encodeURIComponent(id)}/${archived ? "archive" : "recover"}`, {});
  }
  /** Open a draft pull request from an assistant turn's changes; the turn reports it once made. */
  createPullRequest(id: string, turnId: string): Promise<unknown> {
    return this.request("POST", `/tasks/${encodeURIComponent(id)}/turns/${encodeURIComponent(turnId)}/pr`, { mode: "draft", add_codex_tag: false });
  }
  /** The login's email and plan, read by the same request and parser as the usage meters. */
  async usage(now = Date.now()): Promise<{ email?: string; plan?: string }> {
    const body = await requestCodexBackendUsage(this.headers, this.fetchImpl);
    const email = typeof body?.email === "string" ? body.email : undefined;
    const plan = parseBackendUsageResponse(body, now)?.plan_type ?? undefined;
    return { ...(email ? { email } : {}), ...(plan ? { plan } : {}) };
  }
  /** The environments set up for a GitHub repository, stripped to what codecast keeps. */
  environmentsForRepo(owner: string, name: string): Promise<WhamEnvironment[]> {
    return this.environmentList(`/environments/by-repo/github/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
  }
  /** Every environment on the account, stripped to what codecast keeps. */
  environments(): Promise<WhamEnvironment[]> {
    return this.environmentList("/environments");
  }
  private async environmentList(p: string): Promise<WhamEnvironment[]> {
    const raw = await this.request<unknown>("GET", p);
    return (Array.isArray(raw) ? raw : []).map(keptEnvironment).filter((e): e is WhamEnvironment => !!e);
  }
}

/** An environment payload carries the account's env vars and secrets in plain text: only these fields are ever read. */
function keptEnvironment(raw: any): WhamEnvironment | null {
  if (!raw || typeof raw.id !== "string") return null;
  const repos = Object.values(raw.repo_map ?? {}) as Array<{ repository_full_name?: unknown; default_branch?: unknown }>;
  const branch = repos.find((r) => typeof r?.default_branch === "string")?.default_branch;
  return {
    id: raw.id,
    ...(typeof raw.label === "string" ? { label: raw.label } : {}),
    ...(typeof raw.machine_id === "string" ? { machineId: raw.machine_id } : {}),
    ...(raw.is_pinned === true ? { pinned: true } : {}),
    ...(typeof branch === "string" ? { defaultBranch: branch } : {}),
    repos: repos.map((r) => r?.repository_full_name).filter((n): n is string => typeof n === "string"),
  };
}

/**
 * The environment a new task runs in, the way the CLI picks it: the ones set
 * up for the repository (by-repo), else any whose repositories name it; a
 * pinned one first.
 */
export async function pickEnvironment(api: CodexCloudApi, owner: string, name: string): Promise<WhamEnvironment | undefined> {
  const pinnedFirst = (envs: WhamEnvironment[]) => envs.find((e) => e.pinned) ?? envs[0];
  const repo = `${owner}/${name}`.toLowerCase();
  return pinnedFirst(await api.environmentsForRepo(owner, name))
    ?? pinnedFirst((await api.environments()).filter((e) => e.repos.some((r) => r.toLowerCase() === repo)));
}

/** A prompt as the API takes it. */
function inputItems(text: string) {
  return [{ type: "message", role: "user", content: [{ content_type: "text", text }] }];
}

// ── Turns ────────────────────────────────────────────────────────────────────

export function isRunningTurnStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && RUNNING_TURN_STATUSES.has(status);
}

/** The id's own half: turn ids are `<task id>~<turn id>`. */
function turnKey(id: string): string {
  return id.slice(id.indexOf(CLOUD_AGENT_BRANCH_SEPARATOR) + 1);
}

/**
 * One line through a task's turns, oldest first. The task's own line takes
 * attempt 1 wherever several ran; each other attempt is a branch of the line
 * it ran on, forking at its prompt, and keeps its own follow-ups. Lines never
 * change which attempt they follow, so a session's history holds still
 * whichever attempt the task continues from.
 */
export interface CodexTaskLine {
  /** The task's id for its own line, else the branch's attempt turn id. */
  id: string;
  turns: WhamTurn[];
  /** A branch: the line it forks, the prompt it forks at (its record id) and where its own turns start. */
  parent?: string;
  forkAt?: string;
  ownFrom?: number;
}

/** Every turn of a task, in no order. */
function allTurns(turns: WhamTurns): WhamTurn[] {
  return Object.values(turns.turn_mapping ?? {}).map((n) => n.turn).filter((t): t is WhamTurn => !!t?.id);
}

export function codexTaskLines(taskId: string, turns: WhamTurns): CodexTaskLine[] {
  const all = allTurns(turns);
  const byId = new Map(all.map((t) => [t.id, t]));
  const byCreated = (a: WhamTurn, b: WhamTurn) => (a.created_at ?? 0) - (b.created_at ?? 0);
  // Attempts in their order (attemptsAfter); several follow-ups sent from one turn, the newest.
  const next = (id: string) => {
    const attempts = attemptsAfter(all, id);
    return attempts.length ? attempts : all.filter((t) => t.previous_turn_id === id).sort((a, b) => byCreated(b, a));
  };
  const descend = (path: WhamTurn[]) => {
    const seen = new Set(path.map((t) => t.id));
    for (let t = next(path.at(-1)!.id).find((c) => !seen.has(c.id)); t; t = next(t.id).find((c) => !seen.has(c.id))) {
      seen.add(t.id);
      path.push(t);
    }
    return path;
  };
  const root = all.filter((t) => !t.previous_turn_id || !byId.has(t.previous_turn_id)).sort(byCreated)[0];
  const lines: CodexTaskLine[] = [{ id: taskId, turns: root ? descend([root]) : [] }];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    for (let i = line.ownFrom === undefined ? 0 : line.ownFrom + 1; i < line.turns.length; i++) {
      const turn = line.turns[i];
      if (turn.type !== "assistant" || !turn.previous_turn_id) continue;
      for (const attempt of next(turn.previous_turn_id)) {
        if (attempt.id === turn.id || attempt.type !== "assistant") continue;
        const prompt = line.turns[i - 1];
        lines.push({ id: attempt.id, turns: descend([...line.turns.slice(0, i), attempt]), parent: line.id, ...(prompt ? { forkAt: turnKey(prompt.id) } : {}), ownFrom: i });
      }
    }
  }
  return lines;
}

/** A line's turns (the task's own line when `lineId` is the task's id or omitted); empty when the task has no such line. */
export function taskTurnChain(turns: WhamTurns, lineId?: string): WhamTurn[] {
  const lines = codexTaskLines(lineId ? cloudAgentRootId(lineId) : "", turns);
  return (lineId && lineId.includes(CLOUD_AGENT_BRANCH_SEPARATOR) ? lines.find((l) => l.id === lineId) : lines[0])?.turns ?? [];
}

/** The order of a prompt's attempts: by placement, and on older tasks (no placement) by when each started. */
function attemptOrder(a: WhamTurn, b: WhamTurn): number {
  return (a.attempt_placement ?? 0) - (b.attempt_placement ?? 0) || (a.created_at ?? 0) - (b.created_at ?? 0);
}

/** The assistant turns answering one prompt, in attempt order. */
function attemptsAfter(all: WhamTurn[], promptId: string): WhamTurn[] {
  return all.filter((t) => t.type === "assistant" && t.previous_turn_id === promptId).sort(attemptOrder);
}

/** A best-of-N turn's attempts at its prompt, in order: attempt n is index n - 1. A turn with no siblings has just itself. */
function attemptsAt(turns: WhamTurns, turn: WhamTurn): WhamTurn[] {
  if (!turn.previous_turn_id || !turn.sibling_turn_ids?.length) return [turn];
  return attemptsAfter(allTurns(turns), turn.previous_turn_id);
}

/** Which attempt a turn is, counted from 1 as Codex Cloud names them. */
function attemptNumber(turns: WhamTurns, turn: WhamTurn): number {
  return attemptsAt(turns, turn).findIndex((t) => t.id === turn.id) + 1 || 1;
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

/** A failed turn's reason, in whichever shape the API gave it (the same reader as its HTTP errors). */
function turnError(err: unknown): string {
  return typeof err === "string" && err ? err : cloudApiErrorOf(0, err, "no reason given").message;
}

function secondsToMs(s: number | null | undefined): number | undefined {
  return typeof s === "number" && Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : undefined;
}

/**
 * The tool Codex Cloud records a pull request's title and body with (an MCP
 * server's `make_pr`, `container.make_pr` in a worklog). Its call says nothing
 * the turn's pull request row does not, so it is not shown.
 */
const PR_RECORDING_TOOL = "make_pr";

/** An app-server item and when it happened: every turn's log becomes these, and each renders through threadItemToMessage. */
interface DatedItem { item: ThreadItem; at: number }

/** The turn's app-server items, dated by when each completed; the prompt is the user turn's. */
function threadEventItems(turn: WhamTurn): DatedItem[] {
  const out: DatedItem[] = [];
  for (const e of turn.thread_events?.events ?? []) {
    const item = e.method === "item/completed" ? e.params?.item : undefined;
    if (!item?.id || item.type === "userMessage") continue;
    if (item.type === "mcpToolCall" && item.server === PR_RECORDING_TOOL) continue;
    out.push({ item: item as ThreadItem, at: e.params?.completedAtMs ?? 0 });
  }
  return out;
}

/**
 * Worklog calls that say nothing the transcript does not: opening the shell
 * the next commands run in (its reply is empty), and recording the pull
 * request's title and body (the turn's pull request row shows both).
 */
const LEGACY_SILENT_TOOLS: ReadonlySet<string> = new Set(["container.new_session", `container.${PR_RECORDING_TOOL}`]);

/** A worklog tool call as the item Codex records it as now: a shell command, else a tool named by its recipient. */
function legacyToolItem(m: WhamWorklogMessage, id: string): { item: ThreadItem; chars?: string } {
  const code = m.content?.text ?? "";
  let args: Record<string, unknown>;
  try {
    const parsed = JSON.parse(code);
    args = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { input: parsed };
  } catch {
    args = { input: code };
  }
  const recipient = m.recipient ?? "tool";
  const command = (text: string, cwd?: string): ThreadItem => ({ type: "commandExecution", id, command: text, ...(cwd ? { cwd } : {}), status: "completed", aggregatedOutput: "" });
  if (recipient === "container.feed_chars") {
    const chars = typeof args.chars === "string" ? args.chars : "";
    // Keys typed into the terminal read the way a terminal echoes them: Ctrl-C is ^C.
    return { item: command(chars.replace(/\n$/, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (c) => c === "\x7f" ? "^?" : `^${String.fromCharCode(c.charCodeAt(0) + 64)}`)), chars };
  }
  if (recipient === "container.exec") {
    const cmd = Array.isArray(args.cmd) ? args.cmd.map(String) : typeof args.cmd === "string" ? [args.cmd] : [];
    return { item: command(cmd.length === 3 && /^(ba|z)?sh$/.test(cmd[0]) && cmd[1] === "-lc" ? cmd[2] : cmd.join(" "), typeof args.workdir === "string" ? args.workdir : undefined) };
  }
  return { item: { type: "dynamicToolCall", id, tool: recipient, arguments: args, status: "completed" } };
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

/** Add a tool's reply to its item: a command's output grows, any other tool's is its answer. */
function addToolOutput(item: ThreadItem, text: string): void {
  if (item.type === "commandExecution") item.aggregatedOutput = item.aggregatedOutput ? `${item.aggregatedOutput}\n${text}` : text;
  else if (item.type === "dynamicToolCall") item.contentItems = [...(item.contentItems ?? []), { type: "inputText", text }];
}

/**
 * A worklog (tasks from before thread_events) as the items Codex records now:
 * narration as agentMessage (the running commentary the worklog marks as
 * reasoning as reasoning), each tool call with its replies as one item. A
 * shell read with no input (feed_chars with no chars, waiting on output) adds
 * its output to the command before it.
 */
export function legacyWorklogItems(messages: WhamWorklogMessage[]): DatedItem[] {
  const out: DatedItem[] = [];
  // A silent call's reply is swallowed (null), never added to the command before it.
  const openCalls = new Map<string, ThreadItem | null>();
  let lastCommand: ThreadItem | undefined;
  let clock = 0;
  messages.forEach((m, i) => {
    const role = m.author?.role;
    const at = secondsToMs(m.create_time) ?? clock;
    clock = at;
    const id = m.id ?? `worklog-${i}`;
    const ct = m.content?.content_type;
    if (role === "assistant" && ct === "text") {
      const text = (m.content?.parts ?? []).filter((p): p is string => typeof p === "string").join("\n").trim();
      if (!text) return;
      const reasoning = m.metadata?.reasoning_status === "is_reasoning";
      out.push({ item: reasoning ? { type: "reasoning", id, content: [text], summary: [] } : { type: "agentMessage", id, text }, at });
      return;
    }
    if (role === "assistant" && m.recipient && m.recipient !== "all") {
      if (LEGACY_SILENT_TOOLS.has(m.recipient)) { openCalls.set(m.recipient, null); return; }
      const { item, chars } = legacyToolItem(m, id);
      const isRead = m.recipient === "container.feed_chars" && !chars?.trim();
      if (isRead && lastCommand) { openCalls.set(m.recipient, lastCommand); return; }
      out.push({ item, at });
      openCalls.set(m.recipient, item);
      if (item.type === "commandExecution") lastCommand = item;
      return;
    }
    if (role === "tool" || ct === "execution_output") {
      const name = m.author?.name ?? "";
      if (openCalls.get(name) === null) { openCalls.delete(name); return; }
      const item = openCalls.get(name) ?? [...openCalls.values()].filter((c): c is ThreadItem => !!c).at(-1);
      if (!item) return;
      addToolOutput(item, legacyToolOutput(m));
      openCalls.delete(name);
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

type TaskPullRequests = WhamTask["pull_requests"];

/** A task's pull requests, which the list and GET /tasks/{id} name differently. */
function taskPullRequests(task: WhamTask | undefined): TaskPullRequests {
  return task?.pull_requests ?? task?.external_pull_requests;
}

/** A turn's pull request: the one it opened, else the task's for that turn. */
function turnPullRequest(turn: WhamTurn, pullRequests: TaskPullRequests): WhamPullRequest | undefined {
  return turn.pull_request_data?.url ? turn.pull_request_data : pullRequests?.find((p) => p.assistant_turn_id === turn.id)?.pull_request;
}

/**
 * How many attempts ran at a best-of-N turn and which one this line is: each
 * attempt is its own branch of the session, a switch away under the prompt.
 */
function attemptsNote(turns: WhamTurns, turn: WhamTurn): string | undefined {
  const attempts = attemptsAt(turns, turn);
  if (attempts.length < 2) return undefined;
  return `${CODEX.label} ran ${attempts.length} attempts at this; this is attempt ${attemptNumber(turns, turn)}. Each attempt is a branch of this session: switch under the prompt, and a message sent on a branch continues that attempt.`;
}

export interface CodexCloudTranscriptInput {
  taskId: string;
  turns: WhamTurns;
  /** The line to render: the task's own (default) or a branch's (its attempt turn's id). */
  lineId?: string;
  /** Clock for anything the payload does not date. */
  createdAt: number;
  notice?: string;
  /** The task's pull requests, to link the one a turn opened. */
  pullRequests?: TaskPullRequests;
}

/**
 * The task's transcript in the mirror format (transcript.ts). Record ids are
 * `<turn>:<item>`, and every record is dated by the payload (a user turn's
 * created_at, an item's completedAtMs, a worklog message's create_time), so a
 * re-render never moves or duplicates a row.
 */
export function buildCodexCloudTranscript(input: CodexCloudTranscriptInput): string {
  const tx = new MirrorTranscript(input.createdAt, { linkify: codexCitations, notice: input.notice });
  for (const turn of taskTurnChain(input.turns, input.lineId ?? input.taskId)) {
    const key = turnKey(turn.id);
    tx.advanceTo(secondsToMs(turn.created_at));
    if (turn.type === "user") {
      tx.turn(key, contentText(turn.input_items?.flatMap((i) => i.content ?? [])));
      continue;
    }
    tx.turn(undefined, undefined);
    const attempts = attemptsNote(input.turns, turn);
    if (attempts) tx.note(`${key}:attempts`, attempts);
    const events = threadEventItems(turn);
    const worklog = turn.worklog?.messages ?? [];
    for (const { item, at } of events.length ? events : legacyWorklogItems(worklog)) {
      const m = threadItemToMessage(item, at);
      if (m) tx.message({ ...m, uuid: `${key}:${m.uuid}` });
    }
    // The answer, when the turn's own log says it (an app-server agentMessage, a
    // worklog's end_turn message, both with citations), is not repeated from the
    // output items, which carry the same text without them.
    const answered = events.length
      ? events.some(({ item }) => item.type === "agentMessage" && !!item.text)
      : worklog.some((m) => m.end_turn === true && m.author?.role === "assistant" && m.content?.content_type === "text");

    const outputs = turn.output_items ?? [];
    const answer = outputs.find((o) => o.type === "message");
    if (answer && !answered) {
      const text = contentText(answer.content).trim();
      if (text) tx.assistant(`${key}:answer`, text);
    }
    const pr = outputs.find((o) => o.type === "pr");
    const diff = turnDiff(turn);
    if (pr?.pr_title || diff) {
      const opened = turnPullRequest(turn, input.pullRequests);
      const title = pr?.pr_title ? `**${pr.pr_title}**` : "**Changes**";
      const link = opened?.url ? ` · [pull request #${opened.number ?? ""}](${opened.url})` : "";
      tx.assistant(`${key}:pr`, `${title}${link}${pr?.pr_message ? `\n\n${pr.pr_message}` : ""}`);
      const change = diff ? diffMessage(`${key}:diff`, diff, tx.clock) : null;
      if (change) tx.message(change);
    }

    if (isRunningTurnStatus(turn.turn_status)) {
      const text = turn.latest_event?.text?.trim();
      if (text) tx.note(`${key}:progress`, text, secondsToMs(turn.created_at) ?? tx.clock);
      continue;
    }
    if (turn.turn_status === "failed") tx.error(`${key}:error`, `${CODEX.label} turn failed: ${turnError(turn.error)}`);
    else if (turn.turn_status === "cancelled") tx.note(`${key}:cancelled`, "Cancelled.");
    else if (turn.turn_status && turn.turn_status !== "completed") tx.note(`${key}:ended`, `${CODEX.label} ended this turn as ${turn.turn_status}.`);
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

/**
 * The branch the task's shown chain made: a pull request one of its turns
 * opened, else the branch its current attempt pushed. Never the environment's
 * base branch (task_status_display.branch_name, "main" on every task), and
 * never another attempt's pull request (the attempts note links that one): a
 * chain that pushed nothing has no branch of its own.
 */
export function taskGit(taskId: string, task: WhamTask | undefined, chain: WhamTurn[], repo: string | undefined): CloudAgentGit | null {
  const prs = taskPullRequests(task);
  const pr = [...chain].reverse().map((t) => turnPullRequest(t, prs)).find((p) => p?.url);
  const current = [...chain].reverse().find((t) => t.type === "assistant");
  const branch = pr?.head ?? current?.branch_name ?? undefined;
  if (!branch && !pr?.url) return null;
  return { agentId: taskId, ...(repo ? { repoUrl: `https://github.com/${repo}` } : {}), ...(branch ? { branch } : {}), ...(pr?.url ? { prUrl: pr.url } : {}) };
}

/** Whether any of these turns is an assistant turn still running. */
function anyRunning(turns: WhamTurn[]): boolean {
  return turns.some((t) => t.type === "assistant" && isRunningTurnStatus(t.turn_status));
}

/** Whether any turn of the task is still running. */
function taskRunning(turns: WhamTurns): boolean {
  return anyRunning(allTurns(turns));
}

/** An output item's diff of one kind: "follow_up_diff" (that turn's own changes) or "pr" (the line's changes so far, verified live). */
function outputDiff(turn: WhamTurn, type: "follow_up_diff" | "pr"): string {
  return turn.output_items?.find((o) => o.type === type)?.output_diff?.diff || "";
}

/** The diff an assistant turn itself made (the transcript's row for that turn); "" when it changed no code. */
function turnDiff(turn: WhamTurn): string {
  return outputDiff(turn, "follow_up_diff") || outputDiff(turn, "pr");
}

/** Everything the line changed up to this turn: what Create PR and Apply act on. */
function lineDiff(turn: WhamTurn): string {
  return outputDiff(turn, "pr") || outputDiff(turn, "follow_up_diff");
}

/** The last turn of a chain that changed code. */
function lastChanges(chain: WhamTurn[]): WhamTurn | undefined {
  return [...chain].reverse().find((t) => t.type === "assistant" && !!turnDiff(t));
}

function taskVersion(task: WhamTask): string {
  const latest = task.task_status_display?.latest_turn_status_display;
  return `${task.updated_at ?? ""}|${latest?.turn_id ?? ""}|${latest?.turn_status ?? ""}`;
}

// ── Adapter ──────────────────────────────────────────────────────────────────

export interface CodexCloudAdapterOptions {
  /** ~/.codex/auth.json (or CODECAST_CODEX_HOME's), or null when there is none. Read only, never written. */
  readAuth?: () => string | null;
  /** Run the machine's own `codex login` (a utility tmux pane). */
  runLogin?: (command: CloudAgentLoginCommand) => Promise<void>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Waits between reads of a pull request Codex is still opening (tests). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * What a mirror pass starts from: the task as its list shows it, or for a
 * branch, the task and turns its parent line just read.
 */
export type CodexKnown = WhamTask | { task?: WhamTask; turns: WhamTurns };

/** Why Create PR and Apply wait: a running turn's changes are not there yet. */
const STILL_RUNNING = "the task is still running: its changes come when the turn ends";

/** How long Create PR waits for Codex to open the pull request (it passes through "creating" for a few seconds). */
const PR_WAIT_MS = 60_000;
const PR_POLL_MS = 3_000;

/** A task's own title, or nothing while it is still the placeholder. */
export function codexTaskTitle(task: WhamTask | undefined): string | undefined {
  if (!task?.title || task.has_generated_title === false || task.title === PLACEHOLDER_TITLE) return undefined;
  return task.title;
}

export class CodexCloudAdapter implements CloudAgentAdapter<CodexCloudApi, CodexKnown, Record<string, never>> {
  readonly spec = CODEX;
  readonly mirrorFormat = MIRROR_FORMAT;
  readonly pollMs = POLL_MS;
  readonly fastPollMs = FAST_POLL_MS;
  readonly login: CloudAgentLogin<CodexCloudApi>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly readAuth: () => string | null;

  constructor(private readonly opts: CodexCloudAdapterOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.readAuth = opts.readAuth ?? readActiveCodexAuth;
    this.login = {
      whoami: (api) => this.whoami(api),
      localAccount: () => decodeCodexAuth(this.readAuth()).email,
      start: () => this.startLogin(),
    };
  }

  client(): CodexCloudApi | CloudAgentSetupError {
    const raw = this.readAuth();
    const summary = decodeCodexAuth(raw);
    const headers = raw && summary.usable ? codexBackendHeadersFromAuth(raw) : null;
    if (!headers) return CloudAgentSetupError.credentialsMissing(this, summary.api_key ? API_KEY_LOGIN : undefined);
    if (codexAccessExpired(summary, this.now())) return CloudAgentSetupError.credentialsExpired(this, summary.access_expires_at!);
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

  /**
   * One line of a task: its own (the task's id) or a branch (another
   * attempt's turn id). The task's line names its branches as children, each
   * forking at its prompt; every line of a task carries the task's version,
   * so a change anywhere in the task mirrors each again.
   */
  async mirror(api: CodexCloudApi, handle: CloudAgentHandle<Record<string, never>>, known: CodexKnown | undefined): Promise<CloudAgentMirror | null> {
    const lineId = handle.agentId;
    const taskId = cloudAgentRootId(lineId);
    const read = known && "turns" in known ? known : undefined;
    const knownTask = read ? read.task : known as WhamTask | undefined;
    const [turns, task] = await Promise.all([read?.turns ?? api.turns(taskId), knownTask ? Promise.resolve(knownTask) : api.task(taskId).then((r) => r.task)]);
    const lines = codexTaskLines(taskId, turns);
    const line = lines.find((l) => l.id === lineId);
    if (!line) return null;
    const chain = line.turns;
    const createdAt = secondsToMs(task?.created_at) ?? secondsToMs(chain[0]?.created_at) ?? 0;
    const pullRequests = taskPullRequests(task);
    const repo = taskRepo(chain);
    const version = task ? taskVersion(task) : `${turns.current_turn_id ?? ""}|${chain.at(-1)?.turn_status ?? ""}`;
    const title = codexTaskTitle(task);
    const branchOf = line.ownFrom !== undefined ? chain[line.ownFrom] : undefined;
    return {
      transcript: buildCodexCloudTranscript({ taskId, lineId, turns, createdAt, notice: await handle.notice(), pullRequests }),
      title: branchOf && title ? `Attempt ${attemptNumber(turns, branchOf)}: ${title}` : title,
      placeholderTitles: [PLACEHOLDER_TITLE],
      url: CODEX.agentUrl(taskId),
      createdAtMs: createdAt,
      repo,
      version,
      // Any turn of the task running keeps each of its lines followed: a follow-up waits for the whole task.
      running: taskRunning(turns),
      git: taskGit(lineId, task, chain, repo),
      ...(task ? { archived: task.archived === true } : {}),
      children: lines.filter((l) => l.parent === lineId).map((l) => ({
        agentId: l.id,
        description: `attempt ${attemptNumber(turns, l.turns[l.ownFrom!])}`,
        ...(l.forkAt ? { forkAt: l.forkAt } : {}),
        version,
        known: { task, turns },
      })),
    };
  }

  /**
   * A new task in the repository's environment (pickEnvironment), on the
   * branch the session starts from, in ask or code mode, with as many
   * attempts as the launch asked for.
   */
  async create(api: CodexCloudApi, session: CloudAgentSession, content: string): Promise<{ agentId: string; url?: string }> {
    const repo = repoOwnerName(githubRepo(session.repoUrl));
    if (!repo) throw CloudAgentSetupError.repoUnreachable(this, session, "this session's folder has no GitHub remote", `${CODEX.label} works on GitHub repositories: start the session in a checkout of one`);
    const env = await pickEnvironment(api, repo.owner, repo.name);
    if (!env) throw CloudAgentSetupError.repoUnreachable(this, session, "it has no Codex environment", `Create one at ${CODEX.repoAccessUrl}`);
    const attempts = Math.min(Math.max(session.attempts ?? 1, 1), CODEX.launchOptions.maxAttempts);
    const created = await api.createTask({
      new_task: { environment_id: env.id, branch: session.startingRef ?? env.defaultBranch ?? "main", run_environment_in_qa_mode: !!session.ask },
      input_items: inputItems(content),
      ...(attempts > 1 ? { metadata: { best_of_n: attempts } } : {}),
    });
    const agentId = created.task?.id;
    if (!agentId) throw new Error(`${CODEX.label} created no task`);
    return { agentId, url: CODEX.agentUrl(agentId) };
  }

  /**
   * A follow-up continues the line's last turn (a branch's, its own attempt),
   * in the mode the task runs in (ask or code). The whole task waits while any
   * of its turns runs. The mode comes from the task itself, so a task that
   * cannot be read fails the delivery rather than guess code mode for a question.
   */
  async followUp(api: CodexCloudApi, agentId: string, content: string): Promise<void> {
    const taskId = cloudAgentRootId(agentId);
    const [turns, task] = await Promise.all([api.turns(taskId), api.task(taskId).then((r) => r.task)]);
    const last = taskTurnChain(turns, agentId).at(-1);
    if (!last || last.type !== "assistant" || taskRunning(turns)) throw new CloudAgentBusyError(CODEX.label);
    const status = task?.task_status_display;
    const ask = (status?.latest_turn_status_display?.intent ?? status?.initial_intent) === "qa";
    await api.createTask({ follow_up: { task_id: taskId, turn_id: last.id, run_environment_in_qa_mode: ask }, input_items: inputItems(content) });
  }

  /**
   * Cancel the line's own running turn. Codex cancels a whole task, so a line
   * with nothing of its own running cancels nothing (stopping one attempt's
   * session never stops another's work), and one whose attempts run side by
   * side says that they all stopped.
   */
  async cancel(api: CodexCloudApi, agentId: string): Promise<string | null> {
    const taskId = cloudAgentRootId(agentId);
    const turns = await api.turns(taskId);
    const own = taskTurnChain(turns, agentId);
    if (!anyRunning(own)) return null;
    await api.cancel(taskId);
    const ownIds = new Set(own.map((t) => t.id));
    return anyRunning(allTurns(turns).filter((t) => !ownIds.has(t.id))) ? "the running turn, and the task's other attempts with it" : "the running turn";
  }

  async archive(api: CodexCloudApi, agentId: string, archived: boolean): Promise<void> {
    await api.archive(cloudAgentRootId(agentId), archived);
  }

  /**
   * A draft pull request from the line's changes (its last turn with a diff),
   * without Codex's label (add_codex_tag; Codex still ends the body with a
   * link to the task, verified live). Codex opens it within seconds; the link
   * comes back once it did (and reaches the session through the mirror either
   * way). A line that already opened one (on any of its turns, as taskGit
   * finds it) gets that one back: a new POST for a later turn would open a
   * second pull request rather than update the first.
   */
  async createPullRequest(api: CodexCloudApi, agentId: string): Promise<{ url?: string }> {
    const taskId = cloudAgentRootId(agentId);
    const [turns, task] = await Promise.all([api.turns(taskId), api.task(taskId).then((r) => r.task)]);
    const opened = (t: WhamTurn | undefined) => {
      const url = t && turnPullRequest(t, taskPullRequests(task))?.url;
      return url ? { url } : null;
    };
    const existing = [...taskTurnChain(turns, agentId)].reverse().map(opened).find(Boolean);
    if (existing) return existing;
    const turn = await this.changesTurn(api, agentId, turns);
    await api.createPullRequest(taskId, turn.id);
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let waited = 0; waited < PR_WAIT_MS; waited += PR_POLL_MS) {
      await sleep(PR_POLL_MS);
      const now = (await api.turn(taskId, turn.id)).turn;
      const pr = opened(now);
      if (pr) return pr;
      if (now?.pull_request_status && !["creating", "not_created"].includes(now.pull_request_status)) throw new Error(`Codex could not open the pull request (${now.pull_request_status})`);
    }
    return {};
  }

  /**
   * Everything the line changed, as Codex recorded it at the line's last turn
   * that changed code (lineDiff: a follow-up's own diff holds only that
   * turn's changes): the same diff `codex cloud apply` would fetch, applied by
   * the core without running the Codex CLI on this machine's login (which may
   * refresh it).
   */
  async applyPlan(api: CodexCloudApi, agentId: string): Promise<CloudAgentApplyPlan> {
    const turns = await api.turns(cloudAgentRootId(agentId));
    const turn = await this.changesTurn(api, agentId, turns);
    const repo = taskRepo(taskTurnChain(turns, agentId));
    if (!repo) throw new Error("the task names no GitHub repository");
    const what = attemptsAt(turns, turn).length > 1 ? `attempt ${attemptNumber(turns, turn)}'s changes` : "the task's changes";
    return { repo, diff: lineDiff(turn), what };
  }

  /** The line's last turn that changed code, settled; what Create PR and Apply act on. */
  private async changesTurn(api: CodexCloudApi, agentId: string, read?: WhamTurns): Promise<WhamTurn> {
    const turns = read ?? await api.turns(cloudAgentRootId(agentId));
    const chain = taskTurnChain(turns, agentId);
    const turn = lastChanges(chain);
    if (!turn) throw new Error(anyRunning(chain) ? STILL_RUNNING : "this branch changed no code (an ask task answers without changes)");
    if (isRunningTurnStatus(turn.turn_status)) throw new Error(STILL_RUNNING);
    return turn;
  }

  /**
   * A repository Codex Cloud cannot reach, or a workspace with Codex Cloud
   * turned off (a 401 is the core's rule). Only a 403 in the API's own words:
   * the challenge page chatgpt.com's proxy answers with says nothing about
   * the workspace.
   */
  setupErrorOf(err: unknown, session?: CloudAgentSession): CloudAgentSetupError | null {
    if (!(err instanceof CloudApiError) || err.status !== 403 || !err.fromApi) return null;
    if (err.code === "repo_not_accessible") return CloudAgentSetupError.repoUnreachable(this, session, err.message, `Connect it to an environment at ${CODEX.repoAccessUrl}`);
    return CloudAgentSetupError.accessDenied(this, workspaceDisabled(err.message));
  }

  /** The account and plan Codex names; listing a task proves the workspace runs Codex Cloud at all (a 403 when it does not). */
  private async whoami(api: CodexCloudApi): Promise<{ account?: string; plan?: string }> {
    const [usage] = await Promise.all([api.usage().catch(() => undefined), api.listTasks(1)]);
    const summary = decodeCodexAuth(this.readAuth());
    return { account: usage?.email ?? summary.email, plan: usage?.plan ?? summary.plan };
  }

  private async startLogin(): Promise<void> {
    if (!this.opts.runLogin) throw new Error("this codecast cannot run codex login");
    await this.opts.runLogin({
      ...CODEX.login,
      missing: "The Codex CLI isn't installed on this computer. Install it (npm i -g @openai/codex), then sign in.",
    });
  }
}

/** Why an API-key Codex login is no sign-in here, and what signing in changes. */
const API_KEY_LOGIN = `Codex there uses an API key, and ${CODEX.label} needs a ChatGPT sign-in. Signing in moves that Codex from the API key to your ChatGPT plan.`;

function workspaceDisabled(reason: string): string {
  return `${CODEX.label} is not enabled for this ChatGPT workspace (${reason}). A workspace admin can turn on "Use Codex in the cloud" for your role in the workspace's Codex settings`;
}
