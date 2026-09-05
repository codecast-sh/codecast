import { EventEmitter } from "events";
import { spawn, type ChildProcess } from "./proc.js";
import * as readline from "readline";
import { STABLE_ENV_MODE, type CodexTurnError } from "@codecast/shared/contracts";
import { codexTurnErrorMessage } from "./codexTurnError.js";
import { agentSpawnPath } from "./agentSpawnPath.js";
import { withWorktreeConfig } from "./worktreeEnv.js";
import type { ParsedMessage, ToolCall, ToolResult, ImageBlock } from "./parser.js";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/**
 * The resolved sandbox the server reports for a thread. Mirrors
 * codex-cli 0.153.3 `v2/SandboxPolicy.ts`. Richer than SandboxMode: the
 * workspaceWrite variant carries writable roots and network flags that a bare
 * mode cannot reconstruct, which is why a turn override must replay a policy
 * the server actually returned rather than one synthesized from a mode.
 */
export type SandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: boolean }
  | { type: "externalSandbox"; networkAccess: unknown }
  | { type: "workspaceWrite"; writableRoots: string[]; networkAccess: boolean; excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean };
/**
 * Resume params that reproduce a policy the server previously reported.
 *
 * PROTOCOL LIMITATION, measured against codex-cli 0.153.3 on a live restart:
 * thread/resume accepts only a coarse `sandbox: SandboxMode`, so a mode alone
 * does NOT restore a workspaceWrite thread's writable roots or network access.
 * A cold resume naming `workspace-write` came back with empty writableRoots and
 * networkAccess false, losing both. The fine-grained values survive only through
 * the generic `config` override map, which is not part of the typed sandbox
 * contract; sending them there restored the exact original policy.
 *
 * An absent or unrecognised policy returns {} on purpose. An unknown prior
 * sandbox must stay unspecified rather than be guessed: naming a mode we cannot
 * justify would widen a thread that was deliberately restricted. `externalSandbox`
 * is deliberately not reproduced, since its settings are not expressible here.
 */
export function sandboxResumeParams(
  policy: SandboxPolicy | undefined | null,
): { sandbox?: SandboxMode; config?: Record<string, unknown> } {
  if (!policy || typeof policy !== "object") return {};
  switch (policy.type) {
    case "dangerFullAccess":
      return { sandbox: "danger-full-access" };
    case "readOnly":
      // KNOWN GAP: SandboxPolicy.readOnly carries `networkAccess`, but
      // thread/resume offers no channel to restore it, so a read-only thread
      // that had network access resumes without it. That direction is narrower,
      // never broader, so it fails closed, but it is NOT exact preservation.
      return { sandbox: "read-only" };
    case "workspaceWrite":
      // Every field FAILS CLOSED. A missing roots list becomes no extra roots,
      // absent network access becomes none, and an absent exclude flag becomes
      // `true` (exclude), because defaulting it to `false` would hand back a
      // writable /tmp or $TMPDIR that the recorded policy never granted.
      return {
        sandbox: "workspace-write",
        config: {
          "sandbox_workspace_write.writable_roots": Array.isArray(policy.writableRoots) ? policy.writableRoots : [],
          "sandbox_workspace_write.network_access": policy.networkAccess === true,
          "sandbox_workspace_write.exclude_tmpdir_env_var": policy.excludeTmpdirEnvVar !== false,
          "sandbox_workspace_write.exclude_slash_tmp": policy.excludeSlashTmp !== false,
        },
      };
    default:
      return {};
  }
}

/**
 * A JSON-RPC error response: the server answered and REFUSED the request. This
 * is authoritative, so the thread's previous policy still holds. It is
 * deliberately distinct from a timeout or a dropped connection, where the
 * request may well have been applied and the outcome is simply unknown.
 */
export class CodexRequestRefused extends Error {
  readonly refused = true as const;
}

/** True only for an answered refusal, never for an ambiguous transport failure. */
export function isAuthoritativeRefusal(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { refused?: unknown }).refused === true;
}

