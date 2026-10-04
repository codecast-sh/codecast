/**
 * The adapter a cloud agent provider implements (Cursor Cloud Agents, Codex
 * Cloud, the OpenAI Agents API). The core in this directory owns
 * everything provider-neutral: the mirror watcher (poll, per-agent state, the
 * mirror directory, transcript emission, priming, own-vs-imported), the
 * transcript records (transcript.ts), the sessions registry (start, deliver,
 * interrupt, held messages, setup errors) and the daemon's registry
 * (registry.ts). An adapter only speaks its vendor's API.
 */
import { CLOUD_AGENT_CHANGED_PROBE_MS, CLOUD_AGENT_RETRIED_SUFFIX, cloudAgentCardKey, cloudAgentCardText, cloudAgentChangedProblem, cloudAgentLimitProblem, cloudAgentExpiryDate, cloudAgentSetupRules, cloudAgentSetupSentence, cloudAgentUnsentProblem, isCloudAgentCredentialKind, type CloudAgentActionName, type CloudAgentLoginStateName, type CloudAgentProviderSpec, type CloudAgentSetupKind, type CloudAgentSetupRules } from "@codecast/shared/contracts";
import { githubRepo } from "../cloud/gitOrigin.js";
import { deviceLabel } from "../remote/device.js";
import type { ProviderKeyVerdict } from "../providerKeyCrypto.js";
import type { CloudAgentSession } from "./sessions.js";
import type { CloudApiError } from "./apiError.js";
import { doublingDelay } from "./poll.js";

/** One agent from the provider's list: enough to decide whether it moved. */
export interface CloudAgentListItem<A> {
  id: string;
  /** When the agent last changed: agents older than the backfill horizon are not read. */
  updatedAtMs: number;
  /** Changes whenever the agent does; compared for equality only, and kept as settled (state.json). */
  version: string;
  /** Still running: mirrored on every poll until it settles. */
  active: boolean;
  /** The provider's own record, handed back to `mirror` so it need not be read again; absent when the list's copy could not be read, so `mirror` reads it by id. */
  agent?: A;
}

/** The branch (and pull request) an agent last pushed; neither when it pushed none. */
export interface CloudAgentGit { agentId: string; repoUrl?: string; branch?: string; prUrl?: string }

/** One mirror pass over an agent, as the adapter read it. */
export interface CloudAgentMirror {
  /** The rendered transcript (transcript.ts); "" writes nothing. */
  transcript: string;
  title?: string;
  /** Titles the provider gives an agent before it names it (Codex's "New task"): a session still called one takes the real title. */
  placeholderTitles?: string[];
  url?: string;
  createdAtMs?: number;
  /** The GitHub repo it works on (`owner/name`, or any GitHub URL as repoUrl): where its session is placed locally. */
  repo?: string;
  repoUrl?: string;
  /** The agent's version (as listed); kept as settled when nothing is still running. */
  version: string;
  running: boolean;
  /**
   * The branch it pushed; null when it pushed none, which clears whatever
   * branch the session carried (the provider is the only authority on it, a
   * local checkout's is this machine's work); undefined when the adapter
   * cannot tell, which keeps it.
   */
  git?: CloudAgentGit | null;
  /** Agents it started that the provider's list does not show (forked workers), or the other branches of its own work. */
  children?: CloudAgentChild[];
  /** Archived on the provider's site (the header then offers Unarchive); undefined when the adapter cannot tell. */
  archived?: boolean;
}

/**
 * An agent mirrored through its parent, never listed on its own. A worker the
 * agent forked nests under its session; a branch (`forkAt`) is a fork of the
 * parent's session at one of its records, sharing the history before it (a
 * Codex Cloud task's other attempts).
 */
export interface CloudAgentChild {
  agentId: string;
  description?: string;
  /** The record id in the parent's transcript the branch forks at (its records up to there are the parent's own). */
  forkAt?: string;
  /** Changes whenever the child does: a child whose version moved is mirrored again with its parent. */
  version?: string;
  /** The provider's record the parent read, handed to the child's mirror so it need not be read again. */
  known?: unknown;
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

/** A new agent: its id, its page on the provider's site, and a line its transcript opens with under the first prompt (where the agent works). */
export interface CloudAgentCreated { agentId: string; url?: string; notice?: string }

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
  /**
   * Its list is ordered by when each agent was created, and an agent carries
   * no time it last changed (the Agents API): an old one can run again with
   * no sign of it in its age. The read then goes on past the backfill horizon
   * (up to CLOUD_MAX_LIST_PAGES) and mirrors an old agent that runs now or
   * moved since its last mirror.
   */
  readonly listedByCreation?: boolean;
  listAgents(client: C, cursor?: string): Promise<{ items: CloudAgentListItem<A>[]; nextCursor?: string }>;
  /** Read the agent and render its transcript. Null skips this pass; for a child agent, null says its parent no longer has it, and it is forgotten. */
  mirror(client: C, handle: CloudAgentHandle<D>, known: A | undefined): Promise<CloudAgentMirror | null>;
  /** The live streams it follows (streams.ts): the watcher stops them when it stops. */
  readonly streams?: { stop(): void };

