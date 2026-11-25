// Indentation detected from the file itself, so a two-space TypeScript file, a
// four-space Python file and a tab-indented Go file each get their own unit
// without a setting. The approach is the one VS Code and detect-indent use:
// look at how indentation CHANGES between consecutive lines, not at absolute
// widths, because a file nested three deep is full of 6-space lines that say
// nothing about the unit.

export interface IndentInfo {
  /** What one press of Tab (or `>>`) inserts: "\t" or N spaces. */
  unit: string;
  tabs: boolean;
  /** Spaces per level; for a tab file, the display width of a tab. */
  width: number;
  /** False when the file had too little indentation to say (fallback used). */
  detected: boolean;
}

/** Lines examined. Indentation style is settled long before this. */
const SAMPLE_LINES = 10_000;

/** Languages whose convention beats a blanket default when the file can't say. */
const LANGUAGE_DEFAULTS: Record<string, { tabs: boolean; width: number }> = {
  Go: { tabs: true, width: 4 },
  Makefile: { tabs: true, width: 4 },
  Python: { tabs: false, width: 4 },
  Rust: { tabs: false, width: 4 },
  Java: { tabs: false, width: 4 },
  "C#": { tabs: false, width: 4 },
  PHP: { tabs: false, width: 4 },
  Swift: { tabs: false, width: 4 },
  Kotlin: { tabs: false, width: 4 },
};

export function indentInfo(tabs: boolean, width: number, detected: boolean): IndentInfo {
  return { unit: tabs ? "\t" : " ".repeat(width), tabs, width, detected };
}

export function defaultIndent(languageName?: string | null, tabSize = 4): IndentInfo {
  const d = (languageName && LANGUAGE_DEFAULTS[languageName]) || { tabs: false, width: 2 };
  return indentInfo(d.tabs, d.tabs ? tabSize : d.width, false);
}

export function detectIndent(text: string, opts: { languageName?: string | null; tabSize?: number } = {}): IndentInfo {
  let tabLines = 0;
  let spaceLines = 0;
  // Frequency of each positive change in space indentation between lines.
  const deltas = new Map<number, number>();
  let prevSpaces = 0;
  let pos = 0;
  for (let n = 0; n < SAMPLE_LINES && pos <= text.length; n++) {
    let end = text.indexOf("\n", pos);
    if (end === -1) end = text.length;
    const c0 = text.charCodeAt(pos);
    if (c0 === 9) {
      tabLines++;
    } else {
      let spaces = 0;
      while (text.charCodeAt(pos + spaces) === 32) spaces++;
      const next = text.charCodeAt(pos + spaces);
      const blank = pos + spaces >= end || next === 13;
      // A JSDoc or block-comment continuation (" * text") is indented by one
      // for alignment, not by a level; it would vote for width 1.
      const commentStar = next === 42 && spaces > 0 && (spaces & 1) === 1;
      if (!blank && !commentStar) {
        if (spaces > 0) spaceLines++;
        const delta = Math.abs(spaces - prevSpaces);
        if (delta > 1) deltas.set(delta, (deltas.get(delta) ?? 0) + 1);
        prevSpaces = spaces;
      }
    }
    pos = end + 1;
  }

  const fallback = defaultIndent(opts.languageName, opts.tabSize);
  if (tabLines === 0 && spaceLines === 0) return fallback;
  if (tabLines > spaceLines) return indentInfo(true, opts.tabSize ?? 4, true);

  let best = 0;
  let bestCount = 0;
  for (const [delta, count] of deltas) {
    // Ties go to the smaller width: a 2-space file has as many 4-wide jumps
    // (closing two levels at once) as a 4-space file has, but not the reverse.
    if (count > bestCount || (count === bestCount && delta < best)) {
      best = delta;
      bestCount = count;
    }
  }
  if (!best || best > 8) return fallback.tabs ? indentInfo(false, 2, false) : fallback;
  return indentInfo(false, best, true);
}

/** The status bar's words for it, as every editor writes them. */
export function indentLabel(info: IndentInfo): string {
  return info.tabs ? `Tab Size: ${info.width}` : `Spaces: ${info.width}`;
}
