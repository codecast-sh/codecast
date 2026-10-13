// The parts of a presenter replay (scripts/line-present-replay.ts) that hold
// logic: finding a problem's checkpoint, building the station's opening
// message the way the runner does, reading what the recording guard kept of
// each write, folding the `cast decide` calls into the decision the founder
// would have seen, and drawing that decision as one standalone page.
import * as fs from "node:fs";
import * as path from "node:path";
import { Command } from "commander";
import { previewDecisionPage } from "../../src/decisionKit.ts";
import { parseDecideOption, parseDecideSpec, registerDecideCommand } from "../../src/decideCommand.ts";
import { parseWorkflowFile } from "../../src/workflow/parser.ts";
import { stationBrief } from "../../src/workflow/runner.ts";
import { parseProductViewRef } from "../../../shared/contracts/productView.ts";
import { PAGE_HEIGHT_MESSAGE, injectPageTheme } from "../../../shared/render/pageTheme.ts";

// ─── Checkpoints ──────────────────────────────────────────

export interface Checkpoint {
  file: string;
  run_id: string;
  node_id: string;
  at: number;
  context: Record<string, string>;
}

/** Every run checkpoint of one problem under one graph, newest first. A
 *  checkpoint's own `at` orders them; a file without one falls back to its mtime. */
export function problemCheckpoints(repo: string, graphName: string, ref: string): Checkpoint[] {
  const dir = path.join(repo, ".git", "cast-line", `${graphName}-${ref}`, "runs");
  if (!fs.existsSync(dir)) return [];
  const found: Checkpoint[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!raw?.context) continue;
      found.push({ file, run_id: String(raw.run_id ?? name.slice(0, -5)), node_id: String(raw.node_id ?? ""), at: Number(raw.at) || fs.statSync(file).mtimeMs, context: raw.context });
    } catch { /* a checkpoint cut mid-write is not a run to replay */ }
  }
  return found.sort((a, b) => b.at - a.at);
}

/** The problems that have a checkpoint under this graph (`ct-N`, in order). */
export function checkpointRefs(repo: string, graphName: string): string[] {
  const root = path.join(repo, ".git", "cast-line");
  if (!fs.existsSync(root)) return [];
  const prefix = `${graphName}-`;
  return fs.readdirSync(root)
    .filter((d) => d.startsWith(prefix) && /^ct-\d+$/.test(d.slice(prefix.length)))
    .map((d) => d.slice(prefix.length))
    .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
}

/** A station's JSON output as the runner keeps it (`<node>.json`, a string), parsed; `{}` when absent or not JSON. */
export function stationJson(context: Record<string, string>, node: string): any {
  try { return JSON.parse(context[`${node}.json`] || "{}") ?? {}; } catch { return {}; }
}

/**
 * The context the presenter reads on a first visit. A finished run's
 * checkpoint also holds what came AFTER the presenter: its own earlier
 * output, the card built from its words, and the gate's answer. Left in, the
 * prompt would read "why the last card refused your fields" as the finished
 * card and could copy the earlier presenter's words, so everything from the
 * station on is dropped. `fresh` replaces single keys (today's shared text,
 * a card draft rebuilt now).
 */
export function replayContext(context: Record<string, string>, station: string, after: string[], fresh: Record<string, string> = {}): Record<string, string> {
  const dropped = [station, ...after];
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(context)) {
    if (dropped.some((n) => k === n || k.startsWith(`${n}.`))) continue;
    if (k === "human.message" || k.startsWith("human.gate")) continue;
    out[k] = v;
  }
  return { ...out, ...fresh, "human.message": "" };
}

/**
 * The station's opening message, built by the runner's own function with the
 * node's prompt swapped for `promptText`. The runner expands the graph's goal
 * once at the start of a run and keeps it in the context as `goal`; a replay
 * reads it from there.
 */
