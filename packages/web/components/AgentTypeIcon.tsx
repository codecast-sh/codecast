import { CodexIcon, GrokIcon } from "./BrandIcons";

export function AgentTypeIcon({ agentType, className = "w-3 h-3" }: { agentType: string; className?: string }) {
  if (agentType === "claude_code") {
    return (
      <svg className={`${className} text-amber-400`} viewBox="0 0 24 24" fill="currentColor">
        <path d="M17.3041 3.541h-3.6718l6.696 16.918H24L17.3041 3.541Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409H6.696Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456H6.3247Z" />
      </svg>
    );
  } else if (agentType === "codex" || agentType === "codex_cli") {
    return <CodexIcon className={className} />;
  } else if (agentType === "cursor") {
    return (
      <svg className={`${className} text-blue-400`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M4 4l16 6-8 2-2 8z"/>
      </svg>
    );
  } else if (agentType === "gemini") {
    return (
      <svg className={`${className} text-blue-400`} viewBox="0 0 28 28" fill="currentColor">
        <path d="M12 0C12 0 12 6.268 8.134 10.134C4.268 14 0 14 0 14C0 14 6.268 14 10.134 17.866C14 21.732 14 28 14 28C14 28 14 21.732 17.866 17.866C21.732 14 28 14 28 14C28 14 21.732 14 17.866 10.134C14 6.268 14 0 14 0" />
      </svg>
    );
  } else if (agentType === "opencode") {
    return (
      <svg className={`${className} text-orange-400`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="8 6 3 12 8 18" />
        <polyline points="16 6 21 12 16 18" />
      </svg>
    );
  } else if (agentType === "pi") {
    return (
      <span className={`${className} inline-flex items-center justify-center shrink-0 font-semibold text-teal-400 leading-none`}>
        π
      </span>
    );
  } else if (agentType === "grok") {
    return <GrokIcon className={`${className} text-sol-text`} />;
  }
  return null;
}

export function formatAgentType(agentType?: string): string {
  if (!agentType) return "Unknown";
  if (agentType === "claude_code") return "Claude Code";
  if (agentType === "codex") return "Codex";
  if (agentType === "cursor") return "Cursor";
  if (agentType === "gemini") return "Gemini";
  if (agentType === "opencode") return "OpenCode";
  if (agentType === "pi") return "pi";
  if (agentType === "grok") return "Grok";

  return agentType;
}
