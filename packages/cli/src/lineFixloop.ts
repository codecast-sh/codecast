// `cast line fixloop`: the SZZ trace. For every fix commit in a window, blame
// the lines the fix removed or changed at the fix's parent revision, and name
// the commit, session, line run and role that introduced them. The weekly
// fix-loop routine (org-templates/line/org/prompts/fix-loop-weekly.md) reads
// the --json form and files one signal per confirmed regression.
//
// A fix commit is one that (a) carries a task of task_type bug, (b) belongs to
// a change story of kind fix, or (c) has a subject starting `fix:` or
// `fix(`; the subject rule is a cheap convention, named as such in the output.

import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { parseBlamePorcelain, resolveFromParsed, type BlameResolution, type SessionRef } from "./blame.js";

const run = promisify(execFile);

export interface FixCommit {
  sha: string;
  subject: string;
  authorTime: number; // ms
  reason: "task_bug" | "story_fix" | "subject_fix";
}

export interface RemovedRange {
  file: string; // path at the parent revision
  start: number;
  end: number;
}

export interface IntroducedBy {
  sha: string;
  summary?: string;
  authorTime?: number; // ms
  lines: number;
  session?: SessionRef;
}

export interface FixTrace {
  fix: FixCommit;
  introduced: IntroducedBy[];
}

export const SUBJECT_FIX_RE = /^fix(\(|:|!:)/i;

export function isFixSubject(subject: string): boolean {
  return SUBJECT_FIX_RE.test(subject.trim());
}

/** Parse `git log --format=%H%x00%s%x00%at` output. */
export function parseLog(output: string): { sha: string; subject: string; authorTime: number }[] {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, subject, at] = line.split("\0");
      return { sha, subject: subject ?? "", authorTime: Number(at) * 1000 };
    });
}

/** Pick fix commits from a log, given the shas known to be bug tasks or fix stories. */
export function selectFixCommits(
  log: { sha: string; subject: string; authorTime: number }[],
  known: { bugTaskShas?: Set<string>; fixStoryShas?: Set<string> } = {},
): FixCommit[] {
  const out: FixCommit[] = [];
  for (const c of log) {
    const reason = known.bugTaskShas?.has(c.sha) ? "task_bug" : known.fixStoryShas?.has(c.sha) ? "story_fix" : isFixSubject(c.subject) ? "subject_fix" : null;
    if (reason) out.push({ ...c, reason });
  }
  return out;
}

/**
 * The removed or changed line ranges of a `git diff -U0 <parent> <sha>`
 * output, in the parent's numbering: every `-` run inside a hunk. Added-only
 * hunks introduce nothing to blame.
 */
export function removedRanges(diff: string): RemovedRange[] {
  const out: RemovedRange[] = [];
  let file: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ")) {
      const p = line.slice(4).trim();
      file = p === "/dev/null" ? null : p.replace(/^a\//, "");
      continue;
    }
    if (line.startsWith("+++ ")) continue;
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
    if (hunk && file) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (count > 0) out.push({ file, start, end: start + count - 1 });
    }
  }
  return out;
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** Blame the ranges at the parent and count, per introducing sha, the lines the fix touched. */
export async function blameRemoved(cwd: string, fixSha: string, ranges: RemovedRange[]): Promise<Map<string, { summary?: string; authorTime?: number; lines: number; parsedFile: string; parsed: ReturnType<typeof parseBlamePorcelain> }>> {
  const byFile = new Map<string, RemovedRange[]>();
  for (const r of ranges) byFile.set(r.file, [...(byFile.get(r.file) ?? []), r]);
  const out = new Map<string, { summary?: string; authorTime?: number; lines: number; parsedFile: string; parsed: ReturnType<typeof parseBlamePorcelain> }>();
  for (const [file, rs] of byFile) {
    const args = ["blame", "--porcelain"];
    for (const r of rs) args.push("-L", `${r.start},${r.end}`);
    args.push(`${fixSha}^`, "--", file);
    let parsed;
    try {
      parsed = parseBlamePorcelain(await git(args, cwd));
    } catch {
      continue; // a binary or a path git cannot blame at the parent
    }
    for (const l of parsed.lines) {
      const meta = parsed.commits.get(l.sha);
      const cur = out.get(l.sha) ?? { summary: meta?.summary, authorTime: meta?.authorTime ? meta.authorTime * 1000 : undefined, lines: 0, parsedFile: file, parsed };
      cur.lines++;
      out.set(l.sha, cur);
    }
  }
  return out;
}

