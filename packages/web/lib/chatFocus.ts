// What the reader is looking at in chat, right now.
//
// The toast decision needs this (a message in the channel on your screen must
// not toast — chatToastTier's first rule), but nothing RENDERS from it, so it
// stays out of the store: a store field would wake every subscriber on a channel
// switch to serve a value only an event handler reads.

export type ChatFocus = {
  channelId?: string;
  threadRootId?: string;
};

let focus: ChatFocus = {};

export function setChatFocus(next: ChatFocus): void {
  focus = next;
}

export function clearChatFocus(): void {
  focus = {};
}

export function getChatFocus(): ChatFocus {
  return focus;
}