export function presenterPrompt(graphFile: string, station: string, promptText: string, context: Record<string, string>): string {
  const graph = parseWorkflowFile(graphFile);
  const node = graph.nodes.get(station);
  if (!node) throw new Error(`${graphFile} has no node "${station}"`);
  if (context.goal !== undefined) graph.goal = context.goal;
  return stationBrief({ ...node, prompt: promptText }, graph, context);
}

/**
 * The nodes between `station` and the next person: what the run makes from
 * the station's output before anyone answers (the card built from its words,
 * the gate that asks). A first visit has seen none of it. The walk stops at a
 * gate, since past one the graph loops back through the stations before.
 */
export function nodesAfter(graphFile: string, station: string): string[] {
  const graph = parseWorkflowFile(graphFile);
  const seen = new Set<string>();
  const queue = [station];
  while (queue.length) {
    const from = queue.shift()!;
    for (const edge of graph.edges) {
      if (edge.from !== from || seen.has(edge.to) || edge.to === station) continue;
      seen.add(edge.to);
      if (graph.nodes.get(edge.to)?.type !== "human") queue.push(edge.to);
    }
  }
  return [...seen];
}

/** The `$names` a prompt reads, each with whether this context fills it. */
export function promptVariables(promptText: string, context: Record<string, string>, expand: (name: string) => string): { name: string; filled: boolean }[] {
  const names = new Set<string>();
  for (const m of promptText.matchAll(/\$(\w+(?:\.\w+)*)/g)) names.add(m[1]);
  return [...names].map((name) => ({ name, filled: expand(name) !== "" }));
}

// ─── What the fix is ──────────────────────────────────────

export type FixKind = "prompt" | "code" | "prompt+code" | "none";

/** Tests, recorded cases and repro scripts ride along with a fix; they are not the fix. */
export function isSupportFile(file: string): boolean {
  return /(^|\/)(tests?|__tests__|fixtures|__fixtures__)\//.test(file)
    || /(^|\/)(scripts\/(repro|forensics|eval)|scratchpad)\//.test(file)
    || /\.(test|spec)\.[a-z]+$/.test(file);
}

export function isPromptFile(file: string): boolean {
  return /\.(njk|md|txt|prompt)$/.test(file) || /(^|\/)prompts\//.test(file);
}

/** Whether a fix changes what Union is told (prompt files), what it does (code), or both. */
export function fixKind(files: string[]): { kind: FixKind; prompt: string[]; code: string[]; support: string[] } {
  const support = files.filter(isSupportFile);
  const real = files.filter((f) => !isSupportFile(f));
  const prompt = real.filter(isPromptFile);
  const code = real.filter((f) => !isPromptFile(f));
  const kind: FixKind = prompt.length && code.length ? "prompt+code" : prompt.length ? "prompt" : code.length ? "code" : "none";
  return { kind, prompt, code, support };
}

// ─── What the guard recorded ──────────────────────────────

export interface WriteRecord {
  n: number;
  argv: string[];
  /** The piped body, when an argument was a bare `-`. */
  stdin: string | null;
  /** Files an argument named, by the path as the argument gave it: the copy the guard took at call time. */
  files: Record<string, string>;
}

/** Every write the recording guard kept under `<run>/writes`, in call order. */
export function readWrites(runDir: string): WriteRecord[] {
  const root = path.join(runDir, "writes");
  if (!fs.existsSync(root)) return [];
  const out: WriteRecord[] = [];
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    const argvFile = path.join(dir, "argv");
    if (!/^\d+$/.test(name) || !fs.existsSync(argvFile)) continue;
    const argv = fs.readFileSync(argvFile, "utf8").split("\0");
    if (argv[argv.length - 1] === "") argv.pop();
    const stdinFile = path.join(dir, "stdin");
    const files: Record<string, string> = {};
    const tsv = path.join(dir, "files.tsv");
    if (fs.existsSync(tsv)) {
      for (const line of fs.readFileSync(tsv, "utf8").split("\n")) {
        const tab = line.indexOf("\t");
        if (tab > 0) files[line.slice(tab + 1)] = path.join(dir, "files", line.slice(0, tab));
      }
    }
    out.push({ n: Number(name), argv, stdin: fs.existsSync(stdinFile) ? fs.readFileSync(stdinFile, "utf8") : null, files });
  }
  return out.sort((a, b) => a.n - b.n);
}

