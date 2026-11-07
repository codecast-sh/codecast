// One Claude Code conversation driven through the Agent SDK's streaming input.
// Owned by the host process (host.ts); it knows nothing of sockets or the
// daemon. It turns SDK traffic into the facts codecast tracks: status, the
// prompts Claude is blocked on, turn results and failures.
//
// Claude Code still writes its own transcript JSONL (persistSession stays on),
// so codecast's transcript watcher syncs an SDK session exactly as it syncs a
// tmux one. Nothing here reads or forwards message content.

import { EventEmitter } from "node:events";
import * as crypto from "node:crypto";
import type { CanUseTool, Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SdkActivity, SdkHostStatus, SdkImage, SdkInitInfo, SdkPermissionAnswer, SdkPermissionRequest, SdkTurnError } from "./protocol.js";

/** Oldest Claude Code whose stream-json protocol has everything this backend uses:
 *  `priority` on streamed user messages, interrupt receipts, the `requestId` and
 *  `toolUseID` canUseTool reports. Older binaries fall back to tmux. */
export const MINIMUM_CLAUDE_VERSION = "2.1.248";

/** Compares release numbers like 2.1.248; a pre-release or build suffix is ignored. */
export function versionAtLeast(version: string, minimum: string): boolean {
  const parse = (value: string) => value.split(/[-+ ]/)[0].split(".").map((n) => Number(n) || 0);
  const current = parse(version);
  const required = parse(minimum);
  for (let i = 0; i < required.length; i++) {
    const c = current[i] ?? 0;
    if (c !== required[i]) return c > required[i];
  }
  return true;
}

type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;

/** An async iterable fed by push(); the SDK reads the session's input from it. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiter: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(item: SDKUserMessage): void {
    if (this.closed) throw new Error("Claude Code session input is closed");
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: item, done: false });
    } else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiter = resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

export interface ClaudeSdkSessionEvents {
  status: [SdkHostStatus];
  activity: [SdkActivity];
  init: [SdkInitInfo];
  permission: [SdkPermissionRequest];
  permission_settled: [string, "answer" | "abort"];
  result: [{ subtype: string; isError: boolean; text: string | null; error: SdkTurnError | null }];
  message: [SDKMessage];
  exit: [string];
}

interface PendingPrompt {
  request: SdkPermissionRequest;
  resolve: (answer: SdkPermissionAnswer) => void;
}

/** The content blocks of one user message: images first, as Claude Code's own paste does. */
export function userContent(text: string, images: SdkImage[] = []): SDKUserMessage["message"]["content"] {
  if (!images.length) return text;
  return [
    ...images.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mediaType as "image/png", data: img.data } })),
    ...(text ? [{ type: "text" as const, text }] : []),
  ];
}

/** The status message a PermissionRequest hook posts: the tool and a short preview of what it touches. */
export function permissionMessage(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "AskUserQuestion") return toolName;
  for (const key of ["command", "file_path", "pattern", "path", "url"]) {
    const v = input[key];
    if (typeof v === "string" && v) return `${toolName}: ${v.slice(0, 300)}`;
  }
  return toolName;
}

/** The failure a turn ended on, from an assistant error or an error result. */
export function turnError(message: SDKMessage, now = Date.now()): SdkTurnError | null {
  if (message.type === "assistant" && message.error) {
    const text = message.message.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    return { kind: message.error, message: text || message.error, at: now };
  }
  if (message.type === "result" && message.is_error) {
    const text = message.subtype === "success" ? message.result : message.errors.join("\n");
    return { kind: message.subtype, message: text || message.subtype, at: now };
  }
  return null;
}

export class ClaudeSdkSession extends EventEmitter<ClaudeSdkSessionEvents> {
  readonly sessionId: string;
  private readonly input = new InputQueue();
  private readonly query: Query;
  private readonly prompts = new Map<string, PendingPrompt>();
  private _status: SdkHostStatus = "starting";
  private _init: SdkInitInfo | null = null;
  private _lastError: SdkTurnError | null = null;
  private _activity: SdkActivity | null = null;
  /** The boundary activity is due once Claude reports init for this process. */
  private boundaryPending = true;
  /** Sends Claude has not answered with a result yet. */
  private outstanding = 0;
  private drainWaiters: Array<() => void> = [];
  private ended = false;
  private stopping: Promise<void> | null = null;
  readonly ready: Promise<SdkInitInfo>;
  readonly done: Promise<void>;

