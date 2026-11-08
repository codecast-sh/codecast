import type { ComponentProps } from 'react';
import type Feather from '@expo/vector-icons/Feather';
import { create } from 'zustand';

// The app's own popups, drawn by components/PopupHost at the root in place of
// the system's Alert, Alert.prompt and ActionSheetIOS, so every menu, confirm
// and notice wears the app's theme and type. Three kinds:
//
//   showActionSheet  a menu of choices, sliding up from the bottom
//   appAlert         a dialog: a title, a message, and its buttons
//   appPrompt        a dialog with a text field
//
// appAlert keeps Alert.alert's shape (title, message, buttons with text, style
// and onPress), so a call reads the same as before. One popup shows at a time;
// one asked for while another is up waits its turn. No React Native in here,
// so bun tests it directly (lib/popups.test.ts).

export type SheetItem = {
  label: string;
  /** A Feather glyph before the label. Give every row of a sheet one, or none. */
  icon?: ComponentProps<typeof Feather>['name'];
  onPress: () => void;
  /** Renders a check beside the label: the current pick in a picker sheet. */
  selected?: boolean;
  destructive?: boolean;
};

export type AlertButton = {
  text: string;
  onPress?: () => void;
  style?: 'default' | 'cancel' | 'destructive';
};

export type Popup =
  | { kind: 'sheet'; title?: string; items: SheetItem[]; onCancel?: () => void }
  | { kind: 'alert'; title: string; message?: string; buttons: AlertButton[] }
  | {
      kind: 'prompt';
      title: string;
      message?: string;
      placeholder?: string;
      defaultValue?: string;
      confirm: string;
      destructive?: boolean;
      /** Whether the confirm can be pressed yet; by default, once anything is typed. */
      accepts?: (text: string) => boolean;
      onSubmit: (text: string) => void;
    };

type Shown = Popup & { id: number };

export const usePopups = create<{ queue: Shown[] }>(() => ({ queue: [] }));

let seq = 0;
function push(p: Popup) {
  seq += 1;
  const shown = { ...p, id: seq } as Shown;
  usePopups.setState((s) => ({ queue: [...s.queue, shown] }));
}

/** Take the popup `id` down. Its action, if any, runs after it has gone, so a
 *  popup an action opens queues behind nothing. */
export function closePopup(id: number, then?: () => void) {
  usePopups.setState((s) => ({ queue: s.queue.filter((p) => p.id !== id) }));
  then?.();
}

/** A menu of choices. Cancel is drawn by the sheet, so callers list only real choices. */
export function showActionSheet(title: string | undefined, items: SheetItem[], opts?: { onCancel?: () => void }) {
  push({ kind: 'sheet', title, items, onCancel: opts?.onCancel });
}

/** A dialog. With no buttons it is a notice with one OK. */
export function appAlert(title: string, message?: string, buttons?: AlertButton[]) {
  push({ kind: 'alert', title, message, buttons: buttons?.length ? buttons : [{ text: 'OK' }] });
}

/** A dialog with a text field; `onSubmit` gets what was typed. */
export function appPrompt(
  title: string,
  opts: {
    message?: string; placeholder?: string; defaultValue?: string; confirm?: string; destructive?: boolean;
    accepts?: (text: string) => boolean; onSubmit: (text: string) => void;
  },
) {
  push({ ...opts, kind: 'prompt', title, confirm: opts.confirm ?? 'OK' });
}

/** What a tap outside the popup does: a sheet cancels, a dialog runs its
 *  cancel button, a lone button acts as its OK, and a dialog that makes the
 *  person pick between real actions stays up. */
export function outsideTap(p: Popup): { close: boolean; run?: () => void } {
  if (p.kind === 'sheet') return { close: true, run: p.onCancel };
  if (p.kind === 'prompt') return { close: true };
  const cancel = p.buttons.find((b) => b.style === 'cancel');
  if (cancel) return { close: true, run: cancel.onPress };
  if (p.buttons.length === 1) return { close: true, run: p.buttons[0].onPress };
  return { close: false };
}

/** A dialog's buttons in the order drawn: cancel first (left), the rest after. */
export function orderedButtons(buttons: AlertButton[]): AlertButton[] {
  return [...buttons.filter((b) => b.style === 'cancel'), ...buttons.filter((b) => b.style !== 'cancel')];
}