/** `cast decide`'s own option table, read without running its action: the argv parses as the CLI would parse it. */
export function parseDecideArgv(args: string[]): { operands: string[]; opts: Record<string, any> } {
  const program = new Command();
  registerDecideCommand(program, {} as any);
  const decide = program.commands.find((c) => c.name() === "decide")!;
  const { operands } = decide.parseOptions(args);
  return { operands, opts: decide.opts() };
}

/** The text options that take `-`, in the order the CLI hands stdin sections out. */
const STDIN_TEXT_OPTIONS = ["question", "context", "doc", "note"] as const;

/** Stdin for each `-` value: one `-` takes it whole (less the transport newline), several split it on lines holding only `---`. */
export function stdinSections(stdin: string | null, count: number): string[] {
  const body = (stdin ?? "").replace(/\r?\n$/, "");
  if (count <= 1) return [body];
  return body.split(/^---[ \t]*$/m).map((s) => s.replace(/^\r?\n/, "").replace(/\r?\n$/, ""));
}

export interface CapturedOption {
  label: string;
  description?: string;
  body_md?: string;
  page?: { path: string; content: string | null };
}

export interface CapturedReport {
  path: string;
  kind: "html" | "md";
  content: string | null;
}

export interface CapturedDecision {
  question: string;
  options: CapturedOption[];
  context: string;
  report: CapturedReport | null;
  doc: string | null;
  kind: string;
  advisory: boolean;
  default: number | null;
  /** How many times the station posted a decision, and edited one. The capture is the last post with its edits applied. */
  posts: number;
  edits: number;
  cancelled: boolean;
  /** The write records it was folded from (`writes/<n>`). */
  from: number[];
  /** What the call named and the record does not hold (a report file gone before the copy, a `-` with no stdin). */
  missing: string[];
}

function readCopy(record: WriteRecord, named: string): string | null {
  const copy = record.files[named];
  return copy && fs.existsSync(copy) ? fs.readFileSync(copy, "utf8") : null;
}

function reportKind(file: string, content: string | null): "html" | "md" {
  if (/\.html?$/i.test(file)) return "html";
  if (/\.(md|markdown|txt)$/i.test(file)) return "md";
  return content && /^\s*(<!doctype|<html|<div|<style|<section|<main)/i.test(content) ? "html" : "md";
}

/**
 * The decision the founder would have seen: the station's last `cast decide`
 * post with every later `cast decide edit` applied. Null when it posted none.
 */
