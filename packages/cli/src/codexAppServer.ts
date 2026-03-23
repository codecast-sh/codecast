import { EventEmitter } from "events";
import { spawn, type ChildProcess } from "child_process";
import * as readline from "readline";
import type { ParsedMessage, ToolCall, ToolResult, ImageBlock } from "./parser.js";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
export type TurnStatus = "inProgress" | "completed" | "failed" | "interrupted";

export interface ThreadStartParams {
  cwd?: string;
  sandbox?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
  model?: string;
  baseInstructions?: string;
  developerInstructions?: string;
  ephemeral?: boolean;
  config?: Record<string, unknown>;
}

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  model?: string;
  cwd?: string;
  approvalPolicy?: ApprovalPolicy;
}

export type UserInput =
  | { type: "text"; text: string }
  | { type: "localImage"; path: string };

export interface ThreadResumeParams {
  threadId: string;
  cwd?: string;
  sandbox?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
  model?: string;
  baseInstructions?: string;
}

export interface Turn {
  id: string;
  items: ThreadItem[];
  status: TurnStatus;
  error?: { message?: string } | null;
}

export interface ThreadStartResponse {
  thread: { id: string };
  cwd: string;
  model: string;
  sandbox: unknown;
  approvalPolicy: unknown;
}

export interface TurnStartResponse {
  turn: Turn;
}

export interface ThreadResumeResponse {
  thread: { id: string };
  cwd: string;
  model: string;
}

export interface FileUpdateChange {
  path: string;
  diff: string;
  kind: string;
}

interface UserMessageItem { type: "userMessage"; id: string; content: UserInput[] }
interface AgentMessageItem { type: "agentMessage"; id: string; text: string; phase?: "commentary" | "final_answer" | null }
interface PlanItem { type: "plan"; id: string; text: string }
interface ReasoningItem { type: "reasoning"; id: string; content: string[]; summary: string[] }
interface CommandExecutionItem { type: "commandExecution"; id: string; command: string; cwd: string; status: string; aggregatedOutput?: string | null; exitCode?: number | null; durationMs?: number | null }
interface FileChangeItem { type: "fileChange"; id: string; changes: FileUpdateChange[]; status: string }
interface McpToolCallItem { type: "mcpToolCall"; id: string; tool: string; server: string; arguments: unknown; status: string; result?: { content?: unknown[] } | null; error?: { message: string } | null; durationMs?: number | null }
interface DynamicToolCallItem { type: "dynamicToolCall"; id: string; tool: string; arguments: unknown; status: string; durationMs?: number | null; success?: boolean | null }
interface CollabAgentToolCallItem { type: "collabAgentToolCall"; id: string; tool: string; status: string; senderThreadId: string; receiverThreadIds: string[]; prompt?: string | null }
interface WebSearchItem { type: "webSearch"; id: string; query: string }
interface ImageViewItem { type: "imageView"; id: string; path: string }
interface ImageGenerationItem { type: "imageGeneration"; id: string; result: string; status: string }
interface ContextCompactionItem { type: "contextCompaction"; id: string }

export type ThreadItem =
  | UserMessageItem
  | AgentMessageItem
  | PlanItem
  | ReasoningItem
  | CommandExecutionItem
  | FileChangeItem
  | McpToolCallItem
  | DynamicToolCallItem
  | CollabAgentToolCallItem
  | WebSearchItem
  | ImageViewItem
  | ImageGenerationItem
  | ContextCompactionItem;

export interface ApprovalRequest {
  id: number | string;
  method: string;
  params: Record<string, unknown>;
}

