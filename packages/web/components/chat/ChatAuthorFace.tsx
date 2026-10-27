// The face a chat author wears, on every surface that draws one: a role's
// standing agent wears the role's face, a session with a character wears the
// character, anyone else their avatar (CommentAvatar: photo, initials, or the
// agent's logo).
import { CommentAvatar } from "../comments/CommentAvatar";
import { RoleFace } from "../org/RoleFace";
import type { IdentityRow } from "../../lib/sessionIdentity";
import type { ChatAuthor } from "./chatTypes";

export function ChatAuthorFace({ author, size = 22, letters = 2, className }: {
  /** A line's author, or a thread face (which carries agentType and identity flat). */
  author: Pick<ChatAuthor, "name" | "avatarUrl" | "isAgent" | "role" | "session"> & { agentType?: string; identity?: IdentityRow };
  size?: number;
  letters?: 1 | 2;
  className?: string;
}) {
  if (author.role) return <RoleFace role={{ short_id: author.role.shortId, handle: author.role.handle, avatar: author.role.avatar, name: author.role.title }} size={size} title={author.name} className={className} />;
  return (
    <CommentAvatar
      name={author.name}
      image={author.avatarUrl}
      isAgent={author.isAgent}
      agentType={author.session?.agentType ?? author.agentType}
      identity={author.session?.identity ?? author.identity}
      size={size}
      letters={letters}
      className={className}
    />
  );
}
