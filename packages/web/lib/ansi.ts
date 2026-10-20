// Terminal color codes in command output. Pure, so web (renderAnsi) and the
// phone draw a colored `ls` or test run the same way.

export function stripAnsiCodes(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

const ANSI_COLORS: Record<number, string> = {
  30: '#073642', 31: '#dc322f', 32: '#859900', 33: '#b58900',
  34: '#268bd2', 35: '#d33682', 36: '#2aa198', 37: '#eee8d5',
  90: '#586e75', 91: '#cb4b16', 92: '#859900', 93: '#b58900',
  94: '#268bd2', 95: '#6c71c4', 96: '#2aa198', 97: '#fdf6e3',
};

export type AnsiSpan = { text: string; color?: string; bold?: boolean };

/** Text split at its color codes, each run with the color and weight it is drawn in. */
export function ansiSpans(text: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  const regex = /\x1b\[([0-9;]*)m/g;
  let lastIndex = 0;
  let color: string | undefined;
  let bold = false;
  const push = (segment: string) => {
    if (segment) spans.push(color || bold ? { text: segment, color, bold: bold || undefined } : { text: segment });
  };
  let match;
  while ((match = regex.exec(text)) !== null) {
    push(text.slice(lastIndex, match.index));
    lastIndex = regex.lastIndex;
    for (const code of match[1].split(';').map(Number)) {
      if (code === 0) { color = undefined; bold = false; }
      else if (code === 1) bold = true;
      else if (ANSI_COLORS[code]) color = ANSI_COLORS[code];
    }
  }
  push(text.slice(lastIndex));
  return spans;
}
