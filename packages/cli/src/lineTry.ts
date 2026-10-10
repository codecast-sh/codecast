// Try: a step's edited prompt run on past cases, in a sandbox that refuses
// writes (docs/architecture/line-workspace.md LW4). Runs on the machine that
// published the graph, as the daemon's `line_try`.
//
// For each case:
//  1. The brief: what the station's session was handed when the case ran (its
//     first user message), with the template edit applied to the rendered text
//     (applyTemplateEdit). A hunk that cannot be placed falls back to
//     rendering the new template from the run's checkpoint on this machine;
//     with neither, the case is not tryable and says why.
//  2. The run: packages/cli/scripts/prompt-dry-run.ts with its guard (every
//     cast write refused and logged) and --read-only (no file write outside
//     its run dir), on the step's model, in the checkout.
//  3. The answer: what the station pinned (`cast state ... ```json```), read
//     from the run's stream, with the reply, the cost and every refused write.
// Nothing ships from a try: the guard and the sandbox see to that.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { extractJsonOutput } from "./workflow/condition.js";

// ── the template edit, applied to a rendered brief ───────────────────────────

/** A `$name` or `$node.json.field` the runner expands (runner.ts expandPromptVars). */
const VAR_RE = /\$(\w+(?:\.\w+)*)/g;

export type Hunk = { start: number; end: number; added: string[] };

