// Line-level `cast blame`: a drop-in `git blame` whose author column shows the
// codecast session that wrote each line. git does the hard part locally
// (line-history tracking via `git blame --porcelain`); the server resolves the
// unique SHAs to sessions via file_changes commit rows, and uncommitted lines
// by content match against the caller's recent edits. Output mirrors git
// blame's default and porcelain formats byte-for-byte so editor integrations
// keep parsing it; porcelain mode carries the attribution as extra
// `codecast-*` header keys, which porcelain consumers ignore.

import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import open from "open";
import { cliFetchRead } from "./cliHttp.js";

const WEB_BASE = process.env.CODE_CHAT_SYNC_WEB_URL || "https://codecast.sh";

// Deep link to the session behind a blamed line. When the resolution carries
// the originating message id, anchor on it (#msg-<id>) so the conversation
// page scrolls straight to the exact edit; otherwise just open the session.
export function conversationDeepLink(ref: SessionRef): string {
  const base = `${WEB_BASE}/conversation/${ref.conversation_id}`;
  return ref.message_id ? `${base}#msg-${ref.message_id}` : base;
}

export const ZERO_SHA = "0".repeat(40);
// Mirror of the server's MIN_LINE_MATCH_LEN: shorter lines are too common to
// attribute safely, so don't spend request bytes on them.
const MIN_LINE_MATCH_LEN = 8;
const MAX_UNCOMMITTED_LINES = 400;
const MAX_WHO_LABEL = 48;
const RESOLVE_TIMEOUT_MS = 5000;

export interface BlameCommitMeta {
  author: string;
  authorTime: number;
  authorTz: string;
  summary: string;
  boundary: boolean;
}

export interface BlameLine {
  sha: string;
  finalLine: number;
  content: string;
}

export interface ParsedBlame {
  lines: BlameLine[];
  commits: Map<string, BlameCommitMeta>;
}

export interface SessionRef {
  conversation_id: string;
  title: string;
  author_name?: string;
  message_id?: string;
}

export interface BlameResolution {
  // sha → the session that COMMITTED it (hash or subject+time match).
  bySha: Map<string, SessionRef>;
  // trimmed line text → the session whose edit WROTE it (content match).
  // Preferred over bySha: in /commit-style workflows the committing session
  // is a bot organizing other sessions' work — the authoring session is the
  // one whose reasoning you want to read.
  byLine: Map<string, SessionRef>;
}

export const EMPTY_RESOLUTION: BlameResolution = {
  bySha: new Map(),
  byLine: new Map(),
};

const HEADER_RE = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/;

export function parseBlamePorcelain(output: string): ParsedBlame {
  const lines: BlameLine[] = [];
  const commits = new Map<string, BlameCommitMeta>();
  let currentSha: string | null = null;
  let currentFinalLine = 0;

  for (const raw of output.split("\n")) {
    if (raw.startsWith("\t")) {
      if (currentSha !== null) {
        lines.push({ sha: currentSha, finalLine: currentFinalLine, content: raw.slice(1) });
      }
      continue;
    }
    const header = raw.match(HEADER_RE);
    if (header) {
      currentSha = header[1];
      currentFinalLine = parseInt(header[3], 10);
      if (!commits.has(currentSha)) {
        commits.set(currentSha, {
          author: "",
          authorTime: 0,
          authorTz: "+0000",
          summary: "",
          boundary: false,
        });
      }
      continue;
    }
    if (currentSha === null) continue;
    const meta = commits.get(currentSha)!;
    const space = raw.indexOf(" ");
    const key = space === -1 ? raw : raw.slice(0, space);
    const value = space === -1 ? "" : raw.slice(space + 1);
    switch (key) {
      case "author":
        meta.author = value;
        break;
      case "author-time":
        meta.authorTime = parseInt(value, 10);
        break;
      case "author-tz":
        meta.authorTz = value;
        break;
      case "summary":
        meta.summary = value;
        break;
      case "boundary":
        meta.boundary = true;
        break;
    }
  }
  return { lines, commits };
}

