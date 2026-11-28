import { createContext, useContext, type ReactNode } from 'react';
import type { CommentUnit } from '@/lib/messageComments';

/**
 * A hard press anywhere in a message opens that message's menu. The message
 * row provides this; the buttons inside it (links, link cards, images, tool
 * rows) read it, so a long press on them reaches the menu rather than firing
 * their tap or doing something silent. A block passes what of it can be
 * copied (this link, this command, this output) and the menu lists those
 * first.
 */
export type BlockCopy = { label: string; text: string; icon?: 'copy' | 'link' };
/** `unit` is the block of text pressed, which the menu offers to comment on. */
export type MessageLongPress = (copies?: BlockCopy[], unit?: CommentUnit) => void;

export const MessageLongPressContext = createContext<MessageLongPress | null>(null);

/** The message row's own tap. Text that takes a long press of its own (a
 *  block offering a comment) passes a tap through to it, since a touchable
 *  text would otherwise swallow it. */
export const MessageTapContext = createContext<(() => void) | null>(null);

export function useMessageLongPress(): MessageLongPress | null {
  return useContext(MessageLongPressContext);
}

/** A full-screen viewer opened from a message is not part of it: its text is
 *  selectable again and a long press there does not reopen the menu. */
export function OutsideMessage({ children }: { children: ReactNode }) {
  return <MessageLongPressContext.Provider value={null}>{children}</MessageLongPressContext.Provider>;
}
