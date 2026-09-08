// Fencing foreign text before an agent reads it — the ONE implementation.
//
// Three writers need it: `cast cap show` (publisher-controlled capability
// descriptions printed into a terminal an agent is reading), the task prompt a
// spawned run receives, and `cast task context`. It lives here rather than in
// the CLI because Convex builds the task prompt and cannot import CLI code.
//
// Escaping markup does nothing against "ignore previous instructions" — the
// defense that works is provenance: wrap the untrusted region in delimiters
// that NAME where the text came from, so a model (and a human) can see exactly
// where third-party content begins and ends, and the instructions inside it
// read as quoted material rather than as the conversation's own voice.
//
// The delimiter carries a nonce so embedded text cannot close the fence early:
// a description containing the literal closing tag would otherwise escape and
// speak with the terminal's authority.

/**
 * Caps for one fenced block, borrowed from Orca's Linear snapshot
 * (linear-issue-context-snapshot.ts). Unbounded provider prose is the other
 * half of the injection problem: a 200 KB issue body pushes every real
 * instruction out of the model's attention even when the fence holds.
 */
export const FOREIGN_TEXT_CAPS = {
  /** One description, before the block-wide cap applies. */
  descriptionChars: 3000,
  /** How many comments a block carries; the newest win. */
  comments: 8,
  /** One comment body. */
  commentChars: 800,
  /** One inline field (title, author, criterion). */
  inlineChars: 200,
  /** The whole rendered block, delimiters and guidance included. */
  blockChars: 12000,
} as const;

/** Marks every cut, so a reader never mistakes a truncation for the whole text. */
export const FOREIGN_TEXT_TRUNCATION_MARKER = "[truncated]";

// Everything below 0x20 except tab and newline, DEL, the C1 range (NEL U+0085
// lives there), every Unicode format character (zero-width joiners, bidi
// overrides), and the two Unicode line breaks U+2028 and U+2029. Those last
// two are the ones a class of "control characters" misses: they are Zl and Zp,
// not Cf, yet markdown renderers and models break a line on them, so a title
// carrying one forges the line printed below it. Built from a string so the
// source file itself never carries a raw control byte.
const CONTROL_CHARS = new RegExp(
  "[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F\\u2028\\u2029]|\\p{Cf}",
  "gu",
);

/**
 * Make control characters visible instead of active.
 *
 * The sanitizer for stored text REJECTS these (a payload that needed ESC was
 * not prose). Rendering is different: the text is already stored and a human
 * asked to see it, so dropping the whole field would hide the task. Escaping
 * keeps the field readable while stripping the two powers the raw bytes carry
 * — ANSI escapes that repaint a terminal the agent is reading, and invisible
 * format characters that hide one instruction inside the rendering of another.
 *
 * Tabs become two spaces; newlines survive, because line structure is what
 * makes the block readable to the human watching the run.
 */
export function escapeForeignControlChars(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(CONTROL_CHARS, (char) => {
      const code = char.codePointAt(0) ?? 0;
      return `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
    });
}

/** Cut to `maxChars` at most, marking the cut. A cap of 0 or less yields "". */
export function capForeignText(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  const suffix = ` ${FOREIGN_TEXT_TRUNCATION_MARKER}`;
  if (maxChars <= suffix.length) return text.slice(0, maxChars);
  return text.slice(0, maxChars - suffix.length).trimEnd() + suffix;
}

/**
 * One foreign value on one line — a title, an author, a criterion.
 *
 * Escaped, folded to a single line and capped: these land in headings and list
 * items where the reader has no fence to tell them the text is quoted, so a
 * title carrying its own newline could forge the line that follows it.
 */
export function inlineForeignText(value: unknown): string {
  // Every whitespace run collapses, not just newlines: \s covers U+2028,
  // U+2029 and NEL as well, so the line stays one line even if the escaping
  // rules above ever narrow.
  const folded = escapeForeignControlChars(String(value ?? "")).replace(/\s+/g, " ");
  return capForeignText(folded.trim(), FOREIGN_TEXT_CAPS.inlineChars);
}

/**
 * 8 hex chars of nonce: unguessable by embedded text, short enough to stay
 * readable. Uniqueness per call is all it needs — this is not a secret.
 * randomUUID rather than node's randomBytes because this file runs in Convex,
 * the browser and Node alike.
 */
function fenceNonce(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

export type FenceOptions = {
  /**
   * Cap for the WHOLE block. The fence owns this because only it knows what
   * its own delimiters and guidance cost, so a caller can promise a budget
   * without recomputing the overhead.
   */
  maxChars?: number;
  /** A trusted line printed above the opening delimiter, addressed to the reader. */
  note?: string;
};

/**
 * Wrap one foreign string with its provenance.
 *
 * `provenance` names the source concretely — "marketplace claude-plugins-official",
 * "github acme/api#412" — because "untrusted content" alone teaches a reader
 * nothing about how much to distrust it.
 */
export function fenceForeignText(
  text: string,
  provenance: string,
  opts: FenceOptions = {},
): string {
  const nonce = fenceNonce();
  const open = `<untrusted-${nonce} source="${provenance.replace(/"/g, "'")}">`;
  const close = `</untrusted-${nonce}>`;
  const note = opts.note ? `${opts.note}\n` : "";
  const body = opts.maxChars
    ? capForeignText(text, opts.maxChars - note.length - open.length - close.length - 2)
    : text;
  return `${note}${open}\n${body}\n${close}`;
}

/**
 * Fence only when the text needs it.
 *
 * Builtin capabilities' own descriptions are ours; fencing them would train
 * readers that the delimiter is noise. The rule mirrors the store's trust
 * boundary: anything whose slug is not `builtin/` came from outside.
 */
export function fenceUnlessBuiltin(text: string, slug: string, provenance: string): string {
  return slug.startsWith("builtin/") ? text : fenceForeignText(text, provenance);
}
