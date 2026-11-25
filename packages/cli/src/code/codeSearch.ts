// Project search for the editor: ripgrep over a vault, streamed as
// CodeSearchEvent lines while rg is still walking, so the first files paint
// in milliseconds on a large repo and closing the panel kills the walk.
//
// Scope matches the file tree's. ripgrep honors .gitignore itself; the
// always-ignored names go in as override globs (they hold even when the
// person asks for ignored files), and a repo vault's own rules (build output,
// tool dot-directories except the prose ones) go in as an ignore file, since
// gitignore syntax is the only rg input that can say "every dot-directory but
// .github" without turning the search into a whitelist. Every path rg reports
// is checked against vaultScope's predicate before it is sent, so search
// never shows a file the tree hides.
//
// No ripgrep: git grep in a work tree, else a walk of the scan's own listing.

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Readable } from "node:stream";
import {
  CODE_SEARCH_DEFAULT_MAX,
  CODE_SEARCH_MAX_LINE_CHARS,
  VAULT_IGNORED_SEGMENTS,
  VAULT_REPO_ALLOWED_DOT_DIRS,
  VAULT_REPO_IGNORED_SEGMENTS,
  isVaultIgnoredPath,
  type CodeSearchEvent,
  type CodeSearchLine,
  type CodeSearchRange,
} from "@codecast/shared/contracts";
import { spawn, TOOL_PATH, whichBin, type ChildProcess } from "../proc.js";
import { writeVaultFile } from "../vault/vaultFs.js";
import { isRepoVaultRoot, isVaultPathIgnored, normalizeVaultPath, scanVault } from "../vault/vaultScope.js";
import { locateRepo } from "./codeGit.js";

/** The daemon's own ceiling on `max`, whatever a client asks for. */
const MAX_MATCHES_CEILING = 50_000;
/** A search still walking after this long is cut short and reported truncated. */
const SEARCH_TIMEOUT_MS = 60_000;
/** Files larger than this are minified bundles and data dumps, not code. */
const MAX_FILE_BYTES = 16 * 1024 * 1024;
/** The fallbacks run the query as a JS RegExp on this thread, so they read
 *  less of each file and line than rg does. */
const WALK_MAX_FILE_BYTES = 2 * 1024 * 1024;
const REGEX_SCAN_CHARS = 64 * 1024;
/** Lines the walk matches before it lets the loop run. */
const WALK_YIELD_LINES = 4_000;
const WALK_CONCURRENCY = 8;
/** How far before the first match a trimmed long line starts. */
const LINE_LEAD_CHARS = 60;

export interface CodeSearchOptions {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  word: boolean;
  include: string[];
  exclude: string[];
  max: number;
  includeIgnored: boolean;
}

/** The query string of GET /code/search, or null when there is nothing to search for. */
export function parseSearchParams(params: URLSearchParams): CodeSearchOptions | null {
  const query = params.get("q") ?? "";
  if (!query) return null;
  const globs = (name: string) => splitGlobs(params.get(name) ?? "");
  const max = Number(params.get("max"));
  return {
    query,
    regex: params.get("regex") === "1",
    caseSensitive: params.get("case") === "1",
    word: params.get("word") === "1",
    include: globs("include"),
    exclude: globs("exclude"),
    max: Number.isFinite(max) && max > 0 ? Math.min(Math.floor(max), MAX_MATCHES_CEILING) : CODE_SEARCH_DEFAULT_MAX,
    includeIgnored: params.get("ignored") === "1",
  };
}

/** A comma-separated glob list, keeping the commas inside `{ts,tsx}`. */
export function splitGlobs(list: string): string[] {
  return splitTopLevel(list)
    .map((g) => g.trim())
    .filter(Boolean);
}

/** `s` split at the commas outside any braces. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "{") depth++;
    else if (c === "}") depth = Math.max(0, depth - 1);
    else if (c === "," && depth === 0) {
      out.push(s.slice(from, i));
      from = i + 1;
    }
  }
  out.push(s.slice(from));
  return out;
}

const MAX_BRACE_EXPANSIONS = 64;

/**
 * `src/*.{ts,tsx}` as `src/*.ts` and `src/*.tsx`, nested braces included, for
 * git's wildmatch, which has no alternation. An unclosed brace stays literal.
 */
