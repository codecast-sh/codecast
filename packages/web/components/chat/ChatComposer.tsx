import { memo, useCallback, useRef, useState } from "react";
import { Headphones, ImagePlus, MoreHorizontal } from "lucide-react";
import { SlackLogo } from "../SlackLogo";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { WalkiePttButton } from "../calls/WalkiePtt";
import { MessageInput } from "../MessageInput";
import { KeyCap, MenuKeyCaps } from "../KeyboardShortcutsHelp";
import { useTypingMembers, useTypingReporter } from "../../hooks/useChatTyping";
import { TypingIndicator } from "./TypingIndicator";
import { settleComposerAttachments } from "../../lib/draftImages";
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
  slackChannelName,
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
  onSend: (content: string, attachments?: ChatAttachment[], opts?: { broadcast?: boolean; syncLocalOnly?: boolean }) => void;
  /** The channel mirrors to a Slack channel of this name: offer the per-line
   *  "keep this out of Slack" switch. Absent = no switch. */
  slackChannelName?: string;
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
  // Per line, like broadcast: the mirror is the channel's rule, and this is
  // one person deciding that ONE line stays home. Resets after the send.
  const [localOnly, setLocalOnly] = useState(false);
  const offerSlack = !!slackChannelName;
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
          const attachments: ChatAttachment[] = await settleComposerAttachments(images);
          // Every upload failed and nothing was typed — uploadImage already
          // toasted each failure; there is nothing real to send.
          if (!content && attachments.length === 0) return;
          const sendOpts: { broadcast?: boolean; syncLocalOnly?: boolean } = {};
          if (offerBroadcast && broadcast) sendOpts.broadcast = true;
          if (offerSlack && localOnly) sendOpts.syncLocalOnly = true;
          onSend(
            content,
            attachments.length ? attachments : undefined,
            Object.keys(sendOpts).length > 0 ? sendOpts : undefined,
          );
          setBroadcast(false);
          setLocalOnly(false);
        }}
      />
      <div className="ch-composer-foot">
        <button
          type="button"
          className="ch-composer-attach"
          title="Attach an image"
          aria-label="Attach an image"
          onClick={() => pickerRef.current?.click()}
        >
          <ImagePlus className="w-3.5 h-3.5" />
        </button>
        {offerWalkie && (
          <span className="walkie-seat">
            <WalkiePttButton
              roomKey={walkieRoomKey}
              resolveChannelId={resolveChannelId}
              size="sm"
              icon={Headphones}
              title="Talk to them — click again to stop"
              ring={walkieRing ? { toUserIds: walkieRing } : undefined}
            />
          </span>
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
        <TypingIndicator members={typists} />
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" className="ch-composer-options" aria-label="Message options" title="Message options">
              {offerSlack && <SlackLogo className="w-3 h-3" muted={localOnly} />}
              {localOnly && <span>Only here</span>}
              {broadcast && <span>Also in #{channelName}</span>}
              <MoreHorizontal className="w-4 h-4" />
            </button>
          </PopoverTrigger>
          <PopoverContent side="top" align="end" sideOffset={8} className="ch-composer-menu" aria-label="Message options">
            {(offerSlack || offerBroadcast) && (
              <div className="ch-composer-delivery">
                <span className="ch-composer-menu-heading">This message</span>
                {offerSlack && (
                  <label className="ch-composer-choice">
                    <input type="checkbox" checked={!localOnly} onChange={(e) => setLocalOnly(!e.target.checked)} />
                    <SlackLogo className="w-3.5 h-3.5" muted={localOnly} />
                    <span>Also send to Slack #{slackChannelName}</span>
                  </label>
                )}
                {offerBroadcast && (
                  <label className="ch-composer-choice">
                    <input type="checkbox" checked={broadcast} onChange={(e) => setBroadcast(e.target.checked)} />
                    <span>Also send to #{channelName}</span>
                  </label>
                )}
              </div>
            )}
            <div className="ch-composer-shortcuts">
              <span className="ch-composer-menu-heading">Keyboard shortcuts</span>
              <div><span>Send message</span><span><KeyCap size="xs">Enter</KeyCap></span></div>
              <div><span>New line</span><span><KeyCap size="xs">Shift</KeyCap><KeyCap size="xs">Enter</KeyCap></span></div>
              <div><span>Mention someone</span><span><KeyCap size="xs">@</KeyCap></span></div>
              {offerWalkie && <div><span>Toggle voice</span><MenuKeyCaps action="chat.pushToTalk" className="inline-flex items-center gap-[2px]" /></div>}
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
});
