/**
 * Cloud agent providers: agent sessions that run on a vendor's machines and
 * that codecast both mirrors and drives (start, follow-up, interrupt) through
 * the daemon: Cursor Cloud Agents and Codex Cloud. Each entry is what the web,
 * the daemon and the launch path need to tell a provider's sessions apart:
 * the agent type it runs under, the launch model keys that select it, the id
 * its sessions carry, where it opens, and how its setup cards read.
 *
 * The daemon's side (API client, mirror, delivery) lives in
 * packages/cli/src/cloudAgents; the web's in components/cloudAgents.
 */
import type { AgentClientId } from "./agentClients";
import type { CloudSessionSource } from "./cloudSessionSync";
import type { ModelOption } from "./modelOptions";

export interface CloudAgentProviderSpec {
  id: string;
  /** The agent type its sessions run under (conversations.agent_type). */
  agentType: AgentClientId;
  /** Short name for chips and toggles: "Cursor Cloud". */
  label: string;
  /** The account's "sync this source" setting (CLOUD_SESSION_SOURCES). */
  syncSource: CloudSessionSource;
  /**
   * Launch model keys that pick this provider: `<prefix>` for the account's
   * default model, `<prefix>:<model id>` for one model.
   */
  modelPrefix: string;
  /** The id every session it runs carries (conversations.session_id). */
  sessionIdPrefix: string;
  /** The agent's page on the vendor's site, for its session id or a branch's (cloudAgentRootId). */
  agentUrl: (sessionId: string) => string;
  /** The daemon's mirror directory under ~/.codecast (transcripts, state, sessions). */
  mirrorDir: string;
  /**
   * The daemon's setup card copy for missing or refused credentials: the
   * daemon writes it and the web recognizes the card by it, so the card and
   * its connect control can never drift apart. `{machine}` is where the
   * daemon names the machine it runs on (CLOUD_AGENT_MACHINE).
   */
  credentialCards: {
    /** The card when the machine has no credentials. */
    missing: string;
    /** Opens the card when the provider refuses them (the provider's reason follows). */
    rejected: string;
    /** Opens the card when a sign-in codecast only reads ran out (its date follows); else it reads as rejected. */
    expired?: string;
    /** The held message's reason while any of them is the case. */
    holdReason: string;
  };
  /** The Provider Keys entry its credential is, when it is an API key. */
  keyProvider?: string;
  /** Where the person gives the provider access to a repository (named on the "can't reach the repository" card and in the connect dialog). */
  repoAccessUrl: string;
  /**
   * A sign-in based provider's own CLI sign-in: `argv` opens the machine's
   * browser; a machine with no browser (a cloud host) signs in with
   * `headlessArgv`, which prints a link to open on any device.
   */
  login?: { argv: string[]; headlessArgv: string[] };
  /** Tooltip on the composer's "run in the cloud" switch. */
  toggleTitle: string;
  /** Offered by the composer's "run in the cloud" switch (a provider can sync before codecast starts its agents). */
  composer: boolean;
  /**
   * What the composer offers beside its switch, carried in the launch model
   * key (cloudAgentLaunchKey): an ask mode that answers without changing
   * code, and how many attempts the agent makes at the first message.
   */
  launchOptions?: { ask: boolean; maxAttempts: number };
  /** What a session's header offers on the agent itself (CLOUD_AGENT_ACTIONS). */
  actions?: readonly CloudAgentActionName[];
}

/**
 * What a session's header can do to its cloud agent, run by the daemon that
 * hosts the session: open a draft pull request from the branch's changes,
 * apply them to this machine's checkout, archive the agent on the provider's
 * site or bring it back. `needsChanges`: nothing to act on when the agent
 * changed no code (an ask task).
 */
export const CLOUD_AGENT_ACTIONS = {
  create_pr: { label: "Create draft PR", title: "Open a draft pull request with this branch's changes", needsChanges: true },
  apply: { label: "Apply locally", title: "Apply this branch's changes to the repository's checkout on the machine that runs the session", needsChanges: true },
  archive: { label: "Archive", title: "Archive the task on the provider's site (it stays here)", needsChanges: false },
  unarchive: { label: "Unarchive", title: "Bring an archived task back on the provider's site", needsChanges: false },
} as const;
export type CloudAgentActionName = keyof typeof CLOUD_AGENT_ACTIONS;