// git renders the timestamp in the commit author's own timezone.
export function formatGitDate(epochSeconds: number, tz: string): string {
  const m = tz.match(/^([+-])(\d{2})(\d{2})$/);
  const offsetMinutes = m ? (m[1] === "-" ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10)) : 0;
  const d = new Date((epochSeconds + offsetMinutes * 60) * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${tz}`
  );
}

// The author-column replacement: session short id + the human who ran it +
// title — e.g. `jx74qbm Samvit Agent prompt guardrails`. Parens would break
// editor regexes that scan for the `(...)` group, so strip them. First name
// only keeps the column tight while still showing who owns the work.
export function sessionLabel(ref: SessionRef): string {
  const clean = (s: string) => s.replace(/[()\r\n\t]/g, " ").replace(/\s+/g, " ").trim();
  const title = clean(ref.title);
  const first = ref.author_name ? clean(ref.author_name).split(" ")[0] : "";
  const label = first
    ? `${ref.conversation_id.slice(0, 7)} ${first} ${title}`
    : `${ref.conversation_id.slice(0, 7)} ${title}`;
  return label.length > MAX_WHO_LABEL ? label.slice(0, MAX_WHO_LABEL - 2) + ".." : label;
}

function whoFor(line: BlameLine, meta: BlameCommitMeta, resolution: BlameResolution): string {
  // Authoring session (content match) beats committing session (sha match)
  // beats the git author.
  const ref = resolution.byLine.get(line.content.trim()) ?? resolution.bySha.get(line.sha);
  return ref ? sessionLabel(ref) : meta.author;
}

/**
 * Render git blame's default format: `<sha> (<who> <date> <lineno>) <content>`.
 * Layout rules measured from git itself: sha displays at displayLen chars
 * (boundary commits show `^` plus a one-shorter sha so columns stay aligned;
 * uncommitted lines show all zeros), the who column pads to the longest who
 * string, and line numbers right-align to the widest number.
 */
export function formatDefaultBlame(
  parsed: ParsedBlame,
  resolution: BlameResolution,
  displayLen: number,
): string {
  const rows = parsed.lines.map((line) => {
    const meta = parsed.commits.get(line.sha)!;
    const sha =
      line.sha === ZERO_SHA
        ? "0".repeat(displayLen)
        : meta.boundary
          ? "^" + line.sha.slice(0, displayLen - 1)
          : line.sha.slice(0, displayLen);
    return {
      sha,
      who: whoFor(line, meta, resolution),
      date: formatGitDate(meta.authorTime, meta.authorTz),
      lineNo: line.finalLine,
      content: line.content,
    };
  });

  const whoWidth = Math.max(0, ...rows.map((r) => r.who.length));
  const numWidth = Math.max(1, ...rows.map((r) => String(r.lineNo).length));
  return rows
    .map(
      (r) =>
        `${r.sha} (${r.who.padEnd(whoWidth)} ${r.date} ${String(r.lineNo).padStart(numWidth)}) ${r.content}`,
    )
    .join("\n");
}

/**
 * Re-emit git's porcelain output with `codecast-*` keys injected after each
 * `summary` line (i.e. in every block that carries full commit headers: once
 * per commit in --porcelain, every line in --line-porcelain). For the
 * all-zeros uncommitted pseudo-commit, attribution is per-line, so look ahead
 * to the block's content line and use its match.
 */
export function augmentPorcelain(raw: string, resolution: BlameResolution): string {
  const lines = raw.split("\n");
  const out: string[] = [];
  let currentSha: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    const header = line.match(HEADER_RE);
    if (header) {
      currentSha = header[1];
      continue;
    }
    if (!line.startsWith("summary ") || currentSha === null) continue;

    let ref: SessionRef | undefined;
    if (currentSha === ZERO_SHA) {
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].startsWith("\t")) {
          ref = resolution.byLine.get(lines[j].slice(1).trim());
          break;
        }
        if (HEADER_RE.test(lines[j])) break;
      }
    } else {
      ref = resolution.bySha.get(currentSha);
    }
    if (!ref) continue;

    out.push(`codecast-session ${ref.conversation_id.slice(0, 7)}`);
    out.push(`codecast-conversation ${ref.conversation_id}`);
    out.push(`codecast-title ${ref.title.replace(/[\r\n]/g, " ")}`);
    out.push(`codecast-url https://codecast.sh/conversation/${ref.conversation_id}`);
    if (ref.message_id) out.push(`codecast-message ${ref.message_id}`);
  }
  return out.join("\n");
}

