import { MessageSquare } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useRoomThreadUnread } from "../../hooks/useRoomThreadUnread";
import { requestCallThread } from "../../lib/calls/callStage";
import "./arrival.css";

/** What was typed in the call's chat, on the call's card where the faces
 *  float: the header's door is hidden then and the float's own Open shows
 *  only under the pointer, so the card is the one surface always in view.
 *  Nothing while everything is read; a click opens the call on its thread. */
export function CallChatChip({ onOpen }: { onOpen: () => void }) {
  const roomKey = useInboxStore((s: any) => s.call.roomKey ?? null);
  const { unread, latest } = useRoomThreadUnread(roomKey);
  const agent = !!latest?.agent;
  if (unread <= 0) return null;
  const label = unread > 99 ? "99+" : String(unread);
  return (
    <button
      type="button"
      key={`${label}:${agent}`}
      className={`engagement-card-chat ${agent ? "arrival-ring" : "animate-in zoom-in-75 fade-in duration-150 motion-reduce:animate-none"}`}
      data-agent={agent || undefined}
      data-card-action="chat"
      onClick={() => {
        requestCallThread();
        onOpen();
      }}
      title={agent ? `${latest!.agent!.name ?? latest!.agent!.title} replied in the call's chat. Open it` : `${unread} new in the call's chat. Open it`}
      aria-label={`Open the call's chat, ${unread} new`}
    >
      <MessageSquare className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}