/** The changed line ranges from `a` to `b`: old [start, end) becomes `added`. LCS over lines. */
export function lineHunks(a: string[], b: string[]): Hunk[] {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let open: Hunk | null = null;
  const close = () => { if (open) { hunks.push(open); open = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { close(); i++; j++; continue; }
    open ??= { start: i, end: i, added: [] };
    if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { open.added.push(b[j]); j++; }
    else { i++; open.end = i; }
  }
  close();
  return hunks;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Piece = { src: string; groups: Array<string | null>; literal: number; edgeVar: [boolean, boolean] };

/** A template line as a pattern: its literal text exact, each $var a lazy capture. */
function linePattern(line: string): Piece {
  let src = "";
  let literal = 0;
  const groups: Array<string | null> = [];
  let at = 0;
  for (const m of line.matchAll(VAR_RE)) {
    const lit = line.slice(at, m.index);
    src += escapeRe(lit);
    literal += lit.trim().length;
    src += "([\\s\\S]*?)";
    groups.push(m[1]);
    at = m.index! + m[0].length;
  }
  const tail = line.slice(at);
  src += escapeRe(tail);
  literal += tail.trim().length;
  const first = line.search(VAR_RE);
  return { src, groups, literal, edgeVar: [first === 0, groups.length > 0 && tail.length === 0] };
}

/** The most $vars one placement may hold: each is a lazy span, and more of them backtrack badly on a miss. */
const MAX_VARS = 3;
const MIN_LITERAL = 12;
const MAX_CONTEXT = 4;

type Placement = { from: number; to: number; insert: string; vars: Map<string, string> };

/** Where one hunk lands in the rendered text, or why it cannot. */
function placeHunk(old: string[], h: Hunk, text: string): Placement | string {
  for (let k = h.start === h.end ? 1 : 0; k <= MAX_CONTEXT; k++) {
    const before = old.slice(Math.max(0, h.start - k), h.start).map(linePattern);
    const removed = old.slice(h.start, h.end).map(linePattern);
    const after = old.slice(h.end, h.end + k).map(linePattern);
    const all = [...before, ...removed, ...after];
    if (!all.length) continue;
    const vars = all.reduce((s, p) => s + p.groups.length, 0);
    if (vars > MAX_VARS) return "the changed lines sit among more inserted values than one placement can read";
    const literal = all.reduce((s, p) => s + p.literal, 0);
    if (literal < MIN_LITERAL || all[0].edgeVar[0] || all[all.length - 1].edgeVar[1]) {
      if (h.start - k <= 0 && h.end + k >= old.length) break;
      continue;
    }
    // The pattern: before, then the removed lines (or the insertion point) as one capture, then after.
    const groups: Array<string | null> = [];
    const join = (ps: Piece[]) => ps.map((p) => { groups.push(...p.groups); return p.src; }).join("\\n");
    let src = before.length ? `${join(before)}` : "";
    const atEnd = !after.length;
    if (removed.length) {
      src += `${before.length ? "\\n" : ""}(`;
      groups.push(null);
      src += `${join(removed)})`;
      if (after.length) src += "\\n";
    } else {
      src += atEnd ? "()" : "\\n()";
      groups.push(null);
    }
    src += join(after);
    let re: RegExp;
    try { re = new RegExp(src, "dg"); } catch { return "a changed line could not be read as a pattern"; }
    const m = re.exec(text);
    if (!m) {
      if (h.start - k <= 0 && h.end + k >= old.length) break;
      continue;
    }
    const again = re.exec(text);
    if (again && again.index !== m.index) {
      if (h.start - k <= 0 && h.end + k >= old.length) return "the changed lines read the same in more than one place of the brief";
      continue;
    }
    const varMap = new Map<string, string>();
    let span: [number, number] | null = null;
    groups.forEach((g, gi) => {
      const range = m.indices?.[gi + 1];
      if (g === null) span = range ? [range[0], range[1]] : null;
      else if (range && !varMap.has(g)) varMap.set(g, text.slice(range[0], range[1]));
    });
    if (!span) return "the brief's matching text had no place for the change";
    const [from, to] = span as [number, number];
    if (removed.length) return { from, to, insert: h.added.join("\n"), vars: varMap };
    return { from, to, insert: atEnd ? `\n${h.added.join("\n")}` : `${h.added.join("\n")}\n`, vars: varMap };
  }
  return "the brief no longer holds the text the edit changes";
}

/** What `$name` rendered to, read off a line of the old template that shows it with enough text around it to place exactly once. */
function valueInBrief(old: string[], name: string, rendered: string): string | null {
  for (const line of old) {
    const p = linePattern(line);
    const gi = p.groups.indexOf(name);
    if (gi < 0 || p.groups.length > MAX_VARS || p.literal < MIN_LITERAL / 2) continue;
    const re = new RegExp(`(?:^|\\n)${p.src}(?=\\n|$)`, "g");
    const m = re.exec(rendered);
    if (!m || re.exec(rendered)) continue;
    return m[gi + 1] ?? null;
  }
  return null;
}

export type TemplateEditResult = { ok: true; text: string; hunks: number } | { ok: false; reason: string };

/**
 * The rendered brief with the template's edit applied: each changed line range
 * is found in the brief by its own text and the lines around it (inserted
 * values read as wildcards), exactly once, and replaced. Values the new lines
 * name are filled from what the old lines showed in the brief; one the brief
 * never showed refuses the case.
 */
export function applyTemplateEdit(oldTemplate: string, newTemplate: string, rendered: string): TemplateEditResult {
  if (oldTemplate === newTemplate) return { ok: true, text: rendered, hunks: 0 };
  const old = oldTemplate.split("\n");
  const neu = newTemplate.split("\n");
  if (old.length > 3000 || neu.length > 3000) return { ok: false, reason: "the prompt is too long to place an edit in" };
  const hunks = lineHunks(old, neu);
  const goal = /(?:^|\n)# Goal\n([\s\S]*?)\n\n?# Task:/.exec(rendered)?.[1];
  const placed: Array<Placement & { h: Hunk }> = [];
  for (const h of hunks) {
    const p = placeHunk(old, h, rendered);
    if (typeof p === "string") return { ok: false, reason: p };
    placed.push({ ...p, h });
  }
  const known = new Map<string, string>(goal !== undefined ? [["goal", goal]] : []);
  for (const p of placed) for (const [k, v] of p.vars) if (!known.has(k)) known.set(k, v);
  placed.sort((x, y) => x.from - y.from);
  for (let i = 1; i < placed.length; i++) {
    if (placed[i].from < placed[i - 1].to) return { ok: false, reason: "two changes landed on the same text of the brief" };
  }
  let out = rendered;
  for (const p of [...placed].reverse()) {
    const missing: string[] = [];
    const insert = p.insert.replace(VAR_RE, (whole, name: string) => {
      if (!known.has(name)) {
        const found = valueInBrief(old, name, rendered);
        if (found !== null) known.set(name, found);
      }
      if (known.has(name)) return known.get(name)!;
      missing.push(whole);
      return whole;
    });
    if (missing.length) return { ok: false, reason: `the edit adds ${[...new Set(missing)].join(", ")}, which this case's brief does not show` };
    let { from, to } = p;
    // A deletion takes its line's newline with it.
    if (!insert && from === to) continue;
    if (!insert && p.h.end > p.h.start) {
      if (out[to] === "\n") to++;
      else if (from > 0 && out[from - 1] === "\n") from--;
    }
    out = out.slice(0, from) + insert + out.slice(to);
  }
  return { ok: true, text: out, hunks: hunks.length };
}

// ── what a dry run decided ───────────────────────────────────────────────────

export type TryDecision = { status: string | null; words: string; result: Record<string, unknown> | null };

/** The pin a `cast state` command carries: its status, its first sentence, its json block. */
export function decisionFromPin(command: string): TryDecision {
  const status = /--status[ =]+(\w+)/.exec(command)?.[1] ?? null;
  const heredoc = /<<-?\s*'?"?(\w+)'?"?\s*\n([\s\S]*?)\n\s*\1\s*$/m.exec(command);
  const body = heredoc ? heredoc[2] : printedBody(command) ?? command;
  const words = body.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("```") && !l.startsWith("{") && !/^cast\s/.test(l)) ?? "";
  const json = extractJsonOutput(body);
  return { status, words: words.slice(0, 600), result: json && !Array.isArray(json) ? (json as Record<string, unknown>) : null };
}

/** A shell line's words, quotes resolved ('...', "..." with its escapes, and their concatenations). */
export function shellWords(line: string): string[] {
  const out: string[] = [];
  let cur: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'") { const end = line.indexOf("'", i + 1); cur = (cur ?? "") + line.slice(i + 1, end < 0 ? line.length : end); i = end < 0 ? line.length : end; continue; }
    if (ch === '"') {
      let j = i + 1; let v = "";
      while (j < line.length && line[j] !== '"') { if (line[j] === "\\" && /["\\$`\n]/.test(line[j + 1] ?? "")) { v += line[j + 1]; j += 2; } else v += line[j++]; }
      cur = (cur ?? "") + v; i = j; continue;
    }
    if (ch === "\\") { cur = (cur ?? "") + (line[i + 1] ?? ""); i++; continue; }
    if (/\s/.test(ch) || ch === "|" || ch === ";" || ch === "&") { if (cur !== null) out.push(cur); cur = null; if (ch !== " " && ch !== "\t" && ch !== "\n") out.push(ch); continue; }
    cur = (cur ?? "") + ch;
  }
  if (cur !== null) out.push(cur);
  return out;
}

/** The text a `printf '%s\n' a b c | cast state ...` pipes in: its arguments, one a line. Null when the pin is not written that way. */
function printedBody(command: string): string | null {
  const words = shellWords(command);
  const at = words.indexOf("printf");
  if (at < 0) return null;
  const end = words.indexOf("|", at);
  const args = words.slice(at + 2, end < 0 ? undefined : end);
  return args.length ? args.join("\n") : null;
}

/**
 * What the station decided in a dry run: the last `cast state` it ran (the
 * guard refused it, so its words live only in the stream), else the last
 * message it wrote with a json block. Null when it decided nothing.
 */
export function decisionFromRun(streamJsonl: string, said: string[]): TryDecision | null {
  let pin: string | null = null;
  for (const line of streamJsonl.split("\n")) {
    if (!line.includes("tool_use")) continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== "assistant") continue;
    for (const c of d.message?.content ?? []) {
      const cmd = c?.type === "tool_use" && c.name === "Bash" ? String(c.input?.command ?? "") : "";
      if (/\bcast\s+state\b/.test(cmd)) pin = cmd;
    }
  }
  if (pin) return decisionFromPin(pin);
  for (const text of [...said].reverse()) {
    const json = extractJsonOutput(text);
    if (json && !Array.isArray(json)) return { status: null, words: text.split("\n").find((l) => l.trim() && !l.startsWith("```"))?.trim().slice(0, 600) ?? "", result: json as Record<string, unknown> };
  }
  return null;
}

/** The writes the guard refused (calls.log REFUSED lines), as argv text. */
export function refusedCalls(callsLog: string): string[] {
  return callsLog.split("\n").filter((l) => l.startsWith("REFUSED ")).map((l) => l.slice(8).slice(0, 300)).slice(0, 40);
}

// ── the daemon command ───────────────────────────────────────────────────────

export interface LineTryCase {
  /** The line_tries row this case reports to. */
  row_id: string;
  run_id: string;
  /** What the station's session was handed, or null when it is not on record. */
  received: string | null;
}

export interface LineTryArgs {
  try_id: string;
  /** The checkout's root and the .cast file in it, from the graph's origin. */
  root: string;
  file: string;
  node: string;
  /** The model the step runs on; the try runs on the same one. */
  model: string;
  old_template: string;
  new_template: string;
  cases: LineTryCase[];
}

export type LineTryReport = {
  status: "running" | "done" | "not_tryable" | "failed";
  reason?: string;
  via?: "patch" | "checkpoint";
  decision?: TryDecision | null;
  reply?: string;
  cost_usd?: number;
  turns?: number;
  refused?: string[];
  took_ms?: number;
};

export interface LineTryDeps {
  report: (rowId: string, report: LineTryReport) => Promise<void>;
  /** Run the harness; resolves with its exit code. */
  harness: (argv: string[], opts: { cwd: string }) => Promise<number>;
  /** The brief rendered from the run's checkpoint with the new template, or null when this machine holds none. */
  fromCheckpoint: (runId: string) => Promise<string | null> | string | null;
  /** Where a case's run directory goes. */
  runDir: (tryId: string, rowId: string) => string;
  harnessScript: string;
}

/** Cases run two at a time: each is a whole agent turn, and the machine runs the line too. */
const TRY_CONCURRENCY = 2;

/** The brief a case runs with, and how it was made, or why it cannot be made. */
export async function caseBrief(args: Pick<LineTryArgs, "old_template" | "new_template">, c: LineTryCase, fromCheckpoint: LineTryDeps["fromCheckpoint"]): Promise<{ text: string; via: "patch" | "checkpoint" } | { reason: string }> {
  const patched = c.received ? applyTemplateEdit(args.old_template, args.new_template, c.received) : null;
  if (patched?.ok) return { text: patched.text, via: "patch" };
  const rendered = await Promise.resolve(fromCheckpoint(c.run_id)).catch(() => null);
  if (rendered) return { text: rendered, via: "checkpoint" };
  const why = patched && !patched.ok ? patched.reason : "the station's brief is not on record";
  return { reason: `${why}, and this machine holds no checkpoint of the run to render it from` };
}

export async function runLineTry(args: LineTryArgs, deps: LineTryDeps): Promise<{ ran: number; not_tryable: number; failed: number }> {
  const tally = { ran: 0, not_tryable: 0, failed: 0 };
  const queue = [...args.cases];
  const one = async (c: LineTryCase) => {
    const brief = await caseBrief(args, c, deps.fromCheckpoint);
    if ("reason" in brief) {
      tally.not_tryable++;
      await deps.report(c.row_id, { status: "not_tryable", reason: brief.reason });
      return;
    }
    await deps.report(c.row_id, { status: "running", via: brief.via });
    const dir = deps.runDir(args.try_id, c.row_id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const promptFile = path.join(path.dirname(dir), `${path.basename(dir)}.prompt.md`);
    fs.writeFileSync(promptFile, brief.text);
    const started = Date.now();
    try {
      const code = await deps.harness([deps.harnessScript, "--run", dir, "--prompt", promptFile, "--model", args.model, "--cwd", args.root, "--read-only"], { cwd: args.root });
      const read = (f: string) => { try { return fs.readFileSync(path.join(dir, f), "utf8"); } catch { return ""; } };
      let out: any = null;
      try { out = JSON.parse(read("out.json")); } catch { /* no result */ }
      let said: string[] = [];
      try { said = JSON.parse(read("said.json")); } catch { /* none */ }
      const decision = decisionFromRun(read("stream.jsonl"), said);
      const reply = (said[said.length - 1] ?? out?.result ?? "").slice(0, 8000);
      if (!out && code !== 0) {
        tally.failed++;
        await deps.report(c.row_id, { status: "failed", via: brief.via, reason: (read("err.txt").trim().split("\n").pop() || `the dry run exited ${code}`).slice(0, 400), refused: refusedCalls(read("calls.log")), took_ms: Date.now() - started });
        return;
      }
      tally.ran++;
      await deps.report(c.row_id, {
        status: "done", via: brief.via, decision, reply,
        ...(typeof out?.total_cost_usd === "number" ? { cost_usd: out.total_cost_usd } : {}),
        ...(typeof out?.num_turns === "number" ? { turns: out.num_turns } : {}),
        refused: refusedCalls(read("calls.log")), took_ms: Date.now() - started,
      });
    } catch (err) {
      tally.failed++;
      await deps.report(c.row_id, { status: "failed", via: brief.via, reason: (err instanceof Error ? err.message : String(err)).slice(0, 400) }).catch(() => {});
    } finally {
      fs.rmSync(promptFile, { force: true });
    }
  };
  await Promise.all(Array.from({ length: Math.min(TRY_CONCURRENCY, queue.length) }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) await one(c);
  }));
  return tally;
}

// ── this machine's pieces ────────────────────────────────────────────────────

/** The dry-run harness beside this source tree, or null in a build that does not carry it. */
export function harnessScriptPath(): string | null {
  const p = path.resolve(import.meta.dir, "../scripts/prompt-dry-run.ts");
  return fs.existsSync(p) ? p : null;
}

/** A case's run dir: under the machine's own temp dir, which the try's sandbox opens to it alone. */
export const tryRunDir = (tryId: string, rowId: string) =>
  path.join(fs.realpathSync(os.tmpdir()), "cast-line-try", tryId.replace(/[^\w-]/g, ""), rowId.replace(/[^\w-]/g, ""));

/** The newest checkpoint of `runId` under the checkout's run dirs (runner.ts lineRunDir, runResume.ts checkpointPath). */
export function findCheckpointFile(root: string, runId: string): string | null {
  const r = spawnSync("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const common = r.status === 0 ? r.stdout.trim() : "";
  const base = common ? path.join(common, "cast-line") : path.join(os.tmpdir(), "cast-line");
  const name = `${runId.replace(/[^\w-]/g, "")}.json`;
  let best: { file: string; at: number } | null = null;
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(base); } catch { return null; }
  for (const d of dirs) {
    const file = path.join(base, d, "runs", name);
    try {
      const at = fs.statSync(file).mtimeMs;
      if (!best || at > best.at) best = { file, at };
    } catch { /* not here */ }
  }
  return best?.file ?? null;
}

/** Run the harness under bun, resolving with its exit code. */
export function spawnHarness(argv: string[], opts: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(path.basename(process.execPath) === "bun" ? process.execPath : "bun", argv, { cwd: opts.cwd, stdio: "ignore", env: opts.env ?? process.env });
    const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* gone */ } }, opts.timeoutMs ?? 30 * 60_000);
    child.on("exit", (code) => { clearTimeout(timer); resolve(code ?? 1); });
    child.on("error", () => { clearTimeout(timer); resolve(127); });
  });
}

/**
 * The brief a case's station would get from the new template, rendered the
 * way the runner renders it (buildNodePrompt, then the unattended frame) from
 * the context the run's checkpoint on this machine holds. Null without one.
 */
export async function briefFromCheckpoint(castAbs: string, root: string, nodeId: string, newTemplate: string, runId: string): Promise<string | null> {
  const file = findCheckpointFile(root, runId);
  if (!file) return null;
  let context: Record<string, string>;
  try {
    context = JSON.parse(fs.readFileSync(file, "utf8"))?.context;
  } catch {
    return null;
  }
  if (!context || typeof context !== "object") return null;
  const [{ parseWorkflowFile }, { buildNodePrompt }, { applyUnattended }] = await Promise.all([
    import("./workflow/parser.js"), import("./workflow/runner.js"), import("./unattended.js"),
  ]);
  const graph = parseWorkflowFile(castAbs);
  const node = graph.nodes.get(nodeId);
  if (!node) return null;
  node.prompt = newTemplate;
  if (graph.goal) graph.goal = graph.goal.replace(/\$(\w+)/g, (_, key) => context[key] || `$${key}`);
  return applyUnattended(buildNodePrompt(node, graph, context));
}
