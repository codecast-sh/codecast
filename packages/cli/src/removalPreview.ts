// What an rm in a command would delete, read from the disk at prompt time.
//
// Claude Code's dangerous rm check asks a person when it cannot prove a
// removal is safe: a glob after a cd, a target in a shell variable. The card
// that asks is useless without the answer to "delete what?", and the daemon
// runs on the machine that has the files, so it resolves each rm the way the
// shell would (following the cds before it, expanding a glob in the last path
// segment) and counts what is there now. A target it cannot resolve says why.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface RemovalPreview {
  /** The resolved absolute target, or the raw word when it cannot be resolved. */
  target: string;
  files?: number;
  dirs?: number;
  /** Why the target could not be counted. */
  note?: string;
}

const MAX_REMOVALS = 5;
const MAX_WALK = 10_000;

/** Every rm in `command`, resolved against `cwd`. Heredoc bodies are skipped:
 *  they are data written to a file, not commands run here. */
export function describeRemovals(command: string, cwd: string): RemovalPreview[] {
  const out: RemovalPreview[] = [];
  let dir: string | null = cwd;
  for (const words of commandSegments(command)) {
    if (out.length >= MAX_REMOVALS) break;
    const [head, ...args] = words;
    if (head === "cd") {
      const to = args[0] ?? "~";
      dir = isDynamic(to) || dir === null ? null : path.resolve(dir, expandHome(to));
      continue;
    }
    if (head !== "rm") continue;
    const recursive = args.some((a) => /^--recursive$|^-[a-zA-Z]*[rR]/.test(a));
    let flagsDone = false;
    for (const a of args) {
      if (!flagsDone && a === "--") { flagsDone = true; continue; }
      if (!flagsDone && a.startsWith("-")) continue;
      if (out.length >= MAX_REMOVALS) break;
      out.push(previewTarget(a, dir, recursive));
    }
  }
  return out;
}

function previewTarget(word: string, dir: string | null, recursive: boolean): RemovalPreview {
  if (isDynamic(word)) return { target: word, note: "set by the shell when it runs" };
  if (dir === null && !path.isAbsolute(expandHome(word))) return { target: word, note: "after a cd that cannot be resolved" };
  const abs = path.resolve(dir ?? "/", expandHome(word));
  const parent = path.dirname(abs);
  const leaf = path.basename(abs);
  if (hasGlob(parent)) return { target: abs, note: "a pattern in a parent folder" };
  let names: string[];
  if (hasGlob(leaf)) {
    const re = globToRegExp(leaf);
    try {
      names = fs.readdirSync(parent).filter((n) => re.test(n) && (leaf.startsWith(".") || !n.startsWith(".")));
    } catch {
      return { target: abs, files: 0, dirs: 0 };
    }
  } else {
    names = [leaf];
  }
  const count = { files: 0, dirs: 0 };
  for (const n of names) tally(path.join(parent, n), recursive, count);
  return { target: abs, ...count };
}

function tally(p: string, recursive: boolean, count: { files: number; dirs: number }): void {
  let st: fs.Stats;
  try { st = fs.lstatSync(p); } catch { return; }
  if (!st.isDirectory()) { count.files++; return; }
  count.dirs++;
  if (!recursive) return;
  const stack = [p];
  while (stack.length && count.files + count.dirs < MAX_WALK) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) { count.dirs++; stack.push(path.join(d, e.name)); } else count.files++;
    }
  }
}

/** The command's simple commands as word lists, split on ; && || | & and
 *  newlines outside quotes, with heredoc bodies dropped. Enough to follow cd
 *  and find rm; not a shell parser. */
export function commandSegments(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  const heredocs: string[] = [];
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    // `do`, `then` and the like start the command that follows them.
    while (words.length && /^(do|then|else|elif|!|\{|\()$/.test(words[0])) words.shift();
    if (words.length) segments.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; inWord = true; continue; }
    if (c === "\\" && i + 1 < command.length) { word += command[++i]; inWord = true; continue; }
    if (c === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      endWord();
      const m = command.slice(i).match(/^<<-?\s*(['"]?)([A-Za-z_]\w*)\1/);
      if (m) { heredocs.push(m[2]); i += m[0].length - 1; continue; }
    }
    if (c === "\n") {
      endSegment();
      // Drop each pending heredoc's body, up to its terminator line.
      for (const tag of heredocs.splice(0)) {
        const rest = command.slice(i + 1);
        const end = rest.search(new RegExp(`^\\s*${tag}\\s*$`, "m"));
        if (end < 0) return segments;
        const after = rest.indexOf("\n", end);
        i = after < 0 ? command.length : i + 1 + after;
      }
      continue;
    }
    if (c === ";" || c === "|" || c === "&") { endSegment(); continue; }
    if (c === " " || c === "\t") { endWord(); continue; }
    word += c;
    inWord = true;
  }
  endSegment();
  return segments;
}

const isDynamic = (w: string) => /[$`]/.test(w);
const hasGlob = (s: string) => /[*?[]/.test(s);
const expandHome = (p: string) => (p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close < 0) { re += "\\["; continue; }
      re += "[" + glob.slice(i + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\") + "]";
      i = close;
    } else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