export function expandBraces(glob: string): string[] {
  let depth = 0;
  let open = -1;
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] === "{") {
      if (depth++ === 0) open = i;
    } else if (glob[i] === "}" && depth > 0 && --depth === 0) {
      const head = glob.slice(0, open);
      const tail = glob.slice(i + 1);
      return splitTopLevel(glob.slice(open + 1, i))
        .flatMap((alt) => expandBraces(head + alt + tail))
        .slice(0, MAX_BRACE_EXPANSIONS);
    }
  }
  return [glob];
}

/**
 * Includes the way editors read them: a bare name (`src`, `lib/code`) means
 * that folder as well as a file of that name, and a slashless glob (`*.ts`)
 * matches at any depth, which is already gitignore's rule.
 */
export function expandIncludeGlob(glob: string): string[] {
  const g = glob.replace(/^\.\//, "").replace(/\/+$/, "");
  if (/[*?[\]{}]/.test(g)) return [g];
  return g.includes("/") ? [g, `${g}/**`] : [g, `**/${g}/**`];
}

// ── Collecting ───────────────────────────────────────────────────────────────

/** Where the visible window of a line whose first match starts at `first`
 *  ends at the latest. Ranges past it never reach the wire, so engines stop
 *  collecting there. */
const windowEnd = (first: number) => Math.max(0, first - LINE_LEAD_CHARS) + CODE_SEARCH_MAX_LINE_CHARS;

/** One matched line for the wire: line endings dropped, a long line trimmed
 *  to a window that keeps its first match in view. */
export function searchLine(line: number, raw: string, ranges: CodeSearchRange[]): CodeSearchLine {
  const text = raw.replace(/\r?\n$/, "");
  if (text.length <= CODE_SEARCH_MAX_LINE_CHARS) return { line, text, ranges };
  // Same start windowEnd assumes, pulled back when the first match sits near the end.
  const start = Math.max(0, Math.min((ranges[0]?.start ?? 0) - LINE_LEAD_CHARS, text.length - CODE_SEARCH_MAX_LINE_CHARS));
  const end = start + CODE_SEARCH_MAX_LINE_CHARS;
  return {
    line,
    text: text.slice(start, end),
    offset: start,
    ranges: ranges
      .filter((r) => r.end > start && r.start < end)
      .map((r) => ({ start: Math.max(r.start, start) - start, end: Math.min(r.end, end) - start })),
  };
}

/** Counts matches across engines and stops the search at the cap. */
class Collector {
  files = 0;
  matches = 0;
  truncated = false;
  pending = 0;

  constructor(
    private readonly max: number,
    private readonly emit: (event: CodeSearchEvent) => void,
  ) {}

  /** Send one file's lines, cut to what the cap leaves. */
  file(rel: string, lines: CodeSearchLine[]): void {
    if (this.truncated || lines.length === 0) return;
    const kept: CodeSearchLine[] = [];
    for (const line of lines) {
      const count = Math.max(1, line.ranges.length);
      if (this.matches + count > this.max) {
        this.truncated = true;
        break;
      }
      this.matches += count;
      kept.push(line);
    }
    if (kept.length === 0) return;
    this.files += 1;
    this.emit({ type: "file", path: rel, lines: kept });
  }

  /** Whether the file being built has already passed the cap. */
  get over(): boolean {
    return this.matches + this.pending > this.max;
  }
}

/**
 * rg's byte-offset submatches as UTF-16 ranges, in one pass over the line and
 * only as far as its visible window: a minified line is megabytes long and can
 * hold tens of thousands of matches. A malformed byte counts as one unit, as
 * the decoder's U+FFFD does.
 */
export function utf16Ranges(buf: Buffer, spans: Array<{ start: number; end: number }>): CodeSearchRange[] {
  const ranges: CodeSearchRange[] = [];
  let byte = 0;
  let unit = 0;
  const to = (target: number) => {
    while (byte < target && byte < buf.length) {
      const b = buf[byte];
      const width = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
      byte += width;
      unit += width === 4 ? 2 : 1;
    }
    return unit;
  };
  let stop = Infinity;
  for (const span of spans) {
    const start = to(span.start);
    if (start >= stop) break;
    ranges.push({ start, end: to(span.end) });
    if (ranges.length === 1) stop = windowEnd(start);
  }
  return ranges;
}

/** The ranges `matcher` finds in a line's visible window, for engines that
 *  report only lines. The first match is looked for in the line's first
 *  REGEX_SCAN_CHARS, since the regex runs on the daemon's thread. */
function rangesIn(text: string, matcher: RegExp): CodeSearchRange[] {
  const ranges: CodeSearchRange[] = [];
  const scan = text.slice(0, REGEX_SCAN_CHARS);
  let stop = Infinity;
  matcher.lastIndex = 0;
  for (let m = matcher.exec(scan); m && m.index < stop; m = matcher.exec(scan)) {
    if (m[0].length === 0) {
      matcher.lastIndex += 1;
      continue;
    }
    ranges.push({ start: m.index, end: m.index + m[0].length });
    if (ranges.length === 1) stop = windowEnd(m.index);
  }
  return ranges;
}

/** The query as a JS RegExp, the way rg reads it. Throws on bad regex syntax. */
export function compileMatcher(opts: Pick<CodeSearchOptions, "query" | "regex" | "caseSensitive" | "word">): RegExp {
  const source = opts.regex ? opts.query : opts.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(opts.word ? `\\b(?:${source})\\b` : source, opts.caseSensitive ? "g" : "gi");
}

async function* readLines(stream: Readable): AsyncGenerator<string> {
  stream.setEncoding("utf8");
  let rest = "";
  for await (const chunk of stream as AsyncIterable<string>) {
    // Only the new chunk can hold a newline: a megabyte line arrives in dozens
    // of chunks, and rescanning what came before would be quadratic.
    let nl = chunk.indexOf("\n");
    if (nl < 0) {
      rest += chunk;
      continue;
    }
    yield rest + chunk.slice(0, nl);
    let from = nl + 1;
    for (nl = chunk.indexOf("\n", from); nl >= 0; nl = chunk.indexOf("\n", from)) {
      yield chunk.slice(from, nl);
      from = nl + 1;
    }
    rest = chunk.slice(from);
  }
  if (rest) yield rest;
}

// ── Engines ─────────────────────────────────────────────────────────────────

interface Run {
  root: string;
  opts: CodeSearchOptions;
  collector: Collector;
  signal: AbortSignal;
  inScope: (rel: string) => boolean;
  /** Holds the repo scope's ignore file. */
  configDir: string;
}

/** Run a child for one engine: killed on abort, on the cap and on the
 *  timeout; resolves with its exit code and the tail of its stderr. */
async function streamChild(
  child: ChildProcess,
  run: Run,
  onLine: (line: string) => void,
): Promise<{ code: number | null; stderr: string }> {
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (d: string) => {
    stderr = (stderr + d).slice(-2000);
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once("close", (code) => resolve(code));
    child.once("error", () => resolve(-1));
  });
  const kill = () => child.kill("SIGKILL");
  run.signal.addEventListener("abort", kill, { once: true });
  try {
    for await (const line of readLines(child.stdout!)) {
      if (run.signal.aborted || run.collector.truncated) break;
      onLine(line);
      if (run.collector.truncated) break;
    }
  } finally {
    if (child.exitCode === null) kill();
    run.signal.removeEventListener("abort", kill);
  }
  return { code: await exited, stderr };
}

