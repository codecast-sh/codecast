// What a session ran: every shell call in its transcript, grouped by what it
// can do to the world (pushed, installed, deleted, reached the network) and
// marked by how risky it is. Derived at read time from the messages the store
// holds, never stored. Plain pattern matching over each command's words, the
// way a reviewer skims a transcript; it says "look here", not "this is safe".
import { isShellTool } from "@codecast/shared/render";

export type RanGroup = "push" | "install" | "delete" | "network" | "other";
export type RanRisk = "danger" | "caution" | "normal";

export type RanCall = {
  messageId: string;
  callId: string;
  command: string;
  group: RanGroup;
  risk: RanRisk;
  failed: boolean;
  /** Refused before it ran (the person declined it, or a hook or permission rule blocked it): listed, never flagged. */
  denied: boolean;
  timestamp: number;
};

export type RanSummary = {
  calls: RanCall[];
  /** Calls that ran (refused ones left out), per group. */
  counts: Record<RanGroup, number>;
  /** Calls that ran in a group other than "other". */
  notable: number;
  worst: RanRisk;
};

export const RAN_GROUPS: readonly RanGroup[] = ["push", "delete", "install", "network", "other"];
const RISK_RANK: Record<RanRisk, number> = { normal: 0, caution: 1, danger: 2 };
const GROUP_RANK: Record<RanGroup, number> = { push: 4, delete: 3, install: 2, network: 1, other: 0 };

type Words = string[];
/** A simple command: its words, whether it reads the one before (`piped`), a heredoc it was handed (`stdin`), and the scripts of `$(…)`, `` `…` `` and `<(…)` inside its words (`subs`), whose output it takes. */
type Seg = { words: Words; piped: boolean; stdin?: string; subs?: string[] };

/**
 * The command's simple commands, each as its words, the way a shell would
 * split them: quotes keep their text inside one word (so `git commit -m "rm
 * -rf"` runs git, not rm), a backslash-newline joins lines, comments and
 * heredoc bodies are dropped, and `&& || ; | ( ) $( \``, newlines and a
 * trailing `&` end a command. `piped` says the command reads the one before.
 */
