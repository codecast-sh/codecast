// The version tsc records for a file in its build info, computed from the bytes on disk, so `cast check` (check.ts)
// can tell whether a pass checked the files as they are now.
import { createHash } from "node:crypto";

const SOURCE_MAP_COMMENT = /^\/\/[@#] source[M]appingURL=(.+)\r?\n?$/;

/** The text as tsc reads a file: a byte order mark names the encoding and is dropped. */
function textAsTscReads(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return Buffer.from(bytes.subarray(0, bytes.length & ~1)).swap16().toString("utf16le", 2);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.toString("utf16le", 2);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.toString("utf8", 3);
  return bytes.toString("utf8");
}

/** The text without its last source map comment and the blank or `//#` lines after it, which tsc leaves out of a file's version. */
function withoutSourceMapComment(text: string): string {
  let lineEnd = text.length;
  let lineStart = lineEnd;
  for (let pos = lineEnd - 1; pos >= 0; pos--) {
    const ch = text.charCodeAt(pos);
    if (ch === 10 || ch === 13) {
      if (ch === 10 && pos && text.charCodeAt(pos - 1) === 13) pos--;
    } else if (ch < 127 || (ch !== 0x2028 && ch !== 0x2029)) {
      lineStart = pos;
      continue;
    }
    const line = text.substring(lineStart, lineEnd);
    if (SOURCE_MAP_COMMENT.test(line)) return text.substring(0, lineStart);
    if (!/^\s*(\/\/[@#] .*)?$/.test(line)) return text;
    lineEnd = lineStart;
  }
  return text;
}

/** The version tsc records for a file's content: the sha256 of its text, source map comment aside (tsc's getSourceFileVersionAsHashFromText). */
export function tscFileVersion(bytes: Buffer): string {
  let text = textAsTscReads(bytes);
  if (/\/\/[@#] source[M]appingURL=(.+)\r?\n?$/.test(text)) text = withoutSourceMapComment(text);
  return createHash("sha256").update(text).digest("hex");
}