/** The system row an action's result is said in (the session's thread shows it; no work state or summary reads it). */
export const CLOUD_AGENT_ACTION_SUBTYPE = "cloud_agent_action";

export function isCloudAgentActionName(value: unknown): value is CloudAgentActionName {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CLOUD_AGENT_ACTIONS, value);
}

export const CLOUD_AGENT_PROVIDERS = {
  cursor: {
    id: "cursor",
    agentType: "cursor",
    label: "Cursor Cloud",
    syncSource: "cursor",
    modelPrefix: "cloud",
    sessionIdPrefix: "bc-",
    agentUrl: (id: string) => `https://cursor.com/agents/${id}`,
    mirrorDir: "cursor-cloud",
    credentialCards: {
      missing: "Cursor Cloud needs a Cursor API key on {machine}.",
      rejected: "Cursor rejected the API key on {machine}",
      holdReason: "waiting for a Cursor API key on {machine}",
    },
    keyProvider: "cursor",
    repoAccessUrl: "https://cursor.com/dashboard/integrations",
    toggleTitle: "Run this session as a Cursor Cloud Agent: on Cursor's machines, on this repository's branch as it is on GitHub. Messages you send become its follow-ups.",
    composer: true,
  },
  // Codex Cloud (chatgpt.com/codex): tasks on OpenAI's machines, on the
  // person's ChatGPT plan, read and driven with the machine's own `codex
  // login` (never a key, never refreshed by codecast).
  codex: {
    id: "codex",
    agentType: "codex",
    label: "Codex Cloud",
    syncSource: "codex",
    modelPrefix: "cloud",
    sessionIdPrefix: "task_",
    agentUrl: (id: string) => `https://chatgpt.com/codex/tasks/${cloudAgentRootId(id)}`,
    mirrorDir: "codex-cloud",
    credentialCards: {
      missing: "Codex Cloud needs a Codex sign-in on {machine}.",
      rejected: "Codex refused the sign-in on {machine}",
      expired: "The Codex sign-in on {machine} expired",
      holdReason: "waiting for a Codex sign-in on {machine}",
    },
    repoAccessUrl: "https://chatgpt.com/codex/settings/environments",
    login: { argv: ["codex", "login"], headlessArgv: ["codex", "login", "--device-auth"] },
    toggleTitle: "Run this session as a Codex Cloud task: on OpenAI's machines, in this repository's Codex environment, on your ChatGPT plan. Messages you send become its follow-ups.",
    composer: true,
    launchOptions: { ask: true, maxAttempts: 4 },
    actions: ["create_pr", "apply", "archive", "unarchive"],
  },
} satisfies Record<string, CloudAgentProviderSpec>;

export type CloudAgentProviderId = keyof typeof CLOUD_AGENT_PROVIDERS;

const SPECS: CloudAgentProviderSpec[] = Object.values(CLOUD_AGENT_PROVIDERS);

/**
 * What a cloud launch asks for: the provider's model id ("" = the account's
 * default), ask mode (answer without changing code) and how many attempts it
 * makes at the first message. Options the provider does not offer read as off.
 */
export interface CloudAgentLaunch { model: string; ask: boolean; attempts: number }

const ASK_TOKEN = "ask";
const ATTEMPTS_TOKEN = /^x([1-9])$/;

/**
 * The provider a model key selects for an agent type, and the launch it
 * asks for. A key is `<prefix>` or `<prefix>:<token>+<token>...`: `ask`,
 * `x<n>` (attempts) and at most one model id.
 */