  constructor(options: Options & { sessionId?: string; resume?: string }, queryFn: QueryFn) {
    super();
    this.sessionId = options.resume ?? options.sessionId ?? crypto.randomUUID();
    const canUseTool: CanUseTool = (toolName, input, opts) => this.ask(toolName, input, opts);
    this.query = queryFn({ prompt: this.input, options: { ...options, canUseTool } });
    this.ready = this.query.initializationResult().then((init) => {
      const info: SdkInitInfo = {
        version: (init as { claude_code_version?: string }).claude_code_version ?? null,
        model: null,
        permissionMode: null,
        accountEmail: init.account?.email ?? null,
        subscriptionType: init.account?.subscriptionType ?? null,
        slashCommands: init.commands.map((c) => c.name),
      };
      this._init = info;
      if (this._status === "starting") this.setStatus("idle");
      if (this.boundaryPending && this.outstanding === 0) {
        this.boundaryPending = false;
        this.report({ status: "idle", sessionBoundary: true });
      }
      this.emit("init", info);
      return info;
    });
    this.ready.catch(() => {});
    this.done = this.readAll();
  }

  get status(): SdkHostStatus {
    return this._status;
  }
  get init(): SdkInitInfo | null {
    return this._init;
  }
  get lastError(): SdkTurnError | null {
    return this._lastError;
  }
  get pending(): SdkPermissionRequest[] {
    return [...this.prompts.values()].map((p) => p.request);
  }
  get activity(): SdkActivity | null {
    return this._activity;
  }
  get running(): boolean {
    return this.outstanding > 0;
  }

  private setStatus(next: SdkHostStatus): void {
    if (this._status === next || this._status === "stopped") return;
    this._status = next;
    this.emit("status", next);
  }

  /** Report what the status hook would have reported. Repeats of the same status are dropped, except a turn end. */
  private report(activity: Omit<SdkActivity, "ts" | "permissionMode">): void {
    const prev = this._activity;
    if (prev && prev.status === activity.status && !activity.turnCompletedAt && !activity.dialog && prev.message === activity.message) return;
    const next: SdkActivity = { ...activity, ts: Math.floor(Date.now() / 1000), ...(this._init?.permissionMode ? { permissionMode: this._init.permissionMode } : {}) };
    this._activity = next;
    this.emit("activity", next);
  }

  private settleStatus(): void {
    if (this.ended) return this.setStatus("stopped");
    if (this.prompts.size) return this.setStatus("needs_input");
    this.setStatus(this.outstanding > 0 ? "working" : this._init ? "idle" : "starting");
  }

  private async ask(toolName: string, input: Record<string, unknown>, opts: Parameters<CanUseTool>[2]) {
    const requestId = opts.requestId || crypto.randomUUID();
    const request: SdkPermissionRequest = {
      requestId,
      toolName,
      toolUseId: opts.toolUseID,
      input,
      title: opts.title,
      description: opts.description,
      decisionReason: opts.decisionReason,
      blockedPath: opts.blockedPath,
      suggestions: opts.suggestions,
      agentId: opts.agentID,
      createdAt: Date.now(),
    };
    const answer = await new Promise<SdkPermissionAnswer>((resolve) => {
      this.prompts.set(requestId, { request, resolve });
      const abort = () => {
        if (!this.prompts.delete(requestId)) return;
        this.emit("permission_settled", requestId, "abort");
        this.settleStatus();
        resolve({ behavior: "deny", message: "The request was cancelled." });
      };
      if (opts.signal.aborted) return abort();
      opts.signal.addEventListener("abort", abort, { once: true });
      this.emit("permission", request);
      this.report({ status: "permission_blocked", message: permissionMessage(toolName, input), dialog: true });
      this.settleStatus();
    });
    return answer.behavior === "allow"
      ? { behavior: "allow" as const, updatedInput: answer.updatedInput ?? input, updatedPermissions: answer.updatedPermissions, toolUseID: opts.toolUseID }
      : { behavior: "deny" as const, message: answer.message, interrupt: answer.interrupt, toolUseID: opts.toolUseID };
  }

  /** Remember the web card opened for a pending prompt. */
  annotate(requestId: string, cardId: string): boolean {
    const prompt = this.prompts.get(requestId);
    if (!prompt) return false;
    prompt.request.cardId = cardId;
    return true;
  }

  /** Answer a pending prompt. False when it is no longer pending (answered elsewhere, or the turn ended). */
  answer(requestId: string, answer: SdkPermissionAnswer): boolean {
    const prompt = this.prompts.get(requestId);
    if (!prompt) return false;
    this.prompts.delete(requestId);
    this.emit("permission_settled", requestId, "answer");
    prompt.resolve(answer);
    if (!this.prompts.size && this.outstanding > 0) this.report({ status: "working" });
    this.settleStatus();
    return true;
  }

