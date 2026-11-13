// A table pasted from a web page or another spreadsheet (Google Sheets and
// Excel put an HTML table on the clipboard): its cell text, and the bold,
// italic, underline, colors, alignment and merges it carries.
import { colLetters, type CellStyle, type ImportTable, type Rect } from "./sheetCore";
import { snapColor } from "./importFile";

/** A CSS color ("rgb(255, 242, 204)", "#fff2cc", "#fc0") as an ARGB hex, or undefined. */
/** The few color names Excel and web pages write instead of a hex value. */
const NAMED: Record<string, string> = { black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", yellow: "#ffff00", orange: "#ffa500", purple: "#800080", gray: "#808080", grey: "#808080", silver: "#c0c0c0", navy: "#000080", teal: "#008080", maroon: "#800000", olive: "#808000", lime: "#00ff00", aqua: "#00ffff", fuchsia: "#ff00ff" };

function cssHex(css: string): string | undefined {
  const c = (NAMED[css.trim().toLowerCase()] ?? css).trim().toLowerCase();
  const rgb = c.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/);
  if (rgb) {
    if (rgb[4] !== undefined && Number(rgb[4]) === 0) return undefined;
    return "FF" + [rgb[1], rgb[2], rgb[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("").toUpperCase();
  }
  const hex = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hex) return "FF" + (hex[1].length === 3 ? [...hex[1]].map((x) => x + x).join("") : hex[1]).toUpperCase();
  return undefined;
}

/**
 * A formula Google Sheets puts on the clipboard (R1C1: =R[0]C[-1]*2, R2C3 for
 * $C$2) in A1 form for the cell it lands on.
 */
export function r1c1ToA1(formula: string, col: number, row: number): string {
  return formula
    .split(/("(?:[^"]|"")*")/)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(/(?<![A-Za-z_.])R(\[-?\d+\]|\d+)?C(\[-?\d+\]|\d+)?(?![A-Za-z_(\d])/g, (_m, r: string | undefined, c: string | undefined) => {
            // A bare R or C (R[-1]C) is this row or column.
            const rel = (x: string | undefined) => x === undefined || x.startsWith("[");
            const n = (x: string | undefined, base: number) => (x === undefined ? base : rel(x) ? base + Number(x.slice(1, -1)) : Number(x));
            const cc = n(c, col), rr = n(r, row);
            if (cc < 1 || rr < 1) return "#REF!";
            return `${rel(c) ? "" : "$"}${colLetters(cc)}${rel(r) ? "" : "$"}${rr}`;
          }),
    )
    .join("");
}

/** A cell's text with its line breaks (a <br> is a new line in the cell, as Google keeps it). */
function cellText(td: HTMLTableCellElement): string {
  const copy = td.cloneNode(true) as HTMLElement;
  for (const br of copy.querySelectorAll("br")) br.replaceWith("\n");
  return (copy.textContent ?? "").replace(/[^\S\n]+/g, " ").replace(/ *\n */g, "\n").trim();
}

/**
 * The first table in clipboard HTML as a placeable table, or null when there
 * is none. `at` is where it lands, so formulas a spreadsheet copied come in
 * pointing at the same neighbours.
 */
export function htmlTable(html: string, at: { col: number; row: number } = { col: 1, row: 1 }): Omit<ImportTable, "name"> | null {
  if (!/<table[\s>]/i.test(html) || typeof DOMParser === "undefined") return null;
  const page = new DOMParser().parseFromString(html, "text/html");
  const table = page.querySelector("table");
  // Excel puts a cell's look in a <style> block of class rules (.xl65 { font-weight: 700; background: #FFFF00 }), not inline.
  const classes = new Map<string, Map<string, string>>();
  for (const st of page.querySelectorAll("style"))
    for (const m of (st.textContent ?? "").matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g)) {
      const props = classes.get(m[1]) ?? new Map<string, string>();
      for (const decl of m[2].split(";")) {
        const i = decl.indexOf(":");
        if (i > 0) props.set(decl.slice(0, i).trim().toLowerCase(), decl.slice(i + 1).trim());
      }
      classes.set(m[1], props);
    }
  if (!table) return null;
  const grid: string[][] = [];
  const styles: NonNullable<ImportTable["styles"]> = [];
  const merges: Rect[] = [];
  const taken = new Set<string>();
  [...table.rows].forEach((tr, ri) => {
    const row = ri + 1;
    let col = 1;
    for (const td of [...tr.cells]) {
      while (taken.has(`${col}:${row}`)) col++;
      const span = Math.max(1, Number(td.getAttribute("colspan")) || 1);
      const down = Math.max(1, Number(td.getAttribute("rowspan")) || 1);
      for (let r = row; r < row + down; r++) for (let c = col; c < col + span; c++) taken.add(`${c}:${r}`);
      if (span > 1 || down > 1) merges.push({ c0: col, r0: row, c1: col + span - 1, r1: row + down - 1 });
      while (grid.length < row) grid.push([]);
      const line = grid[row - 1];
      while (line.length < col - 1) line.push("");
      const formula = td.getAttribute("data-sheets-formula");
      line[col - 1] = formula?.startsWith("=") ? r1c1ToA1(formula, at.col + col - 1, at.row + row - 1) : cellText(td);
      // Inline styles on the cell or a single wrapper inside it, as spreadsheets write them.
      const inner = td.children.length === 1 ? (td.children[0] as HTMLElement) : null;
      const fromClass = (prop: string) => [...td.classList].map((c) => classes.get(c)?.get(prop) ?? (prop === "background-color" ? classes.get(c)?.get("background") : undefined)).find(Boolean) ?? "";
      const css = (prop: string) => td.style.getPropertyValue(prop) || inner?.style?.getPropertyValue(prop) || fromClass(prop);
      const style: CellStyle = {};
      if (td.tagName === "TH" || /^(bold|[6-9]00)$/.test(css("font-weight")) || td.querySelector("b, strong")) style.b = true;
      if (css("font-style") === "italic" || td.querySelector("i, em")) style.i = true;
      if (/underline/.test(css("text-decoration") + css("text-decoration-line")) || td.querySelector("u")) style.u = true;
      const fill = snapColor(cssHex(css("background-color") || td.getAttribute("bgcolor") || ""), "fill");
      if (fill) style.fill = fill;
      const color = snapColor(cssHex(css("color")), "text");
      if (color) style.color = color;
      const al = css("text-align") || td.getAttribute("align") || "";
      if (al === "center" || al === "right") style.al = al;
      if (Object.keys(style).length) styles.push({ col, row, style });
      col += span;
    }
  });
  if (!grid.length) return null;
  return { grid, ...(styles.length ? { styles } : {}), ...(merges.length ? { merges } : {}) };
}
