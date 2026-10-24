import { AgentIcon } from "../ConversationList";
import { AgentTypeIcon } from "../AgentTypeIcon";
import { SessionFace } from "../identity/SessionFace";
import { useConversationSpeaker } from "../../hooks/useLiveIdentityRow";

// "Ping Hazel" / "Ping Claude": the conversation's agent as it speaks there
// (a role's or character's face and name, else the agent's logo and name),
// styled like the other comment buttons. Asks that agent to reply in this
// thread.
export function PingAgentButton({ conversationId, agentType, onClick }: { conversationId: string; agentType?: string; onClick: () => void }) {
  const speaker = useConversationSpeaker(conversationId, agentType);
  return (
    <button
      type="button"
      className="cc-comment-btn cc-ping-btn"
      onClick={onClick}
      title={`Ping ${speaker.name} to reply in this thread`}
    >
      {speaker.row
        ? <SessionFace row={speaker.row} size={14} badge={<AgentTypeIcon agentType={agentType || "claude_code"} className="w-full h-full p-[1px]" />} />
        : <AgentIcon agentType={agentType || "claude_code"} className="w-3.5 h-3.5 rounded-[3px]" />}
      Ping {speaker.name}
    </button>
  );
}