  /**
   * Queue a user message. While a turn runs it goes in with priority "next",
   * so Claude reads it at the next tool boundary instead of after the turn,
   * as typing into a busy Claude Code does.
   */
  send(text: string, images: SdkImage[] = [], uuid: string = crypto.randomUUID()): string {
    if (this.ended || this.stopping) throw new Error("Claude Code session has stopped");
    const message: SDKUserMessage = {
      type: "user",
      uuid: uuid as SDKUserMessage["uuid"],
      message: { role: "user", content: userContent(text, images) },
      parent_tool_use_id: null,
      origin: { kind: "human" },
      ...(this.outstanding > 0 ? { priority: "next" as const } : {}),
    } as SDKUserMessage;
    if (this.outstanding === 0) this.report({ status: "thinking" });
    this.outstanding++;
    this._lastError = null;
    this.input.push(message);
    this.settleStatus();
    return uuid;
  }

  /** Interrupt the running turn and wait until it has drained (its result written), so the next send starts a fresh turn. */
  async interrupt(): Promise<void> {
    if (this.ended || this.outstanding === 0) return;
    const drained = new Promise<void>((resolve) => this.drainWaiters.push(resolve));
    for (const [id, prompt] of this.prompts) {
      this.prompts.delete(id);
      this.emit("permission_settled", id, "abort");
      prompt.resolve({ behavior: "deny", message: "The user interrupted.", interrupt: true });
    }
    await this.query.interrupt();
    await drained;
  }

  setModel(model: string | null): Promise<void> {
    return this.query.setModel(model ?? undefined);
  }

  setPermissionMode(mode: string): Promise<void> {
    return this.query.setPermissionMode(mode as Parameters<Query["setPermissionMode"]>[0]);
  }

  private async readAll(): Promise<void> {
    let reason = "claude exited";
    try {
      for await (const message of this.query) {
        this.emit("message", message);
        this.observe(message);
      }
    } catch (err) {
      reason = (err as Error).message || String(err);
    } finally {
      this.ended = true;
      for (const [id, prompt] of this.prompts) {
        this.prompts.delete(id);
        this.emit("permission_settled", id, "abort");
        prompt.resolve({ behavior: "deny", message: "Claude Code stopped." });
      }
      this.outstanding = 0;
      for (const w of this.drainWaiters.splice(0)) w();
      this.setStatus("stopped");
      this.emit("exit", reason);
    }
  }

  private observe(message: SDKMessage): void {
    if (message.type === "system" && message.subtype === "init") {
      const info: SdkInitInfo = {
        ...(this._init ?? { accountEmail: null, subscriptionType: null, slashCommands: [] }),
        version: message.claude_code_version ?? this._init?.version ?? null,
        model: message.model,
        permissionMode: message.permissionMode,
        slashCommands: message.slash_commands,
      };
      this._init = info;
      this.emit("init", info);
      return;
    }
    if (message.type === "system" && message.subtype === "status") {
      if (message.permissionMode && this._init) this._init = { ...this._init, permissionMode: message.permissionMode };
      if (message.status === "compacting") this.report({ status: "compacting" });
      else if (this.outstanding > 0 && this._activity?.status === "compacting") this.report({ status: "working" });
      return;
    }
    if (message.type === "assistant" && message.parent_tool_use_id === null && this.outstanding > 0 && !this.prompts.size
      && message.message.content.some((b) => b.type === "tool_use")) {
      this.report({ status: "working" });
    }
    // The assistant's error names the cause (rate_limit, billing_error); the result's only says the turn failed.
    const error = turnError(message);
    if (error && !(message.type === "result" && this._lastError)) this._lastError = error;
    if (message.type !== "result") return;
    const consumed = message.user_message_uuids?.length ?? 1;
    const queued = message.queued_turn_count;
    // queued_turn_count is the CLI's own count of sends still waiting; trust it when present.
    this.outstanding = queued !== undefined ? queued : Math.max(0, this.outstanding - consumed);
    if (this.outstanding === 0) {
      for (const w of this.drainWaiters.splice(0)) w();
      this.report({ status: "idle", turnCompletedAt: Math.floor(Date.now() / 1000) });
    }
    this.emit("result", {
      subtype: message.subtype,
      isError: message.is_error,
      text: message.subtype === "success" ? message.result : null,
      error: message.is_error ? (this._lastError ?? turnError(message)) : null,
    });
    this.settleStatus();
  }

  /** End the session: interrupt a running turn, close the input so Claude flushes and exits. */
  stop(): Promise<void> {
    if (!this.stopping) {
      this.stopping = (async () => {
        try {
          if (this.outstanding > 0 && !this.ended) await Promise.race([this.interrupt(), new Promise((r) => setTimeout(r, 10_000))]);
        } catch {}
        this.input.close();
        await Promise.race([this.done, new Promise((r) => setTimeout(r, 10_000))]);
        this.query.close();
      })();
    }
    return this.stopping;
  }
}
