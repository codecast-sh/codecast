// What one cell paints: its text, alignment and colors, after its own style,
// any table style over it and any conditional color. Colors are palette names
// resolved to the theme's --sol-* tokens, so light and dark both hold.
import {
  formatValue,
  isError,
  rectContains,
  type CellEl,
  type CondFormat,
  type PaletteColor,
  type Scalar,
  type ImpliedFormat,
  type TableStyle,
  type Validation,
  styleOf,
  todaySerial,
  parseDateText,
  shiftFormula,
  codeColor,
  betweenOf,
  PALETTE,
} from "@codecast/shared/artifacts/sheets";

export function solVar(c: PaletteColor): string {
  return c === "gray" ? "var(--sol-text-muted)" : `var(--sol-${c})`;
}

/** A fill tint of a palette color at a strength (percent). */
export function tint(c: PaletteColor, pct: number): string {
  return `color-mix(in srgb, ${solVar(c)} ${pct}%, transparent)`;
}

export type Paint = {
  text: string;
  align: "left" | "center" | "right";
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  size?: number;
  color?: string;
  fill?: string;
  /** Border letters t r b l. */
  bd?: string;
  wrap?: boolean;
  error?: string;
  /** Room on the right for a filter button over the header cell. */
  padRight?: boolean;
  check?: boolean;
  /** A dropdown cell: its value drawn as a chip in this fill and text color. */
  chip?: { fill: string; color: string };
  /** The cell opens a dropdown (list) or a date picker (date). */
  picker?: "list" | "date";
  /** The value is outside the cell's list or is not a date. */
  invalid?: boolean;
  /** The cell has an open comment thread. */
  comment?: boolean;
  /** =HYPERLINK("url", ...): the address it opens. */
  link?: string;
};

export type PaintContext = {
  tables: TableStyle[];
  conds: CondFormat[];
  /** Whether the cell under a table header holds a number (its header then aligns right). */
  numericAt?: (col: number, row: number) => boolean;
  /** The number format a formula takes from the cell it reads, when it has none of its own. */
  inherited?: (el: CellEl) => ImpliedFormat | undefined;
  /** The header cells of a filter block (they carry a filter button). */
  filterHeader?: (col: number, row: number) => boolean;
  /** min/max per scale rule key, computed once per render pass. */
  scaleRange: (key: string) => { min: number; max: number } | null;
  /** The validation covering a cell (dropdown or date). */
  validation?: (col: number, row: number) => Validation | undefined;
  /** Cells with an open comment thread (row * 2^15 + col). */
  comments?: ReadonlyMap<number, unknown>;
  /** Evaluate a rule's formula as if it sat in a cell (custom formula rules). */
  evalAt?: (formula: string, col: number, row: number) => Scalar;
  /** The tab's merged ranges. */
  merges?: readonly { rect: { c0: number; r0: number; c1: number; r1: number } }[];
};