function parseCloudModel(agentType: string | undefined | null, key: string | undefined | null): { spec: CloudAgentProviderSpec; launch: CloudAgentLaunch } | null {
  if (!agentType || !key) return null;
  for (const spec of SPECS) {
    if (spec.agentType !== agentType) continue;
    if (key !== spec.modelPrefix && !key.startsWith(`${spec.modelPrefix}:`)) continue;
    const launch: CloudAgentLaunch = { model: "", ask: false, attempts: 1 };
    for (const token of key.slice(spec.modelPrefix.length + 1).split("+").filter(Boolean)) {
      const attempts = ATTEMPTS_TOKEN.exec(token);
      if (token === ASK_TOKEN && spec.launchOptions?.ask) launch.ask = true;
      else if (attempts && spec.launchOptions) launch.attempts = Math.min(Number(attempts[1]), spec.launchOptions.maxAttempts);
      else if (token !== ASK_TOKEN && !attempts) launch.model = token;
    }
    return { spec, launch };
  }
  return null;
}

/** The launch model key for a provider's launch: the inverse of cloudAgentLaunch. */
export function cloudAgentLaunchKey(spec: CloudAgentProviderSpec, launch: Partial<CloudAgentLaunch>): string {
  const tokens = [
    ...(launch.model ? [launch.model] : []),
    ...(launch.ask && spec.launchOptions?.ask ? [ASK_TOKEN] : []),
    ...(launch.attempts && launch.attempts > 1 && spec.launchOptions ? [`x${Math.min(launch.attempts, spec.launchOptions.maxAttempts)}`] : []),
  ];
  return tokens.length ? `${spec.modelPrefix}:${tokens.join("+")}` : spec.modelPrefix;
}

/** The launch a model key asks a cloud agent provider for, or null for a local launch. */
export function cloudAgentLaunch(agentType: string | undefined | null, key: string | undefined | null): CloudAgentLaunch | null {
  return parseCloudModel(agentType, key)?.launch ?? null;
}

/**
 * A launch model choice that runs on a cloud agent provider: "" for the
 * account's default model, else the provider's model id; null for a local
 * launch (the key then reaches the client's own `--model` flag).
 */
export function cloudAgentModel(agentType: string | undefined | null, model: string | undefined | null): string | null {
  return parseCloudModel(agentType, model)?.launch.model ?? null;
}

/** The provider a launch model key selects, or null for a local launch. */
export function cloudAgentProviderForLaunch(agentType: string | undefined | null, model: string | undefined | null): CloudAgentProviderSpec | null {
  return parseCloudModel(agentType, model)?.spec ?? null;
}

/** What a launch asks of its provider beyond running there, in words: "ask", "3 attempts". */
export function cloudAgentLaunchWords(launch: Partial<CloudAgentLaunch>): string[] {
  return [...(launch.ask ? ["ask"] : []), ...(launch.attempts && launch.attempts > 1 ? [`${launch.attempts} attempts`] : [])];
}

/**
 * The model catalog entries a provider's launch options make (the launch
 * path accepts only listed keys, and a stored stamp reads back through the
 * catalog). The plain key is the one a picker lists; the rest are hidden,
 * set by the composer's own controls.
 */
export function cloudAgentLaunchModelOptions(spec: CloudAgentProviderSpec, hint: string): ModelOption[] {
  const opts = spec.launchOptions;
  const out: ModelOption[] = [];
  for (const ask of opts?.ask ? [false, true] : [false]) {
    for (let attempts = 1; attempts <= (opts?.maxAttempts ?? 1); attempts++) {
      const key = cloudAgentLaunchKey(spec, { ask, attempts });
      const label = [spec.label, ...cloudAgentLaunchWords({ ask, attempts })].join(" · ");
      out.push({ key, label, hint, cliAlias: key, ...(key === spec.modelPrefix ? {} : { hidden: true }) });
    }
  }
  return out;
}

/** Providers an agent type can start on in the cloud (the composer's toggle). */
export function cloudAgentProvidersFor(agentType: string | undefined | null): CloudAgentProviderSpec[] {
  return agentType ? SPECS.filter((s) => s.agentType === agentType && s.composer) : [];
}

/** Joins an agent's id and a branch's own id in the branch's id (a Codex Cloud attempt: `<task id>~<turn id>`). */
export const CLOUD_AGENT_BRANCH_SEPARATOR = "~";