type RgText = { text?: string; bytes?: string };
const rgText = (t: RgText | undefined): Buffer =>
  t?.text !== undefined ? Buffer.from(t.text, "utf8") : Buffer.from(t?.bytes ?? "", "base64");

const REPO_IGNORE_RULES = [...VAULT_REPO_IGNORED_SEGMENTS, ".*", ...VAULT_REPO_ALLOWED_DOT_DIRS.map((d) => `!${d}`), ""].join("\n");
const writtenIgnoreFiles = new Set<string>();

/** The repo vault's scope rules in gitignore syntax, kept in the daemon's own
 *  config folder (a shared /tmp would let another user rewrite them), and
 *  written again if something removed it. */
async function repoIgnoreFile(configDir: string): Promise<string> {
  const file = path.join(configDir, "editor", "search.ignore");
  if (writtenIgnoreFiles.has(file) && (await fsp.stat(file).then(() => true, () => false))) return file;
  await writeVaultFile(file, REPO_IGNORE_RULES);
  writtenIgnoreFiles.add(file);
  return file;
}

export async function ripgrepArgs(root: string, opts: CodeSearchOptions, configDir: string): Promise<string[]> {
  const args = ["--json", "--no-config", "--hidden", "--no-messages", `--max-filesize=${MAX_FILE_BYTES}`];
  args.push(opts.caseSensitive ? "--case-sensitive" : "--ignore-case");
  if (!opts.regex) args.push("--fixed-strings");
  if (opts.word) args.push("--word-regexp");
  for (const seg of VAULT_IGNORED_SEGMENTS) args.push(`--glob=!${seg}`);
  if (opts.includeIgnored) args.push("--no-ignore");
  else if (isRepoVaultRoot(root)) args.push(`--ignore-file=${await repoIgnoreFile(configDir)}`);
  for (const g of opts.include) for (const e of expandIncludeGlob(g)) args.push(`--glob=${e}`);
  for (const g of opts.exclude) args.push(`--glob=!${g.replace(/^\.\//, "").replace(/\/+$/, "")}`);
  args.push(`--regexp=${opts.query}`, "./");
  return args;
}

