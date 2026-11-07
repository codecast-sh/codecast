// A POSIX shell line read into words, and words quoted back into a line a
// person can read or copy. Pure, so the CLI, the server and the apps parse and
// print a command the same way.

/** A shell line's words, quotes resolved ('...', "..." with its escapes, and their concatenations). `|`, `;` and `&` come back as words of their own. */
export function shellWords(line: string): string[] {
  const out: string[] = [];
  let cur: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'") { const end = line.indexOf("'", i + 1); cur = (cur ?? "") + line.slice(i + 1, end < 0 ? line.length : end); i = end < 0 ? line.length : end; continue; }
    if (ch === '"') {
      let j = i + 1; let v = "";
      while (j < line.length && line[j] !== '"') { if (line[j] === "\\" && /["\\$`\n]/.test(line[j + 1] ?? "")) { v += line[j + 1]; j += 2; } else v += line[j++]; }
      cur = (cur ?? "") + v; i = j; continue;
    }
    if (ch === "\\") { cur = (cur ?? "") + (line[i + 1] ?? ""); i++; continue; }
    if (/\s/.test(ch) || ch === "|" || ch === ";" || ch === "&") { if (cur !== null) out.push(cur); cur = null; if (ch !== " " && ch !== "\t" && ch !== "\n") out.push(ch); continue; }
    cur = (cur ?? "") + ch;
  }
  if (cur !== null) out.push(cur);
  return out;
}

/** Always single-quoted: safe inside eval, $(…) and a `bash -c` body. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Bare when it is a plain word, else shellQuote: the readable form of a command line. */
export function shellArg(value: string): string {
  if (value === "") return "''";
  return /^[A-Za-z0-9_./:=+@,%-]+$/.test(value) ? value : shellQuote(value);
}