/** The agent an id belongs to: an agent's own id, or for a branch of one, the part before the separator. */
export function cloudAgentRootId(id: string): string {
  const at = id.indexOf(CLOUD_AGENT_BRANCH_SEPARATOR);
  return at < 0 ? id : id.slice(0, at);
}

/** Whether a session is a branch of a cloud agent (another attempt of a Codex Cloud task), not the agent's own line. */
export function isCloudAgentBranch(agentType: string | undefined | null, sessionId: string | undefined | null): boolean {
  return !!sessionId && sessionId.includes(CLOUD_AGENT_BRANCH_SEPARATOR) && !!cloudAgentProviderOfSession(agentType, sessionId);
}

/** Whether an id (a session id, a mirror directory name) is one of the provider's agents. */
export function isCloudAgentId(spec: CloudAgentProviderSpec, id: string): boolean {
  return id.startsWith(spec.sessionIdPrefix);
}

/** The provider a session runs on, from its agent type and session id; null for a local one. */
export function cloudAgentProviderOfSession(agentType: string | undefined | null, sessionId: string | undefined | null): CloudAgentProviderSpec | null {
  if (!agentType || !sessionId) return null;
  return SPECS.find((s) => s.agentType === agentType && isCloudAgentId(s, sessionId)) ?? null;
}

/**
 * The provider a conversation runs on: from its agent's id once the agent
 * exists, else from its launch stamp (a cloud session whose first message is
 * held for setup, or not yet sent, still has a local-looking session id).
 * Every rule that treats cloud sessions apart (no model or effort, no switch
 * agent, the provider chip) asks this; null for a local session.
 */
export function cloudAgentProviderOfConversation(agentType: string | undefined | null, sessionId: string | undefined | null, model: string | undefined | null): CloudAgentProviderSpec | null {
  return cloudAgentProviderOfSession(agentType, sessionId) ?? cloudAgentProviderForLaunch(agentType, model);
}

/** The provider behind an account sync source (CLOUD_SESSION_SOURCES), if one is. */
export function cloudAgentProviderForSyncSource(source: string): CloudAgentProviderSpec | null {
  return SPECS.find((s) => s.syncSource === source) ?? null;
}

/** The provider whose credential a Provider Keys entry is. */
export function cloudAgentProviderForKey(keyProvider: string): CloudAgentProviderSpec | null {
  return SPECS.find((s) => s.keyProvider === keyProvider) ?? null;
}

/** Where a card's copy names the machine the daemon runs on. */
export const CLOUD_AGENT_MACHINE = "{machine}";

/** A card's copy with the machine named. */
export function cloudAgentCardText(template: string, machine: string): string {
  return template.split(CLOUD_AGENT_MACHINE).join(machine);
}

const cardPatterns = new Map<string, RegExp>();
/** Matches the card's copy whatever machine it names (cards written before the slot said "this machine"). */
function cardPattern(template: string): RegExp {
  let re = cardPatterns.get(template);
  if (!re) cardPatterns.set(template, (re = new RegExp(template.split(CLOUD_AGENT_MACHINE).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".+?"))));
  return re;
}

function isCredentialCard(spec: CloudAgentProviderSpec, message: string): boolean {
  const { missing, rejected, expired } = spec.credentialCards;
  return [missing, rejected, expired].some((card) => !!card && cardPattern(card).test(message));
}

/** The provider whose credential setup card this is (the daemon's "needs a key" / "rejected" card). */
export function cloudAgentCredentialError(agentType: string | undefined | null, message: string): CloudAgentProviderSpec | null {
  if (!agentType) return null;
  return SPECS.find((s) => s.agentType === agentType && isCredentialCard(s, message)) ?? null;
}

/** Whether a message is any provider's credential setup card: an auth banner, whatever its wording. */
export function isCloudAgentCredentialCard(message: string): boolean {
  return SPECS.some((s) => isCredentialCard(s, message));
}

