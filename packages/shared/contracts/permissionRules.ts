// Codecast's own permission rules: what a tool call asks for, what "always"
// keeps, and how kept rules settle the next call. One module for every
// harness, so a rule saved from a Claude card settles the same command from
// Codex. Pure: the daemon derives requests here, convex evaluates them here.
//
// A request names a permission ("bash", "edit", "webfetch", or a tool's own
// lowercased name) and the patterns it touches (one per shell sub-command, so
// `cd x && git push` asks for "git push" on its own). `always` is what an
// "always allow" answer saves: each sub-command cut to its prefix by the arity
// table, with ` *` after it (`git push *`, `npm run *`, `aws s3 cp *`).

export type PermissionRuleAction = "allow" | "deny";

export interface PermissionRule {
  permission: string;
  pattern: string;
  action: PermissionRuleAction;
}

export interface PermissionRuleRequest {
  permission: string;
  /** What the call touches. Empty means nothing to judge (a bare `cd`). */
  patterns: string[];
  /** What "always" saves. Empty when the call cannot be kept as a rule: a
   *  command whose meaning hides in a substitution or a redirect. */
  always: string[];
  /** Part of the call cannot be read without running it, so no allow rule
   *  covers it (a deny still can). */
  opaque?: boolean;
}

/** How many words name a command, by its leading words. Commands absent here
 *  are named by their first word. */
const ARITY: Record<string, number> = {
  cat: 1, chmod: 1, chown: 1, cp: 1, echo: 1, export: 1, grep: 1, kill: 1, killall: 1,
  ln: 1, ls: 1, mkdir: 1, mv: 1, ps: 1, pwd: 1, rm: 1, rmdir: 1, sleep: 1, source: 1, tail: 1,
  touch: 1, unset: 1, which: 1, head: 1, wc: 1, find: 1, sed: 1, rg: 1, curl: 1, jq: 1,
  aws: 3, az: 3, bazel: 2, brew: 2, bun: 2, "bun run": 3, "bun x": 3, bunx: 2, cargo: 2, "cargo add": 3,
  "cargo run": 3, cast: 2, cdk: 2, cf: 2, cmake: 2, composer: 2, deno: 2, "deno task": 3, doctl: 3,
  docker: 2, "docker builder": 3, "docker compose": 3, "docker container": 3, "docker image": 3,
  "docker network": 3, "docker volume": 3, firebase: 2, flyctl: 2, gcloud: 3, gh: 3, git: 2,
  "git config": 3, "git remote": 3, "git stash": 3, go: 2, gradle: 2, helm: 2, heroku: 2, kubectl: 2,
  "kubectl rollout": 3, make: 2, mvn: 2, node: 2, npm: 2, "npm exec": 3, "npm init": 3, "npm run": 3,
  "npm view": 3, npx: 2, "npx convex": 3, pip: 2, pnpm: 2, "pnpm dlx": 3, "pnpm exec": 3, "pnpm run": 3,
  poetry: 2, podman: 2, psql: 2, pulumi: 2, python: 2, python3: 2, railway: 2, rustup: 2, swift: 2,
  systemctl: 2, terraform: 2, tmux: 2, turbo: 2, uv: 2, "uv run": 3, vercel: 2, wrangler: 2, yarn: 2,
  "yarn dlx": 3, "yarn run": 3, xcrun: 2,
};
const ARITY_PREFIX = 3;

/** Where a command runs: the directory it starts in and the project root.
 *  Only a directory change that stays inside the root is read through. */
export interface ShellContext {
  cwd?: string;
  root?: string;
}

/** Directory moves need no permission of their own while they stay in the
 *  project; one that leaves it takes the rest of the line out of the
 *  project's rules, so the whole line can only ask. */
const DIRECTORY_MOVES = new Set(["cd", "pushd", "popd"]);

/** Commands whose words are another command (or a script): a rule kept for
 *  them would allow anything, so they are never matched by a prefix. */