function tokenize(command: string): Seg[] {
  const segs: Seg[] = [];
  const heredocs: { terminator: string; seg: Seg | null }[] = [];
  let pendingHere: { terminator: string; seg: Seg | null }[] = [];
  const substitutions: string[] = [];
  let words: Words = [];
  let cur = "";
  let inWord = false;
  let piped = false;
  const n = command.length;
  const endWord = () => {
    if (inWord) words.push(cur);
    cur = "";
    inWord = false;
  };
  let segSubs: string[] = [];
  const endSeg = (nextPiped: boolean) => {
    endWord();
    const seg: Seg | null = words.length ? { words, piped, ...(segSubs.length ? { subs: segSubs } : {}) } : null;
    segSubs = [];
    if (seg) segs.push(seg);
    // A heredoc belongs to the command that declared it.
    for (const h of pendingHere) { h.seg = seg; heredocs.push(h); }
    pendingHere = [];
    words = [];
    piped = nextPiped;
  };
  let i = 0;
  while (i < n) {
    const ch = command[i];
    if (ch === "\\") {
      if (command[i + 1] !== "\n") { cur += command[i + 1] ?? ""; inWord = true; }
      i += 2;
      continue;
    }
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      cur += command.slice(i + 1, end < 0 ? n : end);
      inWord = true;
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n && command[j] !== '"') {
        if (command[j] === "\\" && j + 1 < n) { cur += command[j + 1]; j += 2; continue; }
        // `$(…)` and backticks run even inside double quotes.
        if ((command[j] === "$" && command[j + 1] === "(" && command[j + 2] !== "(") || command[j] === "`") {
          const end = command[j] === "`" ? command.indexOf("`", j + 1) : closingParen(command, j + 1);
          const stop = end < 0 ? n : end;
          const inner = command.slice(j + (command[j] === "`" ? 1 : 2), stop);
          substitutions.push(inner);
          segSubs.push(inner);
          j = stop + 1;
          continue;
        }
        cur += command[j++];
      }
      inWord = true;
      i = j + 1;
      continue;
    }
    if (ch === "#" && !inWord) {
      while (i < n && command[i] !== "\n") i++;
      continue;
    }
    if (ch === "\n") {
      endSeg(false);
      i++;
      while (heredocs.length) {
        const { terminator, seg } = heredocs.shift()!;
        const body: string[] = [];
        while (i < n) {
          const eol = command.indexOf("\n", i);
          const line = command.slice(i, eol < 0 ? n : eol);
          i = eol < 0 ? n : eol + 1;
          if (line.trim() === terminator) break;
          body.push(line);
        }
        if (seg) seg.stdin = body.join("\n");
      }
      continue;
    }
    // `<<<` is a here-string: one word of input, not a heredoc.
    if (ch === "<" && command[i + 1] === "<" && command[i + 2] === "<") { endWord(); i += 3; continue; }
    // `<(cmd)` / `>(cmd)`: a process substitution, read like a file by the command it sits in.
    if ((ch === "<" || ch === ">") && command[i + 1] === "(") {
      endWord();
      const end = closingParen(command, i + 1);
      const inner = command.slice(i + 2, end < 0 ? n : end);
      substitutions.push(inner);
      segSubs.push(inner);
      words.push("/dev/fd/0");
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (ch === "<" && command[i + 1] === "<") {
      endWord();
      let j = i + 2;
      if (command[j] === "-") j++;
      while (command[j] === " ") j++;
      const m = /^\\?(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(command.slice(j));
      if (m) pendingHere.push({ terminator: m[2], seg: null });
      i = m ? j + m[0].length : i + 2;
      continue;
    }
    if (ch === "$" && command[i + 1] === "(" && command[i + 2] === "(") {
      const end = command.indexOf("))", i);
      i = end < 0 ? n : end + 2;
      inWord = true;
      continue;
    }
    if (ch === "&" && (cur.endsWith(">") || cur.endsWith("<") || command[i + 1] === ">")) { cur += ch; inWord = true; i++; continue; }
    if ((ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|")) { endSeg(false); i += 2; continue; }
    if (ch === "|") { endSeg(true); i += command[i + 1] === "&" ? 2 : 1; continue; }
    // `$(…)` and backticks outside quotes: the same as inside them, a
    // script whose output is a word of this command.
    if ((ch === "$" && command[i + 1] === "(") || ch === "`") {
      const end = ch === "`" ? command.indexOf("`", i + 1) : closingParen(command, i + 1);
      const inner = command.slice(i + (ch === "`" ? 1 : 2), end < 0 ? n : end);
      substitutions.push(inner);
      segSubs.push(inner);
      cur += "$SUB";
      inWord = true;
      i = end < 0 ? n : end + 1;
      continue;
    }
    // `(( … ))`: arithmetic, whose `<<` is a shift, not a heredoc.
    if (ch === "(" && command[i + 1] === "(" && !inWord) {
      const end = command.indexOf("))", i);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (ch === ";" || ch === "(" || ch === ")" || ch === "&") { endSeg(false); i++; continue; }
    if (ch === " " || ch === "\t") { endWord(); i++; continue; }
    cur += ch;
    inWord = true;
    i++;
  }
  endSeg(false);
  for (const inner of substitutions) segs.push(...tokenize(inner));
  return segs;
}

/** The index of the `)` closing the `(` at `open`, or -1, past quoted text and heredoc bodies (a commit message in `$(cat <<'EOF' … EOF)` may hold a lone paren). */
function closingParen(text: string, open: number): number {
  let depth = 0;
  const pending: string[] = [];
  for (let k = open; k < text.length; k++) {
    const ch = text[k];
    if (ch === "\\") { k++; continue; }
    if (ch === "'" || ch === '"') {
      let j = k + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === "\\" && ch === '"' ? 2 : 1;
      k = j;
      continue;
    }
    if (ch === "<" && text[k + 1] === "<") {
      const m = /^<<-?\s*\\?(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(text.slice(k));
      if (m) { pending.push(m[2]); k += m[0].length - 1; continue; }
    }
    if (ch === "\n" && pending.length) {
      for (const terminator of pending.splice(0)) {
        let at = k + 1;
        while (at < text.length) {
          const eol = text.indexOf("\n", at);
          const line = text.slice(at, eol < 0 ? text.length : eol);
          at = eol < 0 ? text.length : eol + 1;
          if (line.trim() === terminator) break;
        }
        k = at - 1;
      }
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return k;
  }
  return -1;
}

// Wrapper flags that take a value, so the program is the word after it.
const WRAPPER_VALUE_FLAGS: Record<string, Set<string>> = {
  xargs: new Set(["-n", "-I", "-i", "-P", "-L", "-l", "-s", "-d", "-E", "-a", "--max-args", "--max-procs", "--replace", "--delimiter", "--arg-file"]),
  sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-U", "-D", "-r", "-t"]),
  env: new Set(["-u", "-C", "-S", "--unset", "--chdir"]),
  nice: new Set(["-n", "--adjustment"]),
  watch: new Set(["-n", "--interval", "-d"]),
};

const WRAPPERS = new Set(["sudo", "doas", "env", "time", "nohup", "exec", "command", "builtin", "nice", "caffeinate", "runner", "xargs", "watch"]);

/** The words with leading VAR=value assignments and wrappers (sudo, timeout, ./runner) dropped. */
// Shell grammar ahead of a command (`if x; then rm …`, `for …; do git push`,
// `{ …; }`, `! cmd`): the command is the word after it.
const SHELL_KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "{", "}", "time", "case", "esac", "in"]);

function unwrap(words: Words): { words: Words; sudo: boolean } {
  let sudo = false;
  while (words.length) {
    if (SHELL_KEYWORDS.has(words[0])) { words = words.slice(1); continue; }
    const head = base(words[0]);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) { words = words.slice(1); continue; }
    if (head === "timeout" || head === "gtimeout") {
      words = words.slice(1);
      while (words[0]?.startsWith("-")) words = words.slice(words[0] === "-s" || words[0] === "-k" || words[0] === "--signal" || words[0] === "--kill-after" ? 2 : 1);
      if (words[0] && /^\d/.test(words[0])) words = words.slice(1);
      continue;
    }
    if (head === "command" && (words[1] === "-v" || words[1] === "-V")) break;
    if (WRAPPERS.has(head)) {
      if (head === "sudo" || head === "doas") sudo = true;
      words = words.slice(1);
      const takesValue = WRAPPER_VALUE_FLAGS[head];
      while (words[0]?.startsWith("-")) words = words.slice(takesValue?.has(words[0]) ? 2 : 1);
      continue;
    }
    break;
  }
  return { words, sudo };
}

const base = (word: string) => word.replace(/^.*\//, "");
const has = (words: Words, ...flags: string[]) => words.some((w) => flags.includes(w));
const hasShortFlag = (words: Words, letter: string) => words.some((w) => /^-[A-Za-z]+$/.test(w) && w.includes(letter));
const firstArg = (words: Words) => words.find((w) => !w.startsWith("-"));

/** The HTTP method a `gh api` call names (`-X DELETE`, `-XDELETE`, `--method=DELETE`), upper case. */
function ghMethod(words: Words): string | null {
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    if (w === "-X" || w === "--method") return (words[k + 1] ?? "").toUpperCase();
    const m = /^(?:-X|--method=)(\w+)$/.exec(w);
    if (m) return m[1].toUpperCase();
  }
  // gh sends POST on its own once a field or a body is given.
  if (words.some((w) => w === "-f" || w === "-F" || w === "--field" || w === "--raw-field" || w === "--input" || /^--(raw-)?field=/.test(w))) return "POST";
  return null;
}

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "pip", "pip3", "uv", "brew", "cargo", "gem", "apt", "apt-get", "go", "poetry", "pipx", "composer", "dnf", "yum"]);
const INSTALL_VERBS = new Set(["install", "i", "add", "get", "upgrade"]);
const PUBLISH_VERBS = new Set(["publish", "push"]);
const NETWORK_TOOLS = new Set(["curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "ncat", "telnet", "ftp", "http", "https", "xh"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish"]);
const INTERPRETERS = new Set([...SHELLS, "python", "python3", "node", "ruby", "perl"]);
const RUNNERS = new Set(["npx", "bunx", "pnpx", "uvx"]);
const DESTRUCTIVE_SQL = /\b(drop\s+(table|database|schema)|truncate\s+(table\s+)?\w|delete\s+from\s+\w+\s*;?\s*$|flushall|flushdb)/i;