export function captureDecision(writes: WriteRecord[]): CapturedDecision | null {
  let current: CapturedDecision | null = null;
  let posts = 0;
  let edits = 0;
  for (const record of writes) {
    if (record.argv[0] !== "decide") continue;
    const { operands, opts } = parseDecideArgv(record.argv.slice(1));
    const verb = operands[0];
    if (verb === "cancel") { if (current) current.cancelled = true; continue; }
    if (verb && ["answer", "recommend", "pass", "ls", "show", "kit"].includes(verb)) continue;
    const editing = verb === "edit";
    const missing: string[] = [];

    const dashes = STDIN_TEXT_OPTIONS.filter((k) => opts[k] === "-");
    if (dashes.length && record.stdin === null) missing.push(`stdin for ${dashes.map((k) => `--${k} -`).join(", ")}`);
    const sections = stdinSections(record.stdin, dashes.length);
    const text = (key: (typeof STDIN_TEXT_OPTIONS)[number]): string | undefined => {
      const value = opts[key];
      if (value === undefined) return undefined;
      return value === "-" ? sections[dashes.indexOf(key)] ?? "" : String(value);
    };
    const fileText = (flag: string, named: string): string | null => {
      const content = readCopy(record, named);
      if (content === null) missing.push(`${flag} ${named}: the file was not there to copy`);
      return content;
    };

    let spec: ReturnType<typeof parseDecideSpec> = {};
    if (opts.spec) {
      const specText = fileText("--spec", opts.spec);
      if (specText !== null) { try { spec = parseDecideSpec(specText); } catch (err: any) { missing.push(`--spec ${opts.spec}: ${err?.message ?? err}`); } }
    }

    const question = editing ? text("question") : (operands[0] ?? spec.question);
    const optionFlags: string[] = opts.option ?? [];
    let options: CapturedOption[] | undefined = optionFlags.length
      ? optionFlags.map(parseDecideOption)
      : spec.options?.map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}), ...(o.body_md ? { body_md: o.body_md } : {}) }));
    const perOption = (flag: "optionBody" | "optionPage", apply: (o: CapturedOption, file: string, content: string | null) => void) => {
      for (const raw of (opts[flag] ?? []) as string[]) {
        const eq = raw.indexOf("=");
        const index = Number(raw.slice(0, eq)) - 1;
        const file = raw.slice(eq + 1);
        const target = (options ?? current?.options ?? [])[index];
        if (eq < 1 || !target) { missing.push(`--${flag === "optionBody" ? "option-body" : "option-page"} ${raw}: no such option`); continue; }
        // A page may be a slug or a url of a page that already exists; only a file has content to show.
        const isFile = record.files[file] !== undefined;
        apply(target, file, isFile ? readCopy(record, file) : null);
      }
    };
    const context = text("context") ?? (editing ? undefined : spec.context_md);
    const doc = text("doc") ?? (editing ? undefined : spec.doc_md);
    const report: CapturedReport | null | undefined = opts.report
      ? (() => { const content = fileText("--report", opts.report); return { path: opts.report, kind: reportKind(opts.report, content), content }; })()
      : undefined;

    if (editing) {
      if (!current) continue;
      edits++;
      if (question !== undefined) current.question = question;
      if (options) current.options = options;
      if (context !== undefined) current.context = context;
      if (doc !== undefined) current.doc = doc;
      if (report !== undefined) current.report = report;
      if (opts.advisory) current.advisory = true;
      if (opts.blocking) { current.advisory = false; current.default = null; }
      if (opts.default) current.default = Number(opts.default);
      if (opts.kind) current.kind = String(opts.kind);
    } else {
      posts++;
      current = {
        question: question ?? "", options: options ?? [], context: context ?? "", report: report ?? null, doc: doc ?? null,
        kind: String(opts.kind ?? spec.kind ?? (opts.line ? "form" : "single")),
        advisory: !!(opts.advisory ?? spec.advisory), default: opts.default ? Number(opts.default) : spec.default ?? null,
        posts: 0, edits: 0, cancelled: false, from: [], missing: [],
      };
    }
    perOption("optionBody", (o, _file, content) => { if (content !== null) o.body_md = content; });
    perOption("optionPage", (o, file, content) => { o.page = { path: file, content }; });
    current.from.push(record.n);
    current.missing.push(...missing);
  }
  if (current) { current.posts = posts; current.edits = edits; }
  return current;
}

export interface CapturedPin {
  status: string | null;
  text: string;
  /** The fenced json block of the pin, parsed: the fields the graph reads as `$<station>.json`. */
  fields: any | null;
}

/** The station's last `cast state` pin: its report, and the fenced json block the graph reads its fields from. */
export function capturePin(writes: WriteRecord[]): CapturedPin | null {
  const pins = writes.filter((w) => w.argv[0] === "state");
  const last = pins[pins.length - 1];
  if (!last) return null;
  const args = last.argv.slice(1);
  const statusAt = args.indexOf("--status");
  const status = statusAt >= 0 ? args[statusAt + 1] ?? null : null;
  const positional = args.filter((a, i) => !a.startsWith("--") && !(statusAt >= 0 && i === statusAt + 1));
  const text = positional.includes("-") ? stdinSections(last.stdin, 1)[0] : positional.join(" ");
  const fence = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)].pop();
  let fields: any = null;
  if (fence) { try { fields = JSON.parse(fence[1]); } catch { /* the pin's block is not JSON: the graph would read nothing either */ } }
  return { status, text, fields };
}