const RUNS_ANOTHER_COMMAND = new Set([
  "sudo", "doas", "su", "env", "command", "builtin", "exec", "eval", "xargs", "time", "nohup", "timeout",
  "nice", "ionice", "watch", "sh", "bash", "zsh", "fish", "dash", "ksh", "ssh", "script", "parallel", "source", ".",
  "caffeinate", "stdbuf", "setsid", "flock", "unbuffer", "chronic", "arch", "sandbox-exec", "taskpolicy", "uvx", "pipx",
  // Programs whose argument is a program: awk/sed scripts can run commands
  // and write files, and export/alias/unset change what later commands mean.
  "awk", "gawk", "mawk", "sed", "gsed", "perl", "export", "alias", "unset", "set", "trap", "declare", "typeset",
  "tmux", "screen", "cross-env", "dotenv", "concurrently", "npm-run-all", "run-p", "run-s", "entr", "nodemon", "watchexec",
]);
/** Interpreters whose flag runs inline code. */
const INLINE_CODE = new Set(["python", "python3", "node", "bun", "deno", "ruby", "php", "osascript", "tsx", "ts-node", "bunx", "npx"]);
/** Flags that make an otherwise named command run something else. */
const EXEC_FLAGS = /^(--pre(=|$)|--exec(=|$)|--checkpoint-action|--to-command|--use-compress-program|--rsh(=|$)|--upload-pack|--receive-pack|--config(=|$)|--command(=|$)|--pre-glob)/;
/** The same, for flags whose meaning belongs to one program. */
const EXEC_FLAGS_OF: Record<string, RegExp> = {
  git: /^(-c|-x|-u|-O.*|--open-files-in-pager.*|--template.*|--exec-path.*|--upload-pack.*|--receive-pack.*|--ext-diff|--textconv)$/,
  rsync: /^(-e|--rsh.*)$/, rg: /^--pre/, tar: /^(-I|--use-compress-program.*)$/,
  ssh: /^-o/, scp: /^(-o.*|-S)$/, sftp: /^(-o.*|-S)$/, make: /^(--eval.*|-E|--file.*|-f)$/,
  find: /^-(fprint|fprintf|fprint0|fls)$/,
};
/** Paths an edit rule never covers: the repository's own machinery and the
 *  agents' settings, where one write runs code or widens what agents may do. */
const PROTECTED_SEGMENT = /(^|\/)(\.git|\.claude|\.codex|\.codecast|\.husky)(\/|$)/i;
const INLINE_CODE_FLAGS = /^(-c|-e|-p|-r|--eval|--print|-[a-zA-Z]*[ce])$/;
const FIND_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete"]);

