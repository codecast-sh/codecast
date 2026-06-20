import { AgentIcon } from "../ConversationList";

// Small round avatar for a comment author. The agent renders with the SAME
// Claude/Codex/etc. icon the conversation uses for assistant messages, so a reply
// reads as that agent. Users render their image, else a colored initial.

const HUES = ["#268bd2", "#2aa198", "#859900", "#b58900", "#cb4b16", "#d33682", "#6c71c4"];

function hueFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length];
}

export function CommentAvatar({
  name,
  image,
  isAgent,
  agentType,
  size = 22,
}: {
  name: string;
  image?: string;
  isAgent?: boolean;
  agentType?: string;
  size?: number;
}) {
  if (isAgent) {
    return (
      <span className="cc-cmt-avatar shrink-0" style={{ width: size, height: size }} title="Agent">
        <AgentIcon agentType={agentType || "claude_code"} className="w-full h-full rounded-md" />
      </span>
    );
  }
  if (image) {
    return (
      <img
        src={image}
        alt={name}
        title={name}
        className="cc-cmt-avatar shrink-0 rounded-full object-cover ring-1 ring-sol-border/40"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className="cc-cmt-avatar grid place-items-center shrink-0 rounded-full font-semibold text-white"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.45), backgroundColor: hueFor(name) }}
      title={name}
    >
      {(name || "?").charAt(0).toUpperCase()}
    </span>
  );
}
