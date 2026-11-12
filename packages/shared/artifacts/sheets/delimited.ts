// Delimited text in and out of a sheet: a clipboard paste, a CSV import, a copy.

/** Parse TSV the way Sheets and Excel put it on the clipboard: quoted fields may hold tabs, newlines and "". */
export function parseTsv(text: string): string[][] {
  return parseDelimited(text, "\t");
}

/** CSV or TSV by what the first line holds: a tab means TSV, else commas (or semicolons, Excel's European export). */
export function parseTable(text: string): string[][] {
  const first = text.slice(0, text.search(/\r?\n|$/));
  if (first.includes("\t")) return parseDelimited(text, "\t");
  const commas = (first.match(/,/g) ?? []).length, semis = (first.match(/;/g) ?? []).length;
  return parseDelimited(text, semis > commas ? ";" : ",");
}

/** Rows of fields split on a delimiter; a field may be quoted ("a, b", "say ""hi""", line breaks inside). */
export function parseDelimited(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  const src = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  let atFieldStart = true;
  while (i < src.length) {
    const ch = src[i];
    if (atFieldStart && ch === '"') {
      // Quoted field: runs to the closing quote not followed by another.
      let j = i + 1;
      let val = "";
      let closed = false;
      while (j < src.length) {
        if (src[j] === '"') {
          if (src[j + 1] === '"') {
            val += '"';
            j += 2;
            continue;
          }
          closed = true;
          j++;
          break;
        }
        val += src[j++];
      }
      if (closed && (j >= src.length || src[j] === sep || src[j] === "\n")) {
        field = val;
        i = j;
        atFieldStart = false;
        continue;
      }
      // Not a well-formed quoted field: read it literally.
    }
    if (ch === sep) {
      row.push(field);
      field = "";
      atFieldStart = true;
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      atFieldStart = true;
    } else {
      field += ch;
      atFieldStart = false;
    }
    i++;
  }
  row.push(field);
  rows.push(row);
  return rows;
}

/** Values as TSV for the clipboard; fields with tabs, newlines or quotes are quoted. */
export function toTsv(grid: string[][]): string {
  return grid.map((r) => r.map((v) => (/[\t\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join("\t")).join("\n");
}
