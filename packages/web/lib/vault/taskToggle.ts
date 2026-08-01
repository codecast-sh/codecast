// Writing a reading-mode checkbox click back to the note's source.
//
// Everything about this is deliberately narrow: it rewrites the ONE character
// inside the brackets on the named line and leaves every other byte of the file
// alone, including line endings and trailing whitespace. The note is a file the
// user owns; a checkbox click must never reformat it.

import { TASK_LINE_RE } from "./parseNote";

/**
 * Set the checkbox on `sourceLine` (1-based, counted in the FULL file including
 * frontmatter) to `checked`, or flip it when `checked` is omitted.
 *
 * Returns the new content, or null when that line isn't a task line — a stale
 * render, a file that changed underneath, or a click on something that only
 * looked like a checkbox. Callers write nothing on null rather than guessing.
 */
export function toggleTaskInContent(
  content: string,
  sourceLine: number,
  checked?: boolean,
): string | null {
  const lines = content.split("\n");
  const line = lines[sourceLine - 1];
  if (line === undefined) return null;
  // Split on "\n" alone so a CRLF file keeps its bytes; the carriage return
  // then rides at the end of the line, where the shared regex (which the index
  // engine applies to already-normalized lines) would refuse to match it.
  const match = TASK_LINE_RE.exec(line.endsWith("\r") ? line.slice(0, -1) : line);
  if (!match) return null;
  const done = /[xX]/.test(match[2]);
  const next = checked ?? !done;
  if (next === done) return null;
  const at = match[1].length;
  lines[sourceLine - 1] = line.slice(0, at) + (next ? "x" : " ") + line.slice(at + 1);
  return lines.join("\n");
}
