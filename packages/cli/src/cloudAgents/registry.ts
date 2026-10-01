/**
 * The daemon's cloud agent providers, one runtime (mirror watcher + sessions)
 * per adapter. The daemon calls these few entry points and never names a
 * provider: the launch path (start), delivery (deliver, which posts the setup
 * card), Escape and teardown (interrupt), the key check (verifyKey), a
 * sign-in based provider's login (checkLogin, startLogin), the account's
 * sync switch (syncTurnedOn), a synced mirror's session (keepSession), the
 * header's actions on the agent (act), what keeps this machine from reading
 * a provider (setupBlocks), and boot (startWatchers).
 */
import { CLIENT_ERROR_BANNER_PREFIX, CLOUD_AGENT_ACTION_SUBTYPE, CLOUD_AGENT_ACTIONS, CLOUD_SESSION_SOURCES, cloudAgentPageUrl, cloudSessionSyncOn, cloudAgentProviderForKey, cloudAgentProviderForLaunch, type CloudAgentActionName, type CloudAgentProviderSpec, type CloudAgentSetupBlock } from "@codecast/shared/contracts";
import { doublingDelay, isCloudMirrorPlaceholder, repoOwnerName } from "./poll.js";
import { applyInCheckout, CloudAgentSessions, cloudSetupErrorOf, judgeCloudFailure, type CloudAgentSessionsDeps } from "./sessions.js";
import { CloudAgentWatcher, type CloudAgentTranscriptEvent, type CloudAgentWatcherOptions } from "./watcher.js";
import { CLOUD_AGENT_ACTION_METHODS, CloudAgentSetupError, CloudAgentUnsentError, errorText, logTag, type AnyCloudAgentAdapter, type CloudAgentGit, type CloudAgentLoginState } from "./types.js";
import type { ProviderKeyVerdict } from "../providerKeyCrypto.js";

export interface CloudAgentRuntime {
  adapter: AnyCloudAgentAdapter;
  sessions: CloudAgentSessions;
  /** Null until startWatchers. */
  readonly watcher: CloudAgentWatcher | null;
}

/**
 * A row codecast adds to a session's thread, under its key: a setup card (the
 * turn-stopped banner) or an action's result (a system note, which neither the
 * work state nor the idle summary reads as the agent speaking).
 */
export interface CloudAgentThreadLine { key: string; role: "assistant" | "system"; content: string; subtype?: string }

export interface CloudAgentRegistryDeps extends Omit<CloudAgentSessionsDeps, "watcher"> {
  /** Add a line codecast says to the session's thread. Never throws. */
  addLine: (conversationId: string, line: CloudAgentThreadLine) => Promise<void>;
  /** Put a message the person wrote on the conversation's delivery rail (pending messages), as the composer does. */
  enqueueMessage: (conversationId: string, content: string) => Promise<void>;
  /**
   * Host a session this daemon runs without a process of its own (register it
   * and heartbeat it): "not_owner" when another live device hosts it,
   * "failed" when the server could not be asked.
   */
  hostSession: (sessionId: string, conversationId: string) => Promise<"hosted" | "not_owner" | "failed">;
  /** Stop hosting it (no heartbeat keeps its last status alive). */
  releaseSession: (sessionId: string) => void;
  /** Move the session to this machine's checkout of its repository; whether it moved. */
  placeSession: (sessionId: string, cwd: string) => Promise<boolean>;
  /** Name the conversation, unless someone renamed it from one of `replaces`; whether it took. */
  retitleSession: (conversationId: string, title: string, replaces: string[]) => Promise<boolean>;
  /** Record whether the session's agent is archived on the provider's site; whether it took. */
  markArchived: (conversationId: string, archived: boolean) => Promise<boolean>;
}

