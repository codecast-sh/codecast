// A table pasted from a web page or another spreadsheet (Google Sheets and
// Excel put an HTML table on the clipboard): its cell text, and the bold,
// italic, underline, colors, alignment and merges it carries.
import type { CellStyle, ImportTable, Rect } from "./sheetCore";
import { snapColor } from "./importFile";

/** A CSS color ("rgb(255, 242, 204)", "#fff2cc", "#fc0") as an ARGB hex, or undefined. */
function cssHex(css: string): string | undefined {
  const c = css.trim().toLowerCase();
  const rgb = c.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/);
  if (rgb) {
    if (rgb[4] !== undefined && Number(rgb[4]) === 0) return undefined;
    return "FF" + [rgb[1], rgb[2], rgb[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("").toUpperCase();
  }
  const hex = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hex) return "FF" + (hex[1].length === 3 ? [...hex[1]].map((x) => x + x).join("") : hex[1]).toUpperCase();
  return undefined;
}

/** The first table in clipboard HTML as a placeable table, or null when there is none. */
export function htmlTable(html: string): Omit<ImportTable, "name"> | null {
  if (!/<table[\s>]/i.test(html) || typeof DOMParser === "undefined") return null;
  const table = new DOMParser().parseFromString(html, "text/html").querySelector("table");
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
      line[col - 1] = (td.textContent ?? "").replace(/\u00a0/g, " ").trim();
      // Inline styles on the cell or a single wrapper inside it, as spreadsheets write them.
      const inner = td.children.length === 1 ? (td.children[0] as HTMLElement) : null;
      const css = (prop: string) => td.style.getPropertyValue(prop) || inner?.style?.getPropertyValue(prop) || "";
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
