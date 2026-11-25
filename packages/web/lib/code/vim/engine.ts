// The vim engine's editor object as this module uses it, and the one way it
// tells the person something.

import type { EditorView } from "@codemirror/view";
import type { CM5EditorInterface, vimState } from "@replit/codemirror-vim";

/** The editor object the engine hands to actions, motions and ex commands. */
export type VimCM = CM5EditorInterface & { cm6: EditorView };
export type VimState = vimState;

/** The editor object behind whatever shape an engine callback types it as. */
export const asVimCM = (cm: unknown) => cm as VimCM;

/** A message at the bottom of the editor, as vim shows one. */
export function notify(cm: unknown, text: string): void {
  const el = document.createElement("span");
  el.textContent = text;
  asVimCM(cm).openNotification?.(el, { bottom: true, duration: 3000 });
}
