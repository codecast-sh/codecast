// The code-like kinds a sentence can carry, for the Modern style, which sets
// words in a sans and anything code-like in mono: codecast ids (ct-4182,
// dp-12), session short ids (jx7d2wk), commit hashes, paths, file names and
// command-line flags. A status line the app composes ("4a6e413b2c landed on
// web dp-12") splits into runs here, and the renderer sets each code run in
// mono. Prose a person or an agent wrote is not split: it is theirs to mark
// up with backticks.

/** Each kind, in the order they are tried. */
export const CODE_LIKE_KINDS = {
  /** A codecast object's short id: task, plan, trigger, call, doc, decision, deploy, bug, replay. */
  id: String.raw`\b(?:ct|pl|tr|cl|doc|sd|dc|dp|bug|rp)-\d+\b`,
  /** A session's short id. */
  session: String.raw`\bjx[0-9a-z]{5}\b`,
  /** A commit or content hash: hex, 7 to 40 long, with at least one digit and one letter. */
  hash: String.raw`\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b`,
  /** A path: rooted, relative, home, or two segments deep, with an optional :line. */
  path: String.raw`(?:(?:~|\.{1,2})?/[\w@.*\[\]-]+(?:/[\w@.*\[\]-]+)*|[\w@.-]+(?:/[\w@.*\[\]-]+)+)(?::\d+)?`,
  /** A file name with a source or config extension. */
  file: String.raw`\b[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|json|md|mdx|py|sh|ya?ml|toml|css|html|sql|rs|go|swift|kt|lock|env)\b`,
  /** A command-line flag. */
  flag: String.raw`(?<![\w-])--?[a-z][\w-]*(?:=\S+)?`,
} as const;

const PATTERN = new RegExp(Object.values(CODE_LIKE_KINDS).join("|"), "g");

/** A one-slash phrase is a path only when it is rooted or names a file ("and/or" is not). */
function isPath(token: string): boolean {
  if (!token.includes("/")) return true;
  if (/^(?:~|\.{1,2})?\//.test(token)) return true;
  if ((token.match(/\//g) ?? []).length >= 2) return true;
  return /\.[a-z0-9]{1,6}(?::\d+)?$/i.test(token);
}

export type CodeRun = { text: string; code: boolean };

/** The text as alternating prose and code-like runs, in order; joined they give the text back. */
export function splitCodeRuns(text: string): CodeRun[] {
  const out: CodeRun[] = [];
  let last = 0;
  for (const m of text.matchAll(PATTERN)) {
    const token = m[0];
    const at = m.index!;
    if (!isPath(token)) continue;
    if (at > last) out.push({ text: text.slice(last, at), code: false });
    out.push({ text: token, code: true });
    last = at + token.length;
  }
  if (last < text.length) out.push({ text: text.slice(last), code: false });
  return out;
}
