import { CommentAvatar } from "../comments/CommentAvatar";
import { memberAvatarUrl } from "../../lib/liveEntities";
import { useTrackedStore } from "../../store/inboxStore";
import { memberDisplayName, viewersLabel, viewersOf, viewersSig } from "./memberPresence";
import "./viewers.css";

// Who has this session open right now, as a stack of small faces. Figma's
// avatars on a file: if Ann's face is on the session, she is looking at it
// this minute, and the two of you can steer it without stepping on each
// other. The faces are the app's one small avatar (CommentAvatar), the same
// face the chat typing line wears, at 14px on an inbox card and 18px on the
// conversation header. Nothing here is declared: the list comes straight off
// the roster's viewing field, which the reporter derives from the window a
// teammate actually has focused.

export function ViewerFaces({
  members,
  size = 16,
  max = 3,
  className = "",
}: {
  members: readonly any[];
  size?: number;
  max?: number;
  className?: string;
}) {
  if (members.length === 0) return null;
  const shown = members.slice(0, max);
  const overflow = members.length - shown.length;
  const label = viewersLabel(members.map((m) => memberDisplayName(m)));
  return (
    <span
      data-sv-viewers={members.length}
      className={`cc-viewers ${className}`}
      style={{ ["--cc-viewers-overlap" as string]: `${Math.round(size * 0.3)}px` }}
      title={label}
      role="img"
      aria-label={label}
    >
      {shown.map((m) => (
        <CommentAvatar key={String(m._id)} name={memberDisplayName(m)} image={memberAvatarUrl(m)} size={size} />
      ))}
      {overflow > 0 && (
        <span
          className="cc-viewers-more"
          style={{ width: size, height: size, fontSize: Math.max(7, Math.round(size * 0.42)) }}
        >
          +{overflow}
        </span>
      )}
    </span>
  );
}

/**
 * The faces for one conversation, read off the roster in the store. One
 * subscription on the viewer id list: a roster push that changes nothing
 * about who is here re-renders nothing, and a heartbeat never reaches it.
 */
export function ConversationViewers({
  conversationId,
  size = 18,
  max = 3,
  className = "",
}: {
  conversationId: string;
  size?: number;
  max?: number;
  className?: string;
}) {
  const st = useTrackedStore([
    (s) => viewersSig(s.teamMembers, conversationId, s.currentUser?._id?.toString?.() ?? null),
  ]);
  const me = st.currentUser?._id?.toString?.() ?? null;
  const viewers = viewersOf(st.teamMembers, conversationId, me);
  return <ViewerFaces members={viewers} size={size} max={max} className={className} />;
}