export interface ContentLine {
  t: string;
  // Deadline (ms): newest edit timestamp allowed to claim the line. Committed
  // lines pass commit-time + slack so the authoring edit (which precedes its
  // commit) matches but later rewrites can't steal the line.
  d?: number;
}

// Only commits this recent get content-matched to an authoring session — the
// server matches against a window of the file's newest edit rows, so older
// lines can't match anyway and would just bloat the request.
const CONTENT_MATCH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const COMMIT_DEADLINE_SLACK_MS = 10 * 60 * 1000;

export function contentLinesToMatch(parsed: ParsedBlame, nowMs: number): ContentLine[] {
  const byText = new Map<string, ContentLine>();
  for (const line of parsed.lines) {
    const trimmed = line.content.trim();
    if (trimmed.length < MIN_LINE_MATCH_LEN) continue;
    let deadline: number | undefined;
    if (line.sha !== ZERO_SHA) {
      const meta = parsed.commits.get(line.sha);
      if (!meta?.authorTime) continue;
      const authorMs = meta.authorTime * 1000;
      if (nowMs - authorMs > CONTENT_MATCH_MAX_AGE_MS) continue;
      deadline = authorMs + COMMIT_DEADLINE_SLACK_MS;
    }
    // Duplicate text across lines: keep the most permissive deadline.
    const existing = byText.get(trimmed);
    if (!existing || (existing.d !== undefined && (deadline === undefined || deadline > existing.d))) {
      byText.set(trimmed, { t: trimmed, d: deadline });
    }
    if (byText.size >= MAX_UNCOMMITTED_LINES) break;
  }
  return [...byText.values()];
}

function execGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve({ stdout, stderr });
    });
  });
}

export interface CommitDescriptor {
  sha: string;
  // Blame porcelain's summary + author-time (ms): lets the server fall back to
  // subject/timestamp matching when the session's commit output carried no
  // parseable hash (compound commands, -q, custom helpers).
  summary?: string;
  author_time?: number;
}

