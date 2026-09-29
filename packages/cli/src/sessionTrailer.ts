// The Codecast-Session trailer on every commit an agent makes.
//
// Claude Code calls the PreToolUse hook (sessionTrailerHook.ts) before each
// Bash command; the hook hands commands that mention `git commit` to
// `cast _session-trailer`, which lands here. We rewrite each `git commit` in
// the command to `git commit --trailer 'Codecast-Session: <session link>'` and
// return it as the hook's updatedInput, with no permission decision, so the
// permission flow sees the command exactly as it would have (a
// `Bash(git commit:*)` rule still matches).
//
// Only a `git commit` at a command position is touched: text inside quotes,
// heredoc bodies and comments is left alone, and so are commits made by a
// script, an alias, `xargs`, or a `$(…)` substitution. The rewrite is
// idempotent: a command that already names the trailer is returned as is.
//
// Off switches, any one of which leaves commands untouched:
//   CODECAST_SESSION_TRAILER=0                    in the agent's environment
//   git config codecast.sessionTrailer false      in one repository
//   cast config session_trailer false             on this machine
//
// Kept off index.ts's import graph: the hook runs on the fast path.

import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { SESSION_TRAILER_KEY, sessionTrailerValue } from "@codecast/shared/blame";
import { CODECAST_BASE_URL } from "@codecast/shared/entities";

type Token =
  | { kind: "word"; text: string; end: number }
  | { kind: "op"; text: string };

const OPERATORS = ["&&", "||", ";;", "|&", "<<-", "<<<", "<<", ">>", ">&", "<&", "&>", ">|", "|", ";", "&", "(", ")", "<", ">"];
const REDIRECTS = new Set(["<<-", "<<<", "<<", ">>", ">&", "<&", "&>", ">|", "<", ">"]);
const WORD_BREAK = new Set([" ", "\t", "\n", ";", "&", "|", "(", ")", "<", ">"]);
// Words after which the next word is still a command.
const KEYWORDS = new Set(["!", "{", "}", "then", "do", "else", "elif", "if", "while", "until", "time"]);
// git's global options that take their value as the next word.
const GIT_OPTS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix"]);

/** Index just past the quote, substitution or escape that starts at `i`. */
function skipQuoted(s: string, i: number): number {
  const ch = s[i];
  if (ch === "\\") return i + 2;
  if (ch === "'") {
    const close = s.indexOf("'", i + 1);
    return close < 0 ? s.length : close + 1;
  }
  if (ch === "$" && s[i + 1] === "'") {
    let j = i + 2;
    while (j < s.length && s[j] !== "'") j += s[j] === "\\" ? 2 : 1;
    return j + 1;
  }
  if (ch === '"' || ch === "`") {
    let j = i + 1;
    while (j < s.length && s[j] !== ch) j += s[j] === "\\" ? 2 : 1;
    return j + 1;
  }
  // $( … ) and ${ … }: balanced, quote aware.
  const open = s[i + 1];
  const close = open === "(" ? ")" : "}";
  let depth = 0;
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === open) depth++;
    else if (c === close && --depth === 0) return j + 1;
    if (c === "'" || c === '"' || c === "`" || c === "\\") { j = skipQuoted(s, j); continue; }
    j++;
  }
  return s.length;
}

function unquote(word: string): string {
  return word.replace(/^-/, "").replace(/['"\\]/g, "");
}

/** The command split into shell words and operators; heredoc bodies and comments are dropped. */
function tokenize(s: string): Token[] {
  const tokens: Token[] = [];
  const heredocs: { delim: string; stripTabs: boolean }[] = [];
  let heredocNext: boolean | null = null;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === " " || ch === "\t") { i++; continue; }
    if (ch === "\\" && s[i + 1] === "\n") { i += 2; continue; }
    if (ch === "\n") {
      tokens.push({ kind: "op", text: "\n" });
      i++;
      for (const { delim, stripTabs } of heredocs.splice(0)) {
        while (i < s.length) {
          const eol = s.indexOf("\n", i);
          const line = s.slice(i, eol < 0 ? s.length : eol);
          i = eol < 0 ? s.length : eol + 1;
          if ((stripTabs ? line.replace(/^\t+/, "") : line) === delim) break;
        }
      }
      continue;
    }
    if (ch === "#") {
      const eol = s.indexOf("\n", i);
      i = eol < 0 ? s.length : eol;
      continue;
    }
    const op = OPERATORS.find((o) => s.startsWith(o, i));
    if (op) {
      tokens.push({ kind: "op", text: op });
      i += op.length;
      if (op === "<<" || op === "<<-") heredocNext = op === "<<-";
      continue;
    }
    const start = i;
    while (i < s.length && !WORD_BREAK.has(s[i])) {
      const c = s[i];
      if (c === "'" || c === '"' || c === "`" || c === "\\" || (c === "$" && (s[i + 1] === "(" || s[i + 1] === "{" || s[i + 1] === "'"))) {
        i = skipQuoted(s, i);
      } else {
        i++;
      }
    }
    const text = s.slice(start, i);
    if (heredocNext !== null) {
      heredocs.push({ delim: unquote(text), stripTabs: heredocNext });
      heredocNext = null;
    }
    tokens.push({ kind: "word", text, end: i });
  }
  return tokens;
}

