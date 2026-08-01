// The one piece of editor logic that is pure text arithmetic, kept out of the
// component so it can be tested without a DOM.
//
// When a note changes on disk while the editor is open and CLEAN, the editor
// must adopt the new bytes without throwing away the cursor. Replacing the
// whole document would collapse the selection to the start on every external
// write (including our own save echo). Instead we replace only the span that
// actually differs — for the common case of an edit somewhere else in the file,
// the cursor sits outside that span and CodeMirror maps it through untouched.

/**
 * The line ending the file already uses. CodeMirror splits on any of \n, \r\n
 * and \r but always JOINS with "\n": a CRLF note opened and saved untouched
 * would come back rewritten end to end unless the editor is both configured
 * with the file's separator and serialized through it
 * (`doc.sliceString(0, doc.length, sep)`). Mixed files follow their majority,
 * which is what every other editor does.
 */
export function detectLineSeparator(content: string): "\n" | "\r\n" {
  let crlf = 0;
  let lf = 0;
  for (let i = content.indexOf("\n"); i !== -1; i = content.indexOf("\n", i + 1)) {
    if (i > 0 && content.charCodeAt(i - 1) === 13) crlf++;
    else lf++;
  }
  return crlf > lf ? "\r\n" : "\n";
}

export interface DocChange {
  from: number;
  to: number;
  insert: string;
}

/** The smallest single-span replacement turning `from` into `to`, or null when
 *  they are already identical. Prefix and suffix are compared by code unit; the
 *  overlap is clamped so the two never cross on a repeated run of text. */
export function docChange(oldDoc: string, newDoc: string): DocChange | null {
  if (oldDoc === newDoc) return null;
  const max = Math.min(oldDoc.length, newDoc.length);
  let start = 0;
  while (start < max && oldDoc.charCodeAt(start) === newDoc.charCodeAt(start)) start++;
  let end = 0;
  while (
    end < max - start &&
    oldDoc.charCodeAt(oldDoc.length - 1 - end) === newDoc.charCodeAt(newDoc.length - 1 - end)
  ) {
    end++;
  }
  return {
    from: start,
    to: oldDoc.length - end,
    insert: newDoc.slice(start, newDoc.length - end),
  };
}
