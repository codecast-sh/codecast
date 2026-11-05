// How the daemon types into a terminal that exposes its panes (Kitty, WezTerm,
// Ghostty, herdr). daemon.ts injectThroughPane drives one of these: the keys
// around a poll and the paste-then-one-submit of a message are the same for
// every terminal, and only this transport differs.
export type PaneTransport = {
  /** Which terminal and pane, for the log line. */
  name: string;
  /** Message text. Calls `beforeInput` right before writing, when given. */
  sendText: (text: string, beforeInput?: () => Promise<void>) => Promise<unknown>;
  /** One named key from a poll step: Escape, Enter, Up, a digit. */
  sendKey: (key: string) => Promise<unknown>;
  /** A payload that IS keys (the permission "\r" / "\x1b"), never bracketed. */
  sendKeystrokes: (keys: string) => Promise<unknown>;
  readScreen: () => Promise<string>;
};
