// The three things you can do to a person, as three labeled buttons.
//
// Talk is a toggle: click, talk, click again. It is ONE WAY — they see your
// face pop up and hear you; you hear nothing back until they Join. Ring starts
// a real huddle and rings them. Message opens the conversation. The same three
// live under a face on the wall and in the floating faces' slot; the chat
// header shows the one key, with Ring under it (right click, long press) — so
// there is one vocabulary for talking to a person wherever their face is.
//
// No icon stands alone: a button here is a word, and an icon beside it.
import { Headphones, MessageSquare, Mic, Square } from "lucide-react";
import { startHuddle } from "../../lib/calls/actions";
import { talkToggleProps, walkieJoinReason, type PushToTalk } from "../../hooks/useWalkie";
import "./faceActions.css";

export type FaceAction = "talk" | "ring" | "message";

export function FaceActions({
  ptt,
  blocked,
  roomKey,
  ringIds,
  onMessage,
  show = ["talk", "ring", "message"],
  size = "md",
  className = "",
}: {
  ptt: PushToTalk;
  /** Why Talk cannot start, or null. Drawn ON the button, not in a tooltip. */
  blocked: string | null;
  roomKey: string;
  /** Who a Ring rings — the other person in a DM, everyone in a group. */
  ringIds: string[];
  /** Absent: no Message button (the chat header is already the conversation). */
  onMessage?: () => void;
  show?: FaceAction[];
  size?: "sm" | "md";
  className?: string;
}) {
  const talking = ptt.holding;
  const ringBlocked = walkieJoinReason(roomKey);
  return (
    <span className={`face-actions face-actions-${size} ${className}`} role="group" aria-label="Talk, ring or message">
      {show.includes("talk") && (
        <button
          type="button"
          className={`face-action face-action-talk${talking ? " face-action-talk-on" : ""}`}
          disabled={!!blocked && !talking}
          data-walkie-state={ptt.dropped ? "dropped" : ptt.capturing ? "live" : talking ? "opening" : "idle"}
          title={
            blocked && !talking
              ? blocked
              : talking
                ? "Stop talking"
                : "Talk to them now — they see your face and hear you; click again to stop"
          }
          {...talkToggleProps(ptt)}
        >
          {talking ? <Square className="face-action-icon" /> : <Mic className="face-action-icon" />}
          <span className="face-action-word">{talking ? "Stop" : "Talk"}</span>
        </button>
      )}
      {show.includes("ring") && (
        <button
          type="button"
          className="face-action face-action-ring"
          disabled={!!ringBlocked || ringIds.length === 0}
          title={ringBlocked ?? "Ring them and start a huddle — a real call, both ways"}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void startHuddle({ roomKey, toUserIds: ringIds });
          }}
        >
          <Headphones className="face-action-icon" />
          <span className="face-action-word">Ring</span>
        </button>
      )}
      {show.includes("message") && onMessage && (
        <button
          type="button"
          className="face-action face-action-message"
          title="Open the conversation"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onMessage();
          }}
        >
          <MessageSquare className="face-action-icon" />
          <span className="face-action-word">Message</span>
        </button>
      )}
      {/* The reason Talk cannot start, said in words under the buttons. */}
      {blocked && !talking && show.includes("talk") && <span className="face-actions-reason">{blocked}</span>}
    </span>
  );
}