export interface CodexAppServerOptions {
  log: (msg: string) => void;
  onApproval?: (threadId: string, approval: ApprovalRequest) => Promise<boolean>;
  codexBinary?: string;
  sessionSource?: string;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface TurnAccumulator {
  items: ThreadItem[];
  threadId: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const THREAD_START_TIMEOUT_MS = 60_000;
const MAX_RESTART_DELAY_MS = 30_000;

const APPROVAL_METHODS = new Set([
  "execCommandApproval",
  "applyPatchApproval",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "item/tool/call",
]);

export class CodexAppServer extends EventEmitter {
  private process: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private pendingRequests = new Map<number | string, PendingRequest>();
  private turnAccumulators = new Map<string, TurnAccumulator>();
  private restartDelay = 1000;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private initialized = false;
  private log: (msg: string) => void;
  private onApproval?: (threadId: string, approval: ApprovalRequest) => Promise<boolean>;
  private codexBinary: string;
  private sessionSource: string;

  constructor(opts: CodexAppServerOptions) {
    super();
    this.log = opts.log;
    this.onApproval = opts.onApproval;
    this.codexBinary = opts.codexBinary || "codex";
    this.sessionSource = opts.sessionSource || "codecast";
  }

  start(): void {
    if (this.process) return;
    this.stopped = false;
    this.spawnProcess();
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.killProcess();
  }

  get running(): boolean {
    return this.process !== null && this.process.exitCode === null && this.initialized;
  }

  private async initialize(): Promise<void> {
    const resp = await this.sendRequest("initialize", {
      clientInfo: { name: "codecast", title: "Codecast Daemon", version: "1.0.0" },
      capabilities: { experimentalApi: false },
    }, THREAD_START_TIMEOUT_MS);
    this.initialized = true;
    const r = resp as { userAgent?: string; platformOs?: string };
    this.log(`[codex-app-server] initialized: ${r.userAgent ?? "unknown"} (${r.platformOs ?? "unknown"})`);
    this.emit("ready");
  }

  async threadStart(params: ThreadStartParams): Promise<ThreadStartResponse> {
    return this.sendRequest("thread/start", params, THREAD_START_TIMEOUT_MS) as Promise<ThreadStartResponse>;
  }

  async turnStart(params: TurnStartParams): Promise<TurnStartResponse> {
    return this.sendRequest("turn/start", params, DEFAULT_TIMEOUT_MS) as Promise<TurnStartResponse>;
  }

  async turnInterrupt(threadId: string, turnId: string): Promise<void> {
    await this.sendRequest("turn/interrupt", { threadId, turnId }, DEFAULT_TIMEOUT_MS);
  }

  async threadResume(params: ThreadResumeParams): Promise<ThreadResumeResponse> {
    return this.sendRequest("thread/resume", params, THREAD_START_TIMEOUT_MS) as Promise<ThreadResumeResponse>;
  }

  respondToApproval(id: number | string, approved: boolean): void {
    this.writeMessage({
      jsonrpc: "2.0",
      id,
      result: { approved },
    });
  }

  private spawnProcess(): void {
    const args = ["app-server", "--session-source", this.sessionSource];
    this.log(`[codex-app-server] spawning: ${this.codexBinary} ${args.join(" ")}`);

    const child = spawn(this.codexBinary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: [process.env.HOME + "/.bun/bin", process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].filter(Boolean).join(":"),
      },
    });

    this.process = child;

    if (!child.stdout || !child.stdin) {
      this.log("[codex-app-server] failed to get stdio handles");
      this.scheduleRestart();
      return;
    }

    const rl = readline.createInterface({ input: child.stdout });
    this.rl = rl;

    rl.on("line", (line) => {
      this.handleLine(line);
    });

    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text) this.log(`[codex-app-server:stderr] ${text}`);
    });

    child.on("error", (err) => {
      this.log(`[codex-app-server] process error: ${err.message}`);
      this.emit("error", err);
      this.cleanup();
      this.scheduleRestart();
    });

    child.on("close", (code, signal) => {
      this.log(`[codex-app-server] process exited: code=${code} signal=${signal}`);
      this.cleanup();
      if (!this.stopped) {
        this.scheduleRestart();
      } else {
        this.emit("closed");
      }
    });

    this.restartDelay = 1000;

    this.initialize().catch((err) => {
      this.log(`[codex-app-server] initialize failed: ${err.message}`);
      this.emit("error", err);
    });
  }

  private killProcess(): void {
    if (this.process) {
      this.process.kill("SIGTERM");
      setTimeout(() => {
        if (this.process && this.process.exitCode === null) {
          this.process.kill("SIGKILL");
        }
      }, 5000);
    }
    this.cleanup();
  }

  private cleanup(): void {
    this.initialized = false;
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    this.process = null;

    this.pendingRequests.forEach((pending, id) => {
      clearTimeout(pending.timer);
      pending.reject(new Error("codex app-server process terminated"));
      this.pendingRequests.delete(id);
    });
  }

  private scheduleRestart(): void {
    if (this.stopped) return;
    this.log(`[codex-app-server] restarting in ${this.restartDelay}ms`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopped) this.spawnProcess();
    }, this.restartDelay);
    this.restartDelay = Math.min(this.restartDelay * 2, MAX_RESTART_DELAY_MS);
  }

  private sendRequest(method: string, params: object, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process || !this.process.stdin) {
        reject(new Error("codex app-server not running"));
        return;
      }

      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });

      this.writeMessage({
        jsonrpc: "2.0",
        id,
        method,
        params,
      });
    });
  }

  private writeMessage(msg: object): void {
    if (!this.process?.stdin?.writable) return;
    this.process.stdin.write(JSON.stringify(msg) + "\n");
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log(`[codex-app-server] unparseable line: ${line.slice(0, 200)}`);
      return;
    }

    if (typeof msg.id !== "undefined" && ("result" in msg || "error" in msg)) {
      this.handleResponse(msg);
      return;
    }

    if (typeof msg.id !== "undefined" && typeof msg.method === "string") {
      this.handleServerRequest(msg);
      return;
    }

    if (typeof msg.method === "string") {
      this.handleNotification(msg);
      return;
    }

    this.log(`[codex-app-server] unroutable message: ${JSON.stringify(msg).slice(0, 200)}`);
  }

  private handleResponse(msg: Record<string, unknown>): void {
    const id = msg.id as number | string;
    const pending = this.pendingRequests.get(id);
    if (!pending) {
      this.log(`[codex-app-server] response for unknown request id=${id}`);
      return;
    }
    this.pendingRequests.delete(id);
    clearTimeout(pending.timer);

    if (msg.error) {
      const err = msg.error as Record<string, unknown>;
      pending.reject(new Error(String(err.message || JSON.stringify(err))));
    } else {
      pending.resolve(msg.result);
    }
  }

  private handleServerRequest(msg: Record<string, unknown>): void {
    const method = msg.method as string;
    const id = msg.id as number | string;
    const params = (msg.params || {}) as Record<string, unknown>;

    if (APPROVAL_METHODS.has(method)) {
      const threadId = (params.threadId as string) || "";
      const approval: ApprovalRequest = { id, method, params };
      this.emit("approvalRequested", threadId, approval);

      if (this.onApproval) {
        this.onApproval(threadId, approval).then((approved) => {
          this.respondToApproval(id, approved);
        }).catch((err) => {
          this.log(`[codex-app-server] approval handler error: ${err.message}`);
          this.respondToApproval(id, false);
        });
      }
      return;
    }

    this.log(`[codex-app-server] unhandled server request: ${method}`);
    this.writeMessage({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Method not found" },
    });
  }

  private handleNotification(msg: Record<string, unknown>): void {
    const method = msg.method as string;
    const params = (msg.params || {}) as Record<string, unknown>;

    switch (method) {
      case "thread/started": {
        const thread = params.thread as Record<string, unknown>;
        const threadId = (thread?.id || params.threadId) as string;
        this.emit("threadStarted", threadId);
        break;
      }

      case "turn/started": {
        const threadId = params.threadId as string;
        const turn = params.turn as Turn;
        this.turnAccumulators.set(turn.id, { items: [], threadId });
        this.emit("turnStarted", threadId, turn.id);
        break;
      }

      case "turn/completed": {
        const threadId = params.threadId as string;
        const turn = params.turn as Turn;
        const acc = this.turnAccumulators.get(turn.id);
        const items = acc?.items || [];
        this.turnAccumulators.delete(turn.id);
        const messages = threadItemsToMessages(items);
        this.emit("turnCompleted", threadId, turn.id, messages, turn.status, turn.error);
        break;
      }

      case "item/started": {
        const turnId = params.turnId as string;
        const item = params.item as ThreadItem;
        const acc = this.turnAccumulators.get(turnId);
        if (acc) {
          this.emit("itemStarted", params.threadId as string, turnId, item);
        }
        break;
      }

      case "item/completed": {
        const threadId = params.threadId as string;
        const turnId = params.turnId as string;
        const item = params.item as ThreadItem;
        const acc = this.turnAccumulators.get(turnId);
        if (acc) {
          acc.items.push(item);
        }
        this.emit("itemCompleted", threadId, turnId, item);
        break;
      }

      case "item/agentMessage/delta": {
        this.emit("messageDelta", params.threadId as string, params.turnId as string, params.delta as string, params.itemId as string);
        break;
      }

      case "item/commandExecution/outputDelta": {
        this.emit("commandOutputDelta", params.threadId as string, params.turnId as string, params.delta as string, params.itemId as string);
        break;
      }

      case "item/fileChange/outputDelta": {
        this.emit("fileChangeDelta", params.threadId as string, params.turnId as string, params.delta as string, params.itemId as string);
        break;
      }

      case "thread/name/updated": {
        this.emit("threadNameUpdated", params.threadId as string, params.threadName as string | null);
        break;
      }

      case "thread/status/changed": {
        const status = params.status as Record<string, unknown>;
        this.emit("statusChanged", params.threadId as string, status);
        break;
      }

      default:
        this.log(`[codex-app-server] unhandled notification: ${method}`);
        break;
    }
  }
}

