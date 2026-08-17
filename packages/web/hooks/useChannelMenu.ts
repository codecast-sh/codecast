import { useContextMenu, type ContextMenuState } from "../components/ui/context-menu";
import type { ChatNotifyLevel } from "../store/chatSlice";

export type ChannelMenuPayload = {
  channelId: string;
  notifyLevel: ChatNotifyLevel;
  /** Where the view goes if this channel is archived out from under it. */
  onArchived?: () => void;
};

/** One hook + one element per surface (sidebar, chat page); rows call
 *  `state.open(e, payload)` from clicks and right-clicks alike. Kept apart
 *  from ChannelContextMenu so that component module stays a pure Fast
 *  Refresh boundary. */
export function useChannelMenu(): ContextMenuState<ChannelMenuPayload> {
  return useContextMenu<ChannelMenuPayload>();
}
