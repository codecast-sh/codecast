import { isAgentTool } from "@codecast/shared/render";
import type { Message } from "../components/conversation/types";

export type RunningSubagent = { id: string; label: string };

// The subagents the running turn launched that have not reported back: Agent
// (Task) calls since the last prompt a person sent with no tool result yet.
// Interrupting the turn stops them too. A background launch answers at once
// and keeps running on its own, so it is never in this list.
export function runningSubagents(messages: readonly Message[] | undefined): RunningSubagent[] {
  if (!messages?.length) return [];
  const answered = new Set<string>();
  const open: RunningSubagent[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    for (const r of m.tool_results ?? []) answered.add(r.tool_use_id);
    for (const tc of m.tool_calls ?? []) {
      if (!isAgentTool(tc.name) || answered.has(tc.id)) continue;
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(tc.input); } catch {}
      if (input.run_in_background || input.background) continue;
      const label = String(input.description || input.name || input.subagent_type || "Subagent");
      open.unshift({ id: tc.id, label });
    }
    if (m.role === "user" && !m.tool_results?.length && m.content?.trim()) break;
  }
  return open;
}