// Flags of ssh that take a value, so the host is the first word after them.
const SSH_VALUE_FLAGS = new Set(["-i", "-p", "-o", "-l", "-F", "-J", "-L", "-R", "-D", "-W", "-b", "-c", "-E", "-S", "-m", "-e", "-Q"]);

type Verdict = { group: RanGroup; risk: RanRisk };
const OTHER: Verdict = { group: "other", risk: "normal" };

/** The weightier of two verdicts: the riskier, and between equally risky ones the weightier group, so a chain is filed where its worst part belongs (`git push && rm -rf /` is a delete). */
function worse(a: Verdict, b: Verdict): Verdict {
  if (RISK_RANK[b.risk] !== RISK_RANK[a.risk]) return RISK_RANK[b.risk] > RISK_RANK[a.risk] ? b : a;
  return GROUP_RANK[b.group] > GROUP_RANK[a.group] ? b : a;
}

function classifyWords(raw: Words, depth: number): Verdict {
  const { words, sudo } = unwrap(raw);
  if (!words.length) return OTHER;
  const verdict = classifyHead(words, depth);
  // As root: whatever it changes is changed for the whole machine.
  if (!sudo) return verdict;
  return { group: verdict.group, risk: verdict.group === "other" ? worse(verdict, { group: "other", risk: "caution" }).risk : "danger" };
}