async function resolveSessions(
  siteUrl: string,
  apiToken: string,
  commits: CommitDescriptor[],
  filePath: string,
  contentLines: ContentLine[],
): Promise<BlameResolution> {
  if (commits.length === 0 && contentLines.length === 0) return EMPTY_RESOLUTION;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);
  try {
    const response = await cliFetchRead(`${siteUrl}/cli/blame/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_token: apiToken,
        commits,
        file_path: filePath,
        content_lines: contentLines,
      }),
      signal: controller.signal,
    });
    const result = (await response.json()) as {
      error?: string;
      resolved?: Record<string, SessionRef>;
      // Array of {line, ...} pairs — line text can't be a Convex field name.
      line_matches?: Array<SessionRef & { line: string }>;
    };
    if (result.error) throw new Error(result.error);
    return {
      bySha: new Map(Object.entries(result.resolved ?? {})),
      byLine: new Map((result.line_matches ?? []).map((u) => [u.line, u])),
    };
  } finally {
    clearTimeout(timer);
  }
}

// Turn parsed blame porcelain into a session resolution. Builds the commit
// descriptors (sha + summary + author-time, for the 3-tier server match) and
// the content-line list (for authoring-session attribution), then calls the
// resolve endpoint. Degrades to no attribution on any failure — a blame must
// stay a faithful git blame even when the network blinks.
async function resolveFromParsed(
  parsed: ParsedBlame,
  absFilePath: string,
  config: { auth_token?: string; convex_url?: string },
): Promise<BlameResolution> {
  if (!config.auth_token || !config.convex_url) return EMPTY_RESOLUTION;
  const commits: CommitDescriptor[] = [...new Set(parsed.lines.map((l) => l.sha))]
    .filter((s) => s !== ZERO_SHA)
    .map((sha) => {
      const meta = parsed.commits.get(sha);
      return {
        sha,
        summary: meta?.summary || undefined,
        author_time: meta?.authorTime ? meta.authorTime * 1000 : undefined,
      };
    });
  const contentLines = contentLinesToMatch(parsed, Date.now());
  const siteUrl = config.convex_url.replace(".cloud", ".site");
  try {
    return await resolveSessions(siteUrl, config.auth_token, commits, absFilePath, contentLines);
  } catch (error) {
    console.error(
      `cast blame: session resolution unavailable (${error instanceof Error ? error.message : error})`,
    );
    return EMPTY_RESOLUTION;
  }
}

export interface BlameCommandOptions {
  ranges: string[];
  rev?: string;
  ignoreWhitespace?: boolean;
  porcelain?: boolean;
  linePorcelain?: boolean;
  abbrev?: number;
  // commander maps --no-sessions onto `sessions: false`
  sessions?: boolean;
}

export async function runBlameCommand(
  filePath: string,
  options: BlameCommandOptions,
  config: { auth_token?: string; convex_url?: string },
): Promise<void> {
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const cwd = path.dirname(absPath);

  const porcelainFlag = options.linePorcelain ? "--line-porcelain" : "--porcelain";
  const gitArgs = [
    "blame",
    porcelainFlag,
    ...options.ranges.flatMap((r) => ["-L", r]),
    ...(options.ignoreWhitespace ? ["-w"] : []),
    ...(options.rev ? [options.rev] : []),
    "--",
    absPath,
  ];

  const { stdout: rawPorcelain } = await execGit(gitArgs, cwd);
  const parsed = parseBlamePorcelain(rawPorcelain);

  const wantSessions = options.sessions !== false && config.auth_token && config.convex_url;
  const resolution = wantSessions
    ? await resolveFromParsed(parsed, absPath, config)
    : EMPTY_RESOLUTION;

  if (options.porcelain || options.linePorcelain) {
    process.stdout.write(augmentPorcelain(rawPorcelain, resolution));
    return;
  }

  let displayLen = 8;
  if (options.abbrev) {
    displayLen = options.abbrev + 1;
  } else {
    // git blame's default sha column is the repo's auto-scaled abbrev + 1
    // (one reserved for the boundary caret).
    try {
      const { stdout } = await execGit(["rev-parse", "--short", "HEAD"], cwd);
      displayLen = stdout.trim().length + 1;
    } catch {
      // keep the fallback
    }
  }

  if (parsed.lines.length > 0) {
    console.log(formatDefaultBlame(parsed, resolution, displayLen));
  }
}

// ── vim-fugitive integration ────────────────────────────────────────────────
// Fugitive renders its blame window from the text of plain `git blame
// --show-number` and parses each line only by the leading SHA and the
// `( … lineno)` columns (autoload/fugitive.vim s:BlameCommitFileLnum) — never
// the author text. So we keep every column byte-identical and swap ONLY the
// author for a session label. The git executable fugitive shells out to is
// g:fugitive_git_executable; pointing it at the shim (scripts/fugitive-git in
// this package, installed to ~/.codecast) routes blame through here.

// Unambiguous boundary between the author field and the rest of a standard
// blame line — git's fixed `YYYY-MM-DD HH:MM:SS ±ZZZZ` stamp, always present
// before the code and never inside the author.
const BLAME_DATE_RE = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [-+]\d{4}/;

// Rewrite standard `git blame` output, replacing the author column with the
// session label and re-padding it, while leaving sha / line-number / code
// columns exactly as git produced them. `standardOut` and `parsed.lines`
// describe the SAME lines in the same order (same blame invocation), so we zip
// by index to recover each line's full sha + code text for lookup.
export function rewriteFugitiveBlame(
  standardOut: string,
  parsed: ParsedBlame,
  resolution: BlameResolution,
): string {
  const hadTrailingNewline = standardOut.endsWith("\n");
  const rawLines = standardOut.split("\n");
  if (hadTrailingNewline) rawLines.pop();
  // If the two views disagree on line count, a zip would mis-attribute — hand
  // back real git's bytes untouched rather than risk it.
  if (rawLines.length !== parsed.lines.length) return standardOut;

  type Row = { prefix: string; who: string; dateOnward: string } | { raw: string };
  const rows: Row[] = rawLines.map((line, i) => {
    const date = line.match(BLAME_DATE_RE);
    const open = line.indexOf("(");
    if (!date || date.index === undefined || open === -1 || open > date.index) {
      return { raw: line };
    }
    const originalAuthor = line.slice(open + 1, date.index).replace(/\s+$/, "");
    const ref =
      resolution.byLine.get(parsed.lines[i].content.trim()) ??
      resolution.bySha.get(parsed.lines[i].sha);
    return {
      prefix: line.slice(0, open + 1),
      who: ref ? sessionLabel(ref) : originalAuthor,
      dateOnward: line.slice(date.index),
    };
  });

  const width = Math.max(0, ...rows.map((r) => ("who" in r ? r.who.length : 0)));
  const out = rows
    .map((r) => ("raw" in r ? r.raw : `${r.prefix}${r.who.padEnd(width)} ${r.dateOnward}`))
    .join("\n");
  return hadTrailingNewline ? out + "\n" : out;
}

function buildPorcelainArgv(argv: string[], blameIdx: number): string[] {
  const copy = [...argv];
  copy.splice(blameIdx + 1, 0, "--porcelain");
  return copy;
}

function fugitiveFilePath(argv: string[]): string | null {
  const ddIdx = argv.lastIndexOf("--");
  const file = ddIdx !== -1 ? argv[ddIdx + 1] : undefined;
  if (!file) return null;
  return path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
}

function execGitRaw(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: process.cwd(), maxBuffer: 256 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

function resolveOnPath(cmd: string, fallback: string): string {
  try {
    return execFileSync("command", ["-v", cmd], { shell: "/bin/bash" }).toString().trim() || fallback;
  } catch {
    return fallback;
  }
}

// Write the fugitive git shim to ~/.codecast/fugitive-git with the real git and
// cast paths baked in (fugitive's job env may not share your shell PATH), then
// tell the user the one line to add to their vimrc.
export function installFugitiveShim(): void {
  const realGit = resolveOnPath("git", "/usr/bin/git");
  const castBin = resolveOnPath("cast", process.argv[1] ?? "cast");
  const dir = path.join(os.homedir(), ".codecast");
  const shimPath = path.join(dir, "fugitive-git");
  const shim = `#!/usr/bin/env bash
# vim-fugitive git shim for \`cast blame\` — generated by \`cast blame --install-fugitive\`.
# Passes every git call through to real git, except \`blame\`, which cast rewrites
# to show codecast session names in the author column (falling back to real git
# on any failure). Set in your vimrc:
#     let g:fugitive_git_executable = expand('~/.codecast/fugitive-git')
CAST_BIN="${castBin}"
REAL_GIT="${realGit}"

sub=""
skip=0
for a in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$a" in
    -c|-C|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix) skip=1 ;;
    -*) ;;
    *) sub="$a"; break ;;
  esac
done

if [ "$sub" = "blame" ]; then
  exec "$CAST_BIN" __fugitive_blame@@ "$@"
fi
exec "$REAL_GIT" "$@"
`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(shimPath, shim, { mode: 0o755 });

  // Vim integration: point fugitive at the shim AND map <CR> in a blame window
  // to open the codecast conversation for the line under the cursor (falling
  // back to fugitive's own commit view when the line has no session).
  const vimPath = path.join(dir, "fugitive.vim");
  const vimIntegration = `" codecast × vim-fugitive — generated by \`cast blame --install-fugitive\`.
" Route fugitive's git through the shim so :Git blame shows session names, and
" make <CR> on a blamed line open the codecast conversation that wrote it.
let g:fugitive_git_executable = expand('~/.codecast/fugitive-git')

" Fugitive's own <CR> action (open the commit) for lines we can't attribute.
function! s:CastBlameCommit() abort
  let l:sha = matchstr(getline('.'), '^\\^\\=\\zs\\x\\+')
  if !empty(l:sha) && l:sha !~# '^0\\+$'
    execute 'Gedit' l:sha
  endif
endfunction

function! s:CastBlameOpen() abort
  let l:line = getline('.')
  " Final line number = trailing digits of the annotation (everything up to the
  " first ')'), robust to spacing and to ')' appearing later in the code.
  let l:anno = matchstr(l:line, '^.\\{-}\\ze)')
  let l:lnum = matchstr(l:anno, '\\d\\+$')
  let l:st = fugitive#Result(bufnr(''))
  let l:gitdir = get(l:st, 'git_dir', '')
  let l:bf = get(l:st, 'blame_file', '')
  if empty(l:lnum) || empty(l:gitdir) || empty(l:bf)
    return s:CastBlameCommit()
  endif
  let l:file = fnamemodify(l:gitdir, ':h') . '/' . l:bf
  let l:url = trim(system('${castBin} __blame_conversation ' . shellescape(l:file) . ' ' . l:lnum))
  if v:shell_error == 0 && l:url =~# '^https\\?://'
    redraw | echo 'codecast: ' . l:url
  else
    " No session for this line — fall back to fugitive's commit view.
    call s:CastBlameCommit()
  endif
endfunction

augroup CastBlameMaps
  autocmd!
  autocmd FileType fugitiveblame nnoremap <buffer> <silent> <CR> :call <SID>CastBlameOpen()<CR>
augroup END

" :Gslog — the session-log (:Gclog equivalent): list the sessions that shaped a
" file, newest first, in the quickfix list. <CR> on an entry opens that
" conversation. Defaults to the current file; pass a path to log another.
function! s:CastSessionLog(file) abort
  let l:file = empty(a:file) ? expand('%:p') : fnamemodify(a:file, ':p')
  let l:out = systemlist('${castBin} blame --log --quickfix ' . shellescape(l:file))
  if v:shell_error != 0 || empty(l:out)
    echo 'cast: no codecast sessions resolved for this file'
    return
  endif
  let l:items = []
  for l:line in l:out
    let l:m = matchlist(l:line, '^\\(.\\{-}\\):\\(\\d\\+\\): \\(.*\\)$')
    if !empty(l:m)
      call add(l:items, {'filename': l:m[1], 'lnum': str2nr(l:m[2]), 'text': l:m[3]})
    endif
  endfor
  call setqflist([], ' ', {'title': 'cast session log', 'items': l:items})
  copen
  nnoremap <buffer> <silent> <CR> :call <SID>CastSessionLogOpen()<CR>
endfunction

" Open the conversation for the quickfix entry under the cursor (reusing the
" single-line resolve path); fall back to jumping to the file line.
function! s:CastSessionLogOpen() abort
  let l:idx = line('.') - 1
  let l:items = getqflist()
  if l:idx < 0 || l:idx >= len(l:items) | return | endif
  let l:it = l:items[l:idx]
  let l:file = bufname(l:it.bufnr)
  let l:url = trim(system('${castBin} __blame_conversation ' . shellescape(l:file) . ' ' . l:it.lnum))
  if v:shell_error == 0 && l:url =~# '^https\\?://'
    redraw | echo 'codecast: ' . l:url
  else
    execute 'cc' (l:idx + 1)
  endif
endfunction

command! -nargs=? -complete=file Gslog call s:CastSessionLog(<q-args>)
`;
  fs.writeFileSync(vimPath, vimIntegration);

  console.log(`Installed fugitive shim: ${shimPath}`);
  console.log(`  git  → ${realGit}`);
  console.log(`  cast → ${castBin}`);
  console.log(`Installed vim integration: ${vimPath}`);
  console.log(`\nAdd this to your vimrc (or init.vim), then restart vim:\n`);
  console.log(`    source ~/.codecast/fugitive.vim\n`);
  console.log(`Then:`);
  console.log(`  :Git blame  — author column shows the codecast session (<CR> opens it)`);
  console.log(`  :Gslog      — session log for the file, newest first (<CR> opens the conversation)`);
}

/**
 * Filter mode invoked by the fugitive git shim. `argv` is the exact argument
 * vector fugitive passed to git (no leading "git"). We run real git verbatim
 * for the bytes fugitive expects, then — only for a human display blame —
 * overlay session labels onto the author column.
 */
export async function runFugitiveBlame(
  argv: string[],
  config: { auth_token?: string; convex_url?: string },
): Promise<void> {
  const blameIdx = argv.indexOf("blame");
  // Fugitive also runs blame for navigation with -s (no author column) or
  // machine formats — nothing to rewrite there, pass straight through.
  const navOnly = argv.some(
    (a) => a === "-s" || a === "--porcelain" || a === "--line-porcelain" || a === "--incremental",
  );
  if (blameIdx === -1 || navOnly) {
    process.stdout.write(await execGitRaw(argv));
    return;
  }

  // Real annotation first; everything after is best-effort and falls back to
  // these exact bytes so fugitive's blame can never break on our account.
  let standardOut: string;
  try {
    standardOut = await execGitRaw(argv);
  } catch (err: any) {
    // Real git failed (bad range, unknown rev): surface its own error.
    if (err?.stderr) process.stderr.write(err.stderr);
    process.exitCode = typeof err?.code === "number" ? err.code : 1;
    return;
  }

  try {
    const porcelain = await execGitRaw(buildPorcelainArgv(argv, blameIdx));
    const parsed = parseBlamePorcelain(porcelain);
    const filePath = fugitiveFilePath(argv);
    const resolution = filePath
      ? await resolveFromParsed(parsed, filePath, config)
      : EMPTY_RESOLUTION;
    process.stdout.write(rewriteFugitiveBlame(standardOut, parsed, resolution));
  } catch {
    process.stdout.write(standardOut);
  }
}

/**
 * Resolve a single blamed line to its codecast conversation and open it. Used
 * by the fugitive <CR> mapping: blame just that one line (fast), resolve it,
 * print the conversation deep-link and open it in the browser. Exit non-zero
 * when the line has no session so the editor can fall back to its own action.
 */
export async function runBlameConversation(
  file: string,
  lnum: number,
  config: { auth_token?: string; convex_url?: string },
): Promise<void> {
  if (!file || !Number.isFinite(lnum) || lnum < 1) {
    process.exitCode = 1;
    return;
  }
  const absPath = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
  const cwd = path.dirname(absPath);

  let porcelain: string;
  try {
    porcelain = (
      await execGit(["blame", "-L", `${lnum},${lnum}`, "--porcelain", "--", absPath], cwd)
    ).stdout;
  } catch {
    process.exitCode = 1;
    return;
  }

  const parsed = parseBlamePorcelain(porcelain);
  if (parsed.lines.length === 0) {
    process.exitCode = 1;
    return;
  }

  const resolution = await resolveFromParsed(parsed, absPath, config);
  const line = parsed.lines[0];
  const ref = resolution.byLine.get(line.content.trim()) ?? resolution.bySha.get(line.sha);
  if (!ref) {
    process.exitCode = 1;
    return;
  }

  const url = conversationDeepLink(ref);
  console.log(url);
  try {
    await open(url);
  } catch {
    // Headless/SSH: printing the url is enough for the editor to surface it.
  }
}

// ── Session log (`:Gclog` equivalent) ───────────────────────────────────────
// Group a file's blame by the session that wrote each line: which sessions
// shaped this file, how much, and when. The session equivalent of `git log
// --follow <file>` / fugitive's :Gclog.

export interface SessionLogEntry {
  conversationId: string;
  shortId: string;
  label: string;
  authorName?: string;
  title: string;
  lineCount: number;
  firstLine: number; // smallest line number it owns — where to jump
  newestTime: number; // most recent author-time across its lines (sort key)
  oldestTime: number;
  messageId?: string;
}

// Fold parsed blame + resolution into one entry per session, newest-touch
// first. Pure for testability. A line's session is its authoring session
// (content match) if known, else its committing session (sha match).
export function groupBlameBySession(
  parsed: ParsedBlame,
  resolution: BlameResolution,
): { entries: SessionLogEntry[]; attributed: number; total: number } {
  const byConv = new Map<string, SessionLogEntry>();
  let attributed = 0;

  for (const line of parsed.lines) {
    const ref = resolution.byLine.get(line.content.trim()) ?? resolution.bySha.get(line.sha);
    if (!ref) continue;
    attributed++;
    const meta = parsed.commits.get(line.sha);
    const t = meta?.authorTime ? meta.authorTime * 1000 : 0;
    const existing = byConv.get(ref.conversation_id);
    if (!existing) {
      byConv.set(ref.conversation_id, {
        conversationId: ref.conversation_id,
        shortId: ref.conversation_id.slice(0, 7),
        label: sessionLabel(ref),
        authorName: ref.author_name,
        title: ref.title,
        lineCount: 1,
        firstLine: line.finalLine,
        newestTime: t,
        oldestTime: t,
        messageId: ref.message_id,
      });
    } else {
      existing.lineCount++;
      existing.firstLine = Math.min(existing.firstLine, line.finalLine);
      existing.newestTime = Math.max(existing.newestTime, t);
      existing.oldestTime = existing.oldestTime === 0 ? t : Math.min(existing.oldestTime, t);
    }
  }

  const entries = [...byConv.values()].sort(
    (a, b) => b.newestTime - a.newestTime || b.lineCount - a.lineCount,
  );
  return { entries, attributed, total: parsed.lines.length };
}

function ymd(ms: number): string {
  if (!ms) return "????-??-??";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * `cast blame --log <file>`: list the sessions that shaped a file, newest
 * first. Human table by default; `--quickfix` emits `<file>:<line>: <msg>`
 * lines for the vim :Gslog quickfix integration (each entry's line lets <CR>
 * resolve+open the conversation via the existing single-line path).
 */
export async function runBlameLog(
  file: string,
  options: { quickfix?: boolean; rev?: string },
  config: { auth_token?: string; convex_url?: string },
): Promise<void> {
  const absPath = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
  const cwd = path.dirname(absPath);

  let porcelain: string;
  try {
    porcelain = (
      await execGit(["blame", "--porcelain", ...(options.rev ? [options.rev] : []), "--", absPath], cwd)
    ).stdout;
  } catch (err: any) {
    process.stderr.write((err?.message ?? String(err)) + "\n");
    process.exitCode = 1;
    return;
  }

  const parsed = parseBlamePorcelain(porcelain);
  const resolution = await resolveFromParsed(parsed, absPath, config);
  const { entries, attributed, total } = groupBlameBySession(parsed, resolution);

  if (options.quickfix) {
    // Parsed by vim with errorformat `%f:%l: %m`. The path is what the user
    // passed (relative is fine — vim resolves against cwd).
    for (const e of entries) {
      process.stdout.write(
        `${file}:${e.firstLine}: ${e.label}  ·  ${e.lineCount} lines  ·  ${ymd(e.newestTime)}\n`,
      );
    }
    return;
  }

  const rel = file.replace(process.env.HOME || "", "~");
  console.log(`Sessions that shaped ${rel}  (${attributed}/${total} lines attributed)\n`);
  if (entries.length === 0) {
    console.log("  (no codecast sessions resolved for this file)");
    return;
  }
  const wAuthor = Math.max(6, ...entries.map((e) => (e.authorName?.split(" ")[0] ?? "").length));
  for (const e of entries) {
    const author = (e.authorName?.split(" ")[0] ?? "").padEnd(wAuthor);
    const title = e.title.length > 44 ? e.title.slice(0, 42) + ".." : e.title;
    const range = ymd(e.oldestTime) === ymd(e.newestTime) ? ymd(e.newestTime) : `${ymd(e.oldestTime)}→${ymd(e.newestTime)}`;
    console.log(
      `  ${e.shortId}  ${author}  ${title.padEnd(44)}  ${String(e.lineCount).padStart(4)} lines  ${range}`,
    );
  }
  console.log(
    `\n  Open: https://codecast.sh/conversation/${entries[0].conversationId}  (newest; cast read <id>)`,
  );
}
