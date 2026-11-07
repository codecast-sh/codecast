// The daemon's Claude SDK backend: which conversations run through an SDK host
// instead of a tmux pane, and the five things the daemon asks of one (start,
// deliver, interrupt, stop, reattach). daemon.ts owns everything codecast-wide
// (the status sink, the permission card pipeline, server writes) and passes it
// in as deps, so this module only knows hosts.
//
// One home per fact: the conversation → session binding and the launch spec
// live in conversations.json beside the hosts' own files, so a daemon that
// restarts knows an SDK conversation even when its host has died, and resumes
// it on the next delivery instead of starting a tmux pane.

import * as fs from "node:fs";
import * as path from "node:path";
import { attachSdkHost, cleanupDeadHost, launchSdkHost, pidAlive, readHostState, type SdkHostClient } from "./client.js";
import type { SdkLaunchSpec } from "./options.js";
import { sdkHostDir, writeFileAtomic } from "./paths.js";
import { askAnswerFromPoll, planAnswerFromPoll, QUESTION_TOOLS } from "./pollAnswer.js";
import type { SdkActivity, SdkImage, SdkPermissionAnswer, SdkPermissionRequest, SdkTurnError } from "./protocol.js";
import { parsePollMessage } from "../pollMessage.js";

export interface ClaudeSdkBackendDeps {
  log: (line: string) => void;
  /** argv that runs cast itself (resolveCastInvocation). */
  castArgv: () => string[];
  /** The account and provider-key prefix a tmux launch line would start with. */
  shellPrefix: (account: string | undefined) => string;
  /** What the status hook would have posted. */
  activity: (conversationId: string, sessionId: string, activity: SdkActivity, launchToken: string | undefined) => void;
  /**
   * Open the web card for a permission prompt (or bind to `request.cardId`, the
   * card a previous daemon opened) and resolve with the person's answer, or null
   * when the wait ends unanswered. `settled` aborts when the prompt ends without
   * the card; `opened` records the card's id on the host.
   */
  permission: (conversationId: string, sessionId: string, request: SdkPermissionRequest, settled: AbortSignal, opened: (cardId: string) => void) => Promise<SdkPermissionAnswer | null>;
  turnError: (conversationId: string, sessionId: string, error: SdkTurnError) => void;
  /** The host is gone: Claude exited, or the host died. The binding stays, so the next delivery resumes. */
  stopped: (conversationId: string, sessionId: string, reason: string) => void;
  /** Claude Code is older than the backend needs; the daemon falls back to tmux. */
  tooOld: (conversationId: string, sessionId: string, version: string | null, minimum: string) => void;
}

interface Binding {
  sessionId: string;
  spec: SdkLaunchSpec;
  account?: string;
}

interface Live {
  client: SdkHostClient;
  prompts: Map<string, AbortController>;
}

/** Image tags the daemon writes into a message for each attachment it downloaded: `[Image /path]`. */
const IMAGE_TAG = /\[Image (\/[^\]\s]+)\]/g;
const MEDIA_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

/** The images a message's tags name, read for the SDK. The text keeps the tags, as the tmux paste does. */
export function imagesFromTags(text: string, read: (p: string) => Buffer = (p) => fs.readFileSync(p)): SdkImage[] {
  const out: SdkImage[] = [];
  for (const m of text.matchAll(IMAGE_TAG)) {
    const mediaType = MEDIA_TYPES[path.extname(m[1]).toLowerCase()];
    if (!mediaType) continue;
    try {
      out.push({ mediaType, data: read(m[1]).toString("base64") });
    } catch {}
  }
  return out;
}

export class ClaudeSdkBackend {
  private readonly bindings = new Map<string, Binding>();
  private readonly live = new Map<string, Live>();
  private readonly starting = new Map<string, Promise<SdkHostClient | null>>();
  private readonly registry: string;

  constructor(private readonly deps: ClaudeSdkBackendDeps, private readonly dir: string = sdkHostDir(), private readonly launchOpts: { noLaunchd?: boolean } = {}) {
    this.registry = path.join(dir, "conversations.json");
    try {
      const saved = JSON.parse(fs.readFileSync(this.registry, "utf-8")) as Record<string, Binding>;
      for (const [conv, b] of Object.entries(saved)) if (b?.sessionId && b.spec) this.bindings.set(conv, b);
    } catch {}
  }

  private save(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(this.registry, JSON.stringify(Object.fromEntries(this.bindings)));
  }