/**
 * The durability barrier failed: the thread's stored policy could not be cleared
 * before a request that may change it. Thrown BEFORE anything reaches the
 * socket, so a narrowing is never in flight while the on-disk record still
 * authorizes the older, broader policy.
 */
export class CodexPolicyInvalidationFailed extends Error {}

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
  /** Codex 0.153+ recomputes a restrictive managed permission profile for any
   *  turn that arrives without one, instead of inheriting what the thread was
   *  created with, so every turn must restate the sandbox. The wire field here
   *  is `sandboxPolicy` and it takes a full SandboxPolicy, NOT the `sandbox`
   *  SandboxMode that thread/start, thread/resume and thread/fork take. Callers
   *  may leave it unset: turnStart replays the policy the server reported for
   *  this thread. */
  sandboxPolicy?: SandboxPolicy;
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
  config?: Record<string, unknown>;
}

export interface ThreadForkParams extends ThreadStartParams {
  threadId: string;
  path?: string;
}

export interface Turn {
  id: string;
  items: ThreadItem[];
  status: TurnStatus;
  error?: CodexTurnError | null;
}

export interface ThreadStartResponse {
  thread: { id: string; path?: string | null; forkedFromId?: string | null };
  cwd: string;
  model: string;
  sandbox: SandboxPolicy;
  approvalPolicy: unknown;
}

export interface TurnStartResponse {
  turn: Turn;
}

export interface ThreadResumeResponse {
  thread: { id: string; path?: string | null; forkedFromId?: string | null; status?: { type: string; activeFlags?: string[] }; turns?: Turn[] };
  cwd: string;
  model: string;
  /** The policy the server resolved for the resumed thread. Present on
   *  thread/resume as well as thread/start in codex-cli 0.153.3. */
  sandbox: SandboxPolicy;
}

export interface ThreadForkResponse extends ThreadStartResponse {}

