/**
 * The adapter a cloud agent provider implements (Cursor Cloud Agents first;
 * Codex Cloud and the OpenAI Agents API next). The core in this directory owns
 * everything provider-neutral: the mirror watcher (poll, per-agent state, the
 * mirror directory, transcript emission, priming, own-vs-imported), the
 * transcript records (transcript.ts), the sessions registry (start, deliver,
 * interrupt, held messages, setup errors) and the daemon's registry
 * (registry.ts). An adapter only speaks its vendor's API.
 */
import { cloudAgentCardText, type CloudAgentProviderSpec } from "@codecast/shared/contracts";
import { githubRepo } from "../cloud/gitOrigin.js";
import { deviceLabel } from "../remote/device.js";
import type { CloudAgentSession } from "./sessions.js";

/** One agent from the provider's list: enough to decide whether it moved. */
export interface CloudAgentListItem<A> {
  id: string;
  /** When the agent last changed: agents older than the backfill horizon are not read. */
  updatedAtMs: number;
  /** Changes whenever the agent does; compared for equality only, and kept as settled (state.json). */
  version: string;
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
  /** The GitHub repo it works on (`owner/name`, or any GitHub URL as repoUrl): where its session is placed locally. */
  repo?: string;
  repoUrl?: string;
  /** The agent's version (as listed); kept as settled when nothing is still running. */
  version: string;
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
  /** Its mirror directory, credential card copy and session id prefix come from here. */
  readonly spec: CloudAgentProviderSpec;
  /** Bump when the rendered transcript changes shape: every mirror re-renders once. */
  readonly mirrorFormat: number;
  /** Between polls while nothing runs (default 30s). */
  readonly pollMs?: number;
  /** Between polls while an agent runs or a reply to codecast is due (default pollMs). */
  readonly fastPollMs?: number;
  /**
   * An API client from this machine's credentials, or the setup problem that
   * keeps it from having one (none, expired, signed out): the core shows that
   * card on delivery and skips the mirror's polls until it clears.
   */
  client(): C | CloudAgentSetupError;
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
  /**
   * A vendor-specific setup problem an API error names, in words the session
   * shows (a repository it cannot reach); null for anything else. A
   * CloudApiError that rejects the credentials is the core's rule
   * (setupErrorOf in sessions.ts) and needs no case here. No session when
   * the error came from checking the sign-in rather than from one session.
   */
  setupErrorOf?(err: unknown, session?: CloudAgentSession): CloudAgentSetupError | null;
  /** Check a key before it is stored (Settings, Provider keys), when the credential is one. */
  verifyKey?(key: string): Promise<{ ok: true; account?: string } | { ok: false; error: string }>;
  /** When the credential is a sign-in on this machine (a CLI's own login) rather than a key. */
  readonly login?: CloudAgentLogin<C>;
}

/** Where a machine's sign-in stands, checked live with the provider (the registry's checkLogin). */
export interface CloudAgentLoginState {
  state: "signed_in" | "signed_out" | "expired" | "disabled" | "unreachable";
  /** The account the provider named (signed in), else the one the local sign-in names. */
  account?: string;
  plan?: string;
  /** The provider's reason (signed out, expired, disabled, unreachable). */
  detail?: string;
}

/**
 * A sign-in based credential: who it signs in as, and the provider's own
 * sign-in run on this machine. Whether it works at all is the core's
 * question: client() says when there is none or it ran out, and an error
 * whoami throws is read by the same setupErrorOf delivery uses.
 */
export interface CloudAgentLogin<C = unknown> {
  /** The account and plan the provider names for this client. Throws what the API threw. */
  whoami(client: C): Promise<{ account?: string; plan?: string }>;
  /** The account the sign-in on disk names, known without asking the provider. */
  localAccount?(): string | undefined;
  /** Start the sign-in (it opens the browser on this machine) and return; the check tells when it lands. */
  start(): Promise<void>;
}

export type AnyCloudAgentAdapter = CloudAgentAdapter<any, any, any>;

/** The one tag every core log line for a provider carries: `[cursor-cloud]`. */
export function logTag(adapter: Pick<AnyCloudAgentAdapter, "spec">): string {
  return `[${adapter.spec.mirrorDir}]`;
}

/** An error's text for a log line or a session's card. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Setup problems: the credential ones are rechecked every few seconds, the
 * rest back off. `access`: the provider refuses the account itself (a
 * workspace that has the product turned off), which signing in again does not fix.
 */
