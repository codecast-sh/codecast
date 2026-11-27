import type { MarkDef } from "./types";

// The inbox rail's own marks: card flags, subagents running, triggers, agent type,
// and the conversation header's terminal pill.

type Def = Omit<MarkDef, "group">;
const inbox = (defs: Def[]): MarkDef[] => defs.map((d) => ({ ...d, group: "Inbox" }));

const AGENT_MEANING = "The agent running this session";

/** The agent a session runs on (components/AgentTypeIcon), by agent_type. */
export function agentMarkId(agentType: string, hosted: boolean): string {
  if (agentType === "codex_cli") return "agent.codex";
  if (hosted) return "agent.cast";
  return `agent.${agentType}`;
}

export const inboxMarks: MarkDef[] = inbox([
  { id: "agent.claude_code", name: "Claude Code", meaning: AGENT_MEANING },
  { id: "agent.codex", name: "Codex", meaning: AGENT_MEANING },
  { id: "agent.cursor", name: "Cursor", meaning: AGENT_MEANING },
  { id: "agent.gemini", name: "Gemini", meaning: AGENT_MEANING },
  { id: "agent.opencode", name: "OpenCode", meaning: AGENT_MEANING },
  { id: "agent.pi", name: "Pi", meaning: AGENT_MEANING },
  { id: "agent.grok", name: "Grok", meaning: AGENT_MEANING },
  { id: "agent.muse", name: "Muse Spark", meaning: AGENT_MEANING },
  { id: "agent.antigravity", name: "Antigravity", meaning: AGENT_MEANING },
  { id: "agent.cast", name: "Cast", meaning: "Codecast's own agent, hosted in the cloud" },

  { id: "inbox.favorite", name: "Favorite", meaning: "You starred it" },
  { id: "inbox.mine", name: "Mine", meaning: "Kept from the team; only you see it" },
  { id: "inbox.team", name: "Team session", meaning: "Everyone on the team has it" },
  { id: "inbox.pinned", name: "Pinned", meaning: "Kept in place at the top" },

  { id: "inbox.blocked", name: "Blocked", meaning: "Sessions stuck on a limit, sign-in or error" },
  { id: "inbox.blocked_workers", name: "Workers blocked", meaning: "Subagent workers are stuck" },
  { id: "inbox.snoozed", name: "Snoozed", meaning: "Hidden until a time you chose" },

  { id: "inbox.spawned", name: "Spawned session", meaning: "A subagent or worker the session above started" },
  { id: "inbox.reports_to", name: "Reports to", meaning: "Its role answers to the one above" },
  { id: "inbox.trigger_run", name: "Trigger run", meaning: "Started by the trigger above" },
  { id: "inbox.inside", name: "Inside this session", meaning: "A trigger, background job, workflow or wake that belongs to the session" },
  { id: "inbox.running", name: "Running", meaning: "A run or background job is live now" },
  { id: "inbox.run_failed", name: "Run failed", meaning: "The trigger's last run failed" },
  { id: "inbox.run_flagged", name: "Run flagged", meaning: "The trigger's last run asked for a look" },
  { id: "inbox.subagents_running", name: "Subagents running", meaning: "Subagents running now, folded under the card" },

  { id: "inbox.label", name: "Label", meaning: "The label it's filed under" },
  { id: "inbox.repo", name: "Repository", meaning: "The repository it runs in" },
  { id: "inbox.flow", name: "Flow run", meaning: "Works for a run of a flow" },
  { id: "inbox.worktree", name: "Worktree", meaning: "Runs in a checkout of its own" },
  { id: "inbox.ship", name: "Shipping", meaning: "This session's change is going out" },
  { id: "inbox.parent", name: "Parent session", meaning: "The session that started it or handed it off" },
  { id: "inbox.implementation", name: "Implementation", meaning: "The session building its plan" },
  { id: "inbox.role_sessions", name: "Role's sessions", meaning: "Sessions under this role" },
  { id: "inbox.comments", name: "Comment threads", meaning: "Open comment threads on it" },

  { id: "inbox.priority_rank", name: "Priority rank", meaning: "Which of your priorities it serves, by rank" },
  { id: "inbox.priority_workspace", name: "Other workspace", meaning: "That priority lives in another workspace", oneGlyph: true },

  // The triage view's lanes and, in Needs you, what the person is asked to do.
  { id: "triage.you", name: "Triage: needs you", meaning: "Waiting on you to act" },
  { id: "triage.agent", name: "Triage: working", meaning: "An agent is on it now" },
  { id: "triage.parked", name: "Triage: parked", meaning: "Waits on a wake, not on you" },
  { id: "triage.settled", name: "Triage: settled", meaning: "Nothing running, nothing asked" },
  { id: "triage.answer", name: "Answer", meaning: "The agent asked you something" },
  { id: "triage.fix", name: "Fix", meaning: "It stopped on a failure you clear" },
  { id: "triage.review", name: "Review", meaning: "Finished; read what it did" },

  { id: "device.computer", name: "Computer", meaning: "Runs on a laptop or desktop" },
  { id: "device.linux", name: "Linux machine", meaning: "Runs on a Linux box" },
  { id: "device.cloud", name: "Cloud host", meaning: "Runs on a machine in the cloud" },
  { id: "device.custom", name: "Machine", meaning: "Runs here, in the icon its owner chose", oneGlyph: true },
  { id: "device.online", name: "Online", meaning: "The machine is connected now" },
  { id: "device.offline", name: "Offline", meaning: "The machine isn't connected" },
  { id: "inbox.terminal", name: "Terminal", meaning: "The tmux pane the agent runs in" },
  { id: "inbox.terminal_live", name: "Terminal live", meaning: "The agent is active in its pane now" },
  { id: "inbox.terminal_quiet", name: "Terminal quiet", meaning: "Not heard from lately; the pane may still be open" },
]);