/** Paths joined and `.`/`..` folded, without node:path (convex and the web read this too). */
export function resolvePath(base: string, target: string): string {
  const parts: string[] = [];
  for (const part of (target.startsWith("/") ? target : `${base}/${target}`).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

export function insideRoot(file: string, root: string): boolean {
  const r = root.replace(/\/+$/, "");
  return file === r || file.startsWith(`${r}/`);
}

/** Splits a shell command into its sub-commands, or null when part of it
 *  cannot be read without running it: an expansion (`$VAR`, `${…}`, `$(…)`,
 *  `$'…'`), a backgrounded job, a subshell, or a write through a redirect
 *  (other than to /dev/null or another descriptor). */
export function splitShellCommand(command: string): string[][] | null {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return null;
      word += command.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        if (command[j] === "\\") { word += command[++j] ?? ""; continue; }
        // Any expansion: its value is decided when the shell runs it.
        if (command[j] === "`" || command[j] === "$") return null;
        word += command[j];
      }
      if (j >= command.length) return null;
      inWord = true;
      i = j;
    } else if (c === "\\") {
      if (command[i + 1] === "\n") { i++; continue; }
      word += command[++i] ?? "";
      inWord = true;
    } else if (c === "`" || c === "$" || c === "(" || c === ")" || c === "{" && !inWord) {
      return null;
    } else if (c === "<" && command[i + 1] === "(") {
      return null;
    } else if (c === ">" || c === "<") {
      // Descriptor dups (2>&1, >&2) and /dev/null are not writes; a heredoc
      // (<<) feeds the command text; anything else names a file.
      if (c === "<" && command[i + 1] === "<") return null;
      if (c === "<") return null;
      let j = i + 1;
      if (command[j] === ">") j++;
      if (command[j] === "&") {
        j++;
        // `>&2` duplicates a descriptor; `>&file` writes the file.
        if (!/[\d-]/.test(command[j] ?? "")) return null;
        while (/[\d-]/.test(command[j] ?? "")) j++;
        if (/[^\s;&|]/.test(command[j] ?? " ")) return null;
        if (inWord && /^\d$/.test(word)) { word = ""; inWord = false; }
        i = j - 1;
        continue;
      }
      while (command[j] === " ") j++;
      if (command.startsWith("/dev/null", j) && !/[^\s;&|]/.test(command[j + 9] ?? " ")) {
        if (inWord && /^\d$/.test(word)) { word = ""; inWord = false; }
        i = j + 8;
        continue;
      }
      return null;
    } else if (c === "&" && command[i + 1] !== "&") {
      return null;
    } else if (c === ";" || c === "\n" || c === "|" || c === "&") {
      endCommand();
      if ((c === "|" || c === "&") && command[i + 1] === c) i++;
    } else if (c === " " || c === "\t") {
      endWord();
    } else if (c === "#" && !inWord) {
      const end = command.indexOf("\n", i);
      if (end < 0) break;
      i = end - 1;
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The words that name a command: leading assignments, then the arity prefix. */
export function commandPrefix(words: readonly string[]): string[] {
  return namedBy(words).words;
}

/** The arity prefix, and whether the command's words fill it with names (no
 *  flag in a subcommand's place, no subcommand missing). Only a full one is
 *  kept as a rule: `npm run` alone would otherwise keep every script, and
 *  `git -C x` every git command. */
function namedBy(words: readonly string[]): { words: string[]; full: boolean } {
  let start = 0;
  while (start < words.length - 1 && ASSIGNMENT.test(words[start])) start++;
  const rest = words.slice(start);
  let arity = 1;
  for (let length = Math.min(ARITY_PREFIX, rest.length); length > 0; length--) {
    const found = ARITY[rest.slice(0, length).join(" ")];
    if (found !== undefined) { arity = found; break; }
  }
  const named = rest.slice(0, arity);
  const full = named.length === arity && named.slice(1).every((w) => !/^[-+]/.test(w));
  return { words: [...words.slice(0, start), ...named], full };
}

/** Whether a command's own words decide what it does: not a wrapper around
 *  another command, not inline code, not named by a variable or a glob. */
function readable(words: readonly string[]): boolean {
  const prefix = commandPrefix(words);
  const name = words.find((w) => !ASSIGNMENT.test(w)) ?? "";
  const base = name.split("/").pop() ?? name;
  if (prefix.some((w) => /[$*?[\]]/.test(w))) return false;
  if (RUNS_ANOTHER_COMMAND.has(base)) return false;
  if (words.some((w) => INLINE_CODE.has(w.split("/").pop() ?? w)) && words.some((w) => INLINE_CODE_FLAGS.test(w))) return false;
  if (base === "find" && words.some((w) => FIND_ACTIONS.has(w))) return false;
  if (words.slice(1).some((w) => EXEC_FLAGS.test(w) || EXEC_FLAGS_OF[base]?.test(w))) return false;
  return true;
}

/** The permission request a shell command makes. */
export function shellRequest(command: string, ctx: ShellContext = {}): PermissionRuleRequest {
  const split = splitShellCommand(command);
  const opaque = { permission: "bash", patterns: [command.trim()], always: [], opaque: true };
  if (!split) return opaque;
  let cwd = ctx.cwd;
  const commands: string[][] = [];
  for (const words of split) {
    if (!DIRECTORY_MOVES.has(words[0])) { commands.push(words); continue; }
    const target = words[0] === "cd" && words.length === 2 ? words[1] : null;
    if (!target || !ctx.root || !cwd || /[$~*?]/.test(target)) return opaque;
    cwd = resolvePath(cwd, target);
    if (!insideRoot(cwd, ctx.root)) return opaque;
  }
  if (!commands.every(readable)) return opaque;
  const patterns = commands.map((words) => words.join(" "));
  const named = commands.map(namedBy);
  const always = named.every((n) => n.full) ? [...new Set(named.map((n) => `${n.words.join(" ")} *`))] : [];
  return { permission: "bash", patterns, always };
}

/** The request a file edit makes: "always" keeps every edit inside the
 *  project root, and nothing for a file outside it. */
export function editRequest(files: readonly string[], ctx: ShellContext = {}): PermissionRuleRequest {
  const resolved = files.map((f) => (ctx.cwd || f.startsWith("/") ? resolvePath(ctx.cwd ?? "/", f) : f));
  if (!resolved.length) return { permission: "edit", patterns: [], always: [], opaque: true };
  const root = ctx.root?.replace(/\/+$/, "");
  const kept = root && !/[*?]/.test(root) && resolved.every((f) => insideRoot(f, root) && !PROTECTED_SEGMENT.test(f)) ? [`${root}/*`] : [];
  return { permission: "edit", patterns: resolved, always: kept };
}

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

function hostOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try { return new URL(url).hostname || null; } catch { return null; }
}

/** The request a Claude Code tool call makes, from its tool_input. */
export function claudeToolRequest(toolName: string, input: Record<string, unknown> | null | undefined, ctx: ShellContext = {}): PermissionRuleRequest {
  const i = input ?? {};
  if (toolName === "Bash" && typeof i.command === "string") return shellRequest(i.command, ctx);
  if (EDIT_TOOLS.has(toolName)) {
    const file = [i.file_path, i.notebook_path].find((v) => typeof v === "string") as string | undefined;
    return editRequest(file ? [file] : [], ctx);
  }
  if (toolName === "WebFetch") {
    const host = hostOf(i.url);
    return host ? { permission: "webfetch", patterns: [host], always: [host] } : { permission: "webfetch", patterns: [String(i.url ?? "")], always: [], opaque: true };
  }
  return { permission: toolName.toLowerCase(), patterns: ["*"], always: ["*"] };
}

/** The request a Codex app-server approval makes, from its method and params. */
export function codexApprovalRequest(method: string, params: Record<string, unknown> | null | undefined, ctx: ShellContext = {}): PermissionRuleRequest | null {
  const p = params ?? {};
  const here = { ...ctx, ...(typeof p.cwd === "string" && p.cwd && { cwd: p.cwd }) };
  if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
    const command = Array.isArray(p.command) ? codexArgvCommand(p.command as unknown[]) : typeof p.command === "string" ? p.command : null;
    return command ? shellRequest(command, here) : null;
  }
  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
    // The newer file change approval names no files: nothing to judge or keep.
    return editRequest(Object.keys((p.changes ?? p.fileChanges ?? {}) as Record<string, unknown>), here);
  }
  return null;
}

