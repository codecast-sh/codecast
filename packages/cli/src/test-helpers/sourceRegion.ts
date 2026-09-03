// Region scoped source slicing for guard tests.
//
// A guard that scans a whole file cannot tell a hot path from a boot time
// helper, and a fixed byte window silently overflows when a comment is
// added. These helpers slice a function or a call block by its indentation:
// the block ends at the first later line that is exactly the start line's
// indentation plus a closing brace. A template literal or a regex with braces
// inside the body can never break the slice, which is what sank an earlier
// tokenizer based attempt on main().

export interface SourceBlock {
  /** The block's text, start line to closing line inclusive. */
  text: string;
  /** 1-based line of the block's first line in the file. */
  startLine: number;
  /** 1-based line of the block's closing line in the file. */
  endLine: number;
}

/** The file's lines with comment lines dropped (line comments and block
 *  comment bodies), numbered 1-based, so a mention in prose never counts.
 *  Copied from web/lib/__tests__/sourceWalk.ts, which the CLI cannot import. */
export function codeLines(src: string): Array<{ line: string; n: number }> {
  const out: Array<{ line: string; n: number }> = [];
  src.split("\n").forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
    out.push({ line, n: i + 1 });
  });
  return out;
}

function lineOf(src: string, idx: number): number {
  let n = 1;
  for (let i = 0; i < idx && i < src.length; i++) if (src.charCodeAt(i) === 10) n++;
  return n;
}

/** The block that starts at `startIdx`: from that line to the first later
 *  line that is exactly the start line's indentation followed by `}`, `},`,
 *  `});`, `}));` or `}, <interval>);` (a callback handed to a timer). */
export function blockAt(src: string, startIdx: number): SourceBlock {
  const lineStart = src.lastIndexOf("\n", startIdx - 1) + 1;
  const startLine = lineOf(src, lineStart);
  const lines = src.split("\n");
  const first = lines[startLine - 1];
  const indent = first.match(/^[ \t]*/)?.[0] ?? "";
  // A block that opens and closes on its start line (a one line timer
  // callback) is that line; scanning on would claim the next block's
  // closing line and misplace every line number in between.
  const opens = (first.match(/{/g) ?? []).length;
  if (opens > 0 && opens === (first.match(/}/g) ?? []).length) {
    return { text: first, startLine, endLine: startLine };
  }
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith(indent + "}")) continue;
    // `} else {`, `} catch (e) {` and `} finally {` continue the same block.
    const rest = line.slice(indent.length + 1);
    if (rest.includes("{") || /^\s*(else|catch|finally)\b/.test(rest)) continue;
    return { text: lines.slice(startLine - 1, i + 1).join("\n"), startLine, endLine: i + 1 };
  }
  throw new Error(`blockAt: no closing line at indent ${JSON.stringify(indent)} after line ${startLine}`);
}

/** The block of `function NAME(` (any of: `function`, `async function`,
 *  `export [async] function`, or an indented method `NAME(...) {` when
 *  `method` is set), searched from `from`. */
export function functionBlock(src: string, name: string, opts: { from?: number; method?: boolean } = {}): SourceBlock {
  const re = opts.method
    ? new RegExp(`^[ \\t]+(?:private\\s+|public\\s+|protected\\s+)?(?:static\\s+)?(?:async\\s+)?${name}\\s*\\(`, "m")
    : new RegExp(`^[ \\t]*(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*[(<]`, "m");
  const tail = src.slice(opts.from ?? 0);
  const m = re.exec(tail);
  if (!m) throw new Error(`functionBlock: ${name} not found`);
  return blockAt(src, (opts.from ?? 0) + m.index);
}

/** Every `setInterval(` call block between `from` and `to`. */
export function intervalBlocks(src: string, from: number, to: number): SourceBlock[] {
  const out: SourceBlock[] = [];
  let idx = from;
  for (;;) {
    const i = src.indexOf("setInterval(", idx);
    if (i < 0 || i >= to) break;
    const block = blockAt(src, i);
    out.push(block);
    idx = i + "setInterval(".length;
  }
  return out;
}

/** The text between two anchors, as a block with file line numbers. */
export function sliceBetween(src: string, startAnchor: string, endAnchor: string, from = 0): SourceBlock {
  const s = src.indexOf(startAnchor, from);
  if (s < 0) throw new Error(`sliceBetween: ${startAnchor} not found`);
  const e = src.indexOf(endAnchor, s);
  if (e < 0) throw new Error(`sliceBetween: ${endAnchor} not found after ${startAnchor}`);
  const startLine = lineOf(src, s);
  const endLine = lineOf(src, e);
  return { text: src.split("\n").slice(startLine - 1, endLine).join("\n"), startLine, endLine };
}
