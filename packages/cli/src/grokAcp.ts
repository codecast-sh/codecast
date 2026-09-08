// grok's ACP transport client — `grok agent stdio` driven over JSON-RPC on stdio.
//
// This is the codex app-server analogue for grok (codexAppServer.ts): a process
// the daemon owns that starts, loads and prompts sessions without a tmux pane,
// receives structured turn events instead of pane scrapes, and answers
// permission requests in-process. Verified live 2026-09-06 against grok 1.0.13:
// `initialize` advertises loadSession plus list/resume/close, `session/load`
// replays the session's history as `session/update` notifications stamped
// `isReplay`, and grok keeps writing the session's updates.jsonl while driven
// this way — so transcript ingest stays file-based and this client only carries
// control: start, load, prompt, cancel, permissions, status.
//
// Not yet wired into the daemon's launch/delivery/kill paths (that is the codex
// integration's 250-site footprint); see ct-49358.
import { spawn, type ChildProcess } from "./proc.js";
import { EventEmitter } from "events";
import * as readline from "readline";

export const GROK_ACP_PROTOCOL_VERSION = 1;
export const GROK_ACP_REQUEST_TIMEOUT_MS = 30_000;
/** A prompt runs until the turn ends; grok streams updates the whole time. */
export const GROK_ACP_PROMPT_TIMEOUT_MS = 60 * 60_000;

export interface GrokAcpOptions {
  log: (msg: string) => void;
  grokBinary?: string;
  /** Extra `grok agent` flags before `stdio` (e.g. `--always-approve`, `-m <model>`). */
  agentArgs?: string[];
  spawnFn?: typeof spawn;
  cwd?: string;
  /**
   * Answer a `session/request_permission` request. Return the optionId to
   * select; the default picks the first `allow_*` option (bypassPermissions
   * parity, the mode every daemon-managed grok pane already runs in).
   */
  onPermission?: (sessionId: string, request: GrokPermissionRequest) => Promise<string | null>;
}

export interface GrokPermissionOption {
  optionId: string;
  name?: string;
  kind?: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

export interface GrokPermissionRequest {
  sessionId: string;
  toolCall?: Record<string, unknown>;
  options: GrokPermissionOption[];
}

export interface GrokSessionUpdate {
  sessionId: string;
  /** `agent_message_chunk`, `user_message_chunk`, `tool_call`, `tool_call_update`, … */
  sessionUpdate: string;
  /** True on history replayed by `session/load`, never on live turn traffic. */
  isReplay: boolean;
  update: Record<string, unknown>;
}

export interface GrokPromptResult {
  /** ACP stop reasons: `end_turn`, `cancelled`, `max_tokens`, `refusal`, … */
  stopReason: string;
  /** Text streamed by `agent_message_chunk` updates during the turn. */
  text: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export declare interface GrokAcpClient {
  on(event: "ready", listener: () => void): this;
  on(event: "update", listener: (update: GrokSessionUpdate) => void): this;
  on(event: "permission", listener: (request: GrokPermissionRequest) => void): this;
  on(event: "exit", listener: (code: number | null) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "binaryNotFound", listener: (binary: string) => void): this;
}

export class GrokAcpClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private turnText = new Map<string, string>();
  private initialized = false;
  private stopped = false;
  private _binaryMissing = false;
  private readonly log: (msg: string) => void;
  private readonly grokBinary: string;
  private readonly agentArgs: string[];
  private readonly spawnFn: typeof spawn;
  private readonly cwd?: string;
  private readonly onPermission?: GrokAcpOptions["onPermission"];
  /** What `initialize` reported: loadSession, session capabilities, x.ai extensions. */
  agentCapabilities: Record<string, unknown> = {};

  constructor(opts: GrokAcpOptions) {
    super();
    this.log = opts.log;
    this.grokBinary = opts.grokBinary || "grok";
    this.agentArgs = opts.agentArgs ?? ["--always-approve"];
    this.spawnFn = opts.spawnFn ?? spawn;
    this.cwd = opts.cwd;
    this.onPermission = opts.onPermission;
  }