// ─── The preview page ─────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CANVAS_FENCE = /^```cast-canvas[^\n]*\n([\s\S]*?)^```[ \t]*$/gm;

/** A cast-canvas block as codecast frames it: themed with the --sol tokens, no scripts, no network. */
function canvasFrame(html: string): string {
  const title = /data-canvas-title="([^"]*)"/.exec(html)?.[1];
  const doc = injectPageTheme(
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: https://codecast.sh https://*.codecast.sh https://*.convex.cloud https://*.r2.dev">` +
    `<style>html,body{margin:0;background:transparent}body{color:var(--sol-text);font-family:var(--font-mono),ui-monospace,monospace;font-size:13px;line-height:1.5;padding:12px}a{color:var(--sol-blue)}</style></head><body>${html}</body></html>`,
  );
  return `<figure class="canvas">${title ? `<figcaption>${esc(title)}</figcaption>` : ""}<iframe class="fit" sandbox="allow-same-origin" srcdoc="${esc(doc)}"></iframe></figure>`;
}

/** A product view reference in running text, as the pill codecast draws for it. */
function productViewPills(html: string): string {
  return html.replace(/(^|[\s(>])([a-z][a-z0-9-]*:[a-z][a-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_-]{7,}(?:@[0-9T:.+\-Z]+)?)(?=[\s<).,;]|$)/g, (whole, lead: string, raw: string) => {
    const ref = parseProductViewRef(raw);
    if (!ref) return whole;
    const when = ref.at ? ` as of ${ref.at.replace("T", " ").replace(/:\d{2}(\.\d+)?Z$/, "Z")}` : "";
    return `${lead}<span class="pv" title="${esc(raw)}">${esc(ref.app)} ${esc(ref.view)}${esc(when)}</span>`;
  });
}

/** Markdown the way a decision's context renders: prose through the markdown renderer, each cast-canvas fence as a framed canvas. */
export function renderDecisionMarkdown(md: string): string {
  const parts: string[] = [];
  let last = 0;
  for (const m of md.matchAll(CANVAS_FENCE)) {
    parts.push(productViewPills(Bun.markdown.html(md.slice(last, m.index))));
    parts.push(canvasFrame(m[1]));
    last = m.index! + m[0].length;
  }
  parts.push(productViewPills(Bun.markdown.html(md.slice(last))));
  return parts.join("\n");
}

export interface PreviewMeta {
  ref: string;
  title?: string;
  prompt: string;
  model: string;
  took?: string;
  cost?: number | null;
  turns?: number | null;
  /** The agent's last message, shown when it posted no decision. */
  said?: string;
  /** Sibling files of the preview worth a link (decision.json, context.md, the report, the prompt). */
  links?: { label: string; href: string }[];
}

const words = (s: string) => (s.trim().match(/\S+/g) ?? []).length;