function classifyHead(words: Words, depth: number): Verdict {
  const head = base(words[0]);
  const rest = words.slice(1);

  // A script handed to a shell, eval or a remote host is what runs.
  if (INTERPRETERS.has(head)) {
    const flag = rest.findIndex((w) => /^-[a-z]*c$/.test(w));
    if (SHELLS.has(head) && flag >= 0 && rest[flag + 1] !== undefined && depth < 3) return classifyCommandAt(rest[flag + 1], depth + 1);
    // `bash deploy.sh`: the script named is what runs.
    const script = SHELLS.has(head) && flag < 0 ? rest.findIndex((w) => !w.startsWith("-")) : -1;
    if (script >= 0 && depth < 3) return classifyHead(rest.slice(script), depth + 1);
    // `node scripts/deploy.mjs`, `python deploy.py`: the script's name says what it does.
    const inline = rest.some((w) => /^-[a-z]*[cep]$/.test(w) || w === "--eval" || w === "--print");
    const file = inline ? undefined : rest.find((w) => !w.startsWith("-"));
    if (file && shipsName(scriptName(file))) return { group: "push", risk: "danger" };
    return OTHER;
  }
  if (head === "eval" && depth < 3) return classifyCommandAt(rest.join(" "), depth + 1);
  if (head === "ssh") {
    let at = 0;
    while (at < rest.length && rest[at].startsWith("-")) at += SSH_VALUE_FLAGS.has(rest[at]) ? 2 : 1;
    const remote = rest.slice(at + 1).join(" ");
    const self: Verdict = { group: "network", risk: "caution" };
    return remote && depth < 3 ? worse(self, classifyCommandAt(remote, depth + 1)) : self;
  }
  if (RUNNERS.has(head) || ((head === "pnpm" || head === "yarn") && rest[0] === "dlx") || (head === "bun" && rest[0] === "x")) {
    let tail = head === "pnpm" || head === "yarn" || head === "bun" ? rest.slice(1) : rest;
    while (tail[0]?.startsWith("-")) tail = tail.slice(tail[0] === "-p" || tail[0] === "--package" ? 2 : 1);
    if (!tail.length) return OTHER;
    return classifyHead([tail[0].replace(/@[^/]*$/, ""), ...tail.slice(1)], depth);
  }

  if (head === "git") {
    // Global options before the subcommand; -C and -c take a value.
    let at = 0;
    while (at < rest.length && rest[at].startsWith("-")) at += rest[at] === "-C" || rest[at] === "-c" ? 2 : 1;
    const sub = rest[at];
    const after = rest.slice(at + 1);
    if (sub === "push" && has(after, "--dry-run", "-n")) return OTHER;
    if (sub === "push") {
      const force = has(after, "--force", "--force-with-lease", "--mirror", "--delete") || hasShortFlag(after, "f") || hasShortFlag(after, "d") || after.some((w) => w.startsWith("+") || w.startsWith(":") || w.startsWith("--force"));
      return { group: "push", risk: force ? "danger" : "caution" };
    }
    if (sub === "reset" && has(after, "--hard")) return { group: "delete", risk: "danger" };
    if (sub === "clean" && (hasShortFlag(after, "f") || has(after, "--force"))) return { group: "delete", risk: "danger" };
    if (sub === "branch" && (has(after, "-D") || (has(after, "--delete") && has(after, "--force")))) return { group: "delete", risk: "danger" };
    if (sub === "branch" && has(after, "-d", "--delete")) return { group: "delete", risk: "caution" };
    // Throws away uncommitted edits: `checkout .`, `checkout -- path`, `restore path` (not --staged).
    if (sub === "checkout" && (after.includes(".") || after.includes("--"))) return { group: "delete", risk: "caution" };
    if (sub === "restore" && !has(after, "--staged", "-S") && after.some((w) => !w.startsWith("-"))) return { group: "delete", risk: "caution" };
    if (sub === "stash" && has(after, "drop", "clear")) return { group: "delete", risk: "caution" };
    if (sub === "rm") return { group: "delete", risk: "caution" };
    if ((sub === "tag" && has(after, "-d", "--delete")) || (sub === "worktree" && after[0] === "remove" && has(after, "--force", "-f"))) return { group: "delete", risk: "caution" };
    if (sub === "clone" || sub === "fetch" || sub === "pull") return { group: "network", risk: "normal" };
    return OTHER;
  }
  if (head === "gh") {
    if (rest[0] === "pr" && (rest[1] === "merge" || rest[1] === "create")) return { group: "push", risk: "caution" };
    if (rest[0] === "release" && rest[1] === "create") return { group: "push", risk: "caution" };
    if ((rest[0] === "workflow" && rest[1] === "run") || (rest[0] === "run" && rest[1] === "rerun") || (rest[0] === "pr" && rest[1] === "review" && has(rest, "--approve", "-a"))) return { group: "push", risk: "caution" };
    if (["pr", "issue"].includes(rest[0]) && ["comment", "create", "close", "edit", "reopen"].includes(rest[1])) return { group: "network", risk: "caution" };
    if (rest[0] === "repo" && rest[1] === "delete") return { group: "delete", risk: "danger" };
    const method = ghMethod(rest);
    if (method && method !== "GET") return method === "DELETE" ? { group: "delete", risk: "caution" } : { group: "network", risk: "caution" };
    return { group: "network", risk: "normal" };
  }
  if (head === "rm" || head === "rmdir" || head === "unlink" || head === "shred" || head === "trash") {
    const recursive = hasShortFlag(rest, "r") || hasShortFlag(rest, "R") || has(rest, "--recursive");
    const wide = rest.some((w) => w === "/" || w === "~" || w === "~/" || w === "." || w === "./" || w === ".." || w === "../" || w === "$HOME" || w === "$HOME/" || w === "${HOME}" || w === "${HOME}/" || (/^\/[^/]*\/?$/.test(w) && !/^\/tmp\/?$/.test(w)) || /^\/(Users|home)\/[^/]+\/?$/.test(w) || /^~\/?\*?$/.test(w) || w.startsWith("/*"));
    return { group: "delete", risk: recursive && wide ? "danger" : "caution" };
  }
  if (head === "find" && (has(rest, "-delete") || (has(rest, "-exec", "-execdir") && rest.some((w) => base(w) === "rm")))) return { group: "delete", risk: "caution" };
  if (head === "mkfs" || head.startsWith("mkfs.") || (head === "dd" && rest.some((w) => /^of=\/dev\//.test(w)))) return { group: "delete", risk: "danger" };
  // Databases and volumes: a dropped table or a reset schema does not come back.
  if (["psql", "mysql", "sqlite3", "mongosh", "redis-cli", "clickhouse-client"].includes(head) && rest.some((w) => DESTRUCTIVE_SQL.test(w))) return { group: "delete", risk: "danger" };
  if ((head === "prisma" && rest[0] === "migrate" && rest[1] === "reset") || (head === "prisma" && rest[0] === "db" && has(rest, "--force-reset"))) return { group: "delete", risk: "danger" };
  // A schema pushed straight to a database, past any migration.
  if ((head === "prisma" && rest[0] === "db" && rest[1] === "push") || (head === "drizzle-kit" && rest[0] === "push")) return { group: "push", risk: has(rest, "--accept-data-loss", "--force") ? "danger" : "caution" };
  if (head === "docker" && rest[0] === "compose" && rest.includes("down") && has(rest, "-v", "--volumes")) return { group: "delete", risk: "caution" };
  if (head === "docker" && rest[0] === "volume" && has(rest, "rm", "prune")) return { group: "delete", risk: "caution" };
  if (head === "chmod" && (hasShortFlag(rest, "R") || has(rest, "--recursive")) && rest.includes("777")) return { group: "other", risk: "danger" };
  if ((head === "kubectl" || head === "helm") && has(rest, "delete", "uninstall")) return { group: "delete", risk: "danger" };
  if ((head === "kubectl" && (has(rest, "apply", "scale") || (rest.includes("rollout") && has(rest, "restart", "undo")))) || (head === "helm" && has(rest, "install", "upgrade"))) return { group: "push", risk: "danger" };

  // Shipping: deploys, publishes, releases.
  if (shipsName(head.replace(/\.sh$/, ""))) return { group: "push", risk: "danger" };
  if ((head === "convex" || head === "vercel" || head === "fly" || head === "flyctl" || head === "wrangler" || head === "netlify") && (has(rest, "deploy", "publish", "--prod"))) return { group: "push", risk: "danger" };
  if (head === "railway" && has(rest, "up", "deploy")) return { group: "push", risk: "danger" };
  if (head === "make" && rest.some((w) => shipsName(w) || /^release([:_-]|$)/.test(w))) return { group: "push", risk: "danger" };
  if (head === "terraform" && has(rest, "destroy")) return { group: "delete", risk: "danger" };
  if (head === "terraform" && has(rest, "apply")) return { group: "push", risk: "danger" };
  if (head === "twine" && rest[0] === "upload") return { group: "push", risk: "danger" };
  if (head === "docker" && has(rest, "push")) return { group: "push", risk: "caution" };
  if (head === "docker" && has(rest, "rm", "rmi", "prune")) return { group: "delete", risk: "caution" };

  if (PACKAGE_MANAGERS.has(head)) {
    const tail = head === "uv" && rest[0] === "pip" ? rest.slice(1) : rest;
    const verb = firstArg(tail);
    if (verb && PUBLISH_VERBS.has(verb) && head !== "go" && head !== "brew") return has(tail, "--dry-run", "-n") ? OTHER : { group: "push", risk: "danger" };
    // A package script named for shipping (`bun run deploy`, `npm run publish:prod`).
    const script = verb === "run" ? firstArg(tail.slice(tail.indexOf(verb) + 1)) : verb;
    if (script && shipsName(scriptName(script))) return { group: "push", risk: "danger" };
    if (!verb || !INSTALL_VERBS.has(verb)) return OTHER;
    // A package named: a new dependency. A bare install of the lockfile (`bun
    // install`, `pip install -r requirements.txt`) changes nothing new.
    const afterVerb = tail.slice(tail.indexOf(verb) + 1);
    const named: string[] = [];
    for (let k = 0; k < afterVerb.length; k++) {
      const w = afterVerb[k];
      if (["-r", "--requirement", "-c", "--constraint", "--prefix", "-C", "--cwd", "--dir", "--filter", "-w", "--workspace"].includes(w)) { k++; continue; }
      if (!w.startsWith("-") && w !== ".") named.push(w);
    }
    return named.length || verb === "upgrade" ? { group: "install", risk: "caution" } : OTHER;
  }
  if (NETWORK_TOOLS.has(head)) {
    const method = rest[rest.findIndex((w) => w === "-X" || w === "--request") + 1] ?? "";
    const writes = has(rest, "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--json", "-F", "--form", "-T", "--upload-file") || /^(POST|PUT|PATCH|DELETE)$/i.test(method) || rest.some((w) => /^(-X|--request=)(POST|PUT|PATCH|DELETE)$/i.test(w));
    return { group: "network", risk: writes || head === "scp" || head === "rsync" ? "caution" : "normal" };
  }
  return OTHER;
}

/** A script or target named for shipping (`deploy`, `deploy:prod`, `publish-web`), not one that only looks (`deploy:check`, `deploy-status`). */
function shipsName(name: string): boolean {
  if (!/(^|[-_.:])(deploy|publish)([-_.:]|$)/.test(name)) return false;
  return !/(^|[-_.:])(check|status|dry|plan|diff|test|lint|verify|logs?)([-_.:]|$)/.test(name);
}

/** A script path's name without directory or extension (`scripts/deploy.mjs` → `deploy`). */
const scriptName = (path: string) => base(path).replace(/\.(m?[jt]sx?|c?js|py|rb|pl|sh)$/, "");

/** An interpreter that runs what it reads on stdin: no inline code (-c, -e, -m) and no script file named. `bash -s -- args` still reads stdin. */
function readsScriptFromStdin(words: Words): boolean {
  const rest = words.slice(1);
  for (let k = 0; k < rest.length; k++) {
    const w = rest[k];
    if (w === "-s" || w === "--" || w === "-") return true;
    if (/^-[a-z]*[cem]$/.test(w) || w === "--eval" || w === "--command") return false;
    if (!w.startsWith("-")) return false;
  }
  return true;
}

/** Where a command sends its output: the word after `>`/`>>`, or a `>path` word; `tee path`. */
function writesTo(words: Words): string | null {
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    if (w === ">" || w === ">>") return words[k + 1] ?? null;
    const m = /^>>?(.+)$/.exec(w);
    if (m) return m[1];
  }
  if (base(words[0] ?? "") === "tee") return words.slice(1).find((w) => !w.startsWith("-")) ?? null;
  return null;
}

function classifyCommandAt(command: string, depth: number): Verdict {
  let verdict = OTHER;
  // Scripts this command wrote from a heredoc (`cat > x.sh <<EOF`), so
  // running one later in it (`bash x.sh`, `./x.sh`) is read for what it does.
  const written = new Map<string, string>();
  let pipelineFetches = false;
  let pipedScript: string | undefined;
  for (const seg of tokenize(command)) {
    if (!seg.piped) { pipelineFetches = false; pipedScript = undefined; }
    const { words } = unwrap(seg.words);
    const head = words[0] ? base(words[0]) : "";
    let r = classifyWords(seg.words, depth);
    if (seg.stdin !== undefined && (head === "cat" || head === "tee")) {
      const target = writesTo(words);
      if (target) written.set(base(target), seg.stdin);
    }
    const ranScript = SHELLS.has(head) ? words.slice(1).find((w) => !w.startsWith("-")) : words[0];
    const body = ranScript ? written.get(base(ranScript)) : undefined;
    if (body !== undefined && depth < 3) r = worse(r, classifyCommandAt(body, depth + 1));
    // A heredoc handed to a shell or a remote host is the script that runs;
    // one piped on into a shell (`cat <<EOF | sh`) is too.
    if (seg.stdin !== undefined && depth < 3 && (SHELLS.has(head) || head === "ssh" || head === "eval")) r = worse(r, classifyCommandAt(seg.stdin, depth + 1));
    if (seg.piped && SHELLS.has(head) && pipedScript !== undefined && depth < 3) r = worse(r, classifyCommandAt(pipedScript, depth + 1));
    // `bash -c "$(curl …)"`, `bash <(curl …)`, `eval "$(curl …)"`: a fetched script run.
    if ((SHELLS.has(head) || head === "eval" || head === "source" || head === ".") && seg.subs?.some(fetches)) r = worse(r, { group: "network", risk: "danger" });
    // `curl … | sh` (or `| tee f | bash`): what was fetched runs. That is
    // the risk, whatever the shell does with no script of its own.
    if (seg.piped && pipelineFetches && INTERPRETERS.has(head) && readsScriptFromStdin(words)) r = worse(r, { group: "network", risk: "danger" });
    if (NETWORK_TOOLS.has(head) && head !== "ssh") pipelineFetches = true;
    if (seg.stdin !== undefined && (head === "cat" || head === "echo" || head === "printf")) pipedScript = seg.stdin;
    verdict = worse(verdict, r);
  }
  return verdict;
}

/** Whether a script fetches from the network (curl, wget…) anywhere in it. */
function fetches(script: string): boolean {
  return tokenize(script).some((seg) => {
    const head = unwrap(seg.words).words[0];
    return !!head && NETWORK_TOOLS.has(base(head)) && base(head) !== "ssh";
  });
}

/** A whole command's group (its weightiest part) and risk (its riskiest part). */
export function classifyCommand(command: string): Verdict {
  return classifyCommandAt(command, 0);
}

function commandOf(input: unknown): string {
  let value = input;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return value as string; }
  }
  if (!value || typeof value !== "object") return "";
  const v = value as Record<string, unknown>;
  const raw = v.command ?? v.cmd;
  if (Array.isArray(raw)) {
    // Codex spells a call as argv, usually ["bash", "-lc", "<script>"].
    const script = raw.length >= 3 && SHELLS.has(base(String(raw[0]))) && /^-[a-z]*c$/.test(String(raw[1])) ? raw[raw.length - 1] : raw.join(" ");
    return String(script);
  }
  return typeof raw === "string" ? raw : "";
}

