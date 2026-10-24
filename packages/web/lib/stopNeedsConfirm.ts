import type { RunningSubagent } from "./runningSubagents";
import { useInboxStore } from "../store/inboxStore";

/** Whether a stop that would take these subagents with it asks first. */
export function stopNeedsConfirm(subagents: RunningSubagent[]): boolean {
  return subagents.length > 0 && useInboxStore.getState().clientState?.ui?.confirm_stop_subagents !== false;
}
