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
import { stopLaunchdJob } from "../launchdJob.js";
import { attachSdkHost, cleanupDeadHost, hostProcessAlive, launchSdkHost, readHostState, type SdkHostClient } from "./client.js";
import type { SdkLaunchSpec } from "./options.js";
import { sdkHostDir, writeFileAtomic } from "./paths.js";
import { askAnswerFromPoll, AUTO_ALLOW_TOOLS, planAnswerFromPoll, QUESTION_TOOLS } from "./pollAnswer.js";
import type { SdkActivity, SdkImage, SdkPermissionAnswer, SdkPermissionRequest, SdkTurnError } from "./protocol.js";
import { parsePollMessage } from "../pollMessage.js";
import type { LivenessVerdict } from "@codecast/shared/contracts";

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
  /** The host is gone: Claude exited, or the host died. The binding stays, so the next delivery resumes. `abandonedCards` are cards it left open that nothing can answer now. */
  stopped: (conversationId: string, sessionId: string, reason: string, abandonedCards?: string[]) => void;
  /**
   * The account a resume runs on: the server's answer (after a usage limit it re-points a
   * conversation at the account this device continues on), else the one the session started on.
   */
  resumeAccount: (conversationId: string, saved: string | undefined) => Promise<string | undefined>;
  /** May this conversation's session come back in a new host now (the resume gate: lifecycle, owner)? */
  mayResume: (conversationId: string, sessionId: string, userInitiated: boolean) => Promise<boolean>;
  /**
   * The model and effort a resume continues with, read from the transcript as the tmux resume reads
   * them (a `/model` or effort change made mid-session lives there, not in the start's argv).
   * Each as `["--model", "x"]`, empty when the transcript names none.
   */
  resumeModelEffort: (sessionId: string, cwd: string) => { model: string[]; effort: string[] };
  /** Has Claude written a transcript for this session? A session nobody typed into has none, and starts fresh. */
  transcriptExists: (sessionId: string, cwd: string) => boolean;
  /** Does the session's transcript already hold this prompt, written since `since` (ms)? Guards a resend of a message already sent. */
  transcriptHas: (sessionId: string, text: string, since: number) => Promise<boolean>;
  /** Claude moved to a new session in the same host (a /clear): the conversation now follows `next`. */
  sessionChanged: (conversationId: string, previous: string, next: string) => void;
  /** Claude Code is older than the backend needs; the daemon falls back to tmux. */
  tooOld: (conversationId: string, sessionId: string, version: string | null, minimum: string) => void;
}

interface Binding {
  /** The Claude session the conversation is in now, and the one a new host resumes. */
  sessionId: string;
  /** The session the running host was started for: its socket and state files carry this id. */
  hostId: string;
  /**
   * When each recent message was first sent, by message id. A host acknowledges a send once it is in
   * its own queue, before Claude has taken it, so a message the daemon retries (a host that died, a
   * row the server put back) is sent again only when the transcript does not hold it.
   */
  sentAt?: Record<string, number>;
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

/**
 * An image the API takes inline: 5 MB once base64-encoded. A bigger one (a phone photo) or a type
 * it does not take (HEIC) rides its tag alone, as on tmux, and Claude's Read tool opens and resizes it.
 */
const MAX_INLINE_IMAGE_BYTES = 3_500_000;

/** The images a message's tags name, read for the SDK. The text keeps the tags, as the tmux paste does. */
export function imagesFromTags(text: string, read: (p: string) => Buffer = (p) => fs.readFileSync(p)): SdkImage[] {
  const out: SdkImage[] = [];
  for (const m of text.matchAll(IMAGE_TAG)) {
    const mediaType = MEDIA_TYPES[path.extname(m[1]).toLowerCase()];
    if (!mediaType) continue;
    try {
      const bytes = read(m[1]);
      if (bytes.length <= MAX_INLINE_IMAGE_BYTES) out.push({ mediaType, data: bytes.toString("base64") });
    } catch {}
  }
  return out;
}

/** `args` with `flag`'s occurrences replaced by `replacement` (a flag and its value); unchanged when it is empty. */
export function withFlags(args: string[], flag: string, replacement: string[]): string[] {
  if (!replacement.length) return args;
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) { i++; continue; }
    if (args[i].startsWith(`${flag}=`)) continue;
    out.push(args[i]);
  }
  return [...out, ...replacement];
}

