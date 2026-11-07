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
  cat: 1, chmod: 1, chown: 1, cp: 1, echo: 1, env: 1, export: 1, grep: 1, kill: 1, killall: 1,
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

/** Directory moves need no permission of their own; the command after them does. */
const DIRECTORY_ONLY = new Set(["cd", "pushd", "popd"]);

/** Splits a shell command into its sub-commands, or null when part of it
 *  cannot be read without running it: a substitution, a backgrounded job, a
 *  subshell, or a write through a redirect (other than to /dev/null or
 *  another descriptor). */
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
        if (command[j] === "`" || (command[j] === "$" && command[j + 1] === "(")) return null;
        word += command[j];
      }
      if (j >= command.length) return null;
      inWord = true;
      i = j;
    } else if (c === "\\") {
      if (command[i + 1] === "\n") { i++; continue; }
      word += command[++i] ?? "";
      inWord = true;
    } else if (c === "`" || (c === "$" && command[i + 1] === "(") || c === "(" || c === ")" || c === "{" && !inWord) {
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
        while (/\d|-/.test(command[j] ?? "")) j++;
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
  let start = 0;
  while (start < words.length - 1 && ASSIGNMENT.test(words[start])) start++;
  const rest = words.slice(start);
  for (let length = Math.min(ARITY_PREFIX, rest.length); length > 0; length--) {
    const arity = ARITY[rest.slice(0, length).join(" ")];
    if (arity !== undefined) return [...words.slice(0, start), ...rest.slice(0, arity)];
  }
  return [...words.slice(0, start), ...rest.slice(0, 1)];
}

/** The permission request a shell command makes. */
export function shellRequest(command: string): PermissionRuleRequest {
  const split = splitShellCommand(command);
  const opaque = { permission: "bash", patterns: [command.trim()], always: [], opaque: true };
  if (!split) return opaque;
  const commands = split.filter((words) => !DIRECTORY_ONLY.has(words[0]));
  // A command named by a variable is whatever the variable holds.
  if (commands.some((words) => words.find((w) => !ASSIGNMENT.test(w))?.includes("$"))) return opaque;
  const patterns = commands.map((words) => words.join(" "));
  const always = [...new Set(commands.map((words) => `${commandPrefix(words).join(" ")} *`))];
  return { permission: "bash", patterns, always };
}

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

function hostOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try { return new URL(url).hostname || null; } catch { return null; }
}

/** The request a Claude Code tool call makes, from its tool_input. */
export function claudeToolRequest(toolName: string, input: Record<string, unknown> | null | undefined): PermissionRuleRequest {
  const i = input ?? {};
  if (toolName === "Bash" && typeof i.command === "string") return shellRequest(i.command);
  if (EDIT_TOOLS.has(toolName)) {
    const file = [i.file_path, i.notebook_path].find((v) => typeof v === "string") as string | undefined;
    return { permission: "edit", patterns: [file ?? "*"], always: ["*"] };
  }
  if (toolName === "WebFetch") {
    const host = hostOf(i.url);
    return host ? { permission: "webfetch", patterns: [host], always: [host] } : { permission: "webfetch", patterns: [String(i.url ?? "")], always: [], opaque: true };
  }
  return { permission: toolName.toLowerCase(), patterns: ["*"], always: ["*"] };
}

/** The request a Codex app-server approval makes, from its method and params. */
export function codexApprovalRequest(method: string, params: Record<string, unknown> | null | undefined): PermissionRuleRequest | null {
  const p = params ?? {};
  if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
    const command = Array.isArray(p.command) ? codexArgvCommand(p.command as unknown[]) : typeof p.command === "string" ? p.command : null;
    return command ? shellRequest(command) : null;
  }
  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
    const files = Object.keys((p.changes ?? p.fileChanges ?? {}) as Record<string, unknown>);
    return { permission: "edit", patterns: files.length ? files : ["*"], always: ["*"] };
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
    const deny = relevant.find((r) => r.action === "deny" && wildcardMatch(pattern, r.pattern));
    if (deny) return { action: "deny", rule: deny, pattern };
  }
  if (!request.patterns.length || request.opaque) return { action: "ask", uncovered: request.patterns };
  const used: PermissionRule[] = [];
  const uncovered: string[] = [];
  for (const pattern of request.patterns) {
    const allow = relevant.find((r) => r.action === "allow" && wildcardMatch(pattern, r.pattern));
    if (allow) { if (!used.includes(allow)) used.push(allow); } else uncovered.push(pattern);
  }
  return uncovered.length ? { action: "ask", uncovered } : { action: "allow", rules: used };
}

/** A rule as a person reads it: the pattern, with the permission named when it is not a command. */
export function permissionRuleLabel(rule: Pick<PermissionRule, "permission" | "pattern">): string {
  if (rule.permission === "bash") return rule.pattern;
  if (rule.permission === "edit") return rule.pattern === "*" ? "edit files" : `edit ${rule.pattern}`;
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

/** The allow rules an "always" on this request keeps. */
export function keptRules(request: PermissionRuleRequest | undefined): PermissionRule[] {
  return keptPatterns(request).map((pattern) => ({ permission: request!.permission, pattern, action: "allow" as const }));
}