export interface CloudAgentWatchOptions extends Pick<CloudAgentWatcherOptions, "resolveRepoDir" | "log"> {
  /** The account's stored sync setting for a source field (e.g. cursor_cloud_sync), read on every poll; unset means the source's default. */
  syncSetting: (field: string) => boolean | undefined;
  /** Sync a mirrored transcript (every provider's mirror is the one format, transcript.ts), under the provider's agent type. */
  onTranscript: (spec: CloudAgentProviderSpec, event: CloudAgentTranscriptEvent) => void;
  /** The branch an agent pushed. */
  onGit: (git: CloudAgentGit) => void;
}

/** An action's result: what it did, and the page it made (a pull request). */
export interface CloudAgentActionResult { message: string; url?: string }

/** How long a setup card stays posted before a held retry may post it again. */
const SETUP_CARD_MS = 60_000;
/** Another live device hosts the session: asked again after this long. */
const HOST_ELSEWHERE_MS = 10 * 60_000;
/** A registration the server did not answer is retried after this, doubling up to HOST_ELSEWHERE_MS. */
const HOST_RETRY_MS = 30_000;

export class CloudAgentRegistry {
  readonly runtimes: CloudAgentRuntime[];
  private readonly setupCardsPosted = new Map<string, number>();
  /** Tries of each conversation's held message that met a setup problem, until one goes out. */
  private readonly setupHolds = new Map<string, number>();
  /** Each provider's mirror, by provider id, once startWatchers ran. */
  private readonly watchers = new Map<string, CloudAgentWatcher>();
  /** Sessions this run hosts, and when another device's claim was last found. */
  private readonly hosted = new Map<string, "hosted" | number>();
  private readonly hostRetries = new Map<string, NodeJS.Timeout>();
  /** The provider title and the checkout each session last took this run. */
  private readonly titles = new Map<string, string>();
  private readonly archived = new Map<string, boolean>();
  private readonly placements = new Map<string, string>();
  /** This machine's checkout of a repository (startWatchers' resolveRepoDir): where Apply runs. */
  private resolveRepoDir: (repo: { owner: string; name: string }) => Promise<string | null> = async () => null;

  /** `sessionsFile` overrides where each provider keeps its sessions (tests). */
  constructor(adapters: AnyCloudAgentAdapter[], private readonly deps: CloudAgentRegistryDeps, sessionsFile?: (adapter: AnyCloudAgentAdapter) => string) {
    const watchers = this.watchers;
    this.runtimes = adapters.map((adapter) => ({
      adapter,
      sessions: new CloudAgentSessions(adapter, { ...deps, watcher: () => watchers.get(adapter.spec.id) ?? null }, sessionsFile?.(adapter)),
      get watcher() { return watchers.get(adapter.spec.id) ?? null; },
    }));
  }

  /**
   * Start every provider's mirror. Each always runs (sessions started from
   * codecast need their mirror); the account's sync setting decides whether
   * it also imports the account's other agents. Idle without credentials.
   */
  startWatchers(opts: CloudAgentWatchOptions): void {
    if (opts.resolveRepoDir) this.resolveRepoDir = opts.resolveRepoDir;
    for (const runtime of this.runtimes) {
      const { adapter, sessions } = runtime;
      const field = CLOUD_SESSION_SOURCES[adapter.spec.syncSource].field;
      const watcher = new CloudAgentWatcher(adapter, {
        importAll: () => cloudSessionSyncOn(field, opts.syncSetting(field)),
        ownAgents: () => sessions.agentIds(),
        resolveRepoDir: (repo, agentId) => this.checkoutOf(runtime, agentId, repo),
        log: opts.log,
      });
      watcher.on("session", (event) => opts.onTranscript(adapter.spec, event));
      watcher.on("error", (error: Error) => opts.log?.(`${logTag(adapter)} poll failed: ${error.message}`));
      watcher.on("git", opts.onGit);
      watcher.on("unfollowed", (agentId) => this.letGo(agentId));
      this.useWatcher(watcher);
      watcher.start();
    }
  }

  /** The mirror a provider's sessions tell about the agents codecast moves (startWatchers, or a test's unstarted one). */
  useWatcher(watcher: CloudAgentWatcher): void {
    this.watchers.set(watcher.adapter.spec.id, watcher);
  }

