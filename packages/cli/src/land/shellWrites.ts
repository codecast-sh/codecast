/**
 * The paths a shell command writes, read from what it says (attribute.ts: which session wrote each dirty file). Only
 * a write counts: a redirect's target, `tee`, `sed -i` and `perl -i` files, `mv`/`cp`/`install`/`ln` destinations,
 * `rm`/`unlink`/`git rm` targets (a deletion is a change too), `touch`, `git checkout|restore -- <files>`, and in
 * code a command runs (a python or node heredoc, `-c`/`-e`), `open(<path>, "w"|"a")`, `write_text` and
 * `writeFileSync`. A path a command only reads or runs (`bun x.ts`, `cat`, `grep`, `sed` without -i) is never one.
 * Each path comes with the directory the command stood in when it named it (the `cd` before it). Pure: no disk.
 */

export type ShellWrite = { path: string; dir: string };

type Cmd = { words: string[]; redirects: string[]; heredocs: string[]; dir: string };

const SEPARATORS = new Set([";", "&&", "||", "|", "&", "\n", "(", ")", "|&"]);
const PREFIXES = new Set(["sudo", "env", "command", "time", "nohup", "exec", "nice", "builtin"]);

/** Split a command line into simple commands: words (quotes removed), redirect targets, heredoc bodies, and the dir each ran in. */
export function parseCommands(text: string, cwd: string, home = process.env.HOME ?? "~"): Cmd[] {
  const out: Cmd[] = [];
  let dir = cwd;
  const stack: string[] = [];
  let cur: Cmd = { words: [], redirects: [], heredocs: [], dir };
  let word: string | null = null;
  let pendingRedirect = false;
  let pendingHeredoc: Array<{ delim: string; strip: boolean }> = [];
  const endWord = () => {
    if (word === null) return;
    const w = word.replace(/^~(?=\/|$)/, home);
    word = null;
    if (pendingRedirect) { cur.redirects.push(w); pendingRedirect = false; return; }
    cur.words.push(w);
  };
  const endCmd = () => {
    endWord();
    if (cur.words.length || cur.redirects.length || cur.heredocs.length) {
      const args = commandArgs(cur.words);
      if (args[0] === "cd") dir = args[1] ? resolveDir(dir, args[1], home) : home;
      out.push(cur);
    }
    cur = { words: [], redirects: [], heredocs: [], dir };
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    // Heredoc bodies start on the line after the one that opened them.
    if (c === "\n" && pendingHeredoc.length) {
      endWord();
      const target = cur;
      let at = i + 1;
      for (const h of pendingHeredoc) {
        const lines: string[] = [];
        for (;;) {
          if (at >= text.length) break;
          const nl = text.indexOf("\n", at);
          const line = text.slice(at, nl < 0 ? text.length : nl);
          at = nl < 0 ? text.length : nl + 1;
          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
          lines.push(line);
        }
        target.heredocs.push(lines.join("\n"));
      }
      pendingHeredoc = [];
      i = at;
      endCmd();
      continue;
    }
    if (c === "'" ) {
      const close = text.indexOf("'", i + 1);
      word = (word ?? "") + text.slice(i + 1, close < 0 ? text.length : close);
      i = close < 0 ? text.length : close + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\" && j + 1 < text.length && '"\\$`'.includes(text[j + 1])) { s += text[j + 1]; j += 2; continue; }
        s += text[j++];
      }
      word = (word ?? "") + s;
      i = j + 1;
      continue;
    }
    if (c === "\\" && i + 1 < text.length) {
      if (text[i + 1] === "\n") { i += 2; continue; }
      word = (word ?? "") + text[i + 1];
      i += 2;
      continue;
    }
    // $(...) and `...`: what they print is not a path this parser can know.
    if ((c === "$" && text[i + 1] === "(") || c === "`") {
      const close = c === "`" ? text.indexOf("`", i + 1) : matchParen(text, i + 1);
      word = (word ?? "") + "\u0000";
      i = close < 0 ? text.length : close + 1;
      continue;
    }
    if (c === "#" && word === null) {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl;
      continue;
    }
    if (c === " " || c === "\t") { endWord(); i++; continue; }
    const two = text.slice(i, i + 2);
    const three = text.slice(i, i + 3);
    if (three === "<<<") { endWord(); i += 3; pendingRedirect = false; skipWord(); continue; }
    if (two === "<<") {
      endWord();
      let j = i + 2;
      const strip = text[j] === "-";
      if (strip) j++;
      while (text[j] === " ") j++;
      const m = text.slice(j).match(/^(['"]?)([\w.-]+)\1/);
      if (m) { pendingHeredoc.push({ delim: m[2], strip }); i = j + m[0].length; continue; }
      i = j;
      continue;
    }
    // Redirects: [n]> [n]>> &> &>> >| ; a dup (>&2) and input (<) are not writes.
    const redir = text.slice(i).match(/^(?:\d*>>?\|?|&>>?)(?!&)/);
    if (redir) {
      // `2>` names a descriptor; `x>f` ends the word x first.
      if (word !== null && /^\d+$/.test(word)) word = null;
      endWord();
      pendingRedirect = true;
      i += redir[0].length;
      continue;
    }
    if (/^\d*>&/.test(text.slice(i)) || c === "<") {
      // `2>&1`: the 2 is the descriptor, not a word.
      if (word !== null && /^\d+$/.test(word)) word = null;
      endWord();
      const m = text.slice(i).match(/^\d*>&-?\d*|^<&?\d*/);
      i += m ? m[0].length || 1 : 1;
      if (c === "<") skipWord();
      continue;
    }
    if (SEPARATORS.has(two) || SEPARATORS.has(c)) {
      const op = SEPARATORS.has(two) ? two : c;
      endCmd();
      if (op === "(") stack.push(dir);
      if (op === ")") { dir = stack.pop() ?? dir; cur.dir = dir; }
      i += op.length;
      continue;
    }
    word = (word ?? "") + c;
    i++;
  }
  endCmd();
  return out;

  function skipWord() {
    while (text[i] === " ") i++;
    while (i < text.length && !/[\s;&|()]/.test(text[i])) i++;
  }
}

function matchParen(text: string, open: number): number {
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    if (text[j] === "(") depth++;
    else if (text[j] === ")" && --depth === 0) return j;
  }
  return -1;
}

function resolveDir(from: string, to: string, home: string): string {
  const t = to.replace(/^~(?=\/|$)/, home);
  if (t.startsWith("/")) return normalize(t);
  return normalize(`${from}/${t}`);
}

function normalize(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join("/")}`;
}

/** The words after env assignments and prefixes like sudo: what runs, then its arguments. */
function commandArgs(words: string[]): string[] {
  let k = 0;
  while (k < words.length && (/^\w+=/.test(words[k]) || PREFIXES.has(words[k]))) k++;
  return words.slice(k);
}

const base = (w: string) => w.split("/").pop() ?? w;
const isOpt = (w: string) => w.startsWith("-") && w !== "-";
const operands = (args: string[]) => {
  const out: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === "--") { ended = true; continue; }
    if (!ended && isOpt(a)) continue;
    out.push(a);
  }
  return out;
};

/** The files `sed -i` edits: its operands after the script (unless -e/-f gave the script). */
function sedFiles(args: string[]): string[] | null {
  let inPlace = false;
  let scriptGiven = false;
  const rest: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === "-i" || a === "--in-place") {
      inPlace = true;
      // BSD sed takes the backup suffix as the next word ('' or .bak).
      if (args[k + 1] === "" || /^\.\w+$/.test(args[k + 1] ?? "")) k++;
      continue;
    }
    if (/^-i/.test(a) || /^--in-place=/.test(a) || (/^-[a-zA-Z]+$/.test(a) && a.includes("i") && !a.startsWith("--"))) { inPlace = true; continue; }
    if (a === "-e" || a === "-f" || a === "--expression" || a === "--file") { scriptGiven = true; k++; continue; }
    if (isOpt(a)) continue;
    rest.push(a);
  }
  if (!inPlace) return null;
  return scriptGiven ? rest : rest.slice(1);
}

/** The files `perl -i` edits: its operands after the -e program (or after the script file). */
function perlFiles(args: string[]): string[] | null {
  let inPlace = false;
  let programGiven = false;
  const rest: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (/^-[a-zA-Z]*i/.test(a)) inPlace = true;
    if (/^-[a-zA-Z]*e$/.test(a) || /^-[a-zA-Z]*E$/.test(a)) { programGiven = true; k++; continue; }
    if (isOpt(a)) continue;
    rest.push(a);
  }
  if (!inPlace) return null;
  return programGiven ? rest : rest.slice(1);
}

/** mv/cp/install/ln: what each lands as (into a directory, under its own name), and for mv, the sources it removes. */
function copyWrites(args: string[], moves: boolean): string[] {
  const ops = operands(args.filter((a, k) => !(args[k - 1] === "-t" || args[k - 1] === "--target-directory" || args[k - 1] === "-m" || args[k - 1] === "-o" || args[k - 1] === "-g")));
  const target = args.find((a, k) => args[k - 1] === "-t" || args[k - 1] === "--target-directory");
  if (target) return [...ops.map((s) => `${target.replace(/\/$/, "")}/${base(s)}`), ...(moves ? ops : [])];
  if (ops.length < 2) return [];
  const dest = ops[ops.length - 1];
  const sources = ops.slice(0, -1);
  const into = sources.length > 1 || dest.endsWith("/");
  return [...(into ? sources.map((s) => `${dest.replace(/\/$/, "")}/${base(s)}`) : [dest]), ...(moves ? sources : [])];
}

/**
 * What code a python process runs writes: open(<path>, "w"|"a"|"x"), Path(<path>).write_text/bytes, shutil copies
 * and moves, removals. A name is read as the value it held at that point (`p = 'a'; open(p,'w'); p = 'b'; open(p,'w')`).
 */
export function pythonWrites(code: string): string[] {
  const vars = new Map<string, string>();
  const val = (lit: string | undefined, name: string | undefined) => lit ?? (name ? vars.get(name) : undefined);
  const out: string[] = [];
  const add = (p: string | undefined) => { if (p && !p.includes("{")) out.push(p); };
  const ref = String.raw`(?:[rbf]?(['"])([^'"\n]+)\1|(\w+))`;
  const patterns: Array<[RegExp, (m: RegExpMatchArray) => void]> = [
    [new RegExp(String.raw`^[ \t]*(\w+)\s*=\s*(?:(?:pathlib\.)?Path\(\s*)?[rbf]?(['"])([^'"\n]+)\2`, "gm"), (m) => { vars.set(m[1], m[3]); }],
    [new RegExp(String.raw`\bopen\(\s*${ref}\s*,\s*(?:mode\s*=\s*)?[rb]?(['"])([^'"]*)\4`, "g"), (m) => { if (/[wax+]/.test(m[5])) add(val(m[2], m[3])); }],
    [new RegExp(String.raw`(?:(?:pathlib\.)?Path\(\s*[rbf]?(['"])([^'"\n]+)\1\s*\)|\b(\w+))\.(?:write_text|write_bytes|unlink|touch)\(`, "g"), (m) => add(val(m[2], m[3]))],
    [new RegExp(String.raw`\bshutil\.(?:copy2?|copyfile|move)\(\s*[^,]+,\s*${ref}`, "g"), (m) => add(val(m[2], m[3]))],
    [new RegExp(String.raw`\bos\.(?:remove|unlink)\(\s*${ref}`, "g"), (m) => add(val(m[2], m[3]))],
  ];
  // In the order the code runs them, so each name is read at its value then.
  const events: Array<{ at: number; run: () => void }> = [];
  for (const [re, run] of patterns) for (const m of code.matchAll(re)) events.push({ at: m.index ?? 0, run: () => run(m) });
  for (const e of events.sort((a, b) => a.at - b.at)) e.run();
  return out;
}

/** What code a node or bun process runs writes: fs writeFile/appendFile (sync or not), Bun.write. */
export function scriptWrites(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/\b(?:writeFileSync|appendFileSync|writeFile|appendFile|Bun\.write|unlinkSync|rmSync)\(\s*(['"`])([^'"`\n$]+)\1/g)) out.push(m[2]);
  return out;
}

/** Every path a command writes, with the directory it stood in when it did. */
export function shellWritePaths(text: string, cwd: string, home = process.env.HOME ?? "~"): ShellWrite[] {
  const out: ShellWrite[] = [];
  const keep = (p: string | undefined, dir: string) => {
    if (!p || p.includes("\u0000") || p.startsWith("/dev/") || p === "-" || /\$/.test(p)) return;
    out.push({ path: p, dir });
  };
  for (const cmd of parseCommands(text, cwd, home)) {
    for (const r of cmd.redirects) keep(r, cmd.dir);
    const [prog, ...args] = commandArgs(cmd.words);
    if (!prog) continue;
    const name = base(prog);
    const code = (flag: string) => { const k = args.indexOf(flag); return k >= 0 ? args[k + 1] : undefined; };
    let paths: string[] = [];
    let at = cmd.dir;
    if (name === "tee") paths = operands(args);
    else if (name === "sed" || name === "gsed") paths = sedFiles(args) ?? [];
    else if (name === "perl") paths = perlFiles(args) ?? [];
    else if (name === "mv") paths = copyWrites(args, true);
    else if (name === "cp" || name === "install" || name === "ln" || name === "rsync") paths = copyWrites(args, false);
    else if (name === "rm" || name === "unlink" || name === "rmdir" || name === "shred") paths = operands(args);
    else if (name === "touch") paths = operands(args);
    else if (name === "truncate") paths = operands(args.filter((a, k) => !(args[k - 1] === "-s" || args[k - 1] === "--size")));
    else if (name === "git") {
      // Global options before the subcommand: -C <dir> moves where its paths are read from; -c takes a value.
      let k = 0;
      for (; k < args.length && isOpt(args[k]); k++) {
        if (args[k] === "-C") at = resolveDir(at, args[++k] ?? "", home);
        else if (args[k] === "-c" || args[k] === "--git-dir" || args[k] === "--work-tree") k++;
      }
      const sub = args[k];
      const after = args.slice(k + 1);
      if (sub === "mv") paths = copyWrites(after, true);
      else if (sub === "rm") paths = operands(after);
      else if (sub === "restore") paths = operands(after.filter((a, k) => !(after[k - 1] === "-s" || after[k - 1] === "--source")));
      else if (sub === "checkout" && after.includes("--")) paths = after.slice(after.indexOf("--") + 1);
    } else if (/^python[\d.]*$/.test(name)) {
      for (const body of [...cmd.heredocs, code("-c")]) if (body) paths.push(...pythonWrites(body));
    } else if (name === "node" || name === "bun" || name === "deno" || name === "tsx") {
      for (const body of [...cmd.heredocs, code("-e"), code("--eval")]) if (body) paths.push(...scriptWrites(body));
    } else if (name === "bash" || name === "sh" || name === "zsh") {
      for (const body of [...cmd.heredocs, code("-c")]) if (body) for (const w of shellWritePaths(body, cmd.dir, home)) out.push(w);
    }
    for (const p of paths) keep(p, at);
  }
  return out;
}
