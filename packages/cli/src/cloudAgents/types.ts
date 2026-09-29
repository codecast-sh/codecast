/**
 * The adapter a cloud agent provider implements (Cursor Cloud Agents first;
 * Codex Cloud and the OpenAI Agents API next). The core in this directory owns
 * everything provider-neutral: the mirror watcher (poll, per-agent state, the
 * mirror directory, transcript emission, priming, own-vs-imported), the
 * transcript records (transcript.ts), the sessions registry (start, deliver,
 * interrupt, held messages, setup errors) and the daemon's registry
 * (registry.ts). An adapter only speaks its vendor's API.
 */
import type { CloudAgentProviderSpec } from "@codecast/shared/contracts";
import type { CloudAgentSession } from "./sessions.js";

/** One agent from the provider's list: enough to decide whether it moved. */
export interface CloudAgentListItem<A> {
  id: string;
  /** Changes whenever the agent does (compared for equality; parsed for the backfill horizon). */
  updatedAt: string;
  /** Still running: mirrored on every poll until it settles. */
  active: boolean;
  /** The provider's own record, handed back to `mirror` so it need not be read again. */
  agent: A;
}

/** The branch (and pull request) an agent last pushed. */
export interface CloudAgentGit { agentId: string; repoUrl?: string; branch?: string; prUrl?: string }

/** One mirror pass over an agent, as the adapter read it. */
export interface CloudAgentMirror {
  /** The rendered transcript (transcript.ts); "" writes nothing. */
  transcript: string;
  title?: string;
  url?: string;
  createdAtMs?: number;
  /** The GitHub repo it works on: where its session is placed locally. */
  repoUrl?: string;
  /** The agent's version (as listed); kept as settled when nothing is still running. */
  updatedAt: string;
  running: boolean;
  git?: CloudAgentGit | null;
  /** Agents it started that the provider's list does not show (forked workers). */
  children?: Array<{ agentId: string; description?: string }>;
}

/**
 * What the core hands an adapter for one agent. `data` is the agent's
 * persisted record (events.json): whatever the adapter needs to outlive the
 * provider's own retention, e.g. a merged event log. The handle stays valid
 * between passes, so a live stream the adapter follows can keep writing to it.
 */
export interface CloudAgentHandle<D> {
  readonly agentId: string;
  data(): D;
  save(): void;
  /** The line codecast adds under the first prompt (see setNotice). */
  notice(): Promise<string | undefined>;
  /** Mirror again shortly (a live stream moved). Coalesced. */
  scheduleRender(): void;
  /** Mirror again now (a live stream ended). */
  follow(): Promise<void>;
  log(msg: string): void;
}

export interface CloudAgentAdapter<C = unknown, A = unknown, D = unknown> {
  readonly spec: CloudAgentProviderSpec;
  /** The mirror's directory under ~/.codecast (transcripts, state, sessions). */
  readonly dir: string;
  /** Bump when the rendered transcript changes shape: every mirror re-renders once. */
  readonly mirrorFormat: number;
  /** An API client from this machine's credentials, or null when there are none. */
  client(): C | null;
  /** Whether a directory name under the mirror root is one of its agents. */
  isAgentId(id: string): boolean;
  /** The persisted per-agent record, from what is on disk (undefined when nothing is). */
  loadData(raw: unknown): D;

  // Mirror side.
  listAgents(client: C, cursor?: string): Promise<{ items: CloudAgentListItem<A>[]; nextCursor?: string }>;
  /** Read the agent and render its transcript. Null skips this pass. */
  mirror(client: C, handle: CloudAgentHandle<D>, known: A | undefined): Promise<CloudAgentMirror | null>;
  /** Stop any live work (streams it follows). */
  stop?(): void;

  // Drive side.
  /** Start the agent with its first message. */
  create(client: C, session: CloudAgentSession, content: string): Promise<{ agentId: string; url?: string }>;
  /** A follow-up message. Throws CloudAgentBusyError while the agent cannot take one yet. */
  followUp(client: C, agentId: string, content: string): Promise<void>;
  /** Cancel the running turn: what was cancelled, or null when nothing was running. */
  cancel(client: C, agentId: string): Promise<string | null>;
  /** The setup problem an API error names, in words the session shows; null for anything else. */
  setupErrorOf(err: unknown, session: CloudAgentSession): CloudAgentSetupError | null;
  /** The setup card when this machine has no credentials. */
  readonly credentialsMissing: string;
  /** The held message's reason while credentials are missing or refused. */
  readonly credentialHoldReason: string;
  /** Check a key before it is stored (Settings, Provider keys), when the credential is one. */
  verifyKey?(key: string): Promise<{ ok: true; account?: string } | { ok: false; error: string }>;
}

export type AnyCloudAgentAdapter = CloudAgentAdapter<any, any, any>;

/** Setup problems: the credential ones are rechecked every few seconds, the rest back off. */
export type CloudAgentSetupKind = "key_missing" | "key_invalid" | "repo";
const CREDENTIAL_KINDS: ReadonlySet<CloudAgentSetupKind> = new Set(["key_missing", "key_invalid"]);

/**
 * A message that cannot go out until someone fixes the setup: no credentials
 * on this machine, credentials the provider rejects, or a repo/branch it
 * cannot reach. `message` is what the session shows; the delivery layer holds
 * the message and resends it once the setup changes. `holdReason` is set for
 * the credential kinds: those are held and rechecked quickly, the rest back
 * off (each try is an API call).
 */
export class CloudAgentSetupError extends Error {
  readonly holdReason?: string;
  constructor(readonly adapter: Pick<AnyCloudAgentAdapter, "spec" | "dir" | "credentialHoldReason">, readonly kind: CloudAgentSetupKind, message: string) {
    super(message);
    if (CREDENTIAL_KINDS.has(kind)) this.holdReason = adapter.credentialHoldReason;
  }
  /** The card's message id: one per conversation and kind. */
  cardKey(conversationId: string): string {
    return `${this.adapter.dir}-setup:${conversationId}:${this.kind}`;
  }
}

/** A follow-up the agent cannot take yet (a turn is still going). Retried by the delivery layer. */
export class CloudAgentBusyError extends Error {
  constructor(label: string) {
    super(`AGENT_STDIN_NOT_READY: the ${label} agent is still running the previous message`);
  }
}