  /**
   * This machine's checkout for an agent's repository: the folder codecast
   * started its task in when that is one (the session stays in the checkout
   * the person picked, a worktree say), else the one resolveRepoDir finds.
   * Where the session is placed, and where Apply runs.
   */
  async checkoutOf(runtime: CloudAgentRuntime, agentId: string | undefined, repo: { owner: string; name: string }): Promise<string | null> {
    return (agentId ? await runtime.sessions.startedIn(agentId, repo) : null) ?? await this.resolveRepoDir(repo);
  }

  /** A provider's runtime, by its id. */
  private runtimeOf(providerId: string | undefined): CloudAgentRuntime | undefined {
    return providerId ? this.runtimes.find((r) => r.adapter.spec.id === providerId) : undefined;
  }

  /** The runtime a conversation runs on, if it is a cloud agent session. */
  forConversation(conversationId: string): CloudAgentRuntime | undefined {
    return this.runtimes.find((r) => r.sessions.get(conversationId));
  }

  /**
   * A launch whose model key picks a cloud agent: record the conversation;
   * its first delivered message creates the agent. A prompt given with the
   * launch goes on the delivery rail like any first message, so it shows at
   * once and is held, carded and retried while the setup is missing. Resolves
   * null for a local launch; `error` says the launch prompt could not be queued.
   */
  async start(agentType: string, conversationId: string, projectPath: string | undefined, modelKey: string | undefined, prompt: unknown): Promise<{ error?: string } | null> {
    const runtime = this.runtimeOf(cloudAgentProviderForLaunch(agentType, modelKey)?.id);
    if (!runtime || !modelKey) return null;
    await runtime.sessions.start(conversationId, projectPath, modelKey);
    if (typeof prompt !== "string" || !prompt.trim()) return {};
    try {
      await this.deps.enqueueMessage(conversationId, prompt);
      return {};
    } catch (err) {
      this.deps.log(`${logTag(runtime.adapter)} first prompt not queued: ${errorText(err)}`);
      return { error: `${runtime.adapter.spec.label} session recorded, but its first message could not be queued: ${errorText(err)}` };
    }
  }

  /**
   * Deliver to the conversation's cloud agent: the runtime that took it, or
   * null when it is not one. A setup problem posts its card, then throws for
   * the delivery layer to hold the message.
   */
  async deliver(conversationId: string, content: string): Promise<CloudAgentRuntime | null> {
    for (const runtime of this.runtimes) {
      try {
        if (await runtime.sessions.deliver(conversationId, content)) {
          this.setupHolds.delete(conversationId);
          return runtime;
        }
      } catch (err) {
        if (err instanceof CloudAgentSetupError) {
          const tries = this.setupHolds.get(conversationId) ?? 0;
          this.setupHolds.set(conversationId, tries + 1);
          err.triedBefore(tries);
        }
        const card = err instanceof CloudAgentSetupError ? this.setupCard(err, conversationId)
          : err instanceof CloudAgentUnsentError ? { key: err.cardKey(conversationId), message: err.message } : null;
        if (card) await this.deps.addLine(conversationId, { key: card.key, role: "assistant", content: `${CLIENT_ERROR_BANNER_PREFIX} ${card.message}` });
        throw err;
      }
    }
    return null;
  }

  /**
   * Cancel the conversation's running turn: "sent", "none" when nothing is
   * running, null when it is not a cloud agent session. A failure throws with
   * the provider's name.
   */
  async interrupt(conversationId: string): Promise<"sent" | "none" | null> {
    const runtime = this.forConversation(conversationId);
    if (!runtime) return null;
    try {
      return await runtime.sessions.interrupt(conversationId) ? "sent" : "none";
    } catch (err) {
      throw new Error(`${runtime.adapter.spec.label} cancel failed: ${errorText(err)}`);
    }
  }

