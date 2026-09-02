import { memo, useCallback, useRef, useState } from "react";
import { ImagePlus } from "lucide-react";
import { WalkiePttButton } from "../calls/WalkiePtt";
import { MessageInput } from "../ConversationView";
import { KeyCap, MenuKeyCaps } from "../KeyboardShortcutsHelp";
import { useTypingMembers, useTypingReporter } from "../../hooks/useChatTyping";
import { TypingIndicator } from "./TypingIndicator";
import { pendingImageUploads } from "../../lib/draftImages";
import type { ChatAttachment } from "../../store/chatSlice";
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
// Images ride the same machinery: paste/drop/pick lands in MessageInput's
// thumbnail strip and its upload pipeline; the gate hands the settled storage
// ids over as chat attachments. A send with uploads still in flight awaits
// their promises (module-level, so a remount can't lose them) and dispatches
// the moment they settle — the box itself already cleared.
//
// The draft key is the composer's identity: `chat:<channel>` for the channel and
// `chat:<channel>:<root>` for a thread, so a half-written reply and a
// half-written channel message never overwrite each other.
//
// Typing presence starts and ends here too. The reporter listens to the input
// events that BUBBLE out of MessageInput's textarea — no prop threaded through
// the shared component — and the matching indicator sits in the foot row, so
// both halves of the feature live at the one point that knows the scope
// (channel vs thread).

export function chatDraftKey(channelId: string, threadRootId?: string): string {
  return threadRootId ? `chat:${channelId}:${threadRootId}` : `chat:${channelId}`;
}