export interface FileUpdateChange {
  path: string;
  diff: string;
  kind: string | { type: string; move_path?: string | null };
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

function imageMediaTypeForPath(imagePath: string): string {
  const cleanPath = imagePath.split(/[?#]/, 1)[0].toLowerCase();
  if (cleanPath.endsWith(".jpg") || cleanPath.endsWith(".jpeg")) return "image/jpeg";
  if (cleanPath.endsWith(".gif")) return "image/gif";
  if (cleanPath.endsWith(".webp")) return "image/webp";
  if (cleanPath.endsWith(".bmp")) return "image/bmp";
  if (cleanPath.endsWith(".svg")) return "image/svg+xml";
  if (cleanPath.endsWith(".avif")) return "image/avif";
  return "image/png";
}

export interface ApprovalRequest {
  id: number | string;
  method: string;
  params: Record<string, unknown>;
}

export interface CodexAppServerOptions {
  log: (msg: string) => void;
  onApproval?: (threadId: string, approval: ApprovalRequest) => Promise<boolean>;
  codexBinary?: string;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface TurnAccumulator {
  items: ThreadItem[];
  threadId: string;
  model?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const THREAD_START_TIMEOUT_MS = 60_000;
const MAX_RESTART_DELAY_MS = 30_000;

export function threadForkTimeoutMsForBytes(bytes: number): number {
  const mib = 1024 * 1024;
  const extraMib = Math.ceil(Math.max(0, bytes - mib) / mib);
  return Math.min(10 * 60_000, THREAD_START_TIMEOUT_MS + extraMib * 15_000);
}

const APPROVAL_METHODS = new Set([
  "execCommandApproval",
  "applyPatchApproval",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "item/tool/call",
]);

const SILENT_NOTIFICATIONS = new Set([
  "thread/tokenUsage/updated",
  "account/rateLimits/updated",
  "turn/diff/updated",
  "item/commandExecution/terminalInteraction",
  "serverRequest/resolved",
]);

export function approvalResultForMethod(method: string, approved: boolean, params?: Record<string, unknown>): Record<string, unknown> {
  switch (method) {
    case "execCommandApproval":
    case "applyPatchApproval":
      return { decision: approved ? "approved" : "denied" };

    case "item/commandExecution/requestApproval":
      return { decision: approved ? "accept" : "decline" };

    case "item/fileChange/requestApproval":
      return { decision: approved ? "accept" : "decline" };

    case "item/permissions/requestApproval": {
      const requested = (params?.permissions || {}) as Record<string, unknown>;
      return approved
        ? { permissions: requested, scope: "session" }
        : { permissions: {}, scope: "turn" };
    }

    case "item/tool/requestUserInput":
      return { answers: {} };

    case "item/tool/call":
      return { contentItems: [], success: approved };

    default:
      return { decision: approved ? "approved" : "denied" };
  }
}

export class CodexAppServer extends EventEmitter {
  private process: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private pendingRequests = new Map<number | string, PendingRequest>();
  private turnAccumulators = new Map<string, TurnAccumulator>();
  private threadModels = new Map<string, string>();
  /** The policy the SERVER resolved for each live thread, taken from the
   *  thread/start, thread/resume and thread/fork responses. This is what a turn
   *  override replays, so writable roots and network access survive verbatim
   *  and a restatement can never widen a thread's real access. */
  private threadPolicies = new Map<string, SandboxPolicy>();
  /** Overrides in flight per thread, REFCOUNTED. While a turn is awaiting the
   *  server's verdict the thread's policy is genuinely unknown: the old one may
   *  already be superseded and the new one is not yet confirmed. A count rather
   *  than a set, because concurrent turns on one thread must not clear each
   *  other's mark, and an implicit turn must not clear an override's at all. */
  private pendingPolicyCounts = new Map<string, number>();
  /** Threads whose policy is unknown until an AUTHORITATIVE one arrives. Set the
   *  moment an override is sent and cleared only by acceptance or by an answered
   *  refusal. An ambiguous outcome leaves it set, because "no live value" must
   *  not decay back into the old, broader value the record still holds. */
  private invalidatedPolicyThreads = new Set<string>();
  /** The latest policy request issued per thread. A response may only record its
   *  policy if it is still the latest: an older response must never clear the
   *  uncertainty a newer request introduced. Refcounting alone does not give
   *  this, because two overrides can settle out of order. */
  private policyGenerations = new Map<string, number>();
  private restartDelay = 1000;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private initialized = false;
  private _binaryMissing = false;
  private log: (msg: string) => void;
  private onApproval?: (threadId: string, approval: ApprovalRequest) => Promise<boolean>;
  private codexBinary: string;

  constructor(opts: CodexAppServerOptions) {
    super();
    this.log = opts.log;
    this.onApproval = opts.onApproval;
    this.codexBinary = opts.codexBinary || "codex";
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

  get binaryMissing(): boolean {
    return this._binaryMissing;
  }

  private async initialize(): Promise<void> {
    const resp = await this.sendRequest("initialize", {
      clientInfo: { name: "codecast", title: "Codecast Daemon", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    }, THREAD_START_TIMEOUT_MS);
    this.initialized = true;
    const r = resp as { userAgent?: string; platformOs?: string };
    this.log(`[codex-app-server] initialized: ${r.userAgent ?? "unknown"} (${r.platformOs ?? "unknown"})`);
    this.emit("ready");
  }

  async threadStart(params: ThreadStartParams): Promise<ThreadStartResponse> {
    const response = await this.sendRequest("thread/start", withWorktreeConfig(params), THREAD_START_TIMEOUT_MS) as ThreadStartResponse;
    this.threadModels.set(response.thread.id, response.model);
    this.rememberPolicy(response.thread.id, response.sandbox, this.nextPolicyGeneration(response.thread.id));
    return response;
  }

  async turnStart(params: TurnStartParams): Promise<TurnStartResponse> {
    if (params.model) this.threadModels.set(params.threadId, params.model);
    const previous = this.threadPolicies.get(params.threadId);

    // An implicit turn changes nothing about the thread's policy, so it must not
    // touch the in-flight bookkeeping at all: doing so would clear an override's
    // mark that a concurrent call is relying on.
    if (!params.sandboxPolicy) {
      return await this.sendRequest(
        "turn/start", previous ? { ...params, sandboxPolicy: previous } : params, DEFAULT_TIMEOUT_MS,
      ) as TurnStartResponse;
    }

    // From here the thread's policy is UNKNOWN, starting before the write hits
    // the socket. The server may apply the override and we may never learn it,
    // so both memory and disk have to stop claiming the old, broader value now
    // rather than after the response.
    const generation = this.beginPendingPolicy(params.threadId);
    this.invalidatePolicyOrThrow(params.threadId);
    try {
      const response = await this.sendRequest(
        "turn/start", { ...params, sandboxPolicy: params.sandboxPolicy }, DEFAULT_TIMEOUT_MS,
      ) as TurnStartResponse;
      // Only if no later override has been issued for this thread. Two overrides
      // can settle out of order, and an earlier acceptance must not resolve the
      // uncertainty a later one created.
      const latest = this.isLatestPolicyGeneration(params.threadId, generation);
      this.rememberPolicy(params.threadId, params.sandboxPolicy, generation);
      this.endPendingPolicy(params.threadId);
      if (latest) this.emit("policyConfirmed", params.threadId, params.sandboxPolicy);
      return response;
    } catch (error) {
      if (isAuthoritativeRefusal(error) && previous && this.isLatestPolicyGeneration(params.threadId, generation)) {
        // The server answered and refused, so the previous policy still holds
        // and may be restored to memory and disk.
        this.rememberPolicy(params.threadId, previous, generation);
        this.endPendingPolicy(params.threadId);
        this.emit("policyConfirmed", params.threadId, previous);
      } else {
        // Ambiguous: a timeout or a dropped connection says nothing about
        // whether the override was applied. Leave the policy unspecified until
        // an authoritative one is known; a resume with none is restrictive.
        this.endPendingPolicy(params.threadId);
      }
      throw error;
    }
  }

  /** Records the policy the server resolved for a thread. Only a server-reported
   *  or caller-supplied policy is ever stored, never one inferred from a mode,
   *  so replaying it cannot widen access. */
  private rememberPolicy(threadId: string, policy?: SandboxPolicy | null, generation?: number): void {
    // A superseded response records nothing. Storing its policy would be stale,
    // and clearing the unknown flag would erase uncertainty a later request
    // introduced, which is how an accepted narrowing gets replayed as the older
    // broader policy.
    if (generation !== undefined && !this.isLatestPolicyGeneration(threadId, generation)) return;
    if (policy && typeof policy === "object" && typeof (policy as { type?: unknown }).type === "string") {
      this.threadPolicies.set(threadId, policy);
      // An authoritative value ends the unknown state.
      this.invalidatedPolicyThreads.delete(threadId);
    }
  }

  /** The policy the server reported for a live thread. */
  policyForThread(threadId: string): SandboxPolicy | undefined {
    return this.threadPolicies.get(threadId);
  }

  /** True while any override for this thread is awaiting the server's verdict,
   *  so the thread's real policy is momentarily unknown. */
  hasPendingPolicyChange(threadId: string): boolean {
    return (this.pendingPolicyCounts.get(threadId) ?? 0) > 0;
  }

  /** Marks a policy request in flight and returns its generation. */
  private beginPendingPolicy(threadId: string): number {
    this.pendingPolicyCounts.set(threadId, (this.pendingPolicyCounts.get(threadId) ?? 0) + 1);
    this.invalidatedPolicyThreads.add(threadId);
    return this.nextPolicyGeneration(threadId);
  }

  private nextPolicyGeneration(threadId: string): number {
    const generation = (this.policyGenerations.get(threadId) ?? 0) + 1;
    this.policyGenerations.set(threadId, generation);
    return generation;
  }

  private isLatestPolicyGeneration(threadId: string, generation: number): boolean {
    return (this.policyGenerations.get(threadId) ?? 0) === generation;
  }

  /** True when this thread's policy is unknown and must not fall back to a
   *  previously recorded one. */
  isPolicyInvalidated(threadId: string): boolean {
    return this.invalidatedPolicyThreads.has(threadId);
  }

  /**
   * Clears the thread's policy in memory and on disk before a request that may
   * change it. A listener that cannot make the clear durable throws, and that
   * failure aborts the request: sending anyway would leave a narrowing in flight
   * against a record that still grants the old broader access.
   */
  private invalidatePolicyOrThrow(threadId: string): void {
    this.threadPolicies.delete(threadId);
    try {
      this.emit("policyInvalidated", threadId);
    } catch (cause) {
      this.endPendingPolicy(threadId);
      throw new CodexPolicyInvalidationFailed(
        `could not clear the stored sandbox policy for thread ${threadId.slice(0, 8)}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  private endPendingPolicy(threadId: string): void {
    const next = (this.pendingPolicyCounts.get(threadId) ?? 0) - 1;
    if (next > 0) this.pendingPolicyCounts.set(threadId, next);
    else this.pendingPolicyCounts.delete(threadId);
  }

  async turnInterrupt(threadId: string, turnId: string): Promise<void> {
    await this.sendRequest("turn/interrupt", { threadId, turnId }, DEFAULT_TIMEOUT_MS);
  }

  async threadResume(params: ThreadResumeParams): Promise<ThreadResumeResponse> {
    // Unlike start and fork, a resume already knows its thread id, so its
    // generation must be taken BEFORE the request goes out. Taking it after the
    // await would make a slow response the newest by definition, letting it
    // overwrite a narrowing that was accepted while it was in flight. A resume
    // can change the policy, so the thread is unknown from here until it answers.
    const generation = this.beginPendingPolicy(params.threadId);
    this.invalidatePolicyOrThrow(params.threadId);
    try {
      const response = await this.sendRequest("thread/resume", withWorktreeConfig(params), THREAD_START_TIMEOUT_MS) as ThreadResumeResponse;
      this.threadModels.set(response.thread.id, response.model);
      // Resume by history or by path can return a different thread. That id has
      // no earlier generation to capture, so it records under a fresh one.
      const sameThread = response.thread.id === params.threadId;
      const recordGeneration = sameThread ? generation : this.nextPolicyGeneration(response.thread.id);
      const current = this.isLatestPolicyGeneration(response.thread.id, recordGeneration);
      this.rememberPolicy(response.thread.id, response.sandbox, recordGeneration);
      this.endPendingPolicy(params.threadId);
      if (current) this.emit("policyConfirmed", response.thread.id, response.sandbox);
      return response;
    } catch (error) {
      // A failed resume says nothing about the thread's policy, so it stays
      // unknown rather than reverting to the value the record still holds.
      this.endPendingPolicy(params.threadId);
      throw error;
    }
  }

  async threadFork(params: ThreadForkParams, timeoutMs = THREAD_START_TIMEOUT_MS): Promise<ThreadForkResponse> {
    const response = await this.sendRequest("thread/fork", withWorktreeConfig(params), timeoutMs) as ThreadForkResponse;
    this.threadModels.set(response.thread.id, response.model);
    this.rememberPolicy(response.thread.id, response.sandbox, this.nextPolicyGeneration(response.thread.id));
    return response;
  }

  respondToApproval(id: number | string, approved: boolean, method?: string, params?: Record<string, unknown>): void {
    const result = approvalResultForMethod(method || "", approved, params);
    this.log(`[codex-app-server] approval response: method=${method} approved=${approved} result=${JSON.stringify(result)}`);
    this.writeMessage({ jsonrpc: "2.0", id, result });
  }

  private consecutiveQuickExits = 0;
  private static readonly QUICK_EXIT_THRESHOLD_MS = 3000;
  private static readonly MAX_CONSECUTIVE_QUICK_EXITS = 5;
  private lastSpawnTime = 0;

  private spawnProcess(): void {
    const args = ["app-server"];
    this.log(`[codex-app-server] spawning: ${this.codexBinary} ${args.join(" ")}`);
    this.lastSpawnTime = Date.now();

    let child: ChildProcess;
    try {
      child = spawn(this.codexBinary, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PATH: agentSpawnPath(),
          // App-server threads get stable context via developerInstructions at
          // threadStart. Suppress the Codex SessionStart hook in this process
          // so a thread can never be injected twice.
          [STABLE_ENV_MODE]: "off",
        },
      });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      const isNotFound = err?.code === "ENOENT" || msg.includes("not found in") || msg.includes("ENOENT");
      this.log(`[codex-app-server] spawn failed: ${msg}`);
      if (isNotFound) {
        this._binaryMissing = true;
        this.stopped = true;
        this.log(`[codex-app-server] binary "${this.codexBinary}" not found in PATH, disabling`);
        this.emit("binaryNotFound", this.codexBinary);
      } else {
        this.emit("error", err instanceof Error ? err : new Error(msg));
        this.scheduleRestart();
      }
      return;
    }

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
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this._binaryMissing = true;
        this.stopped = true;
        this.log(`[codex-app-server] binary "${this.codexBinary}" not found in PATH, disabling`);
        this.emit("binaryNotFound", this.codexBinary);
        this.cleanup();
        return;
      }
      this.emit("error", err);
      this.cleanup();
      this.scheduleRestart();
    });

    child.on("close", (code, signal) => {
      this.log(`[codex-app-server] process exited: code=${code} signal=${signal}`);
      const uptime = Date.now() - this.lastSpawnTime;
      if (uptime < CodexAppServer.QUICK_EXIT_THRESHOLD_MS) {
        this.consecutiveQuickExits++;
        if (this.consecutiveQuickExits >= CodexAppServer.MAX_CONSECUTIVE_QUICK_EXITS) {
          this.log(`[codex-app-server] ${this.consecutiveQuickExits} consecutive quick exits (last uptime ${uptime}ms), disabling`);
          this.stopped = true;
          this.cleanup();
          this.emit("closed");
          return;
        }
      } else {
        this.consecutiveQuickExits = 0;
      }
      this.emit("exited", code, signal);
      this.cleanup();
      if (!this.stopped) {
        this.scheduleRestart();
      } else {
        this.emit("closed");
      }
    });

    this.initialize().then(() => {
      // Only reset backoff after successful initialization
      this.restartDelay = 1000;
      this.consecutiveQuickExits = 0;
    }).catch((err) => {
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
      pending.reject(new CodexRequestRefused(String(err.message || JSON.stringify(err))));
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
          this.respondToApproval(id, approved, method, params);
        }).catch((err) => {
          this.log(`[codex-app-server] approval handler error: ${err.message}`);
          this.respondToApproval(id, false, method, params);
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
        const model = this.threadModels.get(threadId);
        this.turnAccumulators.set(turn.id, { items: [], threadId, model });
        this.emit("turnStarted", threadId, turn.id, model);
        break;
      }

      case "turn/completed": {
        const threadId = params.threadId as string;
        const turn = params.turn as Turn;
        const acc = this.turnAccumulators.get(turn.id);
        const items = acc?.items || [];
        this.turnAccumulators.delete(turn.id);
        const messages: ParsedMessage[] = threadItemsToMessages(items).map(message => ({ ...message, model: acc?.model }));
        if (turn.status === "failed") {
          const timestamp = Math.max(Date.now(), ...messages.map(message => message.timestamp + 1));
          messages.push(codexTurnErrorMessage(turn.id, turn.error ?? {}, timestamp, acc?.model));
        }
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
        if (!SILENT_NOTIFICATIONS.has(method)) {
          this.log(`[codex-app-server] unhandled notification: ${method}`);
        }
        break;
    }
  }
}

export function threadItemToMessage(item: ThreadItem, timestamp = Date.now()): ParsedMessage | null {
  switch (item.type) {
    case "userMessage": {
      const texts: string[] = [];
      const images: ImageBlock[] = [];
      for (const input of item.content) {
        if (input.type === "text") {
          texts.push(input.text);
        } else if (input.type === "localImage") {
          images.push({
            mediaType: imageMediaTypeForPath(input.path),
            localPath: input.path,
          });
        }
      }
      return {
        uuid: item.id,
        role: "user",
        content: texts.join("\n"),
        timestamp,
        images: images.length > 0 ? images : undefined,
      };
    }

    case "agentMessage": {
      return {
        uuid: item.id,
        role: "assistant",
        content: item.text,
        timestamp,
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
        timestamp,
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
        timestamp,
        toolCalls,
        toolResults,
      };
    }

    case "fileChange": {
      const diffSummary = item.changes.map(c => `${typeof c.kind === "string" ? c.kind : c.kind.type}: ${c.path}`).join("\n");
      const fullDiff = item.changes.map(c => {
        const kind = typeof c.kind === "string" ? c.kind : c.kind.type;
        if (kind === "add" || kind === "delete") {
          const lines = c.diff ? c.diff.replace(/\n$/, "").split("\n") : [];
          const adding = kind === "add";
          return `--- ${adding ? "/dev/null" : c.path}\n+++ ${adding ? c.path : "/dev/null"}\n`
            + `@@ -${adding ? "0,0" : `1,${lines.length}`} +${adding ? `1,${lines.length}` : "0,0"} @@\n`
            + lines.map(line => `${adding ? "+" : "-"}${line}`).join("\n");
        }
        return /^diff --git |^--- [^\n]*\n\+\+\+ /m.test(c.diff)
          ? c.diff
          : `--- ${c.path}\n+++ ${c.path}\n${c.diff}`;
      }).join("\n");
      const toolCalls: ToolCall[] = [{
        id: item.id,
        name: "fileChange",
        input: { changes: diffSummary },
      }];
      const toolResults: ToolResult[] = [{
        toolUseId: item.id,
        content: fullDiff,
        isError: item.status === "failed" || item.status === "declined",
      }];
      return {
        uuid: item.id,
        role: "assistant",
        content: "",
        timestamp,
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
        timestamp,
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
        timestamp,
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
        timestamp,
        toolCalls,
      };
    }

    case "webSearch": {
      return {
        uuid: item.id,
        role: "assistant",
        content: "",
        timestamp,
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
        timestamp,
        subtype: "plan",
      };
    }

    case "imageView": {
      return {
        uuid: item.id,
        role: "assistant",
        content: "",
        timestamp,
        images: [{
          mediaType: imageMediaTypeForPath(item.path),
          localPath: item.path,
        }],
      };
    }

    case "imageGeneration": {
      return {
        uuid: item.id,
        role: "assistant",
        content: item.result,
        timestamp,
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
  let currentImages: ImageBlock[] = [];
  let lastUuid: string | undefined;

  const messages: ParsedMessage[] = [];
  const baseTimestamp = Date.now();
  let timestampOffset = 0;

  const nextTimestamp = () => baseTimestamp + timestampOffset++;

  const flushAssistant = () => {
    if (currentText || currentThinking || currentImages.length > 0) {
      messages.push({
        uuid: lastUuid,
        role: "assistant",
        content: currentText.trim(),
        timestamp: nextTimestamp(),
        thinking: currentThinking.trim() || undefined,
        images: currentImages.length > 0 ? [...currentImages] : undefined,
      });
      currentText = "";
      currentThinking = "";
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
      currentImages.push({
        mediaType: imageMediaTypeForPath(item.path),
        localPath: item.path,
      });
      // Progress sync rebuilds the whole completed-item list after every item.
      // Without a stable uuid an image-only group is inserted again on every
      // rebuild instead of patching the same message.
      lastUuid = lastUuid || item.id;
      continue;
    }

    const converted = threadItemToMessage(item);
    if (converted) {
      flushAssistant();
      messages.push({
        ...converted,
        timestamp: nextTimestamp(),
      });
    }
  }

  flushAssistant();
  return messages;
}
