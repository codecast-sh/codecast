/**
 * Cloud agent providers: agent sessions that run on a vendor's machines and
 * that codecast both mirrors and drives (start, follow-up, interrupt) through
 * the daemon. Cursor Cloud Agents is the first. Each entry is what the web,
 * the daemon and the launch path need to tell a provider's sessions apart:
 * the agent type it runs under, the launch model keys that select it, the id
 * its sessions carry, where it opens, and how its setup cards read.
 *
 * The daemon's side (API client, mirror, delivery) lives in
 * packages/cli/src/cloudAgents; the web's in components/cloudAgents.
 */
import type { CloudSessionSource } from "./cloudSessionSync";

export interface CloudAgentProviderSpec {
  id: string;
  /** The agent type its sessions run under (conversations.agent_type). */
  agentType: string;
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
  /** Matches the daemon's setup card for missing or refused credentials. */
  credentialError: RegExp;
  /** The Provider Keys entry its credential is, when it is an API key. */
  keyProvider?: string;
  /** Tooltip on the composer's "run in the cloud" switch. */
  toggleTitle: string;
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
    credentialError: /Cursor API key|Cursor rejected the API key/i,
    keyProvider: "cursor",
    toggleTitle: "Run this session as a Cursor Cloud Agent: on Cursor's machines, on this repository's branch as it is on GitHub. Messages you send become its follow-ups.",
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

/** Providers an agent type can run on in the cloud (the composer's toggle). */
export function cloudAgentProvidersFor(agentType: string | undefined | null): CloudAgentProviderSpec[] {
  return agentType ? SPECS.filter((s) => s.agentType === agentType) : [];
}

/** The provider a session runs on, from its agent type and session id; null for a local one. */
export function cloudAgentProviderOfSession(agentType: string | undefined | null, sessionId: string | undefined | null): CloudAgentProviderSpec | null {
  if (!agentType || !sessionId) return null;
  return SPECS.find((s) => s.agentType === agentType && sessionId.startsWith(s.sessionIdPrefix)) ?? null;
}

/** The provider whose credential setup card this is (the daemon's "needs a key" / "rejected" card). */
export function cloudAgentCredentialError(agentType: string | undefined | null, message: string): CloudAgentProviderSpec | null {
  if (!agentType) return null;
  return SPECS.find((s) => s.agentType === agentType && s.credentialError.test(message)) ?? null;
}
