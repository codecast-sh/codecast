// One Grok conversation driven over ACP (`grok agent stdio`), shaped like
// ClaudeSdkSession so the same host process (host.ts), socket protocol, daemon
// client and backend run it. Owned by the host; it knows nothing of sockets.
//
// Grok writes its own updates.jsonl under ~/.grok/sessions whichever way it is
// driven, so codecast's transcript watcher syncs a direct session exactly as it
// syncs a pane one. Nothing here reads or forwards message content; it turns
// ACP traffic into the facts codecast tracks: status, the prompts Grok is
// blocked on, turn results and failures.

import { EventEmitter } from "node:events";
import * as crypto from "node:crypto";
import { GrokAcpClient, type GrokPermissionOption, type GrokPermissionRequest, type GrokSessionUpdate } from "../grokAcp.js";
import type { SdkActivity, SdkHostStatus, SdkImage, SdkInitInfo, SdkPermissionAnswer, SdkPermissionRequest, SdkTurnError } from "./protocol.js";
import type { ClaudeSdkSessionEvents } from "./session.js";
import { sdkSessionEnv, type SdkLaunchSpec } from "./options.js";

/** What the grok launch argv the tmux path builds says about the session. */
export interface ParsedGrokArgs {
  model?: string;
  effort?: string;
  permissionMode?: string;
  rules?: string;
}

const GROK_VALUE_FLAGS: Record<string, keyof ParsedGrokArgs> = {
  "--model": "model", "-m": "model",
  "--reasoning-effort": "effort", "--effort": "effort",
  "--permission-mode": "permissionMode",
  "--rules": "rules",
};

