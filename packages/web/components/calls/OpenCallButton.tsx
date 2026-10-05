import { SquareArrowOutUpRight } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { canPopOutCall } from "../../lib/desktop";
import { focusExistingHuddle } from "../../lib/calls/huddleWindow";
import { popOutCall } from "../../lib/calls/popOutCall";
import { openCallStage, requestCallThread } from "../../lib/calls/callStage";
import { useRoomThreadUnread } from "../../hooks/useRoomThreadUnread";
import { UnreadCount } from "./UnreadCount";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";

/** Open the call: the full stage (video, screen share, transcript) opens
 *  only when asked; on the desktop the call already has a window, so this
 *  raises it, or gives it one. */
export function openTheCall(): void {
  if (canPopOutCall()) {
    void focusExistingHuddle().then((shown) => {
      if (!shown) void popOutCall();
    });
    return;
  }
  openCallStage();
}

/** The door to the stage on a call's card (the header's face row, a phone's
 *  call strip), wearing the count of what was typed in the call's chat while
 *  it sat collapsed: the same count the stage's own thread button wears. Its
 *  own component so the chat subscription lives only as long as the call
 *  does. */
export function OpenCallButton() {
  const roomKey = useInboxStore((s) => s.call.roomKey ?? null);
  const { unread, latest } = useRoomThreadUnread(roomKey);
  const label = canPopOutCall() ? "Pop out the call" : "Open the call";
  return (
    <ShortcutTooltip label={label}>
      <span className="engagement-card-toggles">
        <button
          type="button"
          onClick={() => {
            if (unread > 0) requestCallThread();
            openTheCall();
          }}
          data-open-call
          data-card-action="open"
          className="engagement-card-toggle relative"
          aria-label={unread > 0 ? `${label}, ${unread} new in its chat` : label}
        >
          <SquareArrowOutUpRight className="h-3.5 w-3.5" />
          <UnreadCount count={unread} agent={!!latest?.agent} className="absolute -right-1.5 -top-1.5" />
        </button>
      </span>
    </ShortcutTooltip>
  );
}