const PREVIEW_CSS = `
*{box-sizing:border-box}
html{background:var(--sol-bg);color:var(--sol-text);font-family:var(--font-mono),ui-monospace,monospace;font-size:14px;line-height:1.6}
body{margin:0}
a{color:var(--sol-blue)}
.rig{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:baseline;padding:8px 20px;font-size:11.5px;color:var(--sol-text-dim);border-bottom:1px solid color-mix(in srgb,var(--sol-border) 40%,transparent);background:var(--sol-bg-alt)}
.rig b{color:var(--sol-text-muted);font-weight:600}
.rig .gap{color:var(--sol-red)}
.rig .grow{flex:1}
.main{max-width:720px;margin:0 auto;padding:36px 20px 8px}
h1.q{font-family:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;font-weight:500;font-size:clamp(1.5rem,1.1rem + 1.6vw,2.1rem);line-height:1.2;letter-spacing:-0.01em;text-wrap:balance;margin:0 0 20px}
.md>*:first-child{margin-top:0}
.md p,.md ul,.md ol,.md blockquote,.md table,.md pre{margin:0 0 14px}
.md h1,.md h2,.md h3{font-size:1rem;margin:22px 0 8px}
.md blockquote{padding:8px 14px;border-left:3px solid var(--sol-cyan);background:color-mix(in srgb,var(--sol-cyan) 8%,transparent);border-radius:0 6px 6px 0}
.md blockquote>*:last-child{margin-bottom:0}
.md code{padding:1px 5px;border-radius:4px;background:var(--sol-bg-alt);font-size:.92em}
.md pre{padding:12px 14px;border-radius:8px;background:var(--sol-bg-alt);overflow:auto}
.md pre code{padding:0;background:none}
.md table{border-collapse:collapse;width:100%;font-size:.93em}
.md th,.md td{padding:6px 10px;border-bottom:1px solid color-mix(in srgb,var(--sol-border) 40%,transparent);text-align:left;vertical-align:top}
.md img{max-width:100%}
.pv{display:inline-block;padding:0 7px;border-radius:999px;font-size:.88em;color:var(--sol-violet);background:color-mix(in srgb,var(--sol-violet) 10%,transparent);border:1px solid color-mix(in srgb,var(--sol-violet) 30%,transparent)}
figure.canvas{margin:0 0 16px;border:1px solid color-mix(in srgb,var(--sol-border) 45%,transparent);border-radius:10px;background:var(--sol-card);overflow:hidden}
figure.canvas figcaption{padding:6px 12px;font-size:12px;color:var(--sol-text-muted);border-bottom:1px solid color-mix(in srgb,var(--sol-border) 30%,transparent)}
iframe{display:block;width:100%;border:0}
iframe.fit{height:120px}
.answers{max-width:720px;margin:0 auto;padding:10px 20px 28px}
.answers h2{font-size:12px;font-weight:600;color:var(--sol-text-muted);margin:0 0 10px}
.opts{display:grid;gap:8px}
.opt{display:flex;gap:10px;padding:12px 14px;border:1px solid color-mix(in srgb,var(--sol-border) 60%,transparent);border-radius:10px;background:var(--sol-card)}
.opt .n{flex:none;width:20px;height:20px;border-radius:5px;border:1px solid var(--sol-border);font-size:11px;display:grid;place-items:center;color:var(--sol-text-dim)}
.opt .l{font-weight:600}
.opt .d{color:var(--sol-text-muted);font-size:13px;margin-top:2px}
.opt .b{margin-top:8px;font-size:13px}
.own{margin-top:10px;padding:10px 14px;border:1px dashed color-mix(in srgb,var(--sol-border) 70%,transparent);border-radius:10px;color:var(--sol-text-dim)}
.none{max-width:720px;margin:0 auto;padding:48px 20px}
.none h1{font-size:1.2rem;margin:0 0 12px;color:var(--sol-red)}
.none pre{white-space:pre-wrap;padding:14px;border-radius:8px;background:var(--sol-bg-alt)}
.report{border-top:1px solid color-mix(in srgb,var(--sol-border) 40%,transparent);background:var(--sol-bg)}
.report>h2{max-width:720px;margin:0 auto;padding:18px 20px 10px;font-size:12px;font-weight:600;color:var(--sol-text-muted)}
.report iframe{height:80vh;background:var(--sol-bg)}
.report .md{max-width:720px;margin:0 auto;padding:0 20px 48px}
`;

// Fit each scriptless canvas frame to its content (same origin, so the page
// reads it), and the report frame from the height its theme bootstrap posts,
// the message a published page sends its frame in codecast.
const PREVIEW_SCRIPT = `
function fit(f){try{var d=f.contentDocument;if(d&&d.body)f.style.height=Math.ceil(d.body.getBoundingClientRect().height)+"px";}catch(e){}}
document.querySelectorAll("iframe.fit").forEach(function(f){f.addEventListener("load",function(){fit(f)});fit(f);});
addEventListener("resize",function(){document.querySelectorAll("iframe.fit").forEach(fit)});
addEventListener("message",function(e){var m=e.data;if(!m||m.type!==${JSON.stringify(PAGE_HEIGHT_MESSAGE)})return;document.querySelectorAll("iframe.page").forEach(function(f){if(f.contentWindow===e.source)f.style.height=Math.max(200,m.height)+"px";});});
`;