export const ChatComposer = memo(function ChatComposer({
  channelId,
  threadRootId,
  teamId,
  placeholder,
  channelName,
  onSend,
  autoFocus,
  compact,
  dropFilesRef,
  walkieRoomKey,
  walkieRing,
}: {
  channelId: string;
  threadRootId?: string;
  /** The channel's team. The composer's conversationId is a draft key, not a
   *  session, so without this the mention scope silently falls to PERSONAL and
   *  every team task/doc/plan vanishes from the @ popup. */
  teamId?: string;
  placeholder: string;
  /** Names the "Also send to #channel" checkbox — offered only in a thread
   *  (Slack's broadcast). Absent = no checkbox. */
  channelName?: string;
  onSend: (content: string, attachments?: ChatAttachment[], opts?: { broadcast?: boolean }) => void;
  autoFocus?: boolean;
  /** The thread panel is narrower and sits under its own scroll region. */
  compact?: boolean;
  /** Handed to the page so the whole transcript is a drop target: files dropped
   *  anywhere on the channel land in this composer's thumbnail strip. */
  dropFilesRef?: React.MutableRefObject<((files: File[]) => void) | null>;
  /** The DM's call room, which turns the foot row's mic into push-to-talk.
   *  Absent in a channel and in a thread: v1 walkie is a DM conversation, and
   *  a burst spoken into a thread would land where nobody is listening. */
  walkieRoomKey?: string;
  /** Who a ring under the key rings — the DM's people. Absent: no ring. */
  walkieRing?: string[];
}) {
  const draftKey = chatDraftKey(channelId, threadRootId);
  // The channel is already open, so keying the mic needs no lookup — but the
  // walkie asks at press time, the same way the hover card does.
  const resolveChannelId = useCallback(() => channelId, [channelId]);
  // A burst is a line in the conversation, and a thread is somewhere else.
  const offerWalkie = !!walkieRoomKey && !threadRootId;
  const typing = useTypingReporter(channelId, threadRootId);
  const typists = useTypingMembers(channelId, threadRootId);
  const ownDropRef = useRef<((files: File[]) => void) | null>(null);
  const dropRef = dropFilesRef ?? ownDropRef;
  const pickerRef = useRef<HTMLInputElement | null>(null);
  // Slack's "also send to #channel". Per-send, not sticky: it resets after each
  // send, because broadcasting is a choice about ONE message, not a mode.
  const [broadcast, setBroadcast] = useState(false);
  const offerBroadcast = !!threadRootId && !!channelName;
  return (
    <div
      className="ch-composer"
      style={compact ? { margin: "0 12px 12px" } : undefined}
      onInput={typing.onTyping}
    >
      <MessageInput
        // Remount on a channel or thread switch so the box never carries the
        // previous room's draft into the new one.
        key={draftKey}
        conversationId={draftKey}
        bareComposer
        chatMentionMode
        mentionTeamId={teamId}
        composerPlaceholder={placeholder}
        autoFocusInput={autoFocus}
        onDropFiles={dropRef}
        onGateSend={async (text: string, images) => {
          typing.stop();
          const content = text.trim();
          const list = images ?? [];
          if (!content && list.length === 0) return;
          // Settle what's still uploading; the registry outlives any remount.
          const settled = await Promise.all(
            list.map(async (img) => ({
              ...img,
              storageId:
                img.storageId ??
                (await (pendingImageUploads.get(img.previewUrl) ?? Promise.resolve(null))),
            })),
          );
          const attachments: ChatAttachment[] = settled
            .filter((img) => img.storageId)
            .map((img) => ({ storage_id: img.storageId as string, mime: img.mime }));
          // Every upload failed and nothing was typed — uploadImage already
          // toasted each failure; there is nothing real to send.
          if (!content && attachments.length === 0) return;
          onSend(
            content,
            attachments.length ? attachments : undefined,
            offerBroadcast && broadcast ? { broadcast: true } : undefined,
          );
          setBroadcast(false);
        }}
      />
      <div className="ch-composer-foot">
        <button
          type="button"
          className="ch-composer-attach"
          title="Attach an image"
          onClick={() => pickerRef.current?.click()}
        >
          <ImagePlus className="w-3.5 h-3.5" />
        </button>
        {offerWalkie && (
          <>
            {/* The key and its first-use callout share a seat, so the callout
                hangs over the key it is about — and a press on the key retires
                it, because pressing IS learning it. */}
            <span
              className="walkie-seat"
            >
              {/* The SMALL key, deliberately.
                  It used to be the composer's 40px control, sized as if the
                  composer were where you talk to people. It is not: the people
                  wall is, where a face is up to 88px of hit area and holding it
                  IS the gesture. Beside that, this is a side entrance — the key
                  you reach for because you are already typing in this DM — and
                  a 40px orange circle in a row of 14px glyphs claimed the
                  composer's whole right end for it. Same key, same states, same
                  chord beside it; one size down, in the row it lives in. */}
              <WalkiePttButton
                roomKey={walkieRoomKey}
                resolveChannelId={resolveChannelId}
                size="sm"
                label="Talk"
                title="Talk to them — they see your face and hear you; click again to stop"
                ring={walkieRing ? { toUserIds: walkieRing } : undefined}
              />
            </span>
            {/* The chord for the same gesture, ON the control rather than in
                the hint row at the far right of the composer, which is where it
                used to be: a binding is learned beside the thing it operates.
                A hand already on the keyboard should never have to find the
                mouse to say one sentence. */}
            <span className="walkie-chord">
              <span className="walkie-chord-word">toggle</span>
              <MenuKeyCaps
                action="chat.pushToTalk"
                className="inline-flex items-center gap-[2px]"
              />
            </span>
          </>
        )}
        <input
          ref={pickerRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length) dropRef.current?.(files);
            e.target.value = "";
          }}
        />
        {offerBroadcast && (
          <label className={`ch-composer-broadcast ${broadcast ? "ch-composer-broadcast-on" : ""}`}>
            <input
              type="checkbox"
              checked={broadcast}
              onChange={(e) => setBroadcast(e.target.checked)}
            />
            Also send to #{channelName}
          </label>
        )}
        <TypingIndicator members={typists} />
        {/* The optional half is shed by WIDTH, not by which panel this is. The
            thread panel was the narrow case the flag was written for, but the
            main composer gets just as narrow with a rail and a thread beside it
            — and it had no guard at all. A container query asks the real
            question: is there room? (see .ch-composer-hint-wide in chat.css) */}
        <span className="ch-composer-hint">
          <span className="ch-composer-hint-wide">
            {/* Push to talk is NOT listed here any more: it is written beside
                the key itself, and saying the same chord twice in one composer
                made the row longer without making it clearer. */}
            <KeyCap size="xs">@</KeyCap> to mention ·{" "}
          </span>
          <KeyCap size="xs">Enter</KeyCap> to send · <KeyCap size="xs">Shift</KeyCap>
          <KeyCap size="xs">Enter</KeyCap> for a new line
        </span>
      </div>
    </div>
  );
});