export function threadItemToMessage(item: ThreadItem): ParsedMessage | null {
  const now = Date.now();

  switch (item.type) {
    case "userMessage": {
      const texts: string[] = [];
      const images: ImageBlock[] = [];
      for (const input of item.content) {
        if (input.type === "text") {
          texts.push(input.text);
        } else if (input.type === "localImage") {
          images.push({ mediaType: "image/png", data: input.path });
        }
      }
      return {
        uuid: item.id,
        role: "user",
        content: texts.join("\n"),
        timestamp: now,
        images: images.length > 0 ? images : undefined,
      };
    }

    case "agentMessage": {
      return {
        uuid: item.id,
        role: "assistant",
        content: item.text,
        timestamp: now,
        subtype: item.phase || undefined,
      };
    }

    case "reasoning": {
      const thinkingText = item.content.length > 0
        ? item.content.join("\n")
        : item.summary.join("\n");
      if (!thinkingText) return null;
      return {
        uuid: item.id,
        role: "assistant",
        content: "",
        timestamp: now,
        thinking: thinkingText,
      };
    }

    case "commandExecution": {
      const toolCalls: ToolCall[] = [{
        id: item.id,
        name: "commandExecution",
        input: { command: item.command, cwd: item.cwd },
      }];
      const toolResults: ToolResult[] = [{
        toolUseId: item.id,
        content: item.aggregatedOutput || "",
        isError: item.status === "failed",
      }];
      return {
        uuid: item.id,
        role: "assistant",
        content: "",
        timestamp: now,
        toolCalls,
        toolResults,
      };
    }

    case "fileChange": {
      const diffSummary = item.changes.map(c => `${c.kind}: ${c.path}`).join("\n");
      const fullDiff = item.changes.map(c => c.diff).join("\n");
      const toolCalls: ToolCall[] = [{
        id: item.id,
        name: "fileChange",
        input: { changes: diffSummary },
      }];
      const toolResults: ToolResult[] = [{
        toolUseId: item.id,
        content: fullDiff,
        isError: item.status === "failed",
      }];
      return {
        uuid: item.id,
        role: "assistant",
        content: "",
        timestamp: now,
        toolCalls,
        toolResults,
      };
    }

    case "mcpToolCall": {
      let args: Record<string, unknown> = {};
      if (item.arguments && typeof item.arguments === "object" && !Array.isArray(item.arguments)) {
        args = item.arguments as Record<string, unknown>;
      } else if (item.arguments !== undefined) {
        args = { input: item.arguments };
      }

      const toolCalls: ToolCall[] = [{
        id: item.id,
        name: `${item.server}__${item.tool}`,
        input: args,
      }];

      let resultContent = "";
      if (item.error) {
        resultContent = item.error.message;
      } else if (item.result?.content) {
        resultContent = JSON.stringify(item.result.content);
      }

      const toolResults: ToolResult[] = [{
        toolUseId: item.id,
        content: resultContent,
        isError: item.status === "failed" || !!item.error,
      }];

      return {
        uuid: item.id,
        role: "assistant",
        content: "",
        timestamp: now,
        toolCalls,
        toolResults,
      };
    }

    case "dynamicToolCall": {
      let args: Record<string, unknown> = {};
      if (item.arguments && typeof item.arguments === "object" && !Array.isArray(item.arguments)) {
        args = item.arguments as Record<string, unknown>;
      } else if (item.arguments !== undefined) {
        args = { input: item.arguments };
      }

      const toolCalls: ToolCall[] = [{
        id: item.id,
        name: item.tool,
        input: args,
      }];

      return {
        uuid: item.id,
        role: "assistant",
        content: "",
        timestamp: now,
        toolCalls,
      };
    }

    case "collabAgentToolCall": {
      const toolCalls: ToolCall[] = [{
        id: item.id,
        name: `collab:${item.tool}`,
        input: {
          sender: item.senderThreadId,
          receivers: item.receiverThreadIds,
          prompt: item.prompt || "",
        },
      }];
      return {
        uuid: item.id,
        role: "assistant",
        content: "",
        timestamp: now,
        toolCalls,
      };
    }

    case "webSearch": {
      return {
        uuid: item.id,
        role: "assistant",
        content: "",
        timestamp: now,
        toolCalls: [{
          id: item.id,
          name: "webSearch",
          input: { query: item.query },
        }],
      };
    }

    case "plan": {
      return {
        uuid: item.id,
        role: "assistant",
        content: item.text,
        timestamp: now,
        subtype: "plan",
      };
    }

    case "imageView": {
      return {
        uuid: item.id,
        role: "assistant",
        content: "",
        timestamp: now,
        images: [{ mediaType: "image/png", data: item.path }],
      };
    }

    case "imageGeneration": {
      return {
        uuid: item.id,
        role: "assistant",
        content: item.result,
        timestamp: now,
        subtype: "imageGeneration",
      };
    }

    case "contextCompaction":
      return null;

    default:
      return null;
  }
}

