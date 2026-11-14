/**
 * What a `cast check` run ends with: an exit code that separates "the code
 * has errors" from "the tool failed", and at most one `cast: hint:` line
 * naming the next action, picked from evidence in severity order. Codes are
 * infraExit.ts's; the idea and the severity-ordered hint are from
 * pandora/client/hints.py (MIT).
 *
 *   0    every project checked clean
 *   1    type errors (some may come with a tool failure elsewhere; the hint names it)
 *   2    the projects asked for could not be resolved
 *   70   a watcher died, was killed for memory, or did not start: no verdict
 *   75   no verdict yet, retry: the queue stayed full, or the watcher's answer was stale
 *   124  the pass outlived the wait; it keeps running and the next ask picks it up
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { EXIT_BUSY, EXIT_INFRA, EXIT_WAIT_ELAPSED } from "./infraExit.js";

export type FailureKind = "oom" | "heap" | "no-tsc" | "died" | "stuck" | "infra" | "stale" | "wait-elapsed" | "busy" | "locked";
export type FailureDetail = { log?: string; command?: string; pid?: number; pgid?: number; lock?: string };

export class CheckFailure extends Error {
  constructor(message: string, readonly kind: FailureKind, readonly detail: FailureDetail = {}) {
    super(message);
  }
}

const EXIT: Record<FailureKind, number> = {
  oom: EXIT_INFRA, heap: EXIT_INFRA, "no-tsc": EXIT_INFRA, died: EXIT_INFRA, stuck: EXIT_INFRA, infra: EXIT_INFRA,
  stale: EXIT_BUSY, busy: EXIT_BUSY, locked: EXIT_BUSY, "wait-elapsed": EXIT_WAIT_ELAPSED,
};

/** Why a watcher stopped, read from the last line it logged (the watcher ends its log with the reason). */
export function deathKind(lastLine: string | null): FailureKind {
  if (!lastLine) return "died";
  if (/out-of-memory killer|most likely for memory/.test(lastLine)) return "oom";
  if (/tsc ran out of memory on .* heap cap/.test(lastLine)) return "heap";
  if (/^tsc did not start: this tree has no TypeScript installed/.test(lastLine)) return "no-tsc";
  if (lastLine.startsWith("stopped to make room for another watcher")) return "busy";
  return "died";
}

// ---------------------------------------------------------------------------
// Phantom errors: a missing export or module that is there on disk
// ---------------------------------------------------------------------------

const MISSING_EXPORT = /^(.+?)\(\d+,\d+\): error TS(?:2305|2614|2724): (?:Module )?'"([^"]+)"' has no exported member (?:named )?'([^']+)'/;
const TS_EXT = [".ts", ".tsx", ".mts", ".cts", ".d.ts"];

/** The file a relative import names, as tsc would find it; null for a package import or nothing on disk. */
function resolveRelative(spec: string, fromFile: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const stem = base.replace(/\.(m|c)?jsx?$/, "");
  const candidates = [base, ...TS_EXT.map((e) => stem + e), ...TS_EXT.map((e) => path.join(base, `index${e}`))];
  return candidates.find((f) => /\.(m|c)?tsx?$/.test(f) && fs.existsSync(f) && fs.statSync(f).isFile()) ?? null;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Comments blanked and string or template contents emptied, in one pass so neither is mistaken for the other. */
const LEXEMES = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g;
const code = (source: string): string => source.replace(LEXEMES, (m) => (m.startsWith("/") ? " " : '""'));

/**
 * The file declares `name` as a top-level export, read from its code with
 * comments and strings removed. A declaration inside braces (a namespace,
 * `declare module`) does not count, nor do re-exports (`export *`,
 * `export { x } from`), whose answer lives in another file.
 */
export function exportsName(source: string, name: string): boolean {
  const n = esc(name);
  const text = code(source).replace(/\bexport\s+(?:type\s+)?\{[^}]*\}\s*from\b/g, (m) => " ".repeat(m.length));
  const patterns = [
    new RegExp(`\\bexport\\s+(?:declare\\s+)?(?:async\\s+)?(?:abstract\\s+)?(?:function\\*?|const|let|var|class|interface|type|enum|namespace)\\s+${n}\\b`, "g"),
    new RegExp(`\\bexport\\s+(?:type\\s+)?\\{[^}]*?(?:^|[\\s,{]|\\bas\\s+)${n}\\s*(?:,|\\}|$)`, "gm"),
  ];
  const depthAt = (i: number) => {
    let d = 0;
    for (let k = 0; k < i; k++) d += text[k] === "{" ? 1 : text[k] === "}" ? -1 : 0;
    return d;
  };
  return patterns.some((re) => [...text.matchAll(re)].some((m) => depthAt(m.index!) === 0));
}

export type ModuleResolver = (spec: string, fromFile: string) => string | null;

export function phantomErrors(diagnostics: string, cwd: string, resolve: ModuleResolver = resolveRelative): { phantom: number; examples: string[] } {
  let phantom = 0;
  const examples: string[] = [];
  for (const line of diagnostics.split("\n")) {
    const exp = MISSING_EXPORT.exec(line);
    if (!exp) continue;
    const target = resolve(exp[2], path.resolve(cwd, exp[1]));
    if (!target) continue;
    let text: string;
    try {
      text = fs.readFileSync(target, "utf-8");
    } catch {
      continue;
    }
    if (!exportsName(text, exp[3])) continue;
    phantom++;
    if (examples.length < 2) examples.push(`${exp[3]} in ${path.relative(cwd, target)}`);
  }
  return { phantom, examples };
}

