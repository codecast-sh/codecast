// File paths in terminal output open the code editor: a compiler error
// (`src/x.ts(12,4)`, `src/x.ts:12:4`), a grep hit, `git status`, an agent's
// own pane. The grammar is the one conversation prose uses (filePathLinks:
// strict, so a slash in prose or a URL is not a path) plus the `(line,col)`
// suffix tsc and MSBuild print. A click goes through the one door,
// lib/filesPane openInEditor, so the file opens beside the stage at the line.
//
// Relative paths resolve against the terminal's directory: a shell's cwd (its
// start directory, then whatever OSC 7 reports), or for an agent's pane the
// conversation's project. The machine is the pane's: a host's file opens
// through its forward, never a same-named checkout here.

import type { IBufferLine, ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { FILE_PATH_SCAN_RE, folderPathContext, mentionFromMatch, type FilePathContextValue } from "../filePathLinks";

export interface TerminalPathLink {
  /** Character offsets into the scanned text; `end` exclusive. */
  start: number;
  end: number;
  path: string;
  line?: number;
  column?: number;
}

// `path(12,4)` (tsc, MSBuild): a suffix the prose grammar has no form for.
const PAREN_LINE = /^\((\d+)(?:,(\d+))?\)/;

/** Every path mention in one logical terminal line, in order. */
export function scanTerminalPaths(text: string): TerminalPathLink[] {
  const out: TerminalPathLink[] = [];
  for (const m of text.matchAll(FILE_PATH_SCAN_RE)) {
    const mention = mentionFromMatch(m[0], m[1], m[2], m[3]);
    if (!mention) continue;
    const start = m.index!;
    let end = start + mention.text.length;
    let { line, column } = mention;
    if (line == null && !mention.rest) {
      const paren = PAREN_LINE.exec(text.slice(end));
      if (paren) {
        line = parseInt(paren[1], 10);
        if (paren[2]) column = parseInt(paren[2], 10);
        end += paren[0].length;
      }
    }
    out.push({ start, end, path: mention.path, ...(line ? { line } : {}), ...(column ? { column } : {}) });
  }
  return out;
}

/** Where a terminal's relative paths resolve, on which machine. */
export interface TerminalFileContext {
  cwd?: string;
  deviceId?: string | null;
}

export function terminalPathContext(t: TerminalFileContext): FilePathContextValue {
  return folderPathContext(t.cwd, t.deviceId);
}

/** The cwd an OSC 7 report names (`file://host/path`), or null. */
export function cwdFromOsc7(data: string): string | null {
  const m = /^file:\/\/[^/]*(\/.*)$/.exec(data.trim());
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/**
 * One logical line around buffer row `y` (0-based): the row plus the rows it
 * wraps into, as text with each character's cell. Wide characters take one
 * character and two cells, which is why the cells are read one by one.
 */
function logicalLine(term: Terminal, y: number): { text: string; cells: Array<{ x: number; y: number }> } | null {
  const buf = term.buffer.active;
  let first = y;
  while (first > 0 && buf.getLine(first)?.isWrapped) first--;
  let last = y;
  while (buf.getLine(last + 1)?.isWrapped) last++;
  let text = "";
  const cells: Array<{ x: number; y: number }> = [];
  for (let row = first; row <= last; row++) {
    const line: IBufferLine | undefined = buf.getLine(row);
    if (!line) break;
    // Trailing blanks of the last row are not part of anything.
    const width = row === last ? line.translateToString(true).length : line.length;
    for (let x = 0, chars = 0; x < line.length && chars < width; x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      const ch = cell.getChars() || " ";
      for (const c of ch) {
        text += c;
        cells.push({ x, y: row });
      }
      chars += ch.length;
    }
  }
  return text ? { text, cells } : null;
}

/** Link file paths in `term`'s output. `context` is read at hover and click,
 *  so a cd the shell reports, or a conversation's project arriving, counts. */
export function installTerminalFileLinks(
  term: Terminal,
  context: () => FilePathContextValue,
  open: (link: TerminalPathLink, ctx: FilePathContextValue) => void,
): void {
  const provider: ILinkProvider = {
    provideLinks(bufferLineNumber, callback) {
      const at = logicalLine(term, bufferLineNumber - 1);
      if (!at) return callback(undefined);
      const row = bufferLineNumber - 1;
      const links: ILink[] = [];
      for (const hit of scanTerminalPaths(at.text)) {
        const a = at.cells[hit.start];
        const b = at.cells[hit.end - 1];
        // Each row of a wrapped line asks for itself; a link is reported by
        // every row it touches, which is how xterm underlines it whole.
        if (!a || !b || a.y > row || b.y < row) continue;
        links.push({
          range: { start: { x: a.x + 1, y: a.y + 1 }, end: { x: b.x + 1, y: b.y + 1 } },
          text: at.text.slice(hit.start, hit.end),
          decorations: { underline: true, pointerCursor: true },
          activate(event) {
            if (event.button !== 0) return;
            open(hit, context());
          },
        });
      }
      callback(links.length ? links : undefined);
    },
  };
  term.registerLinkProvider(provider);
}