  /** Does this conversation run on the SDK backend? */
  owns(conversationId: string): boolean {
    return this.bindings.has(conversationId);
  }

  /** The conversation an SDK session belongs to. */
  conversationForSession(sessionId: string): string | undefined {
    for (const [conv, b] of this.bindings) if (b.sessionId === sessionId) return conv;
    return undefined;
  }

  specFor(conversationId: string): SdkLaunchSpec | undefined {
    return this.bindings.get(conversationId)?.spec;
  }

  sessionFor(conversationId: string): string | undefined {
    return this.bindings.get(conversationId)?.sessionId;
  }

  isRunning(conversationId: string): boolean {
    const l = this.live.get(conversationId);
    return !!l && !l.client.gone;
  }

  /** Start a fresh or resumed session for a conversation, replacing any host it had. */
  async start(conversationId: string, spec: SdkLaunchSpec, account?: string): Promise<SdkHostClient> {
    await this.stop(conversationId, { forget: false });
    this.bindings.set(conversationId, { sessionId: spec.sessionId, spec, account });
    this.save();
    const client = await this.launch(conversationId, spec, account);
    return client;
  }

  private async launch(conversationId: string, spec: SdkLaunchSpec, account?: string): Promise<SdkHostClient> {
    const client = await launchSdkHost(spec, { castArgv: this.deps.castArgv(), shellPrefix: this.deps.shellPrefix(account), dir: this.dir, log: this.deps.log, noLaunchd: this.launchOpts.noLaunchd });
    this.adopt(conversationId, client);
    return client;
  }

  /** Wire a connected host's events into the daemon. */
  private adopt(conversationId: string, client: SdkHostClient): void {
    const sessionId = client.sessionId;
    const prompts = new Map<string, AbortController>();
    this.live.set(conversationId, { client, prompts });
    const openPrompt = (request: SdkPermissionRequest) => {
      if (QUESTION_TOOLS.has(request.toolName) || prompts.has(request.requestId)) return;
      const settled = new AbortController();
      prompts.set(request.requestId, settled);
      const opened = (cardId: string) => void client.annotate(request.requestId, cardId);
      void this.deps.permission(conversationId, sessionId, request, settled.signal, opened).then(async (answer) => {
        if (!answer || settled.signal.aborted) return;
        const r = await client.answer(request.requestId, answer);
        if (!r.ok) this.deps.log(`[claude-sdk] answer for ${request.toolName} ${request.requestId.slice(0, 8)} not taken: ${r.error}`);
      }).catch((err) => this.deps.log(`[claude-sdk] permission card failed: ${(err as Error).message}`));
    };
    client.on("activity", (a) => this.deps.activity(conversationId, sessionId, a, this.bindings.get(conversationId)?.spec.env.CODECAST_LAUNCH_TOKEN));
    client.on("permission", openPrompt);
    // A prompt that ended without its card (the turn was interrupted, Claude moved on) closes the card.
    client.on("permission_settled", (requestId, by) => {
      if (by === "abort") prompts.get(requestId)?.abort();
      prompts.delete(requestId);
    });
    client.on("result", (r) => {
      if (r.isError && r.error) this.deps.turnError(conversationId, sessionId, r.error);
    });
    client.on("too_old", (version, minimum) => {
      this.deps.log(`[claude-sdk] Claude Code ${version ?? "?"} is older than ${minimum}; ${conversationId.slice(0, 12)} falls back to tmux`);
      this.forget(conversationId);
      this.deps.tooOld(conversationId, sessionId, version, minimum);
    });
    client.on("gone", (reason) => {
      for (const c of prompts.values()) c.abort();
      prompts.clear();
      if (this.live.get(conversationId)?.client === client) this.live.delete(conversationId);
      this.deps.log(`[claude-sdk] host for ${conversationId.slice(0, 12)} (${sessionId.slice(0, 8)}) gone: ${reason}`);
      this.deps.stopped(conversationId, sessionId, reason);
    });
    // A reattached host may hold prompts a previous daemon opened cards for; its state lists them.
    const replay = () => { for (const request of client.state?.pending ?? []) openPrompt(request); };
    replay();
    client.on("state", replay);
  }