export function threadItemsToMessages(items: ThreadItem[]): ParsedMessage[] {
  let currentText = "";
  let currentThinking = "";
  let currentToolCalls: ToolCall[] = [];
  let currentToolResults: ToolResult[] = [];
  let currentImages: ImageBlock[] = [];
  let lastUuid: string | undefined;

  const messages: ParsedMessage[] = [];
  const now = Date.now();

  const flushAssistant = () => {
    if (currentText || currentThinking || currentToolCalls.length > 0 || currentToolResults.length > 0 || currentImages.length > 0) {
      messages.push({
        uuid: lastUuid,
        role: "assistant",
        content: currentText.trim(),
        timestamp: now,
        thinking: currentThinking.trim() || undefined,
        toolCalls: currentToolCalls.length > 0 ? [...currentToolCalls] : undefined,
        toolResults: currentToolResults.length > 0 ? [...currentToolResults] : undefined,
        images: currentImages.length > 0 ? [...currentImages] : undefined,
      });
      currentText = "";
      currentThinking = "";
      currentToolCalls = [];
      currentToolResults = [];
      currentImages = [];
      lastUuid = undefined;
    }
  };

  for (const item of items) {
    if (item.type === "userMessage") {
      flushAssistant();
      continue;
    }

    if (item.type === "contextCompaction") continue;

    if (item.type === "agentMessage") {
      currentText += (currentText ? "\n" : "") + item.text;
      lastUuid = lastUuid || item.id;
      continue;
    }

    if (item.type === "reasoning") {
      const text = item.content.length > 0
        ? item.content.join("\n")
        : item.summary.join("\n");
      if (text) {
        currentThinking += (currentThinking ? "\n" : "") + text;
      }
      continue;
    }

    if (item.type === "plan") {
      currentText += (currentText ? "\n" : "") + item.text;
      lastUuid = lastUuid || item.id;
      continue;
    }

    if (item.type === "imageView") {
      currentImages.push({ mediaType: "image/png", data: item.path });
      continue;
    }

    const converted = threadItemToMessage(item);
    if (converted) {
      if (converted.toolCalls) currentToolCalls.push(...converted.toolCalls);
      if (converted.toolResults) currentToolResults.push(...converted.toolResults);
      if (converted.images) currentImages.push(...converted.images);
      lastUuid = lastUuid || converted.uuid;
    }
  }

  flushAssistant();
  return messages;
}
