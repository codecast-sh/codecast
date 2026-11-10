// The agent badge the comment, thread, repo and feed rows draw beside a
// session, and the row type they share. The old conversation list that lived
// here was never rendered and is gone.
export type { Conversation } from "../lib/conversationRow";
import { AgentTypeIcon } from "./AgentTypeIcon";
import { isHostedAgentType } from "@codecast/shared/contracts";
import { ClaudeIcon, CodexIcon, CursorIcon, GeminiIcon, GrokIcon } from "./BrandIcons";

export function AgentIcon({ agentType, className = "w-4 h-4" }: { agentType: string; className?: string }) {
  if (agentType === "codex" || agentType === "codex_cli") {
    return <CodexIcon className={className} />;
  } else if (agentType === "cursor") {
    return (
      <span className={`${className} rounded bg-[#1a1a2e] flex items-center justify-center shrink-0`}>
        <CursorIcon className="w-2.5 h-2.5 text-white" />
      </span>
    );
  } else if (agentType === "gemini") {
    return (
      <span className={`${className} rounded bg-[#1a73e8] flex items-center justify-center shrink-0`}>
        <GeminiIcon className="w-2.5 h-2.5 text-white" />
      </span>
    );
  } else if (agentType === "grok") {
    return (
      <span className={`${className} rounded bg-[#0a0a0a] flex items-center justify-center shrink-0`}>
        <GrokIcon className="w-2.5 h-2.5 text-white" />
      </span>
    );
  } else if (agentType === "opencode" || agentType === "pi" || agentType === "muse" || isHostedAgentType(agentType)) {
    // opencode/pi/muse and the hosted assistant have no dedicated badge glyph
    // here — reuse the canonical AgentTypeIcon (its own accent color) inside
    // the badge chrome so they never fall through to the Claude icon.
    return (
      <span className={`${className} rounded bg-sol-bg-alt flex items-center justify-center shrink-0`}>
        <AgentTypeIcon agentType={agentType} className="w-2.5 h-2.5" />
      </span>
    );
  }
  return (
    <span className={`${className} rounded bg-sol-orange flex items-center justify-center shrink-0`}>
      <ClaudeIcon className="w-2.5 h-2.5 text-sol-bg" />
    </span>
  );
}