// ---------------------------------------------------------------------------
// The run's verdict
// ---------------------------------------------------------------------------

export type ProjectOutcome =
  | { project: string; errors: number; phantom?: number; globalTsc?: boolean }
  | { project: string; failure: CheckFailure };

const ORDER: Array<FailureKind | "phantom" | "global-tsc"> = ["oom", "heap", "no-tsc", "died", "stuck", "infra", "stale", "phantom", "wait-elapsed", "busy", "locked", "global-tsc"];

function hintFor(kind: FailureKind | "phantom" | "global-tsc", projects: string[], details: FailureDetail[], examples: string[]): string {
  const names = projects.join(" ");
  const detail = details[0] ?? {};
  // A log path or a heap command belongs to one project; with several named, the hint stays general.
  const one = projects.length === 1;
  switch (kind) {
    case "oom":
      return `free memory, then run \`cast check ${names}\` again (\`cast check-status\` lists each watcher's size), or check on a bigger machine with \`cast spawn --subagent\``;
    case "heap":
      if (one && detail.command) return `raise tsc's heap and restart the watcher: \`${detail.command}\``;
      // Several at once: the largest cap any of them already asks for, so none is restarted with less than it had.
      return `raise tsc's heap and restart the watchers: \`NODE_OPTIONS=--max-old-space-size=${Math.max(12288, ...details.map((d) => Number(/max-old-space-size=(\d+)/.exec(d.command ?? "")?.[1]) || 0))} cast check --fresh ${names}\``;
    case "no-tsc":
      return `install this tree's dependencies (\`bun install\`, or the setup install in .codecast/workspace.toml), then run \`cast check ${names}\``;
    case "died":
      return `run \`cast check ${names}\` again to start a new watcher${one && detail.log ? `; if it dies again, read ${detail.log}` : ""}`;
    case "stuck":
    {
      // A process group (the watcher with its tsc) when ps named one, else the pid.
      const targets = details.map((d) => (d.pgid ? `-${d.pgid}` : d.pid)).filter(Boolean);
      return `stop the old watcher${targets.length === 1 ? "" : "s"} (\`kill -9 -- ${targets.join(" ")}\`), then run \`cast check --fresh ${names}\``;
    }
    case "locked":
      return `wait, then run \`cast check ${names}\` again${one && detail.lock ? `; if no other \`cast check\` is running, remove ${detail.lock}` : ""}`;
    case "infra":
      return `run \`cast check ${names}\` again; this was a tool failure, not a type error`;
    case "stale":
      return `run \`cast check --fresh ${names}\`: the watcher's answer does not match the files on disk`;
    case "phantom":
      return `run \`cast check --fresh ${names}\`: errors name what exists on disk (${examples.join(", ")}), left from a pass over a half-written tree`;
    case "wait-elapsed":
      return `run \`cast check ${names}\` again: the pass keeps running and the next ask picks it up`;
    case "busy":
      return `wait, then run \`cast check ${names}\` again; \`cast queue\` shows which watchers hold the room (do not use --fresh)`;
    case "global-tsc":
      return `install this tree's dependencies, then run \`cast check --fresh ${names}\`: the tsc on PATH checked it`;
  }
}

/**
 * The exit code and the one hint for a run. Real type errors make it 1, since
 * that verdict holds whatever else failed. Otherwise the most severe failure
 * names the code. A project whose every error is phantom has no verdict, so it
 * exits as stale does.
 */
export function summarize(outcomes: ProjectOutcome[], phantomExamples: string[] = []): { exit: number; hint: string | null } {
  type Entry = { projects: string[]; details: FailureDetail[] };
  const byKind = new Map<(typeof ORDER)[number], Entry>();
  const add = (kind: (typeof ORDER)[number], project: string, detail: FailureDetail = {}) => {
    const e: Entry = byKind.get(kind) ?? { projects: [], details: [] };
    e.projects.push(project);
    e.details.push(detail);
    byKind.set(kind, e);
  };
  let realErrors = false;
  let noVerdictPhantom = false;
  for (const o of outcomes) {
    if ("failure" in o) {
      add(o.failure.kind, o.project, o.failure.detail);
      continue;
    }
    const phantom = Math.min(o.phantom ?? 0, o.errors);
    if (phantom > 0) add("phantom", o.project);
    if (o.errors > phantom) realErrors = true;
    else if (o.errors > 0) noVerdictPhantom = true;
    if (o.globalTsc && o.errors > 0) add("global-tsc", o.project);
  }
  const top = ORDER.find((k) => byKind.has(k));
  const hint = top ? hintFor(top, byKind.get(top)!.projects, byKind.get(top)!.details, phantomExamples.slice(0, 2)) : null;
  if (realErrors) return { exit: 1, hint };
  const worst = ORDER.find((k) => (k === "phantom" ? noVerdictPhantom : k !== "global-tsc" && byKind.has(k)));
  return { exit: !worst ? 0 : worst === "phantom" ? EXIT.stale : EXIT[worst as FailureKind], hint };
}
