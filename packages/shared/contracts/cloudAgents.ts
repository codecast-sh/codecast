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
  /** The agent's page on the vendor's site. */
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
  /** Tooltip on the composer's "run in the cloud" switch. */
  toggleTitle: string;
  /** Offered by the composer's "run in the cloud" switch (a provider can sync before codecast starts its agents). */
  composer: boolean;
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
    agentUrl: (id: string) => `https://chatgpt.com/codex/tasks/${id}`,
    mirrorDir: "codex-cloud",
    credentialCards: {
      missing: "Codex Cloud needs a Codex sign-in on {machine}.",
      rejected: "Codex refused the sign-in on {machine}",
      expired: "The Codex sign-in on {machine} expired",
      holdReason: "waiting for a Codex sign-in on {machine}",
    },
    repoAccessUrl: "https://chatgpt.com/codex/settings/environments",
    toggleTitle: "Run this session as a Codex Cloud task: on OpenAI's machines, in this repository's Codex environment, on your ChatGPT plan. Messages you send become its follow-ups.",
    composer: false,
  },
} satisfies Record<string, CloudAgentProviderSpec>;

export type CloudAgentProviderId = keyof typeof CLOUD_AGENT_PROVIDERS;

const SPECS: CloudAgentProviderSpec[] = Object.values(CLOUD_AGENT_PROVIDERS);

/** The provider a model key selects for an agent type: "" model = the account default. */
function parseCloudModel(agentType: string | undefined | null, model: string | undefined | null): { spec: CloudAgentProviderSpec; model: string } | null {
  if (!agentType || !model) return null;
  for (const spec of SPECS) {
    if (spec.agentType !== agentType) continue;
    if (model === spec.modelPrefix) return { spec, model: "" };
    if (model.startsWith(`${spec.modelPrefix}:`)) return { spec, model: model.slice(spec.modelPrefix.length + 1) };
  }
  return null;
}

/**
 * A launch model choice that runs on a cloud agent provider: "" for the
 * account's default model, else the provider's model id; null for a local
 * launch (the key then reaches the client's own `--model` flag).
 */
export function cloudAgentModel(agentType: string | undefined | null, model: string | undefined | null): string | null {
  return parseCloudModel(agentType, model)?.model ?? null;
}

/** The provider a launch model key selects, or null for a local launch. */
export function cloudAgentProviderForLaunch(agentType: string | undefined | null, model: string | undefined | null): CloudAgentProviderSpec | null {
  return parseCloudModel(agentType, model)?.spec ?? null;
}

/** Providers an agent type can start on in the cloud (the composer's toggle). */
export function cloudAgentProvidersFor(agentType: string | undefined | null): CloudAgentProviderSpec[] {
  return agentType ? SPECS.filter((s) => s.agentType === agentType && s.composer) : [];
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

/**
 * Whether a sign-in codecast only reads (never refreshes) has run out: its
 * access token's expiry is past. One rule for the daemon, which stops reading
 * the provider, and the web, which stops calling the machine connected.
 */
export function signInExpired(expiresAt: number | undefined | null, now: number): boolean {
  return typeof expiresAt === "number" && expiresAt <= now;
}

/** Whether a message is any provider's credential setup card: an auth banner, whatever its wording. */
export function isCloudAgentCredentialCard(message: string): boolean {
  return SPECS.some((s) => isCredentialCard(s, message));
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

/** What keeps a machine from reading a provider at all, as its heartbeat reports it (devices.cloud_agent_blocks). */
export interface CloudAgentSetupBlock {
  provider: string;
  kind: CloudAgentSetupKind;
  /** The provider's reason, or the vendor's sentence saying what to fix. */
  reason?: string;
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
