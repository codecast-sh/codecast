/**
 * The daemon's cloud agent providers, one runtime (mirror watcher + sessions)
 * per adapter. The daemon calls these few entry points and never names a
 * provider: the launch path (start), delivery (deliver, which posts the setup
 * card), Escape and teardown (interrupt), the key check (verifyKey), a
 * sign-in based provider's login (checkLogin, startLogin), the account's
 * sync switch (syncTurnedOn), and boot (startWatchers).
 */
import { CLOUD_SESSION_SOURCES, cloudSessionSyncOn, cloudAgentProviderForKey, cloudAgentProviderForLaunch, type CloudAgentProviderSpec } from "@codecast/shared/contracts";
import { CloudAgentSessions, setupErrorOf, type CloudAgentSessionsDeps } from "./sessions.js";
import { CloudAgentWatcher, type CloudAgentTranscriptEvent, type CloudAgentWatcherOptions } from "./watcher.js";
import { CloudAgentSetupError, errorText, logTag, type AnyCloudAgentAdapter, type CloudAgentGit, type CloudAgentLoginState } from "./types.js";

export interface CloudAgentRuntime {
  adapter: AnyCloudAgentAdapter;
  sessions: CloudAgentSessions;
  /** Null until startWatchers. */
  readonly watcher: CloudAgentWatcher | null;
}

export interface CloudAgentRegistryDeps extends Omit<CloudAgentSessionsDeps, "watcher"> {
  /** Show a setup problem where the person is looking: the turn-stopped card, under its key. */
  postSetupCard: (conversationId: string, card: { key: string; message: string }) => Promise<void>;
  /** Put a message the person wrote on the conversation's delivery rail (pending messages), as the composer does. */
  enqueueMessage: (conversationId: string, content: string) => Promise<void>;
}

export interface CloudAgentWatchOptions extends Pick<CloudAgentWatcherOptions, "resolveRepoDir" | "log"> {
  /** The account's stored sync setting for a source field (e.g. cursor_cloud_sync), read on every poll; unset means the source's default. */
  syncSetting: (field: string) => boolean | undefined;
  /** Sync a mirrored transcript (every provider's mirror is the one format, transcript.ts), under the provider's agent type. */
  onTranscript: (spec: CloudAgentProviderSpec, event: CloudAgentTranscriptEvent) => void;
  /** The branch an agent pushed. */
  onGit: (git: CloudAgentGit) => void;
}

/** How long a setup card stays posted before a held retry may post it again. */
const SETUP_CARD_MS = 60_000;

export class CloudAgentRegistry {
  readonly runtimes: CloudAgentRuntime[];
  private readonly setupCardsPosted = new Map<string, number>();
  /** Each provider's mirror, by provider id, once startWatchers ran. */
  private readonly watchers = new Map<string, CloudAgentWatcher>();

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
    for (const runtime of this.runtimes) {
      const { adapter, sessions } = runtime;
      const field = CLOUD_SESSION_SOURCES[adapter.spec.syncSource].field;
      const watcher = new CloudAgentWatcher(adapter, {
        importAll: () => cloudSessionSyncOn(field, opts.syncSetting(field)),
        isOwnAgent: (agentId) => sessions.ownsAgent(agentId),
        hasOwnAgents: () => sessions.ownsAnyAgent(),
        resolveRepoDir: opts.resolveRepoDir,
        log: opts.log,
      });
      watcher.on("session", (event) => opts.onTranscript(adapter.spec, event));
      watcher.on("error", (error: Error) => opts.log?.(`${logTag(adapter)} poll failed: ${error.message}`));
      watcher.on("git", opts.onGit);
      this.useWatcher(watcher);
      watcher.start();
    }
  }

  /** The mirror a provider's sessions tell about the agents codecast moves (startWatchers, or a test's unstarted one). */
  useWatcher(watcher: CloudAgentWatcher): void {
    this.watchers.set(watcher.adapter.spec.id, watcher);
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
    const spec = cloudAgentProviderForLaunch(agentType, modelKey);
    const runtime = spec && this.runtimes.find((r) => r.adapter.spec.id === spec.id);
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
        if (await runtime.sessions.deliver(conversationId, content)) return runtime;
      } catch (err) {
        const card = err instanceof CloudAgentSetupError ? this.setupCard(err, conversationId) : null;
        if (card) await this.deps.postSetupCard(conversationId, card);
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
  async checkLogin(providerId: string): Promise<CloudAgentLoginState> {
    const runtime = this.loginRuntime(providerId);
    const state = await checkCloudAgentLogin(runtime.adapter);
    if (state.state === "signed_in") runtime.watcher?.hurry();
    return state;
  }

  /** Start a sign-in based provider's own sign-in on this machine; checkLogin tells when it lands. */
  async startLogin(providerId: string): Promise<void> {
    await this.loginRuntime(providerId).adapter.login!.start();
  }

  private loginRuntime(providerId: string): CloudAgentRuntime {
    const runtime = this.runtimes.find((r) => r.adapter.spec.id === providerId);
    if (!runtime?.adapter.login) throw new Error(`${runtime?.adapter.spec.label ?? providerId} has no sign-in to run here`);
    return runtime;
  }

  /** Check a key before it is stored, for the provider whose credential it is. */
  async verifyKey(keyProvider: string, key: string): Promise<{ ok: true; account?: string } | { ok: false; error: string }> {
    const spec = cloudAgentProviderForKey(keyProvider);
    const adapter = spec && this.runtimes.find((r) => r.adapter.spec.id === spec.id)?.adapter;
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
 * else whatever the provider's answer to whoami says through setupErrorOf.
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
    const setup = err instanceof CloudAgentSetupError ? err : setupErrorOf(adapter, err);
    const state = (setup && LOGIN_STATE_OF_SETUP[setup.kind]) ?? "unreachable";
    const detail = state === "unreachable" ? errorText(err) : setup?.reason;
    const account = state === "signed_out" ? undefined : login.localAccount?.();
    return { state, ...(account ? { account } : {}), ...(detail ? { detail } : {}) };
  }
}
