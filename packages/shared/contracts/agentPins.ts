// Which agents a viewer's pickers offer (users.pinned_agents), kept out of
// agentClients.ts for its line cap. The registry lives there.

import {
  AGENT_CLIENTS,
  AGENT_LAUNCH_OPTIONS,
  AGENT_PICKER_OPTIONS,
  type AgentClientCommon,
  type AgentClientId,
  type AgentLaunchOption,
  type AgentPickerOption,
} from "./agentClients";

/** The clients every pin list saved before users.pinned_agents_known existed
 *  was chosen from: the registry as it stood until antigravity (2026-11-22),
 *  the first client added after pinning shipped (2026-10-02). Frozen. */
const PINS_KNOWN_BEFORE_RECORDING: readonly string[] = [
  "claude", "codex", "cursor", "gemini", "opencode", "pi", "grok", "muse", "codecast",
];

/** The agents a user has pinned: their own list (users.pinned_agents) once
 *  they have set one, else every client pinned by default. Unknown ids drop.
 *  A saved list only decides the clients that existed when it was saved
 *  (`known`, users.pinned_agents_known): a client added since follows its own
 *  default, so a new agent reaches every picker instead of staying hidden from
 *  everyone who ever changed a pin. */
export function pinnedAgentIds(pins: readonly string[] | null | undefined, known?: readonly string[] | null): AgentClientId[] {
  const all = Object.values(AGENT_CLIENTS) as AgentClientCommon[];
  const byDefault = (d: AgentClientCommon) => d.pinnedByDefault !== false;
  if (!pins) return all.filter(byDefault).map((d) => d.id);
  const decided = known ?? PINS_KNOWN_BEFORE_RECORDING;
  return all.filter((d) => pins.includes(d.id) || (!decided.includes(d.id) && byDefault(d))).map((d) => d.id);
}

/** The client ids a pin list saved now is chosen from (users.pinned_agents_known). */
export function pinnableAgentIds(): AgentClientId[] {
  return Object.keys(AGENT_CLIENTS) as AgentClientId[];
}

/** A new-conversation picker's row: the pinned agents plus `keep` (the agent
 *  the conversation already has, or the default) so it always names itself. */
export function pinnedPickerOptions(pins: readonly string[] | null | undefined, keep?: AgentClientId | null, known?: readonly string[] | null): AgentPickerOption[] {
  const shown = new Set<AgentClientId>(pinnedAgentIds(pins, known));
  if (keep) shown.add(keep);
  return AGENT_PICKER_OPTIONS.filter((o) => shown.has(o.id));
}

/** The agent row a picker shows: the pinned agents, plus `keep` (the agent a
 *  session already runs) so an unpinned one still names itself. Registry order.
 *  `pins` is an already resolved list (usePinnedAgentIds), taken exactly. */
export function pinnedLaunchOptions(pins: readonly string[] | null | undefined, keep?: AgentClientId | null): AgentLaunchOption[] {
  const shown = new Set<AgentClientId>(pinnedAgentIds(pins, pinnableAgentIds()));
  if (keep) shown.add(keep);
  return AGENT_LAUNCH_OPTIONS.filter((o) => shown.has(o.id));
}