/** Codex sends argv, usually `["bash", "-lc", "<script>"]`; the script is the command. */
function codexArgvCommand(argv: unknown[]): string | null {
  const words = argv.filter((w): w is string => typeof w === "string");
  if (words.length >= 3 && /(^|\/)(ba|z)?sh$/.test(words[0]) && /^-l?c$/.test(words[1])) return words[2];
  if (!words.length) return null;
  return words.map((w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)).join(" ");
}

/** Shell-style wildcard: `*` any run, `?` one character, and a trailing ` *`
 *  also matches the bare command (`git push *` covers `git push`). */
export function wildcardMatch(input: string, pattern: string): boolean {
  let source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  if (source.endsWith(" .*")) source = `${source.slice(0, -3)}( .*)?`;
  return new RegExp(`^${source}$`, "s").test(input);
}

/** A deny matches more spellings than an allow does, since a miss lets the
 *  call through: the command without its leading assignments and with its
 *  program's path cut to its name, and, for a call that cannot be read, any
 *  place in its text the denied command starts. */
function denyMatches(pattern: string, rule: string, opaque: boolean): boolean {
  if (wildcardMatch(pattern, rule)) return true;
  const words = pattern.split(/\s+/);
  let start = 0;
  while (start < words.length - 1 && ASSIGNMENT.test(words[start])) start++;
  const rest = words.slice(start);
  if (rest.length) rest[0] = rest[0].split("/").pop() ?? rest[0];
  if (wildcardMatch(rest.join(" "), rule)) return true;
  // The denied words in order anywhere in the command: `git push --force *`
  // reaches `git -C . push origin main --force`.
  const want = rule.replace(/ \*$/, "").trim().split(/\s+/);
  if (want.length && !want.some((w) => /[*?]/.test(w))) {
    let i = 0;
    for (const w of rest) if (i < want.length && w === want[i]) i++;
    if (i === want.length) return true;
  }
  if (!opaque) return false;
  const stem = rule.replace(/ \*$/, "").trim();
  if (!stem || /[*?]/.test(stem)) return false;
  const escaped = stem.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
  return new RegExp(`(^|[\\s;&|(\`'"/])${escaped}(\\s|$|[;&|)'"\`])`).test(pattern);
}

export type PermissionVerdict =
  | { action: "allow"; rules: PermissionRule[] }
  | { action: "deny"; rule: PermissionRule; pattern: string }
  | { action: "ask"; uncovered: string[] };

/** Settles a request against rules: any deny that matches a pattern wins;
 *  allow only when every pattern has an allow; otherwise ask, naming the
 *  patterns no rule covers. A request with no patterns asks. */
export function evaluatePermission(request: PermissionRuleRequest, rules: readonly PermissionRule[]): PermissionVerdict {
  const relevant = rules.filter((r) => r.permission === request.permission || r.permission === "*");
  for (const pattern of request.patterns) {
    const deny = relevant.find((r) => r.action === "deny" && denyMatches(pattern, r.pattern, !!request.opaque));
    if (deny) return { action: "deny", rule: deny, pattern };
  }
  if (!request.patterns.length || request.opaque) return { action: "ask", uncovered: request.patterns };
  const used: PermissionRule[] = [];
  const uncovered: string[] = [];
  for (const pattern of request.patterns) {
    const shielded = request.permission === "edit" && PROTECTED_SEGMENT.test(pattern);
    const allow = shielded ? undefined : relevant.find((r) => r.action === "allow" && wildcardMatch(pattern, r.pattern));
    if (allow) { if (!used.includes(allow)) used.push(allow); } else uncovered.push(pattern);
  }
  return uncovered.length ? { action: "ask", uncovered } : { action: "allow", rules: used };
}