  get running(): boolean {
    return this.initialized && !this.stopped && !!this.process && this.process.exitCode === null;
  }

  get binaryMissing(): boolean {
    return this._binaryMissing;
  }

  /** Spawn `grok agent … stdio` and run `initialize`; resolves once the agent answered. */
  async start(): Promise<void> {
    if (this.process) return;
    this.stopped = false;
    const args = ["agent", ...this.agentArgs, "stdio"];
    this.log(`[grok-acp] spawning: ${this.grokBinary} ${args.join(" ")}`);
    let child: ChildProcess;
    try {
      child = this.spawnFn(this.grokBinary, args, { stdio: ["pipe", "pipe", "pipe"], cwd: this.cwd, env: process.env });
    } catch (err) {
      this.markSpawnFailure(err);
      throw err instanceof Error ? err : new Error(String(err));
    }
    this.process = child;
    if (!child.stdout || !child.stdin) throw new Error("grok agent stdio: no stdio handles");
    this.rl = readline.createInterface({ input: child.stdout });
    this.rl.on("line", (line) => this.handleLine(line));
    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text) this.log(`[grok-acp:stderr] ${text.slice(0, 500)}`);
    });
    child.on("error", (err) => {
      this.markSpawnFailure(err);
      this.emit("error", err);
    });
    child.on("exit", (code) => {
      this.log(`[grok-acp] exited code=${code}`);
      this.initialized = false;
      this.process = null;
      this.rl?.close();
      this.rl = null;
      for (const [id, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error("grok agent exited"));
        this.pendingRequests.delete(id);
      }
      this.emit("exit", code);
    });
    const resp = (await this.sendRequest("initialize", {
      protocolVersion: GROK_ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    })) as { agentCapabilities?: Record<string, unknown> };
    this.agentCapabilities = resp?.agentCapabilities ?? {};
    this.initialized = true;
    this.emit("ready");
  }

  stop(): void {
    this.stopped = true;
    this.initialized = false;
    const child = this.process;
    this.process = null;
    this.rl?.close();
    this.rl = null;
    if (child && child.exitCode === null) child.kill("SIGTERM");
  }

  /** A fresh session in `cwd`; grok persists it under ~/.grok/sessions as usual. */
  async sessionNew(params: { cwd: string; mcpServers?: unknown[] }): Promise<{ sessionId: string }> {
    return (await this.sendRequest("session/new", { cwd: params.cwd, mcpServers: params.mcpServers ?? [] })) as { sessionId: string };
  }

  /**
   * Load an existing session (any session grok wrote, TUI or ACP). Its history
   * arrives as `update` events with `isReplay: true` before this resolves.
   */
  async sessionLoad(params: { sessionId: string; cwd: string; mcpServers?: unknown[] }): Promise<void> {
    await this.sendRequest("session/load", { sessionId: params.sessionId, cwd: params.cwd, mcpServers: params.mcpServers ?? [] }, GROK_ACP_PROMPT_TIMEOUT_MS);
  }

  /** One user turn; resolves when grok ends the turn. Streams `update` events meanwhile. */
  async prompt(params: { sessionId: string; text: string }): Promise<GrokPromptResult> {
    this.turnText.set(params.sessionId, "");
    const resp = (await this.sendRequest("session/prompt", {
      sessionId: params.sessionId,
      prompt: [{ type: "text", text: params.text }],
    }, GROK_ACP_PROMPT_TIMEOUT_MS)) as { stopReason?: string };
    const text = this.turnText.get(params.sessionId) ?? "";
    this.turnText.delete(params.sessionId);
    return { stopReason: resp?.stopReason ?? "unknown", text };
  }

  /** Interrupt the running turn; the pending `prompt` then resolves with `cancelled`. */
  cancel(sessionId: string): void {
    this.writeMessage({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
  }

  // ── JSON-RPC plumbing ───────────────────────────────────────────────────────

  private markSpawnFailure(err: unknown): void {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      this._binaryMissing = true;
      this.stopped = true;
      this.log(`[grok-acp] binary "${this.grokBinary}" not found`);
      this.emit("binaryNotFound", this.grokBinary);
    }
  }

  private sendRequest(method: string, params: object, timeoutMs = GROK_ACP_REQUEST_TIMEOUT_MS): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin) {
        reject(new Error("grok agent not running"));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`grok agent ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer });
      this.writeMessage({ jsonrpc: "2.0", id, method, params });
    });
  }

  private writeMessage(msg: object): void {
    if (!this.process?.stdin?.writable) return;
    this.process.stdin.write(JSON.stringify(msg) + "\n");
  }

  /** Test seam and single entry point for every line grok writes. */
  handleLine(line: string): void {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log(`[grok-acp] unparseable line: ${line.slice(0, 200)}`);
      return;
    }
    const id = msg.id as number | string | undefined;
    const method = msg.method as string | undefined;
    if (id !== undefined && method === undefined) {
      const pending = this.pendingRequests.get(id as number);
      if (!pending) return;
      this.pendingRequests.delete(id as number);
      clearTimeout(pending.timer);
      if (msg.error) {
        const err = msg.error as { message?: string; code?: number };
        pending.reject(new Error(`grok agent error ${err.code ?? ""}: ${err.message ?? "unknown"}`.trim()));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (method !== undefined && id !== undefined) {
      void this.handleServerRequest(id, method, (msg.params ?? {}) as Record<string, unknown>);
      return;
    }
    if (method !== undefined) this.handleNotification(method, (msg.params ?? {}) as Record<string, unknown>);
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    if (method !== "session/update" && method !== "_x.ai/session/update") return;
    const sessionId = String(params.sessionId ?? "");
    const update = (params.update ?? {}) as Record<string, unknown>;
    const meta = (params._meta ?? {}) as Record<string, unknown>;
    const sessionUpdate = String(update.sessionUpdate ?? "");
    const isReplay = meta.isReplay === true;
    if (!isReplay && sessionUpdate === "agent_message_chunk") {
      const content = update.content as { type?: string; text?: string } | undefined;
      if (content?.type === "text" && typeof content.text === "string" && this.turnText.has(sessionId)) {
        this.turnText.set(sessionId, (this.turnText.get(sessionId) ?? "") + content.text);
      }
    }
    this.emit("update", { sessionId, sessionUpdate, isReplay, update } satisfies GrokSessionUpdate);
  }

  private async handleServerRequest(id: number | string, method: string, params: Record<string, unknown>): Promise<void> {
    if (method === "session/request_permission") {
      const request: GrokPermissionRequest = {
        sessionId: String(params.sessionId ?? ""),
        toolCall: params.toolCall as Record<string, unknown> | undefined,
        options: Array.isArray(params.options) ? (params.options as GrokPermissionOption[]) : [],
      };
      this.emit("permission", request);
      let optionId: string | null = null;
      try {
        optionId = this.onPermission ? await this.onPermission(request.sessionId, request) : null;
      } catch (err) {
        this.log(`[grok-acp] permission handler failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!optionId) optionId = defaultPermissionChoice(request.options);
      this.writeMessage({
        jsonrpc: "2.0",
        id,
        result: optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } },
      });
      return;
    }
    // fs/* and terminal/* are declined at initialize (no capabilities), so any
    // other request is unexpected — answer with a method-not-found error so
    // grok does not hang waiting.
    this.writeMessage({ jsonrpc: "2.0", id, error: { code: -32601, message: `unsupported client method ${method}` } });
  }
}

/** bypassPermissions parity: the first allow option, preferring a one-off allow. */
export function defaultPermissionChoice(options: GrokPermissionOption[]): string | null {
  const once = options.find((o) => o.kind === "allow_once");
  const any = options.find((o) => typeof o.kind === "string" && o.kind.startsWith("allow"));
  return (once ?? any ?? options[0])?.optionId ?? null;
}