type SummaryMessage = {
  _id: string;
  timestamp?: number;
  tool_calls?: { id: string; name: string; input?: unknown }[] | null;
  tool_results?: { tool_use_id: string; is_error?: boolean; content?: unknown }[] | null;
};

// What a refusal looks like in the call's result: Claude Code's decline, and
// a permission rule or hook that blocked the call before it ran.
const DENIED_RESULT = /doesn't want to proceed with this tool use|tool use was rejected|permission to use \w+[^\n]{0,200}?(has been|was) denied|blocked by (a )?(hook|policy|permission)/i;

const cache = new WeakMap<object, RanSummary>();
const callCache = new WeakMap<object, { input: unknown; command: string; group: RanGroup; risk: RanRisk }>();

/** Every shell call in the messages, oldest first, with the rollup. One pass per new messages array. */
export function whatItRan(messages: readonly SummaryMessage[] | undefined): RanSummary {
  const key = messages ?? EMPTY_MESSAGES;
  const hit = cache.get(key);
  if (hit) return hit;
  const failed = new Set<string>();
  const denied = new Set<string>();
  for (const m of key) {
    for (const r of m.tool_results ?? []) {
      if (!r.is_error) continue;
      failed.add(r.tool_use_id);
      if (typeof r.content === "string" && DENIED_RESULT.test(r.content.slice(0, 300))) denied.add(r.tool_use_id);
    }
  }
  const calls: RanCall[] = [];
  const counts: Record<RanGroup, number> = { push: 0, install: 0, delete: 0, network: 0, other: 0 };
  let worst: RanRisk = "normal";
  for (const m of key) {
    for (const call of m.tool_calls ?? []) {
      if (!call || !isShellTool(call.name)) continue;
      let c = callCache.get(call);
      if (!c || c.input !== call.input) {
        const command = commandOf(call.input).trim();
        c = { input: call.input, command, ...classifyCommand(command) };
        callCache.set(call, c);
      }
      if (!c.command) continue;
      const refused = denied.has(call.id);
      // A refused call did nothing: it is listed, plain, and flags nothing.
      calls.push({ messageId: String(m._id), callId: call.id, command: c.command, group: c.group, risk: refused ? "normal" : c.risk, failed: failed.has(call.id), denied: refused, timestamp: m.timestamp ?? 0 });
      if (refused) continue;
      counts[c.group]++;
      if (RISK_RANK[c.risk] > RISK_RANK[worst]) worst = c.risk;
    }
  }
  const ran = RAN_GROUPS.reduce((n, g) => n + counts[g], 0);
  const summary: RanSummary = { calls, counts, notable: ran - counts.other, worst };
  cache.set(key, summary);
  return summary;
}

const EMPTY_MESSAGES: readonly SummaryMessage[] = [];