  /** The running host for a conversation: the live one, a host a previous daemon started, or a resumed one. */
  async ensure(conversationId: string): Promise<SdkHostClient | null> {
    const l = this.live.get(conversationId);
    if (l && !l.client.gone) return l.client;
    const binding = this.bindings.get(conversationId);
    if (!binding) return null;
    const inFlight = this.starting.get(conversationId);
    if (inFlight) return inFlight;
    const p = (async () => {
      const attached = await attachSdkHost(binding.sessionId, this.dir);
      if (attached) {
        this.adopt(conversationId, attached);
        return attached;
      }
      cleanupDeadHost(binding.sessionId, this.dir);
      this.deps.log(`[claude-sdk] resuming ${binding.sessionId.slice(0, 8)} for ${conversationId.slice(0, 12)} in a new host`);
      const spec = { ...binding.spec, resume: true };
      this.bindings.set(conversationId, { ...binding, spec });
      this.save();
      return this.launch(conversationId, spec, binding.account);
    })().finally(() => this.starting.delete(conversationId));
    this.starting.set(conversationId, p);
    return p;
  }

  /**
   * Deliver a message. A poll answer goes to the question Claude is blocked on;
   * prose sent while a question is open answers it in the person's words, as
   * typing at the terminal does. Anything else is a user turn (priority "next"
   * while a turn runs). Throws when the host cannot take it, so the daemon retries.
   */
  async deliver(conversationId: string, messageId: string, text: string): Promise<void> {
    const client = await this.ensure(conversationId);
    if (!client) throw new Error(`no Claude SDK session for ${conversationId}`);
    const question = client.state?.pending.find((p) => QUESTION_TOOLS.has(p.toolName));
    const poll = parsePollMessage(text);
    if (question) {
      const answer = poll
        ? question.toolName === "AskUserQuestion" ? askAnswerFromPoll(question.input, poll) : planAnswerFromPoll(poll)
        : { behavior: "deny" as const, message: `The user replied in chat instead of answering: ${text}` };
      if (answer) {
        const r = await client.answer(question.requestId, answer);
        if (r.ok) return;
        this.deps.log(`[claude-sdk] ${question.toolName} answer not taken: ${r.error}`);
      }
    }
    // A poll answer for a question that is no longer open delivers its prose, never its keys.
    const body = poll ? (poll.text ?? "").trim() : text;
    if (!body) {
      this.deps.log(`[claude-sdk] dropped a stale menu answer for ${conversationId.slice(0, 12)}`);
      return;
    }
    const r = await client.send(messageId, body, imagesFromTags(body));
    if (!r.ok) throw new Error(`Claude SDK host refused the message: ${r.error}`);
  }

  /** Interrupt the running turn and wait for it to drain. False when nothing ran here. */
  async interrupt(conversationId: string): Promise<boolean> {
    const l = this.live.get(conversationId);
    if (!l || l.client.gone) return false;
    const r = await l.client.interrupt();
    return r.ok;
  }

  /** Stop the conversation's host. `forget` also drops the binding (a kill, an agent switch). */
  async stop(conversationId: string, opts: { forget: boolean }): Promise<boolean> {
    const l = this.live.get(conversationId);
    let stopped = false;
    if (l && !l.client.gone) {
      await l.client.stop();
      stopped = true;
    } else {
      const sid = this.bindings.get(conversationId)?.sessionId;
      const state = sid ? readHostState(sid, this.dir) : null;
      if (state && pidAlive(state.pid)) {
        try { process.kill(state.pid, "SIGTERM"); stopped = true; } catch {}
      }
    }
    l?.client.close();
    this.live.delete(conversationId);
    if (opts.forget) this.forget(conversationId);
    return stopped;
  }

  private forget(conversationId: string): void {
    if (!this.bindings.delete(conversationId)) return;
    this.save();
  }

  /** Reattach every host a previous daemon left running. Hosts that died stay bound and resume on demand. */
  async reattachAll(): Promise<string[]> {
    const attached: string[] = [];
    for (const [conv, b] of this.bindings) {
      const state = readHostState(b.sessionId, this.dir);
      if (!state || !pidAlive(state.pid)) continue;
      const client = await attachSdkHost(b.sessionId, this.dir);
      if (!client) continue;
      this.adopt(conv, client);
      attached.push(conv);
    }
    return attached;
  }

  /** The daemon is exiting: drop connections, leave hosts running. */
  detachAll(): void {
    for (const l of this.live.values()) l.client.close();
    this.live.clear();
  }

  conversations(): string[] {
    return [...this.bindings.keys()];
  }
}