export type CloudAgentSetupKind = "key_missing" | "key_invalid" | "repo" | "access";
const CREDENTIAL_KINDS: ReadonlySet<CloudAgentSetupKind> = new Set(["key_missing", "key_invalid"]);

/**
 * A message that cannot go out until someone fixes the setup: no credentials
 * on this machine, credentials the provider rejects, or a repo/branch it
 * cannot reach. `message` is what the session shows; the delivery layer holds
 * the message and resends it once the setup changes. `holdReason` is set for
 * the credential kinds: those are held and rechecked quickly, the rest back
 * off (each try is an API call).
 */
/** A card's copy naming the machine this daemon runs on, as the web lists it. */
function card(template: string): string {
  return cloudAgentCardText(template, deviceLabel());
}

export class CloudAgentSetupError extends Error {
  readonly holdReason?: string;
  /**
   * `reason`: the provider's own words (or the vendor's sentence), without
   * the card around it: what the connect dialog shows.
   */
  constructor(readonly adapter: Pick<AnyCloudAgentAdapter, "spec">, readonly kind: CloudAgentSetupKind, message: string, readonly reason?: string) {
    super(message);
    if (CREDENTIAL_KINDS.has(kind)) this.holdReason = card(adapter.spec.credentialCards.holdReason);
  }
  /** No usable credentials on this machine: the spec's card, and `detail` when there is more to say (a login of the wrong kind). */
  static credentialsMissing(adapter: Pick<AnyCloudAgentAdapter, "spec">, detail?: string): CloudAgentSetupError {
    const missing = card(adapter.spec.credentialCards.missing);
    return new CloudAgentSetupError(adapter, "key_missing", detail ? `${missing} ${detail}` : missing, detail);
  }
  /** The provider refused the credentials: the spec's card with the provider's reason. */
  static credentialsRejected(adapter: Pick<AnyCloudAgentAdapter, "spec">, reason: string): CloudAgentSetupError {
    return new CloudAgentSetupError(adapter, "key_invalid", `${card(adapter.spec.credentialCards.rejected)} (${reason}).`, reason);
  }
  /** A sign-in codecast only reads ran out: found here, before the provider was asked. */
  static credentialsExpired(adapter: Pick<AnyCloudAgentAdapter, "spec">, expiredAt: number): CloudAgentSetupError {
    const date = new Date(expiredAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const { expired } = adapter.spec.credentialCards;
    if (!expired) return CloudAgentSetupError.credentialsRejected(adapter, `it expired ${date}`);
    return new CloudAgentSetupError(adapter, "key_invalid", `${card(expired)} ${date}.`, `expired ${date}`);
  }
  /**
   * The provider cannot reach the session's repository or branch: "<label>
   * can't reach <repo> (<reason>)", then where access is given (the spec's
   * repoAccessUrl) unless `fix` says what to do instead.
   */
  static repoUnreachable(adapter: Pick<AnyCloudAgentAdapter, "spec">, session: Pick<CloudAgentSession, "repoUrl"> | undefined, reason: string, fix?: string): CloudAgentSetupError {
    const { label, repoAccessUrl } = adapter.spec;
    const repo = githubRepo(session?.repoUrl) ?? "this repository";
    return CloudAgentSetupError.retried(adapter, "repo", `${label} can't reach ${repo} (${reason}). ${fix ?? `Give it access at ${repoAccessUrl}`}`);
  }
  /** The provider refuses the account (not its credentials). `problem` is the vendor's sentence (what to fix, no closing period). */
  static accessDenied(adapter: Pick<AnyCloudAgentAdapter, "spec">, problem: string): CloudAgentSetupError {
    return CloudAgentSetupError.retried(adapter, "access", problem);
  }
  private static retried(adapter: Pick<AnyCloudAgentAdapter, "spec">, kind: CloudAgentSetupKind, problem: string): CloudAgentSetupError {
    return new CloudAgentSetupError(adapter, kind, `${problem}; the message retries on its own.`, problem);
  }
  /** The card's message id: one per conversation and kind. */
  cardKey(conversationId: string): string {
    return `${this.adapter.spec.mirrorDir}-setup:${conversationId}:${this.kind}`;
  }
}

/** A follow-up the agent cannot take yet (a turn is still going). Retried by the delivery layer. */
export class CloudAgentBusyError extends Error {
  constructor(label: string) {
    super(`AGENT_STDIN_NOT_READY: the ${label} agent is still running the previous message`);
  }
}