  /**
   * One of the header's actions on the conversation's agent (the provider's
   * spec lists which): its result is said in the session's thread, and a
   * refusal or failure too, then thrown for the page that asked.
   */
  async act(conversationId: string, action: CloudAgentActionName): Promise<CloudAgentActionResult> {
    const runtime = this.forConversation(conversationId);
    if (!runtime) throw new Error("this session does not run on a cloud agent");
    const { adapter } = runtime;
    const label = CLOUD_AGENT_ACTIONS[action].label;
    const session = runtime.sessions.get(conversationId);
    const agentId = session?.agentId;
    if (!agentId) throw new Error(`the ${adapter.spec.label} agent has not started yet`);
    if (!adapter.spec.actions?.includes(action) || !adapter[CLOUD_AGENT_ACTION_METHODS[action]]) throw new Error(`${adapter.spec.label} has no ${label}`);
    const key = `${adapter.spec.mirrorDir}-action:${conversationId}:${action}:${Date.now()}`;
    let done: CloudAgentActionResult;
    const client = adapter.client();
    try {
      if (client instanceof CloudAgentSetupError) throw client;
      done = await this.runAction(runtime, client, agentId, action);
    } catch (err) {
      const setup = err instanceof CloudAgentSetupError ? err : await judgeCloudFailure(adapter, runtime.watcher, client, err, session);
      const message = `${label} failed: ${setup?.message ?? errorText(err)}`;
      this.deps.log(`${logTag(adapter)} ${action} on ${agentId}: ${message}`);
      await this.postNote(conversationId, key, message);
      throw new Error(message);
    }
    this.deps.log(`${logTag(adapter)} ${action} on ${agentId}: ${done.message}${done.url ? ` ${done.url}` : ""}`);
    // A bare link: the thread renders a pull request's as its pill.
    await this.postNote(conversationId, key, done.url ? `${done.message} ${done.url}` : done.message);
    void runtime.watcher?.follow(agentId);
    return done;
  }

  private postNote(conversationId: string, key: string, text: string): Promise<void> {
    return this.deps.addLine(conversationId, { key, role: "system", subtype: CLOUD_AGENT_ACTION_SUBTYPE, content: text });
  }

  private async runAction(runtime: CloudAgentRuntime, client: unknown, agentId: string, action: CloudAgentActionName): Promise<CloudAgentActionResult> {
    // act() checked the adapter has the action's method (CLOUD_AGENT_ACTION_METHODS).
    const { adapter } = runtime;
    switch (action) {
      case "archive":
      case "unarchive": {
        await adapter.archive!(client, agentId, action === "archive");
        return { message: action === "archive" ? `Archived on ${adapter.spec.label}. It stays here; Unarchive brings it back there.` : `Unarchived on ${adapter.spec.label}.` };
      }
      case "create_pr": {
        const pr = await adapter.createPullRequest!(client, agentId);
        const url = cloudAgentPageUrl(pr.url);
        return url ? { message: "Opened a draft pull request.", url } : { message: `${adapter.spec.label} is opening a draft pull request; the session's branch and pull request show here once it is open.` };
      }
      case "apply": {
        const plan = await adapter.applyPlan!(client, agentId);
        const repo = repoOwnerName(plan.repo);
        const { root, files, already } = await applyInCheckout(plan, repo ? await this.checkoutOf(runtime, agentId, repo) : null);
        if (already) return { message: `${root} already has ${plan.what}; nothing changed.` };
        return { message: `Applied ${plan.what} to ${root} (${files.length === 1 ? "1 file" : `${files.length} files`}, not committed).` };
      }
    }
  }

  /** Cancel the running turn in the background (a stopped session). */
  interruptInBackground(conversationId: string): void {
    const runtime = this.forConversation(conversationId);
    if (!runtime) return;
    void this.interrupt(conversationId).catch((err) => this.deps.log(`${logTag(runtime.adapter)} on teardown: ${errorText(err)}`));
  }