/**
 * One standalone page that shows a captured decision in the order codecast
 * does: the question as the title, the context as rendered markdown with its
 * canvases, the answers as the station wrote them and the free answer, then
 * the report at full width. A thin strip on top is the replay's own: which
 * case, which prompt, what the run cost, and what the capture is missing.
 */
export function renderPreview(decision: CapturedDecision | null, meta: PreviewMeta): string {
  const rig: string[] = [
    `<b>${esc(meta.ref)}</b>${meta.title ? ` ${esc(meta.title)}` : ""}`,
    `prompt <b>${esc(path.basename(meta.prompt))}</b>`,
    `<b>${esc(meta.model)}</b>`,
    ...(meta.took ? [esc(meta.took)] : []),
    ...(meta.cost != null ? [`$${meta.cost.toFixed(2)}`] : []),
    ...(meta.turns != null ? [`${meta.turns} turns`] : []),
  ];
  const links = (meta.links ?? []).map((l) => `<a href="${esc(l.href)}">${esc(l.label)}</a>`).join(" ");
  let body: string;
  if (!decision) {
    rig.push(`<span class="gap">no decision posted</span>`);
    body = `<section class="none"><h1>The station posted no decision</h1><p>No <code>cast decide</code> call was recorded in this run. Its last message:</p><pre>${esc(meta.said ?? "(none)")}</pre></section>`;
  } else {
    rig.push(`context ${words(decision.context)} words`, `${decision.options.length} answers`);
    if (decision.posts > 1 || decision.edits) rig.push(`${decision.posts} posts, ${decision.edits} edits`);
    if (decision.cancelled) rig.push(`<span class="gap">cancelled by the station</span>`);
    if (!decision.report) rig.push(`<span class="gap">no report</span>`);
    for (const gap of decision.missing) rig.push(`<span class="gap">${esc(gap)}</span>`);
    const options = decision.options.map((o, i) =>
      `<div class="opt"><span class="n">${i + 1}</span><div><div class="l">${esc(o.label)}${decision.default === i + 1 ? " (default)" : ""}</div>` +
      `${o.description ? `<div class="d">${esc(o.description)}</div>` : ""}${o.body_md ? `<div class="b md">${renderDecisionMarkdown(o.body_md)}</div>` : ""}` +
      `${o.page ? `<div class="d">page: ${esc(o.page.path)}</div>` : ""}</div></div>`).join("");
    const report = decision.report
      ? decision.report.content === null
        ? `<section class="report"><h2>Report (${esc(decision.report.path)})</h2><div class="md"><p>The file was not there when the station named it.</p></div></section>`
        : decision.report.kind === "html"
          ? `<section class="report"><h2>Report</h2><iframe class="page" sandbox="allow-scripts allow-popups" srcdoc="${esc(previewDecisionPage(decision.report.content))}"></iframe></section>`
          : `<section class="report"><h2>Report</h2><div class="md">${renderDecisionMarkdown(decision.report.content)}</div></section>`
      : "";
    body =
      `<main class="main"><h1 class="q">${esc(decision.question)}</h1><div class="md">${renderDecisionMarkdown(decision.context)}</div>` +
      `${decision.doc ? `<div class="md">${renderDecisionMarkdown(decision.doc)}</div>` : ""}</main>` +
      `<section class="answers"><h2>Answers</h2><div class="opts">${options}</div><div class="own">Or answer in your own words</div></section>${report}`;
  }
  return injectPageTheme(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(meta.ref)}: ${esc(decision?.question ?? "no decision")}</title><style>${PREVIEW_CSS}</style></head><body>` +
    `<div class="rig">${rig.map((r) => `<span>${r}</span>`).join("")}<span class="grow"></span>${links}</div>${body}<script>${PREVIEW_SCRIPT}</script></body></html>`,
  );
}