/** Resolves true once the host's Claude answered initialize, false if the host stops or `ms` pass first. */
function initialized(client: SdkHostClient, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const settle = (v: boolean) => {
      clearTimeout(timer);
      client.off("state", check);
      client.off("gone", check);
      resolve(v);
    };
    const check = () => {
      if (client.gone || client.state?.status === "stopped") settle(false);
      else if (client.state?.init) settle(true);
    };
    const timer = setTimeout(() => settle(false), ms);
    client.on("state", check);
    client.on("gone", check);
    check();
  });
}

export class ClaudeSdkBackend {
  private readonly bindings = new Map<string, Binding>();
  private readonly live = new Map<string, Live>();
  /** Each conversation's start, attach, resume and stop run one at a time, in order. */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Conversations whose start is queued or running: the SDK owns them before their binding exists. */
  private readonly starting = new Set<string>();
  private readonly registry: string;

  constructor(private readonly deps: ClaudeSdkBackendDeps, private readonly dir: string = sdkHostDir(), private readonly launchOpts: { noLaunchd?: boolean; startTimeoutMs?: number; initTimeoutMs?: number } = {}) {
    this.registry = path.join(dir, "conversations.json");
    try {
      const saved = JSON.parse(fs.readFileSync(this.registry, "utf-8")) as Record<string, Binding>;
      for (const [conv, b] of Object.entries(saved)) if (b?.sessionId && b.spec) this.bindings.set(conv, { ...b, hostId: b.hostId ?? b.sessionId });
    } catch {}
  }

  private save(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(this.registry, JSON.stringify(Object.fromEntries(this.bindings)));
  }

  /** Does this conversation run on the SDK backend? */
  owns(conversationId: string): boolean {
    return this.bindings.has(conversationId) || this.starting.has(conversationId);
  }

  /** The conversation an SDK session belongs to. */
  conversationForSession(sessionId: string): string | undefined {
    for (const [conv, b] of this.bindings) if (b.sessionId === sessionId) return conv;
    return undefined;
  }

  specFor(conversationId: string): SdkLaunchSpec | undefined {
    return this.bindings.get(conversationId)?.spec;
  }

  /** The mode the running session last reported. */
  permissionModeFor(conversationId: string): string | null {
    return this.live.get(conversationId)?.client.state?.init?.permissionMode ?? null;
  }

  sessionFor(conversationId: string): string | undefined {
    return this.bindings.get(conversationId)?.sessionId;
  }

  isRunning(conversationId: string): boolean {
    const l = this.live.get(conversationId);
    return !!l && !l.client.gone;
  }

  /**
   * Is the conversation's host process there? A start, attach or resume in
   * progress cannot answer yet. A host pid is definitive, unlike a pane probe:
   * no state file, or a pid that is gone, is an observed exit.
   */
  async hostVerdict(conversationId: string): Promise<LivenessVerdict> {
    if (this.isRunning(conversationId)) return "live";
    if (this.locks.has(conversationId) || this.starting.has(conversationId)) return "unverifiable";
    const b = this.bindings.get(conversationId);
    if (!b) return "exited";
    const state = readHostState(b.hostId, this.dir);
    return state && await hostProcessAlive(state.pid) ? "live" : "exited";
  }

