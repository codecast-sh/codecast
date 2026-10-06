// The agent a new conversation starts with, decided in one place for every
// new-conversation surface (the compose popup, Ctrl+N, the context composer,
// the store's create fallback). The preference has one home,
// `client_state.ui.default_agent`; hosted mode and an account with no machine
// default to the hosted assistant, since nothing else can answer there.
// Pure, so the store's create fallback reads it without an import cycle; the
// live hook is useDefaultAgentType (hooks/usePinnedAgents).
import { fromConvexAgentType, toConvexAgentType, type ConvexAgentType } from "@codecast/shared/contracts";
import { HOSTED_AGENT_TYPE } from "@codecast/shared/contracts/assistant";

/** The developer default when nothing else decides. */
const LOCAL_DEFAULT: ConvexAgentType = "claude_code";

/** The slice of store state the default reads. */
export type DefaultAgentState = {
  clientState: { ui?: { lane?: string; default_agent?: string } | null };
  machineRoster: readonly unknown[];
  machineRosterLive: boolean;
};

/** A stored agent_type the registry knows, in the Convex spelling, or null. */
function knownAgentType(value: string | null | undefined): ConvexAgentType | null {
  if (!value) return null;
  const spelled = toConvexAgentType(fromConvexAgentType(value));
  return spelled === value ? spelled : null;
}

/** True once the live roster has answered and lists no machine at all. A
 *  roster that has not answered yet is never read as "no machine". */
export function hasNoMachine(s: Pick<DefaultAgentState, "machineRoster" | "machineRosterLive">): boolean {
  return s.machineRosterLive && s.machineRoster.length === 0;
}

/** Where only the hosted assistant can answer: hosted mode, or an account
 *  with no machine to run a local agent on. */
function onlyHosted(s: DefaultAgentState): boolean {
  return s.clientState.ui?.lane === "simple" || hasNoMachine(s);
}

/** The viewer's default agent: the hosted assistant where only it can
 *  answer, else their own pick, else Claude. */
export function defaultAgentType(s: DefaultAgentState): ConvexAgentType {
  if (onlyHosted(s)) return HOSTED_AGENT_TYPE;
  return knownAgentType(s.clientState.ui?.default_agent) ?? LOCAL_DEFAULT;
}

/** The agent for a new conversation opened beside `inherit` (the agent of
 *  the conversation on screen, or a resumed draft's). Where only the hosted
 *  assistant can answer it always starts; otherwise the conversation's own
 *  agent carries over, as it always has, and the default fills in. */
export function newConversationAgentType(s: DefaultAgentState, inherit?: string | null): ConvexAgentType {
  if (onlyHosted(s)) return HOSTED_AGENT_TYPE;
  return knownAgentType(inherit) ?? defaultAgentType(s);
}
