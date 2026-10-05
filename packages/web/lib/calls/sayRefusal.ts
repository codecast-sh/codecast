import { toast } from "sonner";
import { notifyNative } from "../desktop";

// Where a refused press is said, from whichever window it was pressed in.
//
// A toast is the app's ordinary word for a press that did not land. The
// desktop float is the one window with no toasts: it hangs over somebody's
// editor and lets clicks through, so voiceHost.css hides the toaster under
// this class (VoiceHostPanel sets it on <html> whenever the window is not the
// docked panel). Its presses still need an answer, or a refused Stop just has
// the red mark come back without a word and the person cannot tell whether
// the room is still filmed because of an error or because the press never
// landed. So there the words go up as the system banner the app already uses
// for news while you are elsewhere. One test reads the same class the
// stylesheet does, so the window that hides toasts is exactly the window that
// says its refusals another way.

/** The html class of a window that shows no toasts (voiceHost.css). */
export const TOASTLESS_WINDOW_CLASS = "faces-overlay-window";

export function toastsHiddenHere(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains(TOASTLESS_WINDOW_CLASS);
}

/** A refusal sayer for one kind of press: a toast with the reason, or, in a
 *  window without toasts, a system banner titled `title` with the reason
 *  under it. */
export function sayRefusal(title: string): (message: string) => void {
  return (message) => {
    if (toastsHiddenHere()) void notifyNative(title, message, { key: `refused:${title}:${message}` });
    else toast.error(message);
  };
}