export interface FixloopOptions {
  cwd: string;
  since: string; // git --since
  config: { auth_token?: string; convex_url?: string };
  bugTaskShas?: Set<string>;
  fixStoryShas?: Set<string>;
  resolve?: (parsed: ReturnType<typeof parseBlamePorcelain>, absFile: string) => Promise<BlameResolution>;
}

export async function traceFixes(opts: FixloopOptions): Promise<FixTrace[]> {
  const log = parseLog(await git(["log", `--since=${opts.since}`, "--no-merges", "--format=%H%x00%s%x00%at"], opts.cwd));
  const fixes = selectFixCommits(log, opts);
  const resolve = opts.resolve ?? ((parsed, absFile) => resolveFromParsed(parsed, absFile, opts.config));
  const traces: FixTrace[] = [];
  for (const fix of fixes) {
    const diff = await git(["diff", "-U0", "--no-color", `${fix.sha}^`, fix.sha], opts.cwd).catch(() => "");
    const blamed = await blameRemoved(opts.cwd, fix.sha, removedRanges(diff));
    const introduced: IntroducedBy[] = [];
    for (const [sha, b] of blamed) {
      if (sha === fix.sha) continue;
      let session: SessionRef | undefined;
      try {
        const res = await resolve(b.parsed, path.join(opts.cwd, b.parsedFile));
        session = res.bySha.get(sha);
      } catch { /* a blame without attribution is still a blame */ }
      introduced.push({ sha, summary: b.summary, authorTime: b.authorTime, lines: b.lines, session });
    }
    introduced.sort((a, b) => b.lines - a.lines);
    traces.push({ fix, introduced });
  }
  return traces;
}

export interface RoleRollup { role: string; fixes: number; introduced_commits: number; lines: number }

/** Per role: how many fixes traced to its runs, and how many introducing commits and lines. */
export function rollupByRole(traces: FixTrace[]): RoleRollup[] {
  const by = new Map<string, RoleRollup & { fixSet: Set<string> }>();
  for (const t of traces) {
    for (const i of t.introduced) {
      const role = i.session?.role_handle ?? (i.session ? "(no role)" : "(no session)");
      const cur = by.get(role) ?? { role, fixes: 0, introduced_commits: 0, lines: 0, fixSet: new Set<string>() };
      cur.fixSet.add(t.fix.sha);
      cur.introduced_commits++;
      cur.lines += i.lines;
      by.set(role, cur);
    }
  }
  return [...by.values()].map(({ fixSet, ...r }) => ({ ...r, fixes: fixSet.size })).sort((a, b) => b.lines - a.lines);
}

const days = (a?: number, b?: number) => (a && b ? Math.max(0, Math.round((a - b) / 86_400_000)) : undefined);

export function formatFixloop(traces: FixTrace[]): string {
  const lines: string[] = [];
  const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
  lines.push([pad("fix", 9), pad("introduced", 11), pad("session", 9), pad("role", 14), pad("run", 9), "days", "lines  subject"].join("  "));
  for (const t of traces) {
    if (t.introduced.length === 0) {
      lines.push([pad(t.fix.sha.slice(0, 7), 9), pad("(added only)", 11), pad("", 9), pad("", 14), pad("", 9), pad("", 4), pad("", 5), `${t.fix.subject} [${t.fix.reason}]`].join("  "));
      continue;
    }
    for (const i of t.introduced) {
      const s = i.session;
      lines.push([
        pad(t.fix.sha.slice(0, 7), 9), pad(i.sha.slice(0, 7), 11), pad(s ? s.conversation_id.slice(0, 7) : "-", 9), pad(s?.role_handle ?? "-", 14), pad(s?.run_id ? String(s.run_id).slice(0, 7) : "-", 9),
        pad(String(days(t.fix.authorTime, i.authorTime) ?? "-"), 4), pad(String(i.lines), 5), `${t.fix.subject} [${t.fix.reason}]`,
      ].join("  "));
    }
  }
  const roll = rollupByRole(traces);
  if (roll.length > 0) {
    lines.push("", "per role:");
    for (const r of roll) lines.push(`  ${pad(r.role, 16)} ${r.fixes} fixes · ${r.introduced_commits} introducing commits · ${r.lines} lines`);
  }
  lines.push("", `${traces.length} fix commits (bug task, fix story, or a subject starting fix: / fix( as a convention)`);
  return lines.join("\n");
}
