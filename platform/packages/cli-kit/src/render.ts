// The rendering toolkit every read-only terminal view shares: a palette that
// is a value (so a pure renderer can be handed colour on or off and unit
// tested either way), column helpers that ignore escape codes, word wrap,
// a small table, and the "Next:" block a view ends with so the reader always
// has the exact command to go deeper.
//
// Ported from union-mobile's agentRuns/ansi.ts and conversations/render.ts,
// which every xrun view there is built on. Colour is a parameter here and a
// process global in colors.ts; renderers take the parameter, commands read
// the global once (`renderOpts`) and pass it down.

import { isColorSupported } from "./colors";
import { visibleLength } from "./text";

export type Style = (s: string) => string;

export interface Palette {
  enabled: boolean;
  bold: Style;
  dim: Style;
  italic: Style;
  underline: Style;
  red: Style;
  green: Style;
  yellow: Style;
  blue: Style;
  magenta: Style;
  cyan: Style;
  gray: Style;
  white: Style;
  /** 256 colour foreground by palette index. */
  fg: (code: number) => Style;
}

export function makePalette(enabled: boolean): Palette {
  const wrap =
    (open: string): Style =>
    (s: string) =>
      enabled ? `\x1b[${open}m${s}\x1b[0m` : s;
  return {
    enabled,
    bold: wrap("1"),
    dim: wrap("2"),
    italic: wrap("3"),
    underline: wrap("4"),
    red: wrap("31"),
    green: wrap("32"),
    yellow: wrap("33"),
    blue: wrap("34"),
    magenta: wrap("35"),
    cyan: wrap("36"),
    gray: wrap("90"),
    white: wrap("97"),
    fg: (code: number) => wrap(`38;5;${code}`),
  };
}

/** What every renderer takes: colour, width, and whether to show everything. */
export interface RenderOpts {
  color: boolean;
  width: number;
  full?: boolean;
}

/**
 * The options a command passes its renderer, read once from the process:
 * colour only on a terminal (agents reading through a pipe get plain text),
 * width from the terminal or 100 when there is none.
 */
export function renderOpts(flags: { color?: boolean; width?: number; full?: boolean } = {}): RenderOpts {
  const color = flags.color === undefined ? isColorSupported : flags.color && isColorSupported;
  const width = flags.width ?? (process.stdout.columns && process.stdout.columns > 40 ? Math.min(process.stdout.columns, 160) : 100);
  return { color, width, full: flags.full ?? false };
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Truncate PLAIN text by character count, an ellipsis when cut. Newlines survive; `clip` in text.ts flattens them. */
export function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  if (max === 1) return "…";
  return s.slice(0, max - 1) + "…";
}

/** Pad a (possibly coloured) string on the right to a visible width. */
export function padEnd(s: string, width: number): string {
  const len = visibleLength(s);
  return len >= width ? s : s + " ".repeat(width - len);
}

/** Pad a (possibly coloured) string on the left to a visible width. */
export function padStart(s: string, width: number): string {
  const len = visibleLength(s);
  return len >= width ? s : " ".repeat(width - len) + s;
}

/** A cell: plain text cut to the width, then styled, then padded. Cutting after styling would cut the escape code. */
export function cell(text: string, width: number, style: Style = (s) => s, align: "left" | "right" = "left"): string {
  const cut = truncate(text.replace(/\s+/g, " "), width);
  return align === "right" ? padStart(style(cut), width) : padEnd(style(cut), width);
}

export function hr(p: Palette, width: number, ch = "─"): string {
  return p.dim(ch.repeat(Math.max(1, width)));
}

/** Word wrap plain text to `width`, keeping paragraph breaks and hard splitting a token longer than a line. */
export function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  const w = Math.max(20, width);
  for (const para of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = para.replace(/\t/g, "  ").trimEnd();
    if (line.trim() === "") {
      out.push("");
      continue;
    }
    let cur = "";
    for (const rawWord of line.split(/\s+/)) {
      if (!rawWord) continue;
      let word = rawWord;
      while (word.length > w) {
        if (cur) {
          out.push(cur);
          cur = "";
        }
        out.push(word.slice(0, w));
        word = word.slice(w);
      }
      if (!word) continue;
      if (cur.length + 1 + word.length > w && cur) {
        out.push(cur);
        cur = word;
      } else {
        cur = cur ? `${cur} ${word}` : word;
      }
    }
    if (cur) out.push(cur);
  }
  const collapsed = out.filter((l, i) => !(l === "" && out[i - 1] === ""));
  while (collapsed[0] === "") collapsed.shift();
  while (collapsed[collapsed.length - 1] === "") collapsed.pop();
  return collapsed;
}

/** Indent every line. */
export function indent(lines: string[], by = 2): string[] {
  const pad = " ".repeat(by);
  return lines.map((l) => (l ? pad + l : l));
}

/** The "Next:" block every view ends with: commands aligned, notes dim. */
export function renderNext(items: Array<[command: string, note: string]>, p: Palette): string[] {
  if (items.length === 0) return [];
  const w = Math.max(...items.map(([c]) => c.length)) + 3;
  return [p.dim("Next:"), ...items.map(([c, n]) => `  ${padEnd(p.cyan(c), w)}${p.dim(n)}`)];
}

export interface Column<T> {
  header: string;
  width?: number;
  align?: "left" | "right";
  /** Plain text for the cell; the table cuts it to the width. */
  value: (row: T) => string;
  /** A style for the cell, decided per row. */
  style?: (row: T) => Style;
}

/**
 * A table whose last flexible column takes what is left of the width. A
 * column with no width is measured from its content, capped at 40.
 */
export function renderTable<T>(rows: T[], columns: Column<T>[], p: Palette, width: number): string[] {
  const widths = columns.map((c) => {
    if (c.width) return c.width;
    const longest = Math.max(c.header.length, ...rows.map((r) => c.value(r).length));
    return Math.min(longest, 40);
  });
  const fixed = widths.reduce((n, w) => n + w, 0) + (columns.length - 1) * 2;
  const lastFlex = columns.map((c) => !c.width).lastIndexOf(true);
  if (lastFlex >= 0) widths[lastFlex] = Math.max(8, (widths[lastFlex] ?? 8) + (width - fixed));
  const line = (cells: string[]) => cells.join("  ").trimEnd();
  const out = [line(columns.map((c, i) => cell(c.header, widths[i] ?? 8, p.dim, c.align)))];
  for (const row of rows) out.push(line(columns.map((c, i) => cell(c.value(row), widths[i] ?? 8, c.style?.(row) ?? ((s) => s), c.align))));
  return out;
}

/** A one line key/value header block: `key  value`, keys dim and aligned. */
export function renderFields(fields: Array<[string, string]>, p: Palette): string[] {
  const kept = fields.filter(([, v]) => v !== "" && v !== undefined && v !== null);
  if (kept.length === 0) return [];
  const w = Math.max(...kept.map(([k]) => k.length)) + 2;
  return kept.map(([k, v]) => `${padEnd(p.dim(k), w)}${v}`);
}