export function paintCell(el: CellEl | undefined, value: Scalar, implied: ImpliedFormat | undefined, col: number, row: number, ctx: PaintContext): Paint {
  const s = styleOf(el);
  if (!s.nf && el && typeof el.input === "string" && el.input.startsWith("=") && typeof value === "number") implied = ctx.inherited?.(el) ?? implied;
  // A table's header row is labels: a number there reads as typed ("2025", not "2,025"),
  // whatever number format the column carries.
  const inHeader = ctx.tables.some((t) => row === t.rect.r0 && rectContains(t.rect, col, row));
  const text = inHeader && typeof value === "number" ? formatValue(value, undefined, implied?.nf === "date" ? implied : undefined) : formatValue(value, s, implied);
  const numeric = typeof value === "number";
  const err = isError(value);
  const p: Paint = {
    text,
    align: s.al ?? (err || typeof value === "boolean" ? "center" : numeric ? "right" : "left"),
    bold: s.b,
    italic: s.i,
    underline: s.u,
    size: s.fs,
    bd: s.bd,
    wrap: s.wrap,
  };
  if (s.nf === "check") {
    p.check = true;
    p.align = s.al ?? "center";
  }
  if (ctx.filterHeader?.(col, row)) p.padRight = true;
  if (err) {
    p.error = value.message ?? value.error;
    p.color = "var(--sol-red)";
  }
  for (const t of ctx.tables) {
    if (!rectContains(t.rect, col, row)) continue;
    // The stripes themselves are a layer under the cells (SheetGrid PaneBands).
    if (row === t.rect.r0) {
      p.bold = p.bold ?? true;
      p.color = p.color ?? solVar(t.color);
      if (!s.al && ctx.numericAt?.(col, row + 1)) p.align = "right";
    }
  }
  for (const c of ctx.conds) {
    if (!rectContains(c.rect, col, row) || err) continue;
    const color = c.color;
    switch (c.rule) {
      case "sign":
        if (numeric && value !== 0) p.color = solVar(value > 0 ? "green" : "red");
        break;
      case "scale": {
        const r = ctx.scaleRange(c.key);
        if (numeric && r && r.max > r.min) p.fill = tint(color ?? "green", Math.round(6 + 34 * ((value - r.min) / (r.max - r.min))));
        break;
      }
      case "gt":
      case "lt":
      case "between":
      case "eq":
      case "ne":
      case "empty":
      case "filled": {
        const target = c.value;
        const same = String(value ?? "").toLowerCase() === String(target ?? "").toLowerCase() || (numeric && value === Number(target));
        const range = c.rule === "between" ? betweenOf(target) : null;
        const blank = value === null || value === "";
        const hit =
          c.rule === "eq" ? same
          : c.rule === "ne" ? !blank && !same
          : c.rule === "empty" ? blank
          : c.rule === "filled" ? !blank
          : c.rule === "between" ? numeric && !!range && value >= range[0] && value <= range[1]
          : numeric && typeof target === "number" && (c.rule === "gt" ? value > target : value < target);
        if (hit) {
          p.fill = tint(color ?? "yellow", 22);
          p.color = ruleText(color ?? "yellow");
        }
        break;
      }
      case "formula": {
        const f = typeof c.value === "string" ? c.value : "";
        const r = f && ctx.evalAt ? ctx.evalAt(shiftFormula(f, col - c.rect.c0, row - c.rect.r0), col, row) : null;
        if (r === true || (typeof r === "number" && r !== 0)) {
          p.fill = tint(color ?? "yellow", 22);
          p.color = ruleText(color ?? "yellow");
        }
        break;
      }
      case "before":
      case "after": {
        // Dates are serials; the rule's value is "today" or a date as typed.
        const target = String(c.value ?? "").trim().toLowerCase() === "today" ? todaySerial() : parseDateText(String(c.value ?? ""));
        if (numeric && target !== null && (c.rule === "before" ? value < target : value > target)) {
          p.fill = tint(color ?? "orange", 22);
          p.color = ruleText(color ?? "orange");
        }
        break;
      }
      case "contains":
        if (typeof value === "string" && value.toLowerCase().includes(String(c.value ?? "").toLowerCase())) {
          p.fill = tint(color ?? "yellow", 22);
          p.color = ruleText(color ?? "yellow");
        }
        break;
    }
  }
  // A custom code may name a color for its section ("#,##0;[Red](#,##0)").
  const codeTint = s.nf === "custom" && s.code && numeric ? codeColor(value, s.code) : undefined;
  if (codeTint && (PALETTE as readonly string[]).includes(codeTint)) p.color = solVar(codeTint as PaletteColor);
  // The cell's own colors win over table and rule colors.
  if (s.fill) p.fill = tint(s.fill, 20);
  if (s.color) p.color = solVar(s.color);
  if (ctx.comments?.has(row * 32768 + col)) p.comment = true;
  const link = el && typeof el.input === "string" ? linkOf(el.input) : null;
  if (link) {
    p.link = link;
    p.color = s.color ? p.color : "var(--sol-blue)";
    p.underline = true;
  }
  const dv = ctx.validation?.(col, row);
  if (dv) {
    p.picker = dv.rule;
    if (dv.rule === "list" && text !== "") {
      const want = text.toLowerCase();
      const opt = dv.options.find((o) => o.v.toLowerCase() === want);
      if (opt) p.chip = chipStyle(opt.color);
      else p.invalid = true;
    } else if (dv.rule === "date" && value !== null && value !== "" && !(numeric && (s.nf === "date" || s.nf === "datetime" || implied?.nf === "date" || implied?.nf === "datetime"))) {
      p.invalid = true;
    }
  }
  return p;
}

/** A dropdown value's chip: a tint of its color, with text that reads on it in both themes. */
export function chipStyle(color: PaletteColor | undefined): { fill: string; color: string } {
  const c = color ?? "gray";
  return { fill: tint(c, 22), color: ruleText(c) };
}

/** The address a =HYPERLINK("https://…", label) formula opens (http and https only). */
export function linkOf(input: string): string | null {
  const m = input.match(/^=\s*HYPERLINK\(\s*"(https?:\/\/[^"]+)"/i);
  return m ? m[1] : null;
}

/** Rule-hit text: the color pulled toward the body text so it reads on its own tint in both themes. */
function ruleText(c: PaletteColor): string {
  return `color-mix(in srgb, ${solVar(c)} 55%, var(--sol-text))`;
}

/** Character width of the grid font at the default size, and a cell's horizontal padding. */
const CHAR_PX = 7.6;
const PAD_PX = 14;

/**
 * An automatic-format number shown in a column too narrow for it: fewer
 * decimals until it fits (0.70875908 -> 0.7087591), then scientific, the way
 * Sheets and Excel round to the column instead of cutting the digits off.
 */
export function fitNumber(text: string, value: number, widthPx: number, sizePx = 13): string {
  const room = Math.floor((widthPx - PAD_PX) / (CHAR_PX * (sizePx / 13)));
  if (text.length <= room || room < 1) return text;
  const intLen = String(Math.trunc(Math.abs(value))).length + (value < 0 ? 1 : 0);
  const dp = room - intLen - 1;
  if (dp >= 0 && intLen <= room) return String(Number(value.toFixed(dp)));
  if (intLen <= room) return String(Math.round(value));
  for (let digits = Math.max(0, room - 6); digits >= 0; digits--) {
    const sci = value.toExponential(digits).replace("e+", "E+").replace("e-", "E-");
    if (sci.length <= room) return sci;
  }
  return "#".repeat(Math.max(1, room));
}