/**
 * Whether a sign-in codecast only reads (never refreshes) has run out: its
 * access token's expiry is past. One rule for the daemon, which stops reading
 * the provider, and the web, which stops calling the machine connected.
 */
export function signInExpired(expiresAt: number | undefined | null, now: number): boolean {
  return typeof expiresAt === "number" && expiresAt <= now;
}

/** How far back an account's cloud agents are read when its sync switch is on. */
export const CLOUD_AGENT_BACKFILL_DAYS = 30;

/** A sign-in's expiry as the daemon's cards and the web's notes both name it ("Sep 30"). */
export function cloudAgentExpiryDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Where a sign-in based provider's login on a machine stands (the daemon's live check, the connect dialog). */
export const CLOUD_AGENT_LOGIN_STATES = ["signed_in", "signed_out", "expired", "disabled", "unreachable"] as const;
export type CloudAgentLoginStateName = (typeof CLOUD_AGENT_LOGIN_STATES)[number];

export function isCloudAgentLoginState(value: unknown): value is CloudAgentLoginStateName {
  return (CLOUD_AGENT_LOGIN_STATES as readonly unknown[]).includes(value);
}

/**
 * What keeps a message from reaching a provider: no credentials, credentials
 * it refuses or that ran out, a repository it cannot reach, or the account
 * itself refused (the product turned off for a workspace).
 */
export const CLOUD_AGENT_SETUP_KINDS = ["key_missing", "key_invalid", "repo", "access"] as const;
export type CloudAgentSetupKind = (typeof CLOUD_AGENT_SETUP_KINDS)[number];

/** The kinds a new key or sign-in fixes: the daemon rechecks them every few seconds, the rest back off. */
export function isCloudAgentCredentialKind(kind: CloudAgentSetupKind): boolean {
  return kind === "key_missing" || kind === "key_invalid";
}

/** What keeps a machine from reading a provider at all, as its heartbeat reports it (devices.cloud_agent_blocks). */
export interface CloudAgentSetupBlock {
  provider: string;
  kind: CloudAgentSetupKind;
  /** The provider's reason, or the vendor's sentence saying what to fix. */
  reason?: string;
}

/**
 * A setup problem in one sentence, as the daemon's cards and the web's notes
 * both say it, naming the machine: no credentials (`reason`: more to say),
 * refused credentials (`reason`: the provider's words), a sign-in that ran
 * out (`expiredAt`), and for a repository or an account the provider refuses,
 * `reason` is already the vendor's sentence.
 */
export function cloudAgentSetupSentence(spec: CloudAgentProviderSpec, problem: { kind: CloudAgentSetupKind; reason?: string; expiredAt?: number }, machine: string): string {
  const cards = spec.credentialCards;
  const text = (template: string) => cloudAgentCardText(template, machine);
  if (problem.expiredAt !== undefined) {
    const date = cloudAgentExpiryDate(problem.expiredAt);
    return cards.expired ? `${text(cards.expired)} ${date}.` : `${text(cards.rejected)} (it expired ${date}).`;
  }
  if (problem.kind === "key_missing") return problem.reason ? `${text(cards.missing)} ${problem.reason}` : text(cards.missing);
  if (problem.kind === "key_invalid") return `${text(cards.rejected)}${problem.reason ? ` (${problem.reason})` : ""}.`;
  return `${problem.reason ?? `${spec.label} can't be reached from ${machine}`}.`;
}

/**
 * How the daemon's setup cards that are not about credentials end (a
 * repository it cannot reach, an account the provider refuses): the message
 * is held and retried, and the web recognizes the card by it.
 */
export const CLOUD_AGENT_RETRIED_SUFFIX = "; the message retries on its own.";

/** The provider whose non-credential setup card this is (cloudAgentCredentialError is the credential one). */
export function cloudAgentSetupCard(agentType: string | undefined | null, message: string): CloudAgentProviderSpec | null {
  if (!agentType || !message.trim().endsWith(CLOUD_AGENT_RETRIED_SUFFIX)) return null;
  return SPECS.find((s) => s.agentType === agentType) ?? null;
}
