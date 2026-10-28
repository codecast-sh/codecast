import { desktopAppWindow, hasAppWindow } from "./desktopApps";
import { getDesktopWindowRole, isDetachedTabWindow, isElectron } from "./desktop";

// Which window shows a chat toast. Every desktop window mounts useChatToasts,
// so without one owner a second window (a detached tab, the Work window)
// toasts the same line again, each from its own copy of the store.

export type ChatToastWindowFacts = {
  /** A Chat app window exists somewhere. */
  chatWindowOpen: boolean;
  /** This window is the Chat app window. */
  isChatWindow: boolean;
  /** On the desktop shell (several windows can exist). */
  desktop: boolean;
  /** This window has focus. */
  focused: boolean;
  /** Some window the person works in has focus (the shell's word). */
  appFocused: boolean;
  /** This is the main window: not a detached tab, not an app window. */
  isMainWindow: boolean;
};

/** While a Chat window exists it is where chat happens, toasts included, and
 *  the card's click opens the channel where it lives. Otherwise the window the
 *  person is in, and with none of them focused, the main window, so the card
 *  waits where they come back to. */
export function chatToastWindowOwns(f: ChatToastWindowFacts): boolean {
  if (f.chatWindowOpen) return f.isChatWindow;
  if (!f.desktop || f.focused) return true;
  if (f.appFocused) return false;
  return f.isMainWindow;
}

export function ownsChatToasts(): boolean {
  const app = desktopAppWindow();
  return chatToastWindowOwns({
    chatWindowOpen: hasAppWindow("chat"),
    isChatWindow: app === "chat",
    desktop: isElectron(),
    focused: typeof document === "undefined" || document.hasFocus(),
    appFocused: getDesktopWindowRole().appFocused,
    isMainWindow: !isDetachedTabWindow() && app === null,
  });
}
