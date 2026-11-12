// A tab as a PDF to print or send: the cells as the grid shows them (bold,
// fills, text colors, numbers to the right), with light gridlines, on
// landscape Letter pages. Columns keep their relative widths, scaled down to
// fit a page; the frozen header rows repeat on every page. No dependency: a
// PDF is a short text file of drawing commands with the standard Helvetica
// fonts, which every reader has.
import { cellNum, styleOf, type SheetModel, type Workbook } from "./sheetCore";
import { PALETTE_HEX, shownText } from "./exportFile";

const PAGE_W = 792, PAGE_H = 612, MARGIN = 36;
const DEF_COL = 100, MAX_ROWS = 20_000;

/** Helvetica advance widths (per 1000 em) for the printable ASCII range, so text is cut where it really ends. */
const HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const textWidth = (s: string, size: number, bold: boolean) => [...s].reduce((w, ch) => w + (HELV[ch.charCodeAt(0) - 32] ?? 556), 0) * (size / 1000) * (bold ? 1.06 : 1);

/** Text as a PDF string in WinAnsi (the standard fonts' encoding): € and quotes mapped, other characters shown as "?". */
function pdfString(s: string): string {
  const map: Record<string, string> = { "€": "\\200", "‘": "\\221", "’": "\\222", "“": "\\223", "”": "\\224", "–": "\\226", "—": "\\227", "…": "\\205", "£": "\\243", "¥": "\\245" };
  let out = "";
  for (const ch of s) {
    if (ch === "(" || ch === ")" || ch === "\\") out += `\\${ch}`;
    else if (map[ch]) out += map[ch];
    else out += ch.charCodeAt(0) < 32 ? " " : ch.charCodeAt(0) < 256 ? ch : "?";
  }
  return `(${out})`;
}

function cut(s: string, room: number, size: number, bold: boolean): string {
  if (textWidth(s, size, bold) <= room) return s;
  let t = s;
  while (t.length > 1 && textWidth(`${t}…`, size, bold) > room) t = t.slice(0, -1);
  return `${t}…`;
}

const rgb = (argb: string) => [0, 2, 4].map((i) => (parseInt(argb.slice(2 + i, 4 + i), 16) / 255).toFixed(3)).join(" ");

export function sheetPdf(model: SheetModel, wb: Workbook, tabId: string): Uint8Array {
  const t = model.byId.get(tabId);
  const cols = Math.max(1, t?.cols ?? 1), rows = Math.min(MAX_ROWS, Math.max(1, t?.rows ?? 1));
  const shownCols = Array.from({ length: cols }, (_, i) => i + 1).filter((c) => !t?.hiddenCols?.has(c));
  const widths = shownCols.map((c) => t?.colWidths.get(c) ?? DEF_COL);
  const scale = Math.min(0.75, (PAGE_W - 2 * MARGIN) / widths.reduce((a, b) => a + b, 0));
  const size = Math.max(5, Math.min(9, 13 * scale)), rowH = size * 1.6;
  const xs: number[] = [MARGIN];
  for (const w of widths) xs.push(xs[xs.length - 1] + w * scale);
  const head = Math.min(t?.meta.frozenRows ?? 0, 5);
  const body = Array.from({ length: rows - head }, (_, i) => head + i + 1).filter((r) => !t?.hiddenRows?.has(r));
  const perPage = Math.max(1, Math.floor((PAGE_H - 2 * MARGIN - head * rowH - 16) / rowH));

  const pages: string[] = [];
  for (let start = 0; start < Math.max(1, body.length); start += perPage) {
    const lines = [...Array.from({ length: head }, (_, i) => i + 1), ...body.slice(start, start + perPage)];
    const ops: string[] = [];
    // Title line: the tab's name and the page.
    ops.push(`BT /F2 ${size + 2} Tf ${MARGIN} ${PAGE_H - MARGIN + 4} Td ${pdfString(t?.meta.name ?? "Sheet")} Tj ET`);
    lines.forEach((row, li) => {
      const y = PAGE_H - MARGIN - 12 - (li + 1) * rowH;
      shownCols.forEach((col, ci) => {
        const el = t?.cells.get(cellNum(col, row));
        const st = styleOf(el);
        const x0 = xs[ci], x1 = xs[ci + 1];
        // A cell's own fill, else its table's header tint or band (every other body row).
        const table = model.tables.find((x) => x.tab === tabId && col >= x.rect.c0 && col <= x.rect.c1 && row >= x.rect.r0 && row <= x.rect.r1);
        const fill = st.fill && PALETTE_HEX[st.fill] ? rgb(PALETTE_HEX[st.fill].fill) : table && PALETTE_HEX[table.color] && (row === table.rect.r0 || (table.banded && (row - table.rect.r0) % 2 === 0)) ? rgb(PALETTE_HEX[table.color].fill) : null;
        if (fill) ops.push(`${fill} rg ${x0} ${y} ${x1 - x0} ${rowH} re f`);
        ops.push(`0.85 0.85 0.85 RG 0.4 w ${x0} ${y} ${x1 - x0} ${rowH} re S`);
        const text = shownText(model, wb, tabId, col, row);
        if (!text) return;
        const bold = !!st.b || row <= head || !!(table && row === table.rect.r0);
        const shown = cut(text, x1 - x0 - 6, size, bold);
        const value = wb.value(tabId, col, row);
        const right = st.al === "right" || (st.al !== "left" && st.al !== "center" && typeof value === "number");
        const w = textWidth(shown, size, bold);
        const tx = st.al === "center" ? x0 + (x1 - x0 - w) / 2 : right ? x1 - 3 - w : x0 + 3;
        const color = st.color && PALETTE_HEX[st.color] ? rgb(PALETTE_HEX[st.color].text) : "0.1 0.1 0.1";
        ops.push(`BT ${color} rg /F${bold ? 2 : 1} ${size} Tf ${tx.toFixed(1)} ${(y + rowH / 2 - size / 3).toFixed(1)} Td ${pdfString(shown)} Tj ET`);
      });
    });
    pages.push(ops.join("\n"));
  }

  // Objects: 1 catalog, 2 pages, 3-4 fonts, then a page and its content per page.
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(" ");
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  pages.forEach((content, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${latin1(content).length} >>\nstream\n${content}\nendstream`);
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(latin1(out).length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = latin1(out).length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return latin1(out);
}

/** The file's bytes: every character is already in 0-255 (WinAnsi), one byte each. */
function latin1(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}
