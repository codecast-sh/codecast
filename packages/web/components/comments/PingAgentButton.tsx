import { AgentIcon } from "../ConversationList";
import { agentDisplayName } from "../../lib/commentThread";

// "Ping Claude" / "Ping Codex" — the conversation's own agent logo + name, styled
// like the other comment buttons (no sparkle, no violet). Asks that agent to
// reply in this thread.
export function PingAgentButton({ agentType, onClick }: { agentType?: string; onClick: () => void }) {
  const name = agentDisplayName(agentType);
  return (
    <button
      type="button"
      className="cc-comment-btn cc-ping-btn"
      onClick={onClick}
      title={`Ping ${name} to reply in this thread`}
    >
      <AgentIcon agentType={agentType || "claude_code"} className="w-3.5 h-3.5 rounded-[3px]" />
      Ping {name}
    </button>
  );
}