  /**
   * Run `fn` after every earlier start, attach, resume or stop of this
   * conversation has finished. A delivery that arrives while a host boots
   * then waits for that host instead of reading its missing state file as a
   * dead host, and a start never races a resume into two hosts.
   */
  private withLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(conversationId) ?? Promise.resolve()).catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    this.locks.set(conversationId, tail);
    void tail.then(() => { if (this.locks.get(conversationId) === tail) this.locks.delete(conversationId); });
    return run;
  }

  /** Start a fresh or resumed session for a conversation, replacing any host it had. */
  start(conversationId: string, spec: SdkLaunchSpec, account?: string): Promise<SdkHostClient> {
    this.starting.add(conversationId);
    return this.withLock(conversationId, async () => {
      await this.stopHost(conversationId);
      this.bindings.set(conversationId, { sessionId: spec.sessionId, hostId: spec.sessionId, spec, account, sentAt: {} });
      this.save();
      try {
        return await this.launch(conversationId, spec, account);
      } catch (err) {
        // A start that did not come up leaves nothing behind for a queued delivery to resume.
        this.forget(conversationId);
        throw err;
      }
    }).finally(() => this.starting.delete(conversationId));
  }

  private async launch(conversationId: string, spec: SdkLaunchSpec, account?: string): Promise<SdkHostClient> {
    const client = await launchSdkHost(spec, { castArgv: this.deps.castArgv(), shellPrefix: this.deps.shellPrefix(account), dir: this.dir, log: this.deps.log, noLaunchd: this.launchOpts.noLaunchd, startTimeoutMs: this.launchOpts.startTimeoutMs });
    this.adopt(conversationId, client);
    // Up means Claude answered initialize. A Claude that never does (a stuck MCP server, a login
    // wait) is a failed start, so the caller falls back to tmux or retries, instead of every
    // delivery waiting on it forever.
    const ready = await initialized(client, this.launchOpts.initTimeoutMs ?? 180_000);
    if (!ready) {
      await this.stopHost(conversationId);
      throw new Error("Claude Code did not finish starting in its SDK host");
    }
    return client;
  }

  /** Wire a connected host's events into the daemon. */
  private adopt(conversationId: string, client: SdkHostClient): void {
    // Read at each event: a /clear moves the conversation to a new session mid-host.
    const current = () => this.bindings.get(conversationId)?.sessionId ?? client.sessionId;
    const follow = (claudeSessionId: string) => {
      const b = this.bindings.get(conversationId);
      if (!b || b.sessionId === claudeSessionId) return;
      this.bindings.set(conversationId, { ...b, sessionId: claudeSessionId, spec: { ...b.spec, sessionId: claudeSessionId } });
      this.save();
      this.deps.log(`[claude-sdk] ${conversationId.slice(0, 12)} moved from ${b.sessionId.slice(0, 8)} to ${claudeSessionId.slice(0, 8)}`);
      this.deps.sessionChanged(conversationId, b.sessionId, claudeSessionId);
    };
    client.on("session", follow);
    client.on("state", (st) => { if (st.claudeSessionId) follow(st.claudeSessionId); });
    const prompts = new Map<string, AbortController>();
    const previous = this.live.get(conversationId);
    if (previous && previous.client !== client) previous.client.close();
    this.live.set(conversationId, { client, prompts });
    const openPrompt = (request: SdkPermissionRequest) => {
      if (QUESTION_TOOLS.has(request.toolName) || prompts.has(request.requestId)) return;
      if (AUTO_ALLOW_TOOLS.has(request.toolName)) {
        prompts.set(request.requestId, new AbortController());
        void client.answer(request.requestId, { behavior: "allow" });
        return;
      }
      const settled = new AbortController();
      prompts.set(request.requestId, settled);
      const opened = (cardId: string) => void client.annotate(request.requestId, cardId);
      void this.deps.permission(conversationId, current(), request, settled.signal, opened).then(async (answer) => {
        if (settled.signal.aborted || client.gone) return;
        // No card and no answer: the session has no terminal dialog to fall back on, so it must not wait forever.
        const final = answer ?? { behavior: "deny" as const, message: "codecast could not show this permission request; ask again or do it another way." };
        const r = await client.answer(request.requestId, final);
        if (!r.ok) this.deps.log(`[claude-sdk] answer for ${request.toolName} ${request.requestId.slice(0, 8)} not taken: ${r.error}`);
      }).catch((err) => this.deps.log(`[claude-sdk] permission card failed: ${(err as Error).message}`));
    };
    client.on("activity", (a) => this.deps.activity(conversationId, current(), a, this.bindings.get(conversationId)?.spec.env.CODECAST_LAUNCH_TOKEN));
    client.on("permission", openPrompt);
    // A prompt that ended without its card (the turn was interrupted, Claude moved on) closes the card.
    client.on("permission_settled", (requestId, by) => {
      if (by === "abort") prompts.get(requestId)?.abort();
      prompts.delete(requestId);
    });
    client.on("result", (r) => {
      if (r.isError && r.error) this.deps.turnError(conversationId, current(), r.error);
    });
    client.on("too_old", (version, minimum) => {
      this.deps.log(`[claude-sdk] Claude Code ${version ?? "?"} is older than ${minimum}; ${conversationId.slice(0, 12)} falls back to tmux`);
      const sessionId = current();
      void this.stop(conversationId, { forget: true });
      this.deps.tooOld(conversationId, sessionId, version, minimum);
    });
    client.on("gone", (reason) => {
      for (const c of prompts.values()) c.abort();
      prompts.clear();
      if (this.live.get(conversationId)?.client === client) this.live.delete(conversationId);
      this.deps.log(`[claude-sdk] host for ${conversationId.slice(0, 12)} (${current().slice(0, 8)}) gone: ${reason}`);
      this.deps.stopped(conversationId, current(), reason);
    });
    // A reattached host may hold prompts a previous daemon opened cards for; its state lists them.
    const replay = () => { for (const request of client.state?.pending ?? []) openPrompt(request); };
    replay();
    client.on("state", replay);
  }

  /** The running host for a conversation: the live one, a host a previous daemon started, or a resumed one. */
  async ensure(conversationId: string, opts: { userInitiated?: boolean } = {}): Promise<SdkHostClient | null> {
    const l = this.live.get(conversationId);
    if (l && !l.client.gone && !this.locks.has(conversationId)) return l.client;
    return this.withLock(conversationId, async () => {
      const current = this.live.get(conversationId);
      if (current && !current.client.gone) return current.client;
      const binding = this.bindings.get(conversationId);
      if (!binding) return null;
      const attached = await attachSdkHost(binding.hostId, this.dir);
      if (attached) {
        this.adopt(conversationId, attached);
        // What happened while no daemon listened (a turn ended, a prompt opened) is in the host's
        // snapshot, not in a frame: report it once, so the session is filed where it stands.
        const activity = attached.state?.activity;
        if (activity) this.deps.activity(conversationId, this.bindings.get(conversationId)?.sessionId ?? attached.sessionId, activity, binding.spec.env.CODECAST_LAUNCH_TOKEN);
        return attached;
      }
      // Decided here, under the lock, so a message that queued behind a kill cannot bring the session back.
      if (!await this.deps.mayResume(conversationId, binding.sessionId, !!opts.userInitiated)) {
        throw new Error(`the Claude SDK session for ${conversationId} may not be resumed now`);
      }
      cleanupDeadHost(binding.hostId, this.dir);
      const resume = this.deps.transcriptExists(binding.sessionId, binding.spec.cwd);
      this.deps.log(`[claude-sdk] ${resume ? "resuming" : "starting"} ${binding.sessionId.slice(0, 8)} for ${conversationId.slice(0, 12)} in a new host`);
      let args = binding.spec.args;
      if (resume) {
        const { model, effort } = this.deps.resumeModelEffort(binding.sessionId, binding.spec.cwd);
        args = withFlags(args, "--model", model);
        args = withFlags(args, "--effort", effort);
      }
      const spec = { ...binding.spec, args, sessionId: binding.sessionId, resume };
      const account = await this.deps.resumeAccount(conversationId, binding.account);
      this.bindings.set(conversationId, { ...binding, hostId: spec.sessionId, spec, account });
      this.save();
      return this.launch(conversationId, spec, account);
    });
  }

  /**
   * Deliver a message. A poll answer goes to the question Claude is blocked on;
   * prose sent while a question is open answers it in the person's words, as
   * typing at the terminal does. Anything else is a user turn (priority "next"
   * while a turn runs). Throws when the host cannot take it, so the daemon retries.
   */
  async deliver(conversationId: string, messageId: string, text: string): Promise<"sent" | "answered" | "dropped"> {
    const client = await this.ensure(conversationId);
    if (!client) throw new Error(`no Claude SDK session for ${conversationId}`);
    const question = client.state?.pending.find((p) => QUESTION_TOOLS.has(p.toolName));
    const poll = parsePollMessage(text);
    if (question) {
      // Prose instead of an answer closes the question, as typing at the terminal does, and then goes
      // in as the person's own message, so the transcript holds it and the pending row is acknowledged.
      const answer = poll
        ? question.toolName === "AskUserQuestion" ? askAnswerFromPoll(question.input, poll) : planAnswerFromPoll(poll, question.modeBeforePlan)
        : { behavior: "deny" as const, message: "The user replied in chat instead of answering; their message follows." };
      // A pick that names nothing on this question (a stray Enter, the menu's own "type something"
      // row) dismisses it: left open, Claude would wait on it forever.
      const typed = (poll?.text ?? "").trim();
      const final = answer ?? (poll
        ? typed
          ? { behavior: "deny" as const, message: `The user answered in their own words instead of picking an option: ${typed}` }
          : { behavior: "deny" as const, message: "The user dismissed the question without picking an option." }
        : null);
      if (final) {
        const r = await client.answer(question.requestId, final);
        if (r.ok && poll) return "answered";
        if (!r.ok) this.deps.log(`[claude-sdk] ${question.toolName} answer not taken: ${r.error}`);
      }
    }
    // A poll answer for a question that is no longer open delivers its prose, never its keys.
    const body = poll ? (poll.text ?? "").trim() : text;
    if (!body) {
      this.deps.log(`[claude-sdk] dropped a stale menu answer for ${conversationId.slice(0, 12)}`);
      return "dropped";
    }
    // Kept in the binding, so the guard outlives a daemon restart as well as a host death.
    const sentAt = { ...(this.bindings.get(conversationId)?.sentAt ?? {}) };
    const triedAt = sentAt[messageId];
    if (triedAt !== undefined && await this.deps.transcriptHas(this.bindings.get(conversationId)?.sessionId ?? client.sessionId, body, triedAt)) {
      this.setSentAt(conversationId, messageId, undefined);
      this.deps.log(`[claude-sdk] msg ${messageId.slice(0, 8)} already reached Claude; not sending it again`);
      return "sent";
    }
    if (triedAt === undefined) this.setSentAt(conversationId, messageId, Date.now());
    const r = await client.send(messageId, body, imagesFromTags(body));
    if (!r.ok) throw new Error(`Claude SDK host refused the message: ${r.error}`);
    return "sent";
  }

  private setSentAt(conversationId: string, messageId: string, at: number | undefined): void {
    const b = this.bindings.get(conversationId);
    if (!b) return;
    const sentAt = { ...(b.sentAt ?? {}) };
    if (at === undefined) delete sentAt[messageId];
    else sentAt[messageId] = at;
    const ids = Object.keys(sentAt);
    if (ids.length > 50) delete sentAt[ids[0]];
    this.bindings.set(conversationId, { ...b, sentAt });
    this.save();
  }

  /** Change the running session's model. False when no host runs it. */
  async setModel(conversationId: string, model: string | null): Promise<boolean> {
    const l = this.live.get(conversationId);
    return !!l && !l.client.gone && (await l.client.setModel(model)).ok;
  }

  /** Change the running session's permission mode. False when no host runs it. */
  async setPermissionMode(conversationId: string, mode: string): Promise<boolean> {
    const l = this.live.get(conversationId);
    return !!l && !l.client.gone && (await l.client.setPermissionMode(mode)).ok;
  }

  /** Interrupt the running turn and wait for it to drain. False when nothing ran here. */
  async interrupt(conversationId: string): Promise<boolean> {
    const l = this.live.get(conversationId);
    if (!l || l.client.gone) return false;
    const r = await l.client.interrupt();
    return r.ok;
  }

  /** Stop the conversation's host. `forget` also drops the binding (a kill, an agent switch). */
  stop(conversationId: string, opts: { forget: boolean }): Promise<boolean> {
    return this.withLock(conversationId, async () => {
      const stopped = await this.stopHost(conversationId);
      if (opts.forget) this.forget(conversationId);
      return stopped;
    });
  }

  /**
   * Stop the conversation's host and wait until its process is gone, so a
   * host started next (with the same session id and files, maybe) never
   * shares them with the old one. A host that does not take the stop request
   * is signalled, then killed.
   */
  private async stopHost(conversationId: string): Promise<boolean> {
    const l = this.live.get(conversationId);
    const hostId = this.bindings.get(conversationId)?.hostId;
    const hostState = hostId ? readHostState(hostId, this.dir) : null;
    const pid = hostState?.pid;
    const alive = async () => !!pid && await hostProcessAlive(pid);
    let asked = false;
    if (l && !l.client.gone) asked = (await l.client.stop()).ok;
    const waitGone = async (ms: number) => {
      const deadline = Date.now() + ms;
      while (await alive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
    };
    if (asked) await waitGone(15_000);
    if (await alive()) {
      try { process.kill(pid!, "SIGTERM"); } catch {}
      await waitGone(10_000);
      if (await alive()) try { process.kill(pid!, "SIGKILL"); } catch {}
      await waitGone(2_000);
      // A host killed outright never unloaded its own job.
      if (hostState?.launchdLabel) stopLaunchdJob(hostState.launchdLabel);
    }
    l?.client.close();
    this.live.delete(conversationId);
    return asked || !!pid;
  }

  private forget(conversationId: string): void {
    const b = this.bindings.get(conversationId);
    if (!b) return;
    this.bindings.delete(conversationId);
    this.save();
    // Once nothing will resume it, nothing reads its files either. A host told to stop takes a moment to go.
    const sweep = async () => {
      const state = readHostState(b.hostId, this.dir);
      if (state && await hostProcessAlive(state.pid)) return false;
      cleanupDeadHost(b.hostId, this.dir, true);
      return true;
    };
    void sweep().then((done) => { if (!done) setTimeout(() => void sweep(), 5_000).unref?.(); });
  }

  /** Reattach every host a previous daemon left running. Hosts that died stay bound and resume on demand. */
  async reattachAll(): Promise<string[]> {
    const attached: string[] = [];
    for (const [conv, b] of this.bindings) {
      const state = readHostState(b.hostId, this.dir);
      if (!state || !(await hostProcessAlive(state.pid))) {
        // Died while no daemon listened: say so now (nothing else will), and close the cards it left.
        // What it reported last goes first, as a live attach replays it: a turn
        // that ended before the host died must read as ended.
        if (state?.activity) this.deps.activity(conv, b.sessionId, state.activity, b.spec.env.CODECAST_LAUNCH_TOKEN);
        if (state) this.deps.stopped(conv, b.sessionId, "host not running when the daemon started", state.pending.map((p) => p.cardId).filter((id): id is string => !!id));
        continue;
      }
      // Through ensure, so a delivery racing the reattach shares this attach instead of adopting a second client.
      const client = await this.ensure(conv).catch((err) => {
        this.deps.log(`[claude-sdk] reattach of ${conv.slice(0, 12)} failed: ${(err as Error).message}`);
        this.retryAttach(conv, 15_000);
        return null;
      });
      if (client) attached.push(conv);
    }
    return attached;
  }

  /** A live host that did not answer the reattach (a loaded machine) is asked again, with backoff, while its process lives. */
  private retryAttach(conversationId: string, delayMs: number): void {
    setTimeout(() => {
      void (async () => {
        const b = this.bindings.get(conversationId);
        if (!b || this.isRunning(conversationId)) return;
        const state = readHostState(b.hostId, this.dir);
        if (!state || !(await hostProcessAlive(state.pid))) return;
        await this.ensure(conversationId).catch(() => this.retryAttach(conversationId, Math.min(delayMs * 2, 5 * 60_000)));
      })();
    }, delayMs).unref?.();
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
