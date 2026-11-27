// Every owners change a person makes on the phone (the sheet's Save, leaving,
// Take it over): the phone's twin of
// web's applyOwnersWithToast. It applies the change through the store's one
// owners action, then shows the undo bar: with Undo when the change recorded a
// history entry, as a plain notice when it did not. No React Native in here,
// so bun tests it directly.
import { getUndoHistory } from '@platform/engine';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import type { SessionOwnersChange } from '@codecast/web/store/sessionOwnersSlice';
import { showNotice, showUndo } from './undoBar';

export function applyOwnersWithUndo(conversationId: string, change: SessionOwnersChange, inverse: SessionOwnersChange | null, words: string): void {
  const before = getUndoHistory().head;
  useInboxStore.getState().applySessionOwners(conversationId, change, inverse);
  const head = getUndoHistory().head;
  if (head && head !== before) showUndo(words, head);
  else showNotice(words);
}
