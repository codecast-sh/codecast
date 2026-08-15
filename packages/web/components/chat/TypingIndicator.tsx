import { CommentAvatar } from "../comments/CommentAvatar";
import { memberName, type ChatMember } from "../../lib/chatViews";
import "./chat.css";

// "Someone is typing" — the composer-foot strip.
//
// It rides in the same row as the keyboard hints, so appearing and vanishing
// never moves the message list by a pixel: the row's height is already paid
// for. Everything animated here is opacity/transform only.

function firstName(m: ChatMember): string {
  return memberName(m).split(/\s+/)[0] || "someone";
}

function phrase(members: ChatMember[]): string {
  if (members.length === 1) return `${memberName(members[0])} is typing`;
  if (members.length === 2)
    return `${firstName(members[0])} and ${firstName(members[1])} are typing`;
  if (members.length === 3)
    return `${firstName(members[0])}, ${firstName(members[1])} and ${firstName(members[2])} are typing`;
  return `${firstName(members[0])}, ${firstName(members[1])} and ${members.length - 2} others are typing`;
}

export function TypingIndicator({ members }: { members: ChatMember[] }) {
  if (members.length === 0) return null;
  return (
    <span className="ch-typing" role="status" aria-live="polite">
      <span className="ch-typing-avatars" aria-hidden="true">
        {members.slice(0, 3).map((m) => (
          <CommentAvatar
            key={String(m._id)}
            name={memberName(m)}
            image={m.is_bot ? undefined : m.image || m.github_avatar_url}
            isAgent={!!m.is_bot}
            size={14}
            letters={1}
          />
        ))}
      </span>
      <span className="ch-typing-text">{phrase(members)}</span>
      <span className="ch-typing-dots" aria-hidden="true">
        <span /><span /><span />
      </span>
    </span>
  );
}