  /**
   * The card a setup problem shows where the person is looking (the
   * turn-stopped card; a credential one carries the connect control), once
   * per conversation and kind a minute; null while one is already up.
   */
  setupCard(err: CloudAgentSetupError, conversationId: string, now = Date.now()): { key: string; message: string } | null {
    const key = err.cardKey(conversationId);
    if (now - (this.setupCardsPosted.get(key) ?? 0) <= SETUP_CARD_MS) return null;
    this.setupCardsPosted.set(key, now);
    return { key, message: err.message };
  }

  /** The account turned a sync source on: its provider's mirror polls soon rather than at its idle cadence. */
  syncTurnedOn(source: string): void {
    for (const r of this.runtimes) if (r.adapter.spec.syncSource === source) r.watcher?.hurry();
  }

  /** A sign-in based provider's state on this machine, checked live; a machine that just signed in polls soon. */
  async checkLogin(providerId: string): Promise<Omit<CloudAgentLoginState, "setup">> {
    const runtime = this.loginRuntime(providerId);
    const state = await checkCloudAgentLogin(runtime.adapter);
    // The check is the provider's answer too: what the machine reports follows it, as far as a sign-in proves.
    if (state.state === "signed_in") {
      runtime.watcher?.signInPassed();
      runtime.watcher?.hurry();
    } else if (state.setup) runtime.watcher?.setRemoteSetup(state.setup);
    const { setup: _setup, ...shown } = state;
    return shown;
  }

  /** Start a sign-in based provider's own sign-in on this machine; checkLogin tells when it lands. */
  async startLogin(providerId: string): Promise<void> {
    await this.loginRuntime(providerId).adapter.login!.start();
  }

  private loginRuntime(providerId: string): CloudAgentRuntime {
    const runtime = this.runtimeOf(providerId);
    if (!runtime?.adapter.login) throw new Error(`${runtime?.adapter.spec.label ?? providerId} has no sign-in to run here`);
    return runtime;
  }

  /**
   * Keep a mirrored agent's session: hosted by this daemon (it has no local
   * process; this daemon mirrors and drives it), named by the provider's
   * latest title unless someone renamed it (retitleSession replaces only the
   * provider's own earlier names), marked archived as the provider says
   * (the header offers Archive or Unarchive), and placed in this machine's checkout of
   * its repository when this machine hosts it and has one. Only the host
   * places it: two machines keep their checkouts at different paths, and a
   * machine without a checkout never moves it (its placeholder folder is no
   * better than any other). Resolves false when another live device hosts
   * it: that device alone syncs its transcript (two machines signed in to
   * one account each mirror its agents, and would write it twice).
   */
  async keepSession(sessionId: string, conversationId: string, metadata: { title?: string; formerTitles?: string[]; cwd?: string; cloudArchived?: boolean }): Promise<boolean> {
    const { cwd, title } = metadata;
    const host = await this.host(sessionId, conversationId);
    const hosting = host === "hosted";
    if (hosting && cwd && !isCloudMirrorPlaceholder(cwd, this.runtimes.map((r) => r.adapter.spec.mirrorDir)) && this.placements.get(sessionId) !== cwd) {
      if (await this.deps.placeSession(sessionId, cwd)) this.placements.set(sessionId, cwd);
    }
    if (title && this.titles.get(sessionId) !== title && await this.deps.retitleSession(conversationId, title, metadata.formerTitles ?? [])) {
      this.titles.set(sessionId, title);
    }
    const archived = metadata.cloudArchived;
    if (archived !== undefined && this.archived.get(sessionId) !== archived && await this.deps.markArchived(conversationId, archived)) {
      this.archived.set(sessionId, archived);
    }
    return host !== "elsewhere";
  }