  // Drive side.
  /** Start the agent with its first message. */
  create(client: C, session: CloudAgentSession, content: string): Promise<CloudAgentCreated>;
  /** A follow-up message. Throws CloudAgentBusyError while the agent cannot take one yet. */
  followUp(client: C, agentId: string, content: string): Promise<void>;
  /**
   * The provider takes a follow-up while a turn runs and steers that turn
   * with it (the Agents API): it goes out at once rather than being held
   * until the turn ends.
   */
  readonly steersRunningTurn?: boolean;
  /** Cancel the running turn: what was cancelled, or null when nothing was running. */
  cancel(client: C, agentId: string): Promise<string | null>;
  /**
   * A vendor-specific setup problem an API error names, in words the session
   * shows (a repository it cannot reach); null for anything else. The rules
   * every provider shares (refused credentials, a limit, a changed answer, a
   * refusal in no words of the provider's) are the core's (cloudSetupErrorOf
   * in sessions.ts) and need no case here. No session when the error came
   * from checking the sign-in rather than from one session.
   */
  setupErrorOf?(err: unknown, session?: CloudAgentSession): CloudAgentSetupError | null;
  /** Check a key before it is stored (Settings, Provider keys), when the credential is one. */
  verifyKey?(key: string): Promise<ProviderKeyVerdict>;
  /**
   * After a 429 (`err`): the limit that is used up, from the error's own code
   * (an account out of credit) or the provider's usage reading, and when it
   * resets (`resetsAt`, and `waitMs` until then); null when none is (the
   * requests themselves were rate limited). Without it every 429 reads as a
   * rate limit.
   */
  usageLimit?(client: C, err: CloudApiError): Promise<{ detail: string; waitMs?: number; resetsAt?: number } | null>;

  // Session actions (the header's, CLOUD_AGENT_ACTIONS): each one the spec lists.
  /** Archive the agent on the provider's site, or bring it back. */
  archive?(client: C, agentId: string, archived: boolean): Promise<void>;
  /** Open a draft pull request from the agent's changes: its link, once the provider made it. */
  createPullRequest?(client: C, agentId: string): Promise<{ url?: string }>;
  /**
   * The agent's changes to apply to a local checkout: the repository it works
   * on and its diff. The core applies that diff itself (`git apply`), so what
   * the thread says was applied is exactly what the checkout got, and no
   * provider CLI runs on this machine's login.
   */
  applyPlan?(client: C, agentId: string): Promise<CloudAgentApplyPlan>;
  /** When the credential is a sign-in on this machine (a CLI's own login) rather than a key. */
  readonly login?: CloudAgentLogin<C>;
}

/** The adapter method each header action runs: an adapter offers an action (its spec's `actions`) exactly when it has the method. */
export const CLOUD_AGENT_ACTION_METHODS = {
  create_pr: "createPullRequest",
  apply: "applyPlan",
  archive: "archive",
  unarchive: "archive",
} as const satisfies Record<CloudAgentActionName, keyof CloudAgentAdapter>;

/** What applying an agent's changes locally takes (CloudAgentAdapter.applyPlan). */
export interface CloudAgentApplyPlan {
  /** `owner/name` on GitHub. */
  repo: string;
  /** A unified diff with the repository's paths. */
  diff: string;
  /** What is applied, for the thread: "attempt 2's changes". */
  what: string;
}

/**
 * A provider's own sign-in command, as the daemon runs it: `argv` where it
 * can open this machine's browser, `headlessArgv` for a machine with none (a
 * cloud host: the person opens the link it prints on any device), `missing`
 * when its CLI is not installed.
 */
export interface CloudAgentLoginCommand { argv: string[]; headlessArgv?: string[]; missing: string; deviceCode?: boolean }

/** A device-code sign-in in progress: the page to open on any device and the code to enter there. */
export interface CloudAgentDeviceCode { url: string; code: string }

