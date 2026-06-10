// Line-level `cast blame`: a drop-in `git blame` whose author column shows the
// codecast session that wrote each line. git does the hard part locally
// (line-history tracking via `git blame --porcelain`); the server resolves the
// unique SHAs to sessions via file_changes commit rows, and uncommitted lines
// by content match against the caller's recent edits. Output mirrors git
// blame's default and porcelain formats byte-for-byte so editor integrations
// keep parsing it; porcelain mode carries the attribution as extra
// `codecast-*` header keys, which porcelain consumers ignore.

import { execFile } from "node:child_process";
import * as path from "node:path";
import { cliFetchRead } from "./cliHttp.js";

export const ZERO_SHA = "0".repeat(40);
// Mirror of the server's MIN_LINE_MATCH_LEN: shorter lines are too common to
// attribute safely, so don't spend request bytes on them.
const MIN_LINE_MATCH_LEN = 8;
const MAX_UNCOMMITTED_LINES = 400;
const MAX_WHO_LABEL = 40;
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
  bySha: Map<string, SessionRef>;
  byUncommittedLine: Map<string, SessionRef>;
}

export const EMPTY_RESOLUTION: BlameResolution = {
  bySha: new Map(),
  byUncommittedLine: new Map(),
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

// The author-column replacement: session short id + title. Parens would break
// editor regexes that scan for the `(...)` group, so strip them.
export function sessionLabel(ref: SessionRef): string {
  const title = ref.title.replace(/[()\r\n\t]/g, " ").replace(/\s+/g, " ").trim();
  const label = `${ref.conversation_id.slice(0, 7)} ${title}`;
  return label.length > MAX_WHO_LABEL ? label.slice(0, MAX_WHO_LABEL - 2) + ".." : label;
}

function whoFor(line: BlameLine, meta: BlameCommitMeta, resolution: BlameResolution): string {
  if (line.sha === ZERO_SHA) {
    const ref = resolution.byUncommittedLine.get(line.content.trim());
    return ref ? sessionLabel(ref) : meta.author;
  }
  const ref = resolution.bySha.get(line.sha);
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
          ref = resolution.byUncommittedLine.get(lines[j].slice(1).trim());
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

export function uncommittedLinesToMatch(parsed: ParsedBlame): string[] {
  const wanted = new Set<string>();
  for (const line of parsed.lines) {
    if (line.sha !== ZERO_SHA) continue;
    const trimmed = line.content.trim();
    if (trimmed.length >= MIN_LINE_MATCH_LEN) wanted.add(trimmed);
    if (wanted.size >= MAX_UNCOMMITTED_LINES) break;
  }
  return [...wanted];
}

function execGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve({ stdout, stderr });
    });
  });
}

async function resolveSessions(
  siteUrl: string,
  apiToken: string,
  shas: string[],
  filePath: string,
  uncommittedLines: string[],
): Promise<BlameResolution> {
  if (shas.length === 0 && uncommittedLines.length === 0) return EMPTY_RESOLUTION;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);
  try {
    const response = await cliFetchRead(`${siteUrl}/cli/blame/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_token: apiToken,
        shas,
        file_path: filePath,
        uncommitted_lines: uncommittedLines,
      }),
      signal: controller.signal,
    });
    const result = (await response.json()) as {
      error?: string;
      resolved?: Record<string, SessionRef>;
      uncommitted?: Record<string, SessionRef>;
    };
    if (result.error) throw new Error(result.error);
    return {
      bySha: new Map(Object.entries(result.resolved ?? {})),
      byUncommittedLine: new Map(Object.entries(result.uncommitted ?? {})),
    };
  } finally {
    clearTimeout(timer);
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

  let resolution = EMPTY_RESOLUTION;
  const wantSessions = options.sessions !== false && config.auth_token && config.convex_url;
  if (wantSessions) {
    const shas = [...new Set(parsed.lines.map((l) => l.sha))].filter((s) => s !== ZERO_SHA);
    const uncommitted = uncommittedLinesToMatch(parsed);
    const siteUrl = config.convex_url!.replace(".cloud", ".site");
    try {
      resolution = await resolveSessions(siteUrl, config.auth_token!, shas, absPath, uncommitted);
    } catch (error) {
      // Stay a faithful git blame on any resolution failure — editor
      // integrations must never see a broken pipe because the network blinked.
      console.error(
        `cast blame: session resolution unavailable (${error instanceof Error ? error.message : error})`,
      );
    }
  }

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