/** Read a grok launch argv (without the binary). Other flags are ignored: agent mode takes none of them. */
export function parseGrokArgs(args: string[]): ParsedGrokArgs {
  const out: ParsedGrokArgs = {};
  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    const eq = raw.indexOf("=");
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    const key = GROK_VALUE_FLAGS[flag];
    if (!key) continue;
    const value = eq > 0 ? raw.slice(eq + 1) : args[++i];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** The `grok agent` options for a parsed argv: model and effort apply to every session the process runs. */
export function grokAgentArgs(parsed: ParsedGrokArgs): string[] {
  return [...(parsed.model ? ["-m", parsed.model] : []), ...(parsed.effort ? ["--reasoning-effort", parsed.effort] : [])];
}

/** Always-approve is grok's bypassPermissions; auto is its own mode. */
function permissionMeta(mode: string | undefined): { yoloMode?: boolean; autoMode?: boolean } {
  if (mode === "bypassPermissions") return { yoloMode: true };
  if (mode === "auto") return { autoMode: true, yoloMode: false };
  return { yoloMode: false };
}

/** The option a codecast answer picks: a remembered allow is grok's allow_always. */
export function grokOptionFor(answer: SdkPermissionAnswer, options: GrokPermissionOption[]): string | null {
  const pick = (...kinds: string[]) => kinds.map((k) => options.find((o) => o.kind === k)).find(Boolean)?.optionId ?? null;
  if (answer.behavior === "allow") return answer.updatedPermissions?.length ? pick("allow_always", "allow_once") : pick("allow_once", "allow_always");
  return pick("reject_once", "reject_always");
}

/** A turn's failure from a rejected prompt: grok names the cause in the error text. */
export function grokTurnError(err: unknown, now = Date.now()): SdkTurnError {
  const message = err instanceof Error ? err.message : String(err);
  const kind = /auth|sign in|login|token/i.test(message) ? "authentication_failed"
    : /rate.?limit|quota|usage limit|429/i.test(message) ? "rate_limit"
    : /billing|credit|payment/i.test(message) ? "billing_error"
    : "error";
  return { kind, message, at: now };
}

interface PendingPrompt {
  request: SdkPermissionRequest;
  options: GrokPermissionOption[];
  resolve: (optionId: string | null) => void;
}

export interface GrokSessionOptions {
  /** Tests stand in a client; the host runs the real `grok agent stdio`. */
  client?: GrokAcpClient;
  log?: (line: string) => void;
}

export class GrokAcpSession extends EventEmitter<ClaudeSdkSessionEvents> {
  readonly sessionId: string;
  private _grokSessionId: string;
  private readonly client: GrokAcpClient;
  private readonly prompts = new Map<string, PendingPrompt>();
  private _status: SdkHostStatus = "starting";
  private _init: SdkInitInfo | null = null;
  private _lastError: SdkTurnError | null = null;
  private _activity: SdkActivity | null = null;
  private permissionMode: string;
  private readonly cwd: string;
  /** Our prompts grok has not ended yet; each is one turn, queued behind the one running. */
  private outstanding = 0;
  private drainWaiters: Array<() => void> = [];
  private ended = false;
  private stopping: Promise<void> | null = null;
  readonly ready: Promise<SdkInitInfo>;

  constructor(spec: SdkLaunchSpec, base: Record<string, string | undefined>, opts: GrokSessionOptions = {}) {
    super();
    const parsed = parseGrokArgs(spec.args);
    this.sessionId = spec.sessionId;
    this._grokSessionId = spec.sessionId;
    this.permissionMode = parsed.permissionMode ?? "default";
    this.cwd = spec.cwd;
    const log = opts.log ?? (() => {});
    this.client = opts.client ?? new GrokAcpClient({
      log,
      grokBinary: spec.executable,
      agentArgs: grokAgentArgs(parsed),
      cwd: spec.cwd,
      env: sdkSessionEnv(base, spec, { effortSet: false }),
      spawnPrefix: spec.spawnPrefix,
      onPermission: (_sid, request) => this.ask(request),
    });
    this.client.on("update", (u) => this.observe(u));
    this.client.on("exit", (code) => this.end(`grok exited${code === null ? "" : ` (${code})`}`));
    this.client.on("error", (err) => log(`[grok] ${err.message}`));
    const rules = [parsed.rules, spec.appendSystemPrompt].filter(Boolean).join("\n\n") || undefined;
    this.ready = this.boot(spec, parsed, rules);
    this.ready.catch((err) => {
      log(`[grok] did not start: ${(err as Error).message}`);
      this.client.stop();
      this.end((err as Error).message);
    });
  }

  /** Start grok, then load the session (or create it), and report it ready. */
  private async boot(spec: SdkLaunchSpec, parsed: ParsedGrokArgs, rules: string | undefined): Promise<SdkInitInfo> {
    await this.client.start();
    const meta = permissionMeta(this.permissionMode);
    if (spec.resume) {
      // Rules a session was created with stay with it; a load takes only the permission mode.
      await this.client.sessionLoad({ sessionId: spec.sessionId, cwd: spec.cwd, meta });
    } else {
      const { sessionId } = await this.client.sessionNew({ cwd: spec.cwd, meta: { ...meta, ...(rules ? { rules } : {}) } });
      if (sessionId && sessionId !== this._grokSessionId) {
        this._grokSessionId = sessionId;
        this.emit("session", sessionId);
      }
    }
    const model = (this.client.agentMeta.modelState as { currentModelId?: string } | undefined)?.currentModelId ?? parsed.model ?? null;
    const info: SdkInitInfo = {
      version: typeof this.client.agentMeta.agentVersion === "string" ? this.client.agentMeta.agentVersion : null,
      model,
      permissionMode: this.permissionMode,
      accountEmail: null,
      subscriptionType: null,
      slashCommands: [],
    };
    this._init = info;
    if (this._status === "starting") this.setStatus("idle");
    this.report({ status: "idle", sessionBoundary: true });
    this.emit("init", info);
    return info;
  }

  get claudeSessionId(): string {
    return this._grokSessionId;
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

  /** Report what the status hook would have reported; ClaudeSdkSession.report's rules. */
  private report(activity: Omit<SdkActivity, "ts" | "permissionMode">): void {
    if (this.prompts.size && activity.status !== "permission_blocked") return;
    const prev = this._activity;
    if (prev && prev.status === activity.status && !activity.turnCompletedAt && !activity.dialog && !activity.sessionBoundary && prev.message === activity.message) return;
    const next: SdkActivity = { ...activity, ts: Math.floor(Date.now() / 1000), permissionMode: this.permissionMode };
    this._activity = next;
    this.emit("activity", next);
  }

  private settleStatus(): void {
    if (this.ended) return this.setStatus("stopped");
    if (this.prompts.size) return this.setStatus("needs_input");
    this.setStatus(this.outstanding > 0 ? "working" : this._init ? "idle" : "starting");
  }

  private observe(u: GrokSessionUpdate): void {
    if (u.isReplay || this.outstanding === 0 || this.prompts.size) return;
    if (u.sessionUpdate === "tool_call") this.report({ status: "working" });
  }

  /** A tool permission grok asks for: held until the daemon's card answers it. */
  private ask(request: GrokPermissionRequest): Promise<string | null> {
    const call = request.toolCall ?? {};
    const requestId = typeof call.toolCallId === "string" && call.toolCallId ? call.toolCallId : crypto.randomUUID();
    const rawInput = call.rawInput;
    const input = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? rawInput as Record<string, unknown> : {};
    const toolName = typeof call.title === "string" && call.title ? call.title : typeof call.kind === "string" ? call.kind : "tool";
    const sdkRequest: SdkPermissionRequest = { requestId, toolName, toolUseId: requestId, input, createdAt: Date.now() };
    return new Promise((resolve) => {
      this.prompts.set(requestId, { request: sdkRequest, options: request.options, resolve });
      this.emit("permission", sdkRequest);
      const command = typeof input.command === "string" ? input.command : typeof input.path === "string" ? input.path : "";
      this.report({ status: "permission_blocked", message: command ? `${toolName}: ${command.slice(0, 300)}` : toolName, dialog: true });
      this.settleStatus();
    });
  }

  annotate(requestId: string, cardId: string): boolean {
    const prompt = this.prompts.get(requestId);
    if (!prompt) return false;
    prompt.request.cardId = cardId;
    return true;
  }

  answer(requestId: string, answer: SdkPermissionAnswer): boolean {
    const prompt = this.prompts.get(requestId);
    if (!prompt) return false;
    this.prompts.delete(requestId);
    this.emit("permission_settled", requestId, "answer");
    prompt.resolve(grokOptionFor(answer, prompt.options));
    if (!this.prompts.size) this.report({ status: "working" });
    this.settleStatus();
    return true;
  }

  private abortPrompts(): void {
    for (const [id, prompt] of this.prompts) {
      this.prompts.delete(id);
      this.emit("permission_settled", id, "abort");
      prompt.resolve(null);
    }
  }

  /**
   * Queue a user message. Grok runs a prompt sent during a turn as the next
   * turn, so a message never interrupts the one running.
   */
  send(text: string, images: SdkImage[] = [], uuid: string = crypto.randomUUID()): string {
    if (this.ended || this.stopping) throw new Error("Grok session has stopped");
    if (this.outstanding === 0 && !this.prompts.size) this.report({ status: "thinking" });
    this.outstanding++;
    this._lastError = null;
    this.settleStatus();
    void this.client.prompt({ sessionId: this._grokSessionId, text, images }).then(
      (r) => this.turnEnded(r.stopReason === "refusal" ? { subtype: r.stopReason, isError: true, text: null, error: { kind: "refusal", message: r.text || "Grok refused the request.", at: Date.now() } } : { subtype: r.stopReason, isError: false, text: r.text, error: null }),
      (err) => {
        const error = grokTurnError(err);
        this._lastError = error;
        this.turnEnded({ subtype: "error", isError: true, text: null, error });
      },
    );
    return uuid;
  }

  private turnEnded(result: { subtype: string; isError: boolean; text: string | null; error: SdkTurnError | null }): void {
    this.outstanding = Math.max(0, this.outstanding - 1);
    if (this.outstanding === 0) {
      for (const w of this.drainWaiters.splice(0)) w();
      this.report({ status: "idle", turnCompletedAt: Math.floor(Date.now() / 1000) });
    }
    this.emit("result", result);
    this.settleStatus();
  }

  /** Cancel the running turn and wait until grok has ended it. Prompts queued behind it are cancelled too. */
  async interrupt(): Promise<void> {
    if (this.ended || this.outstanding === 0) return;
    const drained = new Promise<void>((resolve) => this.drainWaiters.push(resolve));
    this.abortPrompts();
    this.client.cancel(this._grokSessionId);
    await Promise.race([drained, new Promise((r) => setTimeout(r, 30_000))]);
  }

  async setModel(model: string | null): Promise<void> {
    if (model) await this.client.setConfigOption(this._grokSessionId, "model", model);
  }

  /** Reloading a running session with new `_meta` is how grok changes its permission mode. */
  async setPermissionMode(mode: string): Promise<void> {
    await this.client.sessionLoad({ sessionId: this._grokSessionId, cwd: this.cwd, meta: permissionMeta(mode) });
    this.permissionMode = mode;
    if (this._init) {
      this._init = { ...this._init, permissionMode: mode };
      this.emit("init", this._init);
    }
    if (this._activity) this.report({ status: this._activity.status, ...(this._activity.message && { message: this._activity.message }) });
  }

  private end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.abortPrompts();
    this.outstanding = 0;
    for (const w of this.drainWaiters.splice(0)) w();
    this.setStatus("stopped");
    this.emit("exit", reason);
  }

  /** End the session: cancel a running turn, then stop grok. */
  stop(): Promise<void> {
    if (!this.stopping) {
      this.stopping = (async () => {
        if (this.outstanding > 0 && !this.ended) await Promise.race([this.interrupt(), new Promise((r) => setTimeout(r, 10_000))]).catch(() => {});
        const exited = new Promise<void>((resolve) => { if (this.ended) resolve(); else this.once("exit", () => resolve()); });
        this.client.stop();
        await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
        this.end("stopped");
      })();
    }
    return this.stopping;
  }
}