/** Where a machine's sign-in stands, checked live with the provider (the registry's checkLogin). */
export interface CloudAgentLoginState {
  state: CloudAgentLoginStateName;
  /** The account the provider named (signed in), else the one the local sign-in names. */
  account?: string;
  plan?: string;
  /** The provider's reason (signed out, expired, disabled, unreachable). */
  detail?: string;
  /** The setup problem the provider's answer named (not one found on the machine): what the machine reports until it answers otherwise. */
  setup?: CloudAgentSetupError;
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
  /**
   * Start the sign-in and return; the check tells when it lands. It opens the
   * browser on this machine, or with `deviceCode` (the person is on another
   * device) answers the page and code to finish it anywhere.
   */
  start(opts?: { deviceCode?: boolean }): Promise<CloudAgentDeviceCode | void>;
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

export type { CloudAgentSetupKind };
/** A card's copy naming the machine this daemon runs on, as the web lists it. */
function card(template: string): string {
  return cloudAgentCardText(template, deviceLabel());
}

/** A credential problem's sentence (the one the web's notes say too), naming this machine. */
function sentence(adapter: Pick<AnyCloudAgentAdapter, "spec">, problem: Parameters<typeof cloudAgentSetupSentence>[1]): string {
  return cloudAgentSetupSentence(adapter.spec, problem, deviceLabel());
}

/** How soon a held message whose credentials are missing or refused is tried again: they are read on this machine, so every few seconds. */
const CREDENTIAL_RECHECK_MS = 5_000;
/** A held message on a lane paused because the provider changed asks the mirror's verdict, not the provider; each try is still a write to the server, so once a minute. */
const PAUSED_RECHECK_MS = 60_000;
/**
 * The rest ask the provider again on every try, so less often, and less
 * often again each time it still refuses (doubling from the first wait to the
 * last). A limit that named no reset waits longer: asking sooner only spends
 * what the provider is counting.
 */
const PROVIDER_RECHECK = { baseMs: 30_000, maxMs: 10 * 60_000 };
const LIMIT_RECHECK = { baseMs: 60_000, maxMs: 30 * 60_000 };
/** A limit's named wait, kept within reason: a reset a second away is asked about in a minute, and one a week away is asked about every six hours. */
const LIMIT_MIN_WAIT_MS = 60_000;
const LIMIT_MAX_WAIT_MS = 6 * 60 * 60_000;

/** Waits that double each try, from `baseMs` to `maxMs`; a wait the provider named (`named`) comes first. */
function doubling({ baseMs, maxMs }: { baseMs: number; maxMs: number }, named?: (problem: CloudAgentSetupError) => number | undefined): (problem: CloudAgentSetupError, tries: number) => number {
  return (problem, tries) => named?.(problem) ?? doublingDelay(baseMs, maxMs, tries);
}

/** The waits one setup kind sets on this machine. */
interface CloudAgentSetupWaits {
  /** The wait before a paused lane checks again, after `tries` earlier checks (0: the next pass). */
  lane: (problem: CloudAgentSetupError, tries: number) => number;
  /** The wait before a held message is tried again, after `tries` earlier tries. */
  held: (problem: CloudAgentSetupError, tries: number) => number;
}

/** What one setup kind does on this machine: the shared rules (cloudAgentSetupRules) and this machine's waits, the one policy the mirror (watcher.ts), delivery (sessions.ts) and held messages read. */
export type CloudAgentSetupPolicy = CloudAgentSetupRules & CloudAgentSetupWaits;

const CREDENTIAL_WAITS: CloudAgentSetupWaits = { lane: () => 0, held: () => CREDENTIAL_RECHECK_MS };
const REFUSAL_WAITS: CloudAgentSetupWaits = { lane: () => 0, held: doubling(PROVIDER_RECHECK) };
const SETUP_WAITS: Partial<Record<CloudAgentSetupKind, CloudAgentSetupWaits>> = {
  changed: { lane: () => CLOUD_AGENT_CHANGED_PROBE_MS, held: () => PAUSED_RECHECK_MS },
  // A read's own 429 waits as long as its Retry-After says (else backing off); a held message waits for the reset.
  limit: { lane: doubling(LIMIT_RECHECK, (p) => p.retryAfterMs), held: doubling(LIMIT_RECHECK, (p) => p.waitMs) },
};

/** A setup kind's policy: its shared rules, with the waits of a credential, of its own, or of any other refusal. */
export function cloudAgentSetupPolicy(kind: CloudAgentSetupKind): CloudAgentSetupPolicy {
  const waits = isCloudAgentCredentialKind(kind) ? CREDENTIAL_WAITS : SETUP_WAITS[kind] ?? REFUSAL_WAITS;
  return { ...cloudAgentSetupRules(kind), ...waits };
}

/**
 * A message the agent cannot take yet: the delivery layer holds it with
 * `holdReason` (never spending its retries) and tries again every `recheckMs`.
 */
export abstract class CloudAgentHoldError extends Error {
  abstract readonly holdReason: string;
  abstract readonly recheckMs: number;
}

/**
 * A message that cannot go out until someone fixes the setup: no credentials
 * on this machine, credentials the provider rejects, or a repo/branch it
 * cannot reach. `message` is what the session shows.
 */
export class CloudAgentSetupError extends CloudAgentHoldError {
  readonly holdReason: string;
  private tries = 0;
  /**
   * `reason`: the provider's own words (or the vendor's sentence), without
   * the card around it: what the connect dialog shows. `holdReason`: what
   * the held message says, for the kinds that are not about credentials.
   */
  constructor(readonly adapter: Pick<AnyCloudAgentAdapter, "spec">, readonly kind: CloudAgentSetupKind, message: string, readonly reason?: string, holdReason?: string) {
    super(message);
    this.holdReason = isCloudAgentCredentialKind(kind) ? card(adapter.spec.credentialCards.holdReason) : holdReason ?? `waiting for ${adapter.spec.label} setup`;
  }
  /** Set when the provider named how long a held message waits (a limit's reset, else a Retry-After): the next try waits that long. */
  waitMs?: number;
  /** A 429's own Retry-After: how long a paused lane's reads wait, whatever the plan's reset. */
  retryAfterMs?: number;
  /** A limit's reset (ms since the epoch), when the provider named it: the machine reports it, and the web counts it down. */
  resetsAt?: number;
  /** Where the provider's answer broke, for a lane paused because it changed (the daemon's log names it; the card does not). */
  detail?: string;
  /** How long until the next try of a held message (the registry counts its tries: triedBefore). */
  get recheckMs(): number {
    return this.policy.held(this, this.tries);
  }
  /** Its kind's rules and waits (cloudAgentSetupPolicy). */
  get policy(): CloudAgentSetupPolicy {
    return cloudAgentSetupPolicy(this.kind);
  }
  /** How many tries this conversation's hold already had (the registry counts them). */
  triedBefore(tries: number): this {
    this.tries = tries;
    return this;
  }
  /** No usable credentials on this machine: the spec's card, and `detail` when there is more to say (a login of the wrong kind). */
  static credentialsMissing(adapter: Pick<AnyCloudAgentAdapter, "spec">, detail?: string): CloudAgentSetupError {
    return new CloudAgentSetupError(adapter, "key_missing", sentence(adapter, { kind: "key_missing", reason: detail }), detail);
  }
  /** The provider refused the credentials: the spec's card with the provider's reason. */
  static credentialsRejected(adapter: Pick<AnyCloudAgentAdapter, "spec">, reason: string): CloudAgentSetupError {
    return new CloudAgentSetupError(adapter, "key_invalid", sentence(adapter, { kind: "key_invalid", reason }), reason);
  }
  /** A sign-in codecast only reads ran out: found here, before the provider was asked. */
  static credentialsExpired(adapter: Pick<AnyCloudAgentAdapter, "spec">, expiredAt: number): CloudAgentSetupError {
    const date = cloudAgentExpiryDate(expiredAt);
    const reason = adapter.spec.credentialCards.expired ? `expired ${date}` : `it expired ${date}`;
    return new CloudAgentSetupError(adapter, "key_invalid", sentence(adapter, { kind: "key_invalid", expiredAt }), reason);
  }
  /**
   * The provider cannot reach the session's repository or branch: "<label>
   * can't reach <repo> (<reason>)", then `fix`, what to do about it (the
   * provider's page where access is given, usually its repoAccessUrl).
   */
  static repoUnreachable(adapter: Pick<AnyCloudAgentAdapter, "spec">, session: Pick<CloudAgentSession, "repoUrl"> | undefined, reason: string, fix: string): CloudAgentSetupError {
    const repo = githubRepo(session?.repoUrl) ?? "this repository";
    return CloudAgentSetupError.retried(adapter, "repo", `${adapter.spec.label} can't reach ${repo} (${reason}). ${fix}`, `waiting until ${adapter.spec.label} can reach ${repo}`);
  }
  /** The provider refuses the account (not its credentials). `problem` is the vendor's sentence (what to fix, no closing period). */
  static accessDenied(adapter: Pick<AnyCloudAgentAdapter, "spec">, problem: string): CloudAgentSetupError {
    return CloudAgentSetupError.retried(adapter, "access", problem, `waiting until ${adapter.spec.label} lets this account in`);
  }
  /**
   * The provider answered in a shape codecast does not read, or kept giving
   * answers it does not expect: its API changed. `detail` names where (never a
   * value), for the daemon's log. Nothing guesses at it: the lane pauses until a check passes.
   */
  static changed(adapter: Pick<AnyCloudAgentAdapter, "spec">, detail: string): CloudAgentSetupError {
    const err = CloudAgentSetupError.retried(adapter, "changed", cloudAgentChangedProblem(adapter.spec, deviceLabel()), `waiting until codecast can read ${adapter.spec.label} again`);
    err.detail = detail;
    return err;
  }
  /**
   * The provider holds this account to a limit (`detail`: the plan's window
   * used up, or the rate limit). `waitMs`: how long until a held message is
   * worth trying again, `resetsAt`: when the limit resets, when the provider
   * said, and `retryAfterMs`: the 429's own Retry-After.
   */
  static limited(adapter: Pick<AnyCloudAgentAdapter, "spec">, detail: string, wait: { waitMs?: number; resetsAt?: number; retryAfterMs?: number } = {}): CloudAgentSetupError {
    const err = CloudAgentSetupError.retried(adapter, "limit", cloudAgentLimitProblem(adapter.spec, detail), `waiting for the ${adapter.spec.label} limit to reset`);
    const within = (ms: number) => Math.min(Math.max(ms, LIMIT_MIN_WAIT_MS), LIMIT_MAX_WAIT_MS);
    const waitMs = wait.waitMs ?? wait.retryAfterMs;
    if (waitMs !== undefined) err.waitMs = within(waitMs);
    if (wait.retryAfterMs !== undefined) err.retryAfterMs = within(wait.retryAfterMs);
    if (wait.resetsAt !== undefined) err.resetsAt = wait.resetsAt;
    return err;
  }
  /** A card that is not about credentials: it opens with the provider's label, and ends saying the message retries. */
  private static retried(adapter: Pick<AnyCloudAgentAdapter, "spec">, kind: CloudAgentSetupKind, problem: string, holdReason: string): CloudAgentSetupError {
    const named = problem.startsWith(adapter.spec.label) ? problem : `${adapter.spec.label}: ${problem}`;
    return new CloudAgentSetupError(adapter, kind, `${named}${CLOUD_AGENT_RETRIED_SUFFIX}`, problem, holdReason);
  }
  /** The card's message id (cloudAgentCardKey): one per conversation and kind, and how the web tells the kind. */
  cardKey(conversationId: string): string {
    return cloudAgentCardKey(this.adapter.spec, conversationId, this.kind);
  }
}

/** What a key-based adapter is built with: the provider's key on this machine, and the fetch its client uses (tests). */
export interface KeyedCloudAdapterOptions {
  /** The provider's key on this machine, or null. */
  readKey: () => string | null;
  fetchImpl?: typeof fetch;
}

/** A key-based provider's API client from the machine's key, or the card that says the machine has none. */
export function keyedCloudClient<C>(adapter: Pick<AnyCloudAgentAdapter, "spec">, readKey: () => string | null, make: (key: string) => C): C | CloudAgentSetupError {
  const key = readKey();
  return key ? make(key) : CloudAgentSetupError.credentialsMissing(adapter);
}

/**
 * A message the provider may have acted on though codecast could not read
 * its answer (a create whose answer changed shape): it is not sent again,
 * since that could start the agent twice. `unreadable` is what could not be
 * read: the daemon's log names it, the card does not.
 */
export class CloudAgentUnsentError extends Error {
  constructor(readonly adapter: Pick<AnyCloudAgentAdapter, "spec">, readonly unreadable: Error) {
    super(cloudAgentUnsentProblem(adapter.spec));
  }
  /** The card's message id (cloudAgentCardKey): one per message that went unread (each is its own). */
  cardKey(conversationId: string, now = Date.now()): string {
    return cloudAgentCardKey(this.adapter.spec, conversationId, "unsent", now);
  }
}

/** How often a follow-up held behind a running turn is tried again (against the mirror's last read, not the provider). */
const BUSY_RECHECK_MS = 5_000;

/** A follow-up the agent cannot take yet (a turn is still going). Held by the delivery layer, with its reason, until the turn ends. */
export class CloudAgentBusyError extends CloudAgentHoldError {
  readonly holdReason: string;
  readonly recheckMs = BUSY_RECHECK_MS;
  constructor(label: string) {
    super(`AGENT_STDIN_NOT_READY: the ${label} agent is still running the previous message`);
    this.holdReason = `waiting for ${label} to finish the running turn`;
  }
}
