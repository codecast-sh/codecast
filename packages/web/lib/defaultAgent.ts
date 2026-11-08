// The agent a new conversation starts with, decided in one place for every
// new-conversation surface (the compose popup, Ctrl+N, the context composer,
// the phone's sheet, the store's create fallback). Order: the default the
// person saved (`client_state.ui.default_agent`), else the agent they last
// picked by hand (`last_picked_agent`), else the conversation on screen's,
// else Claude. An account with no machine always gets the hosted assistant,
// since nothing else can answer there.
// Pure, so the store's create fallback reads it without an import cycle; the
// live hook is useDefaultAgentType (hooks/usePinnedAgents).
import { fromConvexAgentType, toConvexAgentType, type ConvexAgentType } from "@codecast/shared/contracts";
import { HOSTED_AGENT_TYPE } from "@codecast/shared/contracts/assistant";

/** The developer default when nothing else decides. */
const LOCAL_DEFAULT: ConvexAgentType = "claude_code";

/** The slice of store state the default reads. */
export type DefaultAgentState = {
  clientState: { ui?: { default_agent?: string | null; last_picked_agent?: string | null } | null };
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

/** Where only the hosted assistant can answer: an account with no machine
 *  to run a local agent on. */
export function onlyHostedAgent(s: DefaultAgentState): boolean {
  return hasNoMachine(s);
}

/** The agent the person said new work starts with: their saved default,
 *  else their last hand pick. Null when they have said nothing. */
function intendedAgentType(s: DefaultAgentState): ConvexAgentType | null {
  const ui = s.clientState.ui;
  return knownAgentType(ui?.default_agent) ?? knownAgentType(ui?.last_picked_agent);
}

/** The viewer's default agent: the hosted assistant where only it can
 *  answer, else their saved default or last pick, else Claude. */
export function defaultAgentType(s: DefaultAgentState): ConvexAgentType {
  if (onlyHostedAgent(s)) return HOSTED_AGENT_TYPE;
  return intendedAgentType(s) ?? LOCAL_DEFAULT;
}

/** The agent for a new conversation opened beside `inherit` (the agent of
 *  the conversation on screen, or a resumed draft's). The person's saved
 *  default and last hand pick come first; the conversation's own agent
 *  fills in when they have neither. */
export function newConversationAgentType(s: DefaultAgentState, inherit?: string | null): ConvexAgentType {
  if (onlyHostedAgent(s)) return HOSTED_AGENT_TYPE;
  return intendedAgentType(s) ?? knownAgentType(inherit) ?? LOCAL_DEFAULT;
}
