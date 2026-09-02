import { AgentIcon } from "../ConversationList";
import { AvatarImg } from "../../lib/avatarCache";
import { hueFor, initials } from "../../lib/avatarInitials";

// The app's small round avatar. Used by comments, by chat, and by anything else
// that draws one face: a teammate must not be a circle in one surface and a
// square in another on the same screen. The agent renders with the SAME
// Claude/Codex/etc. icon the conversation uses for assistant messages, so a
// reply reads as that agent. Users render their image, else a colored initial.

export function CommentAvatar({
  name,
  image,
  isAgent,
  agentType,
  size = 22,
  letters = 1,
  className = "",
}: {
  name: string;
  image?: string;
  isAgent?: boolean;
  agentType?: string;
  size?: number;
  /** How many letters the initials fallback shows. */
  letters?: 1 | 2;
  className?: string;
}) {
  if (isAgent) {
    return (
      <span
        className={`cc-cmt-avatar shrink-0 ${className}`}
        style={{ width: size, height: size }}
        title={name || "Agent"}
      >
        <AgentIcon agentType={agentType || "claude_code"} className="w-full h-full rounded-md" />
      </span>
    );
  }
  const initialsFallback = (
    <span
      className={`cc-cmt-avatar grid place-items-center shrink-0 rounded-full font-semibold text-white leading-none ${className}`}
      // The initials must scale with the box. Leaving the size in CSS makes a
      // 16px face in a reply stack render 10px text, which collides into an
      // unreadable smudge once the faces overlap. leading-none matters too:
      // an inherited 20px line height in a 14px box overflows the grid cell
      // and drops the letter below center.
      style={{
        width: size,
        height: size,
        fontSize: Math.max(7, Math.round(size * (letters === 2 ? 0.42 : 0.45))),
        backgroundColor: hueFor(name),
      }}
      title={name}
    >
      {initials(name, letters)}
    </span>
  );
  return (
    <AvatarImg
      src={image}
      alt={name}
      title={name}
      className={`cc-cmt-avatar shrink-0 rounded-full object-cover ring-1 ring-sol-border/40 ${className}`}
      style={{ width: size, height: size }}
      fallback={initialsFallback}
    />
  );
}
