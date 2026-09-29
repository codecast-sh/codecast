/**
 * The daemon's cloud agent providers, one runtime (mirror watcher + sessions)
 * per adapter. The daemon calls these few entry points and never names a
 * provider: the launch path (start), delivery (deliver + the setup card),
 * Escape and teardown (interrupt), the key check (verifyKey), and boot
 * (startWatchers).
 */
import { CLOUD_SESSION_SOURCES, cloudAgentProviderForLaunch } from "@codecast/shared/contracts";
import { CloudAgentSessions, type CloudAgentSessionsDeps } from "./sessions.js";
import { CloudAgentWatcher, type CloudAgentTranscriptEvent, type CloudAgentWatcherOptions } from "./watcher.js";
import type { AnyCloudAgentAdapter, CloudAgentGit, CloudAgentSetupError } from "./types.js";

export interface CloudAgentRuntime {
  adapter: AnyCloudAgentAdapter;
  sessions: CloudAgentSessions;
  /** Null until startWatchers. */
  watcher: CloudAgentWatcher | null;
}

export type CloudAgentRegistryDeps = Omit<CloudAgentSessionsDeps, "watcher">;

export interface CloudAgentWatchOptions extends Pick<CloudAgentWatcherOptions, "resolveRepoDir" | "log"> {
  /** The account's sync setting for a source field (e.g. cursor_cloud_sync), read on every poll. */
  syncSetting: (field: string) => boolean;
  /** A mirrored transcript, for the transcript pipeline of the provider's agent type. */
  onSession: (agentType: string, event: CloudAgentTranscriptEvent) => void;
  /** The branch an agent pushed. */
  onGit: (git: CloudAgentGit) => void;
}

/** How long a setup card stays posted before a held retry may post it again. */
const SETUP_CARD_MS = 60_000;

export class CloudAgentRegistry {
  readonly runtimes: CloudAgentRuntime[];
  private readonly setupCardsPosted = new Map<string, number>();

  constructor(adapters: AnyCloudAgentAdapter[], private readonly deps: CloudAgentRegistryDeps) {
    this.runtimes = adapters.map((adapter) => {
      const runtime: CloudAgentRuntime = { adapter, watcher: null, sessions: null as unknown as CloudAgentSessions };
      runtime.sessions = new CloudAgentSessions(adapter, { ...deps, watcher: () => runtime.watcher });
      return runtime;
    });
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
        importAll: () => opts.syncSetting(field),
        isOwnAgent: (agentId) => sessions.ownsAgent(agentId),
        resolveRepoDir: opts.resolveRepoDir,
        log: opts.log,
      });
      watcher.on("session", (event) => opts.onSession(adapter.spec.agentType, event));
      watcher.on("error", (error: Error) => opts.log?.(`${adapter.spec.label} poll failed: ${error.message}`));
      watcher.on("git", opts.onGit);
      runtime.watcher = watcher;
      watcher.start();
    }
  }

  /** The runtime a conversation runs on, if it is a cloud agent session. */
  forConversation(conversationId: string): CloudAgentRuntime | undefined {
    return this.runtimes.find((r) => r.sessions.get(conversationId));
  }

  /**
   * A launch whose model key picks a cloud agent: record the conversation and
   * send the first prompt, which creates the agent. Resolves false for a
   * local launch.
   */
  async start(agentType: string, conversationId: string, projectPath: string | undefined, modelKey: string | undefined, prompt: unknown): Promise<boolean> {
    const spec = cloudAgentProviderForLaunch(agentType, modelKey);
    const runtime = spec && this.runtimes.find((r) => r.adapter.spec.id === spec.id);
    if (!runtime || !modelKey) return false;
    await runtime.sessions.start(conversationId, projectPath, modelKey);
    if (typeof prompt === "string" && prompt.trim()) {
      await runtime.sessions.deliver(conversationId, prompt).catch((err) => this.deps.log(`${spec.label.toLowerCase()}: first prompt failed: ${err instanceof Error ? err.message : String(err)}`));
    }
    return true;
  }

  /** Deliver to the conversation's cloud agent: the runtime that took it, or null when it is not one. */
  async deliver(conversationId: string, content: string): Promise<CloudAgentRuntime | null> {
    for (const runtime of this.runtimes) {
      if (await runtime.sessions.deliver(conversationId, content)) return runtime;
    }
    return null;
  }

  /** Cancel the running turn in the background (a stopped session). */
  interruptInBackground(conversationId: string): void {
    const runtime = this.forConversation(conversationId);
    if (!runtime) return;
    void runtime.sessions.interrupt(conversationId).catch((err) => this.deps.log(`${runtime.adapter.spec.label.toLowerCase()}: cancel on teardown failed: ${err instanceof Error ? err.message : String(err)}`));
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

  /** Check a key before it is stored, for the provider whose credential it is. */
  async verifyKey(keyProvider: string, key: string): Promise<{ ok: true; account?: string } | { ok: false; error: string }> {
    const adapter = this.runtimes.find((r) => r.adapter.spec.keyProvider === keyProvider)?.adapter;
    return adapter?.verifyKey ? adapter.verifyKey(key) : { ok: true };
  }
}