  /**
   * Register the session as this daemon's unless another device holds it:
   * "hosted", "elsewhere" (another live device holds it), or "unknown" (the
   * server has not answered yet).
   */
  private async host(sessionId: string, conversationId: string, attempt = 0): Promise<"hosted" | "elsewhere" | "unknown"> {
    const hosted = this.hosted.get(sessionId);
    if (hosted === "hosted") return "hosted";
    if (typeof hosted === "number" && Date.now() - hosted <= HOST_ELSEWHERE_MS) return "elsewhere";
    if (attempt === 0 && this.hostRetries.has(sessionId)) return "unknown";
    const result = await this.deps.hostSession(sessionId, conversationId);
    this.hostRetries.delete(sessionId);
    if (result === "hosted") this.hosted.set(sessionId, "hosted");
    else if (result === "not_owner") this.hosted.set(sessionId, Date.now());
    else {
      // Unanswered, not refused: ask again soon, or its status is dropped until the next restart.
      const delay = doublingDelay(HOST_RETRY_MS, HOST_ELSEWHERE_MS, attempt);
      this.hostRetries.set(sessionId, setTimeout(() => void this.host(sessionId, conversationId, attempt + 1), delay));
    }
    return result === "hosted" ? "hosted" : result === "not_owner" ? "elsewhere" : "unknown";
  }

  /** A session its mirror can no longer follow: this daemon stops hosting it until a mirror reaches it again. */
  private letGo(sessionId: string): void {
    const retry = this.hostRetries.get(sessionId);
    if (retry) clearTimeout(retry);
    this.hostRetries.delete(sessionId);
    this.hosted.delete(sessionId);
    this.deps.releaseSession(sessionId);
  }

  /** What keeps this machine from reading each provider, for the device's heartbeat (Settings shows it by the provider). */
  setupBlocks(): CloudAgentSetupBlock[] {
    return this.runtimes.flatMap(({ adapter, watcher }) => {
      const problem = watcher?.setupProblem;
      return problem ? [{ provider: adapter.spec.id, kind: problem.kind, ...(problem.reason ? { reason: problem.reason } : {}), ...(problem.resetsAt ? { resets_at: problem.resetsAt } : {}), ...(watcher?.holdsOnlySends ? { sends_only: true } : {}) }] : [];
    });
  }

  /** Check a key before it is stored, for the provider whose credential it is. */
  async verifyKey(keyProvider: string, key: string): Promise<ProviderKeyVerdict> {
    const adapter = this.runtimeOf(cloudAgentProviderForKey(keyProvider)?.id)?.adapter;
    return adapter?.verifyKey ? adapter.verifyKey(key) : { ok: true };
  }
}

const LOGIN_STATE_OF_SETUP: Partial<Record<CloudAgentSetupError["kind"], CloudAgentLoginState["state"]>> = {
  key_missing: "signed_out",
  key_invalid: "expired",
  access: "disabled",
};

/**
 * Where a sign-in based provider's login on this machine stands, by the same
 * rules delivery uses: the client's own setup problem (none, or run out),
 * else whatever the provider's answer to whoami says through cloudSetupErrorOf.
 * Anything that names no setup problem is the provider being unreachable.
 */
export async function checkCloudAgentLogin(adapter: AnyCloudAgentAdapter): Promise<CloudAgentLoginState> {
  const login = adapter.login!;
  const client = adapter.client();
  try {
    if (client instanceof CloudAgentSetupError) throw client;
    const who = await login.whoami(client);
    return { state: "signed_in", ...(who.account ? { account: who.account } : {}), ...(who.plan ? { plan: who.plan } : {}) };
  } catch (err) {
    const setup = err instanceof CloudAgentSetupError ? err : await cloudSetupErrorOf(adapter, client, err);
    const state = (setup && LOGIN_STATE_OF_SETUP[setup.kind]) ?? "unreachable";
    // Unreachable: the provider's limit or change when it named one, else the error itself.
    const detail = state === "unreachable" ? setup?.reason ?? errorText(err) : setup?.reason;
    const account = state === "signed_out" ? undefined : login.localAccount?.();
    return { state, ...(account ? { account } : {}), ...(detail ? { detail } : {}), ...(setup && !(err instanceof CloudAgentSetupError) ? { setup } : {}) };
  }
}
