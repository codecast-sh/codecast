// Who an agent speaks as, on every line that names the speaker of its words
// (a transcript turn, a search hit, a shared message, a comment): a role's
// face and given name, a character's face and name, or for a plain session
// the agent's mark and product name. The agent brand rides a face as a corner
// badge (session-characters.md S3).
import { AgentTypeIcon } from "../AgentTypeIcon";
import { AssistantIcon } from "../conversation/blocks/shared";
import { useAgentSpeaker } from "../../hooks/useLiveIdentityRow";
import type { IdentityRow } from "../../lib/sessionIdentity";
import { IdentityFace, IdentityHover } from "./IdentityFace";

export function AgentSpeaker({ row, agentType, size = 24, nameClassName = "text-sol-text-secondary text-xs font-medium" }: {
  row: IdentityRow | null;
  agentType?: string | null;
  size?: number;
  nameClassName?: string;
}) {
  const speaker = useAgentSpeaker(row, agentType);
  if (!speaker.row) {
    // AssistantIcon draws at 24 px; a smaller line scales it down.
    const icon = <AssistantIcon agentType={agentType ?? undefined} />;
    return (
      <>
        {size === 24 ? icon : (
          <span className="flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
            <span style={{ transform: `scale(${size / 24})` }}>{icon}</span>
          </span>
        )}
        <span className={nameClassName}>{speaker.name}</span>
      </>
    );
  }
  // Face and name are one hover target: a role opens its card from either.
  return (
    <IdentityHover row={speaker.row} triggerClassName="inline-flex items-center gap-2 cursor-default">
      <IdentityFace
        row={speaker.row}
        size={size}
        hover={false}
        badge={<AgentTypeIcon agentType={agentType || "claude_code"} className="w-full h-full p-[1px]" />}
      />
      <span className={nameClassName}>{speaker.name}</span>
    </IdentityHover>
  );
}