async function searchRipgrep(rg: string, run: Run): Promise<void> {
  const child = spawn(rg, await ripgrepArgs(run.root, run.opts, run.configDir), { cwd: run.root, stdio: ["ignore", "pipe", "pipe"] });
  let current: { rel: string | null; lines: CodeSearchLine[] } | null = null;
  const flush = () => {
    if (current?.rel) run.collector.file(current.rel, current.lines);
    current = null;
    run.collector.pending = 0;
  };
  const { code, stderr } = await streamChild(child, run, (raw) => {
    let msg: { type: string; data: Record<string, unknown> };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === "begin") {
      const rel = normalizeVaultPath(rgText(msg.data.path as RgText).toString("utf8"));
      current = { rel: rel && run.inScope(rel) ? rel : null, lines: [] };
    } else if (msg.type === "match" && current?.rel) {
      const buf = rgText(msg.data.lines as RgText);
      const spans = (msg.data.submatches as Array<{ start: number; end: number }>) ?? [];
      const line = searchLine(msg.data.line_number as number, buf.toString("utf8"), utf16Ranges(buf, spans));
      current.lines.push(line);
      run.collector.pending += Math.max(1, line.ranges.length);
      // A file that overruns the cap goes out now, cut to it, and ends the search.
      if (run.collector.over) flush();
    } else if (msg.type === "end") flush();
  });
  if (!run.collector.truncated && !run.signal.aborted) flush();
  // 1 is "no matches"; 2 with stderr is a pattern rg could not compile.
  if (code === 2 && stderr.trim() && run.collector.matches === 0) throw new Error(stderr.trim().split("\n").slice(-3).join(" "));
}

