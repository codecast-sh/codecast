// Which chat room the person is looking at RIGHT NOW — the mobile twin of
// web's lib/chatFocus. The push handler consults it so a banner about the very
// channel on screen never fires (telling someone about a message they are
// reading is how banners get ignored). Module-level on purpose: the push
// handler runs outside React.

type ChatFocusState = { channelId?: string; threadRootId?: string };

let focus: ChatFocusState = {};

export function setChatFocus(next: ChatFocusState): void {
  focus = next;
}

export function clearChatFocus(): void {
  focus = {};
}

export function getChatFocus(): ChatFocusState {
  return focus;
}

/** Should a foreground banner about this push stay quiet? Same rule as the web
 *  toast tier's "already on screen" branch: same channel AND same thread
 *  context. A thread reply still banners while you sit on the channel floor —
 *  its words are not on your screen. */
export function chatPushIsOnScreen(data: {
  channelId?: unknown;
  threadRootId?: unknown;
}): boolean {
  if (!data?.channelId || !focus.channelId) return false;
  if (String(data.channelId) !== focus.channelId) return false;
  return String(data.threadRootId ?? "") === (focus.threadRootId ?? "");
}
