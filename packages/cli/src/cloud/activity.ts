import { MID_TURN_AGENT_STATUSES } from "@codecast/shared/contracts";
import { HIBERNATE_SUBAGENT_QUIET_MS } from "../hibernation.js";

export function hasActiveCloudWork(statuses: Iterable<string>, activeTurns: number, subagentActivity: Iterable<number> = []): boolean {
  return activeTurns > 0 || [...statuses].some((status) =>
    MID_TURN_AGENT_STATUSES.has(status) || status === "waiting" || status === "starting" || status === "resuming",
  ) || [...subagentActivity].some((age) => Number.isNaN(age) || age < HIBERNATE_SUBAGENT_QUIET_MS);
}