/** git's pathspec for an include or exclude glob, with the same reading as rg's. */
function pathspecs(opts: CodeSearchOptions): string[] {
  const glob = (g: string) => (g.includes("/") ? g : `**/${g}`);
  const specs = opts.include.flatMap(expandBraces).flatMap((g) => expandIncludeGlob(g).map((e) => `:(glob)${glob(e)}`));
  for (const g of opts.exclude.flatMap(expandBraces)) {
    const e = g.replace(/^\.\//, "").replace(/\/+$/, "");
    specs.push(`:(glob,exclude)${glob(e)}`, `:(glob,exclude)${glob(e)}/**`);
  }
  return opts.include.length === 0 ? [".", ...specs] : specs;
}

async function searchGitGrep(run: Run, matcher: RegExp): Promise<void> {
  const { opts } = run;
  const args = ["grep", "-n", "-z", "-I", "--no-color", "--untracked", opts.regex ? "-E" : "-F"];
  if (opts.includeIgnored) args.push("--no-exclude-standard");
  if (!opts.caseSensitive) args.push("-i");
  if (opts.word) args.push("-w");
  args.push("-e", opts.query, "--", ...pathspecs(opts));
  const child = spawn("git", args, {
    cwd: run.root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  let current: { rel: string | null; raw: string; lines: CodeSearchLine[] } | null = null;
  const flush = () => {
    if (current?.rel) run.collector.file(current.rel, current.lines);
    current = null;
    run.collector.pending = 0;
  };
  const { code, stderr } = await streamChild(child, run, (raw) => {
    // path NUL line NUL text
    const a = raw.indexOf("\0");
    const b = raw.indexOf("\0", a + 1);
    if (a < 0 || b < 0) return;
    const file = raw.slice(0, a);
    if (current?.raw !== file) {
      flush();
      const rel = normalizeVaultPath(file);
      current = { rel: rel && run.inScope(rel) ? rel : null, raw: file, lines: [] };
    }
    if (!current.rel) return;
    const text = raw.slice(b + 1);
    const line = searchLine(Number(raw.slice(a + 1, b)), text, rangesIn(text, matcher));
    current.lines.push(line);
    run.collector.pending += Math.max(1, line.ranges.length);
    if (run.collector.over) flush();
  });
  if (!run.collector.truncated && !run.signal.aborted) flush();
  if (code !== null && code > 1 && stderr.trim()) throw new Error(stderr.trim().split("\n").pop());
}

async function searchWalk(run: Run, matcher: RegExp): Promise<void> {
  const files = (await scanVault(run.root, { includeIgnored: run.opts.includeIgnored })).filter((f) => !f.dir);
  const includes = run.opts.include.flatMap(expandIncludeGlob).map((g) => new Bun.Glob(g.includes("/") ? g : `**/${g}`));
  const excludes = run.opts.exclude.map((g) => g.replace(/^\.\//, "").replace(/\/+$/, "")).flatMap((g) => {
    const base = g.includes("/") ? g : `**/${g}`;
    return [new Bun.Glob(base), new Bun.Glob(`${base}/**`)];
  });
  const wanted = files.filter(
    (f) =>
      f.size <= WALK_MAX_FILE_BYTES &&
      (includes.length === 0 || includes.some((g) => g.match(f.path))) &&
      !excludes.some((g) => g.match(f.path)),
  );
  let next = 0;
  const worker = async () => {
    while (next < wanted.length && !run.signal.aborted && !run.collector.truncated) {
      const file = wanted[next++];
      let data: Buffer;
      try {
        data = await fsp.readFile(path.join(run.root, ...file.path.split("/")));
      } catch {
        continue;
      }
      if (data.subarray(0, 8000).includes(0)) continue; // binary, as rg and git judge it
      const lines: CodeSearchLine[] = [];
      const text = data.toString("utf8").split("\n");
      // Past the cap the file's remaining lines would be dropped anyway.
      let left = run.opts.max - run.collector.matches;
      for (let i = 0; i < text.length && left >= 0; i++) {
        if (i > 0 && i % WALK_YIELD_LINES === 0) {
          await new Promise((resolve) => setImmediate(resolve));
          if (run.signal.aborted || run.collector.truncated) return;
        }
        const ranges = rangesIn(text[i], matcher);
        if (ranges.length === 0) continue;
        const line = searchLine(i + 1, text[i], ranges);
        lines.push(line);
        left -= Math.max(1, line.ranges.length);
      }
      run.collector.file(file.path, lines);
    }
  };
  await Promise.all(Array.from({ length: WALK_CONCURRENCY }, worker));
}

let rgCache: { at: number; bin: string | null } | null = null;

/** ripgrep on this machine, looked up on the login shell's PATH so a
 *  Homebrew install is found from a daemon started with a bare one. */
function ripgrep(): string | null {
  if (!rgCache || (!rgCache.bin && Date.now() - rgCache.at > 60_000)) {
    rgCache = { at: Date.now(), bin: whichBin("rg", TOOL_PATH) };
  }
  return rgCache.bin;
}

export interface SearchEngines {
  /** Path to rg, or null to skip it. Tests pin the engine through this. */
  rg?: string | null;
  /** False to skip git grep. */
  gitGrep?: boolean;
}

/**
 * Search a vault, calling `emit` per file as results arrive and once with
 * "done" (or "error") at the end. Resolves when the engine has exited.
 */
export async function searchVault(
  root: string,
  opts: CodeSearchOptions,
  emit: (event: CodeSearchEvent) => void,
  signal: AbortSignal,
  env: { configDir: string; engines?: SearchEngines },
): Promise<void> {
  const engines = env.engines ?? {};
  const started = Date.now();
  const collector = new Collector(opts.max, emit);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), SEARCH_TIMEOUT_MS);
  const run: Run = {
    root,
    opts,
    collector,
    signal: AbortSignal.any([signal, timeout.signal]),
    inScope: (rel) => (opts.includeIgnored ? !isVaultIgnoredPath(rel) : !isVaultPathIgnored(root, rel)),
    configDir: env.configDir,
  };
  let engine: "rg" | "git-grep" | "walk";
  try {
    const rg = engines.rg === undefined ? ripgrep() : engines.rg;
    if (rg) {
      engine = "rg";
      await searchRipgrep(rg, run);
    } else {
      const matcher = compileMatcher(opts);
      if (engines.gitGrep !== false && (await locateRepo(root))) {
        engine = "git-grep";
        await searchGitGrep(run, matcher);
      } else {
        engine = "walk";
        await searchWalk(run, matcher);
      }
    }
  } catch (err) {
    emit({ type: "error", message: (err as Error).message || String(err) });
    return;
  } finally {
    clearTimeout(timer);
  }
  emit({
    type: "done",
    files: collector.files,
    matches: collector.matches,
    truncated: collector.truncated || timeout.signal.aborted,
    elapsed_ms: Date.now() - started,
    engine,
  });
}
