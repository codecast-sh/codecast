// "Select text" on the phone terminal: the relayed screen as plain text, with
// the line breaks a TUI inserted itself joined back, so a copied paragraph
// pastes as a paragraph rather than as the pane's rows.
//
// Ported from agentboard src/client/utils/snapshotRejoin.ts (MIT): Claude Code
// and Codex word-wrap their own output, so a row was wrapped by the app when
// the first word of the next row would not have fitted on it. The wrap width is
// measured from the capture (the widest ordinary row).

/** Rows wider than this many columns short of the pane prove nothing. */
const WIDTH_EVIDENCE_SLACK = 2;
/** Box drawing and block elements: tables, borders and the prompt box. */
const BOX_DRAWING = /[\u2500-\u259f]/;
/** A row that opens a list item or bullet (after its indent). */
const LIST_ITEM = /^\s*(?:[-*+•●◦▪‣⏺›❯>]|\d+[.)])\s/;
/** A first word that reads as a code statement: a wrapped sentence never continues with one. */
const CODE_STATEMENT = /\w[([{]|\w=/;
/** Where a long token (URL, path, hyphenated word) is broken without a space. */
const TOKEN_BREAK_END = /(?:[/?&=#]|\w-)$/;
/** SGR colors and the other escapes capture-pane -e emits, OSC 8 links included. */
// eslint-disable-next-line no-control-regex
const ESCAPE_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-_])/g;

function codePointWidth(code: number): number {
  if (code === 0 || code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if ((code >= 0x300 && code <= 0x36f) || (code >= 0x200b && code <= 0x200f) || code === 0xfe0f) return 0;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) return 2;
  return 1;
}

/** Display width of `text` in terminal columns. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += codePointWidth(char.codePointAt(0) ?? 0);
  return width;
}

const isOrdinaryRow = (row: string, paneCols: number) =>
  row.trim() !== '' && !BOX_DRAWING.test(row) && displayWidth(row) <= paneCols;

/** The column the app wrapped at, or the pane width when the capture holds no evidence. */
export function inferWrapWidth(rows: string[], paneCols: number): number {
  let widest = 0;
  for (const row of rows) {
    if (isOrdinaryRow(row, paneCols)) widest = Math.max(widest, displayWidth(row.trimEnd()));
  }
  return widest >= paneCols - WIDTH_EVIDENCE_SLACK ? widest : paneCols;
}

/** How rows i and i+1 join: ' ' (wrapped at a space), '' (token broken), or null. */
export type RowJoin = ' ' | '' | null;

export function findWrappedRows(rows: string[], paneCols: number, wrapWidth = inferWrapWidth(rows, paneCols)): RowJoin[] {
  const joins: RowJoin[] = [];
  for (let i = 0; i + 1 < rows.length; i++) {
    const row = rows[i].trimEnd();
    const next = rows[i + 1];
    if (!isOrdinaryRow(row, paneCols) || !isOrdinaryRow(next, paneCols) || LIST_ITEM.test(next)) {
      joins.push(null);
      continue;
    }
    const nextWord = next.trimStart().split(/\s/, 1)[0];
    if (displayWidth(row) + 1 + displayWidth(nextWord) <= wrapWidth) {
      joins.push(null);
      continue;
    }
    const content = row.trimStart();
    const brokenToken = !/\s/.test(content) || TOKEN_BREAK_END.test(content);
    if (!brokenToken && CODE_STATEMENT.test(nextWord)) {
      joins.push(null);
      continue;
    }
    joins.push(brokenToken ? '' : ' ');
  }
  return joins;
}

/** A relayed frame as plain rows: escapes stripped, trailing blanks dropped. */
export function frameRows(frame: string): string[] {
  const rows = frame.replace(ESCAPE_RE, '').split('\n').map((r) => r.trimEnd());
  while (rows.length && rows[rows.length - 1] === '') rows.pop();
  return rows;
}

/**
 * The frame as text to select and copy. `tui` rejoins the app's own wraps; a
 * plain shell's rows are kept as they are, since the app there did no wrapping
 * and tmux's own wraps cannot be told from a full-width line on a screen grab.
 */
/** A row that is only a rule (a TUI's full-width separator). */
const RULE_ROW = /^\s*[\u2500-\u257f\-=_]{8,}\s*$/;

export function snapshotText(frame: string, paneCols: number, mode: 'tui' | 'shell'): string {
  // A full-width rule would wrap into rows of dashes on a phone-width sheet:
  // it reads the same short.
  const rows = frameRows(frame).map((r) => (RULE_ROW.test(r) ? r.trim().slice(0, 12) : r));
  if (mode === 'shell' || rows.length < 2) return rows.join('\n');
  const joins = findWrappedRows(rows, paneCols);
  let out = rows[0];
  for (let i = 1; i < rows.length; i++) {
    const join = joins[i - 1];
    out += join === null ? '\n' + rows[i] : join + rows[i].trimStart();
  }
  return out;
}

/** The prompt glyphs Claude Code and Codex draw at their input line. */
const TUI_PROMPT = /^\s*[\u276f\u203a>]\s/m;

/**
 * Whether the screen is an agent's TUI (box drawing, its prompt glyph) rather
 * than a bare shell the agent left behind: only a TUI wrapped its own lines.
 */
export function looksLikeTui(frame: string): boolean {
  const plain = frameRows(frame).join('\n');
  return BOX_DRAWING.test(plain) || TUI_PROMPT.test(plain);
}
