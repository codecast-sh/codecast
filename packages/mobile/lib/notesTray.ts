// What the notes tray above the session composer (components/session/NotesTray)
// shows: the batch items that ride the next send as quotes, pins on pictures
// and text quotes alike, in the order the send writes them. Proposal answers
// are left out: their card already shows and withdraws them. No React Native
// here, so bun tests it directly.

import { isProposalAnswer, pinNumbers, sortPendingComments, type PendingComment } from '@codecast/web/lib/quoteFormat';
import { notesHeadline } from './imagePins';

export type TrayRow = {
  id: string;
  /** The picture's address, for a note pinned on (or quoting) a picture. */
  src?: string;
  /** The pin's number on its picture (pinNumbers), as the gallery and the sent markers draw it. */
  number?: number;
  /** The quoted words on one line; empty for a picture. */
  quote: string;
  /** The person's note, trimmed; empty for a bare pin or a bare quote. */
  note: string;
};

export function trayRows(comments: readonly PendingComment[] | undefined): TrayRow[] {
  if (!comments?.length) return [];
  // Numbered over the whole batch in its own order, as pinNumbers is everywhere
  // else, so a picture's pins read 1, 2, 3 here exactly as on the picture.
  const numbers = pinNumbers(comments);
  return sortPendingComments(comments.filter((c) => !isProposalAnswer(c))).map((c) => ({
    id: c.id,
    ...(c.image ? { src: c.image.src } : {}),
    ...(numbers.has(c.id) ? { number: numbers.get(c.id) } : {}),
    quote: c.image ? '' : (c.quote || '').replace(/\s+/g, ' ').trim(),
    note: c.body.trim(),
  }));
}

/** A signature of exactly what the tray draws, so the tray re-renders only when one of its rows changes. */
export function traySig(comments: readonly PendingComment[] | undefined): string {
  const rows = trayRows(comments);
  return rows.length ? JSON.stringify(rows) : '';
}

/** The tray's head: the gallery header's words. */
export function trayHeadline(rows: readonly TrayRow[]): string | null {
  return notesHeadline(rows.length);
}

// Clear takes every row at once, so it arms on the first press and takes
// them on the second, as the web's Clear does ("Discard N?").
export function clearWords(count: number, armed: boolean): string {
  return armed ? `Discard ${count}?` : 'Clear';
}
