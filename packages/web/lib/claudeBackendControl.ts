// What the "Runs in" control offers for a Claude session: tmux or the Agent
// SDK, which one it is on, and what pressing the other does. Pure, so the
// header pill and the session control panel say the same thing.

import { CLAUDE_BACKEND_LABELS, MID_TURN_AGENT_STATUSES, isHostedAgentType, type ClaudeBackend } from "@codecast/shared/contracts";

export type BackendSwitching = { moving: ClaudeBackend } | { failed: string } | null;

export interface BackendRow {
  backend: ClaudeBackend;
  label: string;
  /** What this backend gives up next to the other, at a glance. */
  hint: string;
  current: boolean;
  /** Pressing it: switch, interrupt the running turn then switch, or nothing (current, or a switch in flight). */
  action: "switch" | "interrupt_and_switch" | null;
  /** The row's own verb when pressing it acts. */
  verb?: string;
}

// The SDK path's gaps (docs/architecture/claude-sdk-backend.md parity matrix) are named on its row.
const HINTS: Record<ClaudeBackend, string> = {
  tmux: "A pane you can watch and attach to",
  sdk: "No pane to attach · never parked when idle",
};

/** Only a started local Claude session has a backend to move. */
export function canSwitchClaudeBackend(agentType: string | undefined, sessionId: string | null | undefined, messageCount: number | undefined): boolean {
  if (isHostedAgentType(agentType) || (agentType && agentType !== "claude_code")) return false;
  return !!sessionId && (messageCount ?? 0) > 0;
}

export function turnRunning(agentStatus: string | null | undefined): boolean {
  return MID_TURN_AGENT_STATUSES.has(agentStatus ?? "");
}

export function backendRows(backend: ClaudeBackend, agentStatus: string | null | undefined, switching: BackendSwitching): BackendRow[] {
  const moving = switching && "moving" in switching ? switching.moving : null;
  const busy = turnRunning(agentStatus);
  return (["tmux", "sdk"] as const).map((b) => {
    const current = b === backend;
    const action = current || moving ? null : busy ? "interrupt_and_switch" as const : "switch" as const;
    const target = b === "sdk" ? "the Agent SDK" : "the terminal";
    return {
      backend: b,
      label: CLAUDE_BACKEND_LABELS[b],
      hint: moving === b ? "Moving…" : HINTS[b],
      current,
      action,
      ...(action === "interrupt_and_switch" ? { verb: `Stop the turn, move to ${target}` } : {}),
    };
  });
}
