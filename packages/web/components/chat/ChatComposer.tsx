import { memo } from "react";
import { MessageInput } from "../ConversationView";
import { KeyCap } from "../KeyboardShortcutsHelp";
import "./chat.css";

// The chat composer.
//
// It is the app's own MessageInput in `bareComposer` mode — the exact reuse the
// comment composer already makes (components/comments/CommentComposer.tsx). That
// one component carries mention autocomplete, image paste and drag-drop,
// auto-grow, the draft that survives a reload, and a submit path that clears the
// box synchronously so Enter never feels laggy. Reimplementing any of that here
// would give chat a second, worse text box that drifts from the one people
// already know.
//
// The draft key is the composer's identity: `chat:<channel>` for the channel and
// `chat:<channel>:<root>` for a thread, so a half-written reply and a
// half-written channel message never overwrite each other.

export function chatDraftKey(channelId: string, threadRootId?: string): string {
  return threadRootId ? `chat:${channelId}:${threadRootId}` : `chat:${channelId}`;
}

export const ChatComposer = memo(function ChatComposer({
  channelId,
  threadRootId,
  placeholder,
  onSend,
  autoFocus,
  compact,
}: {
  channelId: string;
  threadRootId?: string;
  placeholder: string;
  onSend: (content: string) => void;
  autoFocus?: boolean;
  /** The thread panel is narrower and sits under its own scroll region. */
  compact?: boolean;
}) {
  const draftKey = chatDraftKey(channelId, threadRootId);
  return (
    <div className="ch-composer" style={compact ? { margin: "0 12px 12px" } : undefined}>
      <MessageInput
        // Remount on a channel or thread switch so the box never carries the
        // previous room's draft into the new one.
        key={draftKey}
        conversationId={draftKey}
        bareComposer
        chatMentionMode
        composerPlaceholder={placeholder}
        autoFocusInput={autoFocus}
        onGateSend={async (text: string) => {
          const content = text.trim();
          if (content) onSend(content);
        }}
      />
      <div className="ch-composer-foot">
        {/* The optional half is shed by WIDTH, not by which panel this is. The
            thread panel was the narrow case the flag was written for, but the
            main composer gets just as narrow with a rail and a thread beside it
            — and it had no guard at all. A container query asks the real
            question: is there room? (see .ch-composer-hint-wide in chat.css) */}
        <span className="ch-composer-hint">
          <span className="ch-composer-hint-wide">
            <KeyCap size="xs">@</KeyCap> to mention ·{" "}
          </span>
          <KeyCap size="xs">Enter</KeyCap> to send · <KeyCap size="xs">Shift</KeyCap>
          <KeyCap size="xs">Enter</KeyCap> for a new line
        </span>
      </div>
    </div>
  );
});