export interface GitCommitSite {
  /** Offset just past the `commit` word, where the flag goes. */
  offset: number;
  /** The directory the commit runs in, relative to the command's start:
   *  from an earlier `cd` in the command and git's own `-C`. */
  dir: string;
}

function joinDir(base: string, next: string): string {
  if (next.startsWith("/") || next.startsWith("~")) return next;
  return base === "." ? next : `${base}/${next}`;
}

/** Every `git … commit` at a command position, and the directory it runs in. */
export function findGitCommits(command: string): GitCommitSite[] {
  const found: GitCommitSite[] = [];
  let commandPosition = true;
  let inGit = false;
  let inCd = false;
  let gitDir = "";
  let skipWord = false;
  let valueFor: "-C" | null = null;
  let cwd = ".";
  for (const token of tokenize(command)) {
    if (token.kind === "op") {
      if (REDIRECTS.has(token.text)) { skipWord = true; continue; }
      commandPosition = true;
      inGit = inCd = false;
      continue;
    }
    const word = token.text;
    if (skipWord) {
      skipWord = false;
      if (valueFor === "-C") gitDir = joinDir(gitDir || cwd, unquote(word));
      valueFor = null;
      continue;
    }
    if (inCd) {
      if (!word.startsWith("-")) cwd = joinDir(cwd, unquote(word));
      inCd = false;
      continue;
    }
    if (inGit) {
      if (GIT_OPTS_WITH_VALUE.has(word)) { skipWord = true; valueFor = word === "-C" ? "-C" : null; continue; }
      if (word.startsWith("-")) continue;
      if (word === "commit") found.push({ offset: token.end, dir: gitDir || cwd });
      inGit = false;
      continue;
    }
    if (!commandPosition) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || KEYWORDS.has(word)) continue;
    commandPosition = false;
    inGit = word === "git";
    inCd = word === "cd";
    gitDir = "";
  }
  return found;
}

/**
 * The command with `--trailer '<trailer>'` after every `git commit` in it that
 * `keep` accepts (by the directory it runs in), or null when there is nothing
 * to add: no commit, or the trailer already named.
 */
export function addCommitTrailer(command: string, trailer: string, keep: (dir: string) => boolean = () => true): string | null {
  if (command.toLowerCase().includes(SESSION_TRAILER_KEY.toLowerCase())) return null;
  const sites = findGitCommits(command).filter((site) => keep(site.dir));
  if (sites.length === 0) return null;
  const flag = ` --trailer '${trailer.replace(/'/g, "'\\''")}'`;
  let out = command;
  for (const { offset } of sites.reverse()) out = out.slice(0, offset) + flag + out.slice(offset);
  return out;
}

const OFF = new Set(["0", "false", "off", "no"]);

export interface SessionTrailerDeps {
  env: NodeJS.ProcessEnv;
  /** `cast config session_trailer`: false turns the trailer off on this machine. */
  configEnabled: () => boolean;
  /** `git config codecast.sessionTrailer` in the command's directory, if set. */
  repoSetting: (cwd: string) => string | null;
  /** Does this git take `commit --trailer` (2.32 and later)? */
  gitTakesTrailer: () => boolean;
  /** The conversation id for an agent session id, or null. */
  conversationFor: (sessionId: string) => Promise<string | null>;
  webUrl: string;
  log: (line: string) => void;
}

