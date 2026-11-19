import { createContext, useContext, type ReactNode } from 'react';

/**
 * A hard press anywhere in a message opens that message's menu. The message
 * row provides this; the buttons inside it (links, link cards, images, tool
 * rows) read it, so a long press on them reaches the menu rather than firing
 * their tap or doing something silent. A block passes what of it can be
 * copied (this link, this command, this output) and the menu lists those
 * first.
 */
export type BlockCopy = { label: string; text: string; icon?: 'copy' | 'link' };
export type MessageLongPress = (copies?: BlockCopy[]) => void;

export const MessageLongPressContext = createContext<MessageLongPress | null>(null);

export function useMessageLongPress(): MessageLongPress | null {
  return useContext(MessageLongPressContext);
}

/** A full-screen viewer opened from a message is not part of it: its text is
 *  selectable again and a long press there does not reopen the menu. */
export function OutsideMessage({ children }: { children: ReactNode }) {
  return <MessageLongPressContext.Provider value={null}>{children}</MessageLongPressContext.Provider>;
}
