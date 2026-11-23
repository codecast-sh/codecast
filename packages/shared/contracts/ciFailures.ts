// The failures in a CI job's log, read the same way wherever a red run is
// judged: the change flow's CI station (cli/src/workflow/ciStation.ts) and red
// main on the server (convex/mainRed.ts). A failure is matched across two runs
// by its id: its file and test, or the failed step for one the log cannot name.

export interface CiFailure {
  job: string;
  test: string | null;
  assertion: string | null;
  file: string | null;
  line: number | null;
  excerpt: string;
}

const EXCERPT_LINES = 40;
const EXCERPT_CHARS = 4000;

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const STAMP = /^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z ?/;
const TURBO = /^@?[\w./-]+:[\w-]+: /; // a turbo task's `@pkg/name:task: ` prefix
const END = /^##\[error\]Process completed with exit code (\d+)/;
const NOISE = /orphan process|^Post job cleanup|^Cleaning up orphan processes/i;

/** A log line without its `job<TAB>step<TAB>` prefix (gh run view --log), timestamp and colour; `stamped` is false for the continuation lines of a multi-line annotation. */
function logLines(log: string): Array<{ text: string; stamped: boolean }> {
  return log.split(/\r?\n/).map((raw) => {
    const line = (STAMP.test(raw) ? raw : raw.replace(/^[^\t\n]*\t[^\t\n]*\t/, "")).replace(ANSI, "");
    const m = STAMP.exec(line);
    return m ? { text: line.slice(m[0].length), stamped: true } : { text: line.replace(/^﻿/, ""), stamped: false };
  });
}