/**
 * The PreToolUse hook's answer for one tool call: the JSON that rewrites the
 * command, or "" to leave it alone. Never throws and never blocks the call:
 * a commit without the trailer is always better than a commit that failed.
 */
export async function sessionTrailerHookOutput(input: string, deps: SessionTrailerDeps): Promise<string> {
  if (OFF.has((deps.env.CODECAST_SESSION_TRAILER ?? "").trim().toLowerCase())) return "";
  let hook: { session_id?: unknown; cwd?: unknown; tool_name?: unknown; tool_input?: Record<string, unknown> };
  try {
    hook = JSON.parse(input);
  } catch {
    return "";
  }
  const command = hook.tool_input?.command;
  if (hook.tool_name !== "Bash" || typeof command !== "string" || typeof hook.session_id !== "string") return "";
  // Placeholder first: the lookups below cost a process or a request, and most
  // commands that mention "git" and "commit" still add nothing.
  if (addCommitTrailer(command, "x") === null) return "";
  if (!deps.configEnabled()) return "";
  // A repository opts out by its own git config, read where each commit runs:
  // the hook's cwd is the session's, and the command may `cd` elsewhere first.
  const cwd = typeof hook.cwd === "string" ? hook.cwd : process.cwd();
  const home = deps.env.HOME ?? "";
  const optedIn = new Map<string, boolean>();
  const keep = (dir: string) => {
    const abs = path.resolve(cwd, dir.replace(/^~(?=\/|$)/, home));
    if (!optedIn.has(abs)) optedIn.set(abs, !OFF.has((deps.repoSetting(abs) ?? "").trim().toLowerCase()));
    return optedIn.get(abs)!;
  };
  if (addCommitTrailer(command, "x", keep) === null) return "";
  if (!deps.gitTakesTrailer()) {
    deps.log("codecast: git is older than 2.32 (no `commit --trailer`); commit left without a Codecast-Session trailer");
    return "";
  }
  const conversationId = await deps.conversationFor(hook.session_id);
  if (!conversationId) {
    deps.log(`codecast: session ${hook.session_id} has not synced yet; commit left without a Codecast-Session trailer`);
    return "";
  }
  const rewritten = addCommitTrailer(command, `${SESSION_TRAILER_KEY}: ${sessionTrailerValue(conversationId, deps.webUrl)}`, keep);
  if (!rewritten) return "";
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { ...hook.tool_input, command: rewritten },
    },
  });
}

function gitTakesTrailer(): boolean {
  try {
    const m = /(\d+)\.(\d+)/.exec(execFileSync("git", ["--version"], { encoding: "utf-8", timeout: 3000 }));
    return !!m && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 32));
  } catch {
    return false;
  }
}

function repoSetting(cwd: string): string | null {
  try {
    return execFileSync("git", ["-C", cwd, "config", "--get", "codecast.sessionTrailer"], {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** `cast _session-trailer`: the hook's stdin in, its JSON answer out. */
export async function runSessionTrailerHook(): Promise<void> {
  const [{ readAuthConfig, defaultConfigDir }, { readLocalConversationMap }] = await Promise.all([
    import("./config/readAuthConfig.js"),
    import("./localConversationMap.js"),
  ]);
  let config: ReturnType<typeof readAuthConfig> = null;
  try {
    config = readAuthConfig(defaultConfigDir());
  } catch {
    // An unreadable config only costs the server lookup.
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const out = await sessionTrailerHookOutput(Buffer.concat(chunks).toString("utf-8"), {
    env: process.env,
    configEnabled: () => {
      const v = (config as Record<string, unknown> | null)?.session_trailer;
      return v !== false && !OFF.has(String(v ?? "").toLowerCase());
    },
    repoSetting,
    gitTakesTrailer,
    conversationFor: async (sessionId) => {
      const local = readLocalConversationMap()[sessionId];
      if (local) return local;
      if (!config?.auth_token || !config.convex_url) return null;
      try {
        const response = await fetch(`${config.convex_url.replace(".cloud", ".site")}/cli/session-links`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId, api_token: config.auth_token }),
          signal: AbortSignal.timeout(3000),
        });
        return ((await response.json()) as { conversation_id?: string })?.conversation_id ?? null;
      } catch {
        return null;
      }
    },
    webUrl: config?.web_url || CODECAST_BASE_URL,
    log: (line) => process.stderr.write(`${line}\n`),
  });
  if (out) process.stdout.write(`${out}\n`);
}
