import { AgentIcon } from "../ConversationList";
import { AgentTypeIcon } from "../AgentTypeIcon";
import { SessionFace } from "../identity/SessionFace";
import { useConversationSpeaker } from "../../hooks/useLiveIdentityRow";

// "Ping Hazel" / "Ping Claude": the conversation's agent as it speaks there
// (a role's or character's face and name, else the agent's logo and name),
// styled like the other comment buttons. Asks that agent to reply in this
// thread.
export function PingAgentButton({ conversationId, agentType, onClick, compact }: { conversationId: string; agentType?: string; onClick: () => void; compact?: boolean }) {
  const speaker = useConversationSpeaker(conversationId, agentType);
  return (
    <button
      type="button"
      className={compact ? "cc-cmt-tool cc-ping-btn cc-ping-tool" : "cc-comment-btn cc-ping-btn"}
      onClick={onClick}
      title={`Ping ${speaker.name} to reply in this thread`}
      aria-label={`Ping ${speaker.name}`}
      data-comment-ping
    >
      {speaker.row
        ? <SessionFace row={speaker.row} size={compact ? 12 : 14} badge={<AgentTypeIcon agentType={agentType || "claude_code"} className="w-full h-full p-[1px]" />} />
        : <AgentIcon agentType={agentType || "claude_code"} className={compact ? "w-3 h-3 rounded-[3px]" : "w-3.5 h-3.5 rounded-[3px]"} />}
      {compact ? "Ask" : <>Ping {speaker.name}</>}
    </button>
  );
}
