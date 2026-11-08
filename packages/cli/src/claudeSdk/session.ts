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
  /** Claude moved to another session in the same process (a /clear). */
  session: [string];
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
  private _claudeSessionId: string;
  private readonly input = new InputQueue();
  private readonly query: Query;
  private readonly prompts = new Map<string, PendingPrompt>();
  private _status: SdkHostStatus = "starting";
  private _init: SdkInitInfo | null = null;
  private _lastError: SdkTurnError | null = null;
  private _activity: SdkActivity | null = null;
  /** The mode the session was in before it entered plan mode: starting a plan returns to it. */
  private modeBeforePlan: string | null = null;
  /** The boundary activity is due once Claude reports init for this process. */
  private boundaryPending = true;
  /** A /clear inside the running turn: its end is a session boundary, as the SessionStart(clear) hook reports it. */
  private switchedThisTurn = false;
  /** Our sends Claude has not consumed in a result yet, by uuid, oldest first. */
  private readonly pendingSends = new Set<string>();
  /** Sends Claude has not answered with a result yet. */
  private get outstanding(): number {
    return this.pendingSends.size;
  }
  /** Claude's own word that a turn runs (session_state_changed), ours or one it started itself. */
  private cliRunning = false;
  /** A turn is running or one of our sends is waiting for one. */
  private get active(): boolean {
    return this.outstanding > 0 || this.cliRunning;
  }
  private drainWaiters: Array<() => void> = [];
  private ended = false;
  private stopping: Promise<void> | null = null;
  readonly ready: Promise<SdkInitInfo>;
  readonly done: Promise<void>;

  constructor(options: Options & { sessionId?: string; resume?: string }, queryFn: QueryFn) {
    super();
    this.sessionId = options.resume ?? options.sessionId ?? crypto.randomUUID();
    this._claudeSessionId = this.sessionId;
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

  get claudeSessionId(): string {
    return this._claudeSessionId;
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
    return this.active;
  }

  private setStatus(next: SdkHostStatus): void {
    if (this._status === next || this._status === "stopped") return;
    this._status = next;
    this.emit("status", next);
  }

  /** Report what the status hook would have reported. Repeats of the same status are dropped, except a turn end. */
  private report(activity: Omit<SdkActivity, "ts" | "permissionMode">): void {
    // While a prompt is open the session is blocked on a person, whatever else ends or starts: any
    // other status would read to the daemon as the prompt closing, and close its card.
    if (this.prompts.size && activity.status !== "permission_blocked") return;
    const prev = this._activity;
    if (prev && prev.status === activity.status && !activity.turnCompletedAt && !activity.dialog && prev.message === activity.message && prev.permissionMode === (this._init?.permissionMode ?? undefined)) return;
    const next: SdkActivity = { ...activity, ts: Math.floor(Date.now() / 1000), ...(this._init?.permissionMode ? { permissionMode: this._init.permissionMode } : {}) };
    this._activity = next;
    this.emit("activity", next);
  }

  private settleStatus(): void {
    if (this.ended) return this.setStatus("stopped");
    if (this.prompts.size) return this.setStatus("needs_input");
    this.setStatus(this.active ? "working" : this._init ? "idle" : "starting");
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
      ...(toolName === "ExitPlanMode" ? { modeBeforePlan: this.modeBeforePlan ?? (this._init?.permissionMode !== "plan" ? this._init?.permissionMode : null) ?? null } : {}),
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
    // The answered call goes on, inside a turn or not.
    if (!this.prompts.size) this.report({ status: "working" });
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
      ...(this.active ? { priority: "next" as const } : {}),
    } as SDKUserMessage;
    // Our own turn starting (the UserPromptSubmit hook's moment), even right after a turn Claude ran itself.
    // Not while a prompt is open: the move away from permission_blocked would close its card.
    if (this.outstanding === 0 && !this.prompts.size) this.report({ status: "thinking" });
    this.pendingSends.add(uuid);
    this._lastError = null;
    this.input.push(message);
    this.settleStatus();
    return uuid;
  }

  /** Interrupt the running turn and wait until it has drained (its result written), so the next send starts a fresh turn. A message queued behind it still runs, as Claude Code's receipt says. */
  async interrupt(): Promise<void> {
    if (this.ended || !this.active) return;
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

  /** Claude takes the new mode at once but announces it only with its next
   *  init or status message, so the session records it here: until then every
   *  activity report, and a backend switch reading the mode, would carry the old one. */
  async setPermissionMode(mode: string): Promise<void> {
    await this.query.setPermissionMode(mode as Parameters<Query["setPermissionMode"]>[0]);
    if (!this._init || this._init.permissionMode === mode) return;
    if (mode === "plan" && this._init.permissionMode !== "plan") this.modeBeforePlan = this._init.permissionMode;
    this._init = { ...this._init, permissionMode: mode };
    this.emit("init", this._init);
    if (this._activity) this.report({ status: this._activity.status, ...(this._activity.message && { message: this._activity.message }) });
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
      this.pendingSends.clear();
      for (const w of this.drainWaiters.splice(0)) w();
      this.setStatus("stopped");
      this.emit("exit", reason);
    }
  }

  private observe(message: SDKMessage): void {
    const sid = (message as { session_id?: unknown }).session_id;
    if (typeof sid === "string" && sid && sid !== this._claudeSessionId && (message.type === "system" || message.type === "result")) {
      this._claudeSessionId = sid;
      this.switchedThisTurn = true;
      this.emit("session", sid);
    }
    if (message.type === "system" && message.subtype === "init") {
      if (message.permissionMode === "plan" && this._init?.permissionMode && this._init.permissionMode !== "plan") this.modeBeforePlan = this._init.permissionMode;
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
    // Claude's own running/idle state covers the turns it starts itself (a background task that
    // finished, a hook continuation): they hold none of our sends, yet run, ask, and can be stopped.
    if (message.type === "system" && message.subtype === "session_state_changed") {
      if (message.state === "running") {
        const wasActive = this.active;
        this.cliRunning = true;
        if (!wasActive && !this.prompts.size) this.report({ status: "working" });
      } else if (message.state === "idle") {
        this.cliRunning = false;
        if (!this.active) {
          for (const w of this.drainWaiters.splice(0)) w();
          if (this._activity && this._activity.status !== "idle") this.report({ status: "idle", turnCompletedAt: Math.floor(Date.now() / 1000) });
        }
      }
      this.settleStatus();
      return;
    }
    // Claude's own record of each send we made: completed or cancelled is final. A send whose
    // turn ends without a result naming it (a local command) would otherwise read as running forever.
    const lifecycle = message as { type: string; command_uuid?: string; state?: string };
    if (lifecycle.type === "command_lifecycle") {
      // Only when no turn runs: a message folded into a running turn completes before that turn ends.
      if ((lifecycle.state === "completed" || lifecycle.state === "cancelled") && lifecycle.command_uuid && this.pendingSends.delete(lifecycle.command_uuid) && !this.pendingSends.size && !this.cliRunning) {
        for (const w of this.drainWaiters.splice(0)) w();
        this.report({ status: "idle", turnCompletedAt: Math.floor(Date.now() / 1000) });
        this.settleStatus();
      }
      return;
    }
    if (message.type === "system" && message.subtype === "status") {
      if (message.permissionMode === "plan" && this._init?.permissionMode && this._init.permissionMode !== "plan") this.modeBeforePlan = this._init.permissionMode;
      if (message.permissionMode && this._init && message.permissionMode !== this._init.permissionMode) {
        this._init = { ...this._init, permissionMode: message.permissionMode };
        this.emit("init", this._init);
      }
      if (message.status === "compacting") this.report({ status: "compacting" });
      else if (this.active && this._activity?.status === "compacting") this.report({ status: "working" });
      return;
    }
    if (message.type === "assistant" && message.parent_tool_use_id === null && this.active && !this.prompts.size
      && message.message.content.some((b) => b.type === "tool_use")) {
      this.report({ status: "working" });
    }
    // The assistant's error names the cause (rate_limit, billing_error); the result's only says the turn failed.
    const error = turnError(message);
    if (error && !(message.type === "result" && this._lastError)) this._lastError = error;
    if (message.type !== "result") return;
    // The result names the sends its turn consumed. A send pushed after the CLI counted its queue is
    // still ours to wait for, so the count is never taken from queued_turn_count alone.
    const consumed = message.user_message_uuids ?? (message.user_message_uuid ? [message.user_message_uuid] : null);
    // A result that names none of them is a turn Claude started itself (a hook continuation, a
    // task notification): it consumed nothing of ours, beyond what the CLI's own queue count says.
    if (consumed) for (const uuid of consumed) this.pendingSends.delete(uuid);
    else if (message.queued_turn_count !== undefined) {
      while (this.pendingSends.size > message.queued_turn_count) this.pendingSends.delete(this.pendingSends.values().next().value!);
    }
    // An interrupt waits for this turn's result; messages queued behind it run as the next turn.
    for (const w of this.drainWaiters.splice(0)) w();
    if (this.outstanding === 0) {
      this.report(this.switchedThisTurn ? { status: "idle", sessionBoundary: true } : { status: "idle", turnCompletedAt: Math.floor(Date.now() / 1000) });
      this.switchedThisTurn = false;
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
          if (this.active && !this.ended) await Promise.race([this.interrupt(), new Promise((r) => setTimeout(r, 10_000))]);
        } catch {}
        this.input.close();
        await Promise.race([this.done, new Promise((r) => setTimeout(r, 10_000))]);
        this.query.close();
      })();
    }
    return this.stopping;
  }
}