/** A runner's absolute path as a path in the repository. */
const repoPath = (p: string) => p.replace(/^.*?\/work\/[^/]+\/[^/]+\//, "");

function excerptOf(lines: string[]): string {
  let a = 0, b = lines.length;
  while (a < b && !lines[a]!.trim()) a++;
  while (b > a && !lines[b - 1]!.trim()) b--;
  const text = lines.slice(Math.max(a, b - EXCERPT_LINES), b).join("\n");
  return text.length > EXCERPT_CHARS ? text.slice(-EXCERPT_CHARS) : text;
}

function bunFailure(job: string, test: string, block: string[], group: string | null): CiFailure {
  let assertion: string | null = null;
  const err = block.findIndex((l) => /^\s*error: /.test(l) || /timed out after \d+/.test(l));
  if (err >= 0) {
    assertion = block[err]!.trim().replace(/^error: /, "");
    const told = block.slice(err + 1, err + 6).map((l) => l.trim()).filter((l) => /^(Expected|Received)/.test(l));
    if (told.length) assertion += ` (${told.join("; ")})`;
  }
  let file: string | null = group;
  let line: number | null = null;
  const at = block.map((l) => /\bat .*?\(?(\/[^\s()]+?\.[cm]?[jt]sx?):(\d+):\d+\)?\s*$/.exec(l)).filter((m) => m !== null);
  const own = at.find((m) => /\.(test|spec)\./.test(m![1]!)) ?? at[0];
  if (own) { file = repoPath(own[1]!); line = Number(own[2]); }
  return { job, test, assertion, file, line, excerpt: excerptOf(block) };
}

/** A failure with the identity it is matched to main's by: its file (as bun groups it) and test, or `step:<the step's Run header>` for one the log cannot name. */
export interface NamedFailure { failure: CiFailure; id: string }

/** One step of a job's log: its `##[group]Run` header, its lines up to its exit, and whether it failed. */
interface Step { header: string; lines: Array<{ text: string; stamped: boolean }>; failed: boolean }

/** The log cut at each step's `##[group]Run` header; a step failed when it ends with the runner's exit-code error. */
function splitSteps(log: string): Step[] {
  const steps: Step[] = [{ header: "Set up job", lines: [], failed: false }];
  let ended = false;
  for (const line of logLines(log)) {
    if (line.text.startsWith("##[group]Run ")) {
      steps.push({ header: line.text.slice("##[group]".length), lines: [], failed: false });
      ended = false;
      continue;
    }
    if (ended) continue;
    const step = steps[steps.length - 1]!;
    if (END.test(line.text)) { step.failed = true; ended = true; continue; }
    step.lines.push(line);
  }
  return steps;
}

/**
 * The failures in one step: bun test's `(fail)` lines with the expect output printed above each, tsc's
 * `file(line,col): error TSnnnn`, eslint's stylish `line:col error message rule` under its file. Bun's own
 * summary (`N fail`, `N error`) must be accounted for: an error between tests (a file that no longer loads)
 * or more failures than the log names adds a failure with no test. A step that names nothing is one failure
 * with the step's tail.
 */
function scanStep(job: string, step: Step): NamedFailure[] {
  const named: NamedFailure[] = [];
  const seen = new Set<string>();
  const add = (failure: CiFailure, id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    named.push({ failure, id });
  };
  let block: string[] = [];
  let group: string | null = null;
  let annotation = false;
  let lintFile: string | null = null;
  let bunNamed = 0, fails = 0, errors = 0;
  let unhandled: string[] | null = null;
  let summary = false;
  const lines: string[] = [];
  for (const { text: raw, stamped } of step.lines) {
    // GitHub repeats an error as a `##[error]` annotation whose further lines carry no timestamp: a copy, not output.
    if (annotation && !stamped) continue;
    annotation = raw.startsWith("##[error]");
    if (annotation || NOISE.test(raw)) continue;
    const text = raw.replace(TURBO, "");
    lines.push(text);
    const count = /^\s*(\d+) (fail|errors?)\s*$/.exec(text);
    if (count) { if (count[2] === "fail") fails += Number(count[1]); else errors += Number(count[1]); continue; }
    if (/^# Unhandled error/.test(text)) unhandled = [];
    if (unhandled && unhandled.length < EXCERPT_LINES) unhandled.push(text);
    // Bun ends each run by listing its failures again, outside any file's group: copies, not more failures.
    if (/^\s*\d+ tests? failed:\s*$/.test(text)) { summary = true; continue; }
    const g = /^##\[group\](\S+\.(?:test|spec)\.[cm]?[jt]sx?):\s*$/.exec(text);
    if (g || text.startsWith("##[")) { group = g?.[1] ?? group; block = []; summary = false; continue; }
    const fail = /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?\s*$/.exec(text);
    if (fail && summary) continue;
    if (fail) {
      const f = bunFailure(job, fail[1]!, block, group);
      const id = `${group ?? f.file ?? ""}::${fail[1]}`;
      if (!seen.has(id)) bunNamed++;
      add(f, id);
      block = [];
      continue;
    }
    if (/^\((pass|skip|todo)\) /.test(text)) { block = []; continue; }
    block.push(text);
    const tsc = /^(\S+?\.[cm]?[jt]sx?)(?:\((\d+),\d+\):|:(\d+):\d+ -) error (TS\d+): (.*)$/.exec(text);
    if (tsc) {
      const test = `${tsc[1]}: ${tsc[4]} ${tsc[5]}`;
      add({ job, test, assertion: `${tsc[4]}: ${tsc[5]}`, file: tsc[1]!, line: Number(tsc[2] ?? tsc[3]), excerpt: text }, test);
      continue;
    }
    if (/^\/\S+\.[cm]?[jt]sx?$/.test(text.trim())) { lintFile = repoPath(text.trim()); continue; }
    const lint = lintFile ? /^\s+(\d+):\d+\s+error\s+(.+?)\s{2,}(\S+)\s*$/.exec(text) : null;
    if (lint) {
      const test = `${lintFile}: ${lint[2]} (${lint[3]})`;
      add({ job, test, assertion: lint[2]!, file: lintFile, line: Number(lint[1]), excerpt: `${lintFile}\n${text}` }, test);
    }
  }
  const unnamed = (assertion: string | null, excerpt: string[]) =>
    named.push({ failure: { job, test: null, assertion, file: null, line: null, excerpt: excerptOf([step.header, ...excerpt]) }, id: `step:${step.header}` });
  if (errors > 0 || fails > bunNamed) {
    const what = [errors ? `${errors} error${errors === 1 ? "" : "s"} between tests` : "", fails > bunNamed ? `${fails - bunNamed} failure${fails - bunNamed === 1 ? "" : "s"} the log names no test for` : ""].filter(Boolean).join(" and ");
    unnamed(`bun reported ${what}`, unhandled ?? lines.slice(-60));
  } else if (!named.length) unnamed(null, lines.slice(-60));
  return named;
}

/** Every failure in a job's log, from each step that failed; a log with no failed step is read whole. */
export function jobFailures(job: string, log: string): NamedFailure[] {
  const steps = splitSteps(log);
  const failed = steps.filter((s) => s.failed);
  if (failed.length) return failed.flatMap((s) => scanStep(job, s));
  return scanStep(job, { header: "", lines: steps.flatMap((s) => s.lines), failed: true });
}

/** The failures in one job's log (see scanStep), as ci.json lists them. */
export function parseFailures(job: string, log: string): CiFailure[] {
  return jobFailures(job, log).map((n) => n.failure);
}