/** A rule as a person reads it: the pattern, with the permission named when it is not a command. */
export function permissionRuleLabel(rule: Pick<PermissionRule, "permission" | "pattern">): string {
  if (rule.permission === "bash") return rule.pattern;
  if (rule.permission === "edit") return rule.pattern.endsWith("/*") ? `edit in ${rule.pattern.slice(0, -2)}` : `edit ${rule.pattern}`;
  if (rule.permission === "webfetch") return `fetch ${rule.pattern}`;
  return rule.pattern === "*" ? rule.permission : `${rule.permission} ${rule.pattern}`;
}

export const MAX_RULE_PATTERNS = 8;
export const MAX_RULE_PATTERN_LENGTH = 300;

/** The request as a row may store it. One past the bounds keeps no patterns
 *  rather than a cut of them: a cut could drop the sub-command a deny names,
 *  and a request with no patterns always asks. */
export function boundedRuleRequest(request: PermissionRuleRequest): PermissionRuleRequest {
  const fits = (xs: string[], n: number) => xs.length <= n && xs.every((x) => x.length <= MAX_RULE_PATTERN_LENGTH);
  const permission = request.permission.slice(0, 80);
  if (!fits(request.patterns, MAX_RULE_PATTERNS * 4) || !fits(request.always, MAX_RULE_PATTERNS)) return { permission, patterns: [], always: [], opaque: true };
  return { permission, patterns: request.patterns, always: request.always, ...(request.opaque && { opaque: true }) };
}

/** The rules an "always" on this request keeps; none for a call that cannot be kept. */
export function keptPatterns(request: PermissionRuleRequest | undefined): string[] {
  return request && !request.opaque ? request.always : [];
}

/** A pending ask as the cascade reads it. */
export interface PendingAsk {
  _id: string;
  session_id: string;
  conversation_id: string;
  rule_request?: PermissionRuleRequest;
}

/** What one answer settles among the same session's other open asks: after an
 *  "always", the ones the rules now allow; after a denial with a reason, all
 *  of them, with that reason. `rules` are the rules in force after the answer
 *  (the server passes all of them, a client the ones the answer kept). */
export function cascadeFromAnswer(
  answered: PendingAsk,
  answer: { status: "approved" | "denied"; message?: string; remember?: boolean },
  pending: readonly PendingAsk[],
  rules: readonly PermissionRule[],
): { approve: string[]; deny: string[] } {
  if (!answered.session_id) return { approve: [], deny: [] };
  const siblings = pending.filter((p) => p._id !== answered._id && p.session_id === answered.session_id && p.conversation_id === answered.conversation_id);
  if (answer.status === "approved" && answer.remember && keptPatterns(answered.rule_request).length) {
    return { approve: siblings.filter((p) => p.rule_request && evaluatePermission(p.rule_request, rules).action === "allow").map((p) => p._id), deny: [] };
  }
  if (answer.status === "denied" && answer.message?.trim()) return { approve: [], deny: siblings.map((p) => p._id) };
  return { approve: [], deny: [] };
}

/** What an "always" on a stored request may keep, re-derived from what the
 *  call touched rather than taken from the caller: commands their own arity
 *  prefix, edits the conversation's checkout root, a fetch its hosts. */
export function keepableFor(request: PermissionRuleRequest, root?: string): string[] {
  if (request.opaque || !request.patterns.length) return [];
  if (request.permission === "bash") {
    // Each pattern is one sub-command already split (its quoted words joined
    // by spaces), so its prefix is read off its leading words, not re-parsed.
    const named = request.patterns.map((p) => namedBy(p.split(" ")));
    if (named.some((n) => !n.full || n.words.some((w) => /[$*?[\]`'"\\]/.test(w)))) return [];
    const derived = [...new Set(named.map((n) => `${n.words.join(" ")} *`))];
    return request.always.length === derived.length && request.always.every((a) => derived.includes(a)) ? derived : [];
  }
  if (request.permission === "edit") {
    if (!root) return [];
    return editRequest(request.patterns, { root }).always.filter((a) => request.always.includes(a));
  }
  if (request.permission === "webfetch") return request.always.every((a) => request.patterns.includes(a)) ? request.always : [];
  return request.always.length === 1 && request.always[0] === "*" ? ["*"] : [];
}
