// A Claude Code workflow becomes a flow of the pool (docs/architecture/flows.md
// FL5). The script runs in a sandbox where agent, parallel, pipeline, phase,
// log and workflow are recording stand-ins: no model, no network, no files.
// Each agent call is recorded with its label, phase, prompt and schema, and
// answers with a placeholder shaped like its schema, so the script's own
// loops and branches play out. The recording is then shaped into a graph:
// a station per distinct agent call, calls made side by side as a fan-out,
// a round that repeats as a loop back, the script's phases as stages.
import { spawnSync } from "../proc.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import { parseWorkflowSource, validateWorkflow } from "./parser.js";

export type TracedCall = {
  seq: number;
  kind: "agent" | "workflow";
  prompt: string;
  label: string | null;
  phase: string | null;
  schema: unknown;
  /** Calls made side by side (one parallel() or one pipeline stage) share a group. */
  group: number | null;
  /** For a workflow() call: the flow it names. */
  flow?: string;
};

export type ScriptTrace = {
  meta: { name?: string; description?: string; phases?: Array<{ title: string; detail?: string }> };
  calls: TracedCall[];
  /** Set when the script did not run to its end in the sandbox (it read something absent, or looped past the cap). */
  stopped: string | null;
};

const CALL_CAP = 300;

/** A value shaped like a JSON schema, as empty as the schema allows: no items, zeros, empty strings. */
export function placeholderFor(schema: any): unknown {
  if (!schema || typeof schema !== "object") return "";
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "array") return [];
  if (type === "number" || type === "integer") return 0;
  if (type === "boolean") return false;
  if (type === "string") return "";
  if (type === "null") return null;
  if (type === "object" || schema.properties) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema.properties ?? {})) out[k] = placeholderFor(v);
    return out;
  }
  return "";
}

class TraceStop extends Error {}

/** Run a workflow script with recording stand-ins and return what it would have asked for. */
export async function traceWorkflowScript(source: string, args: unknown = {}): Promise<ScriptTrace> {
  const calls: TracedCall[] = [];
  let currentPhase: string | null = null;
  let group: number | null = null;
  let groups = 0;
  const record = (c: Omit<TracedCall, "seq" | "group">) => {
    if (calls.length >= CALL_CAP) throw new TraceStop(`the script asked for more than ${CALL_CAP} agents with placeholder answers, so its loop was cut there`);
    calls.push({ ...c, seq: calls.length, group });
  };
  const agent = async (prompt: unknown, opts: any = {}) => {
    record({ kind: "agent", prompt: String(prompt ?? ""), label: opts?.label ?? null, phase: opts?.phase ?? currentPhase, schema: opts?.schema ?? null });
    return opts?.schema ? placeholderFor(opts.schema) : "";
  };
  const inGroup = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const outer = group;
    group = ++groups;
    try { return await fn(); } finally { group = outer; }
  };
  const parallel = (thunks: Array<() => Promise<unknown>>) => inGroup(async () => {
    const out: unknown[] = [];
    for (const t of thunks ?? []) {
      try { out.push(await t()); } catch (err) { if (err instanceof TraceStop) throw err; out.push(null); }
    }
    return out;
  });
  const pipeline = async (items: unknown[], ...stages: Array<(prev: unknown, item: unknown, i: number) => unknown>) => {
    let results: unknown[] = [...(items ?? [])];
    for (const stage of stages) {
      results = await inGroup(async () => {
        const next: unknown[] = [];
        for (const [i, prev] of results.entries()) {
          if (prev === null && i < (items ?? []).length && results !== items) { next.push(null); continue; }
          try { next.push(await stage(prev, (items ?? [])[i], i)); } catch (err) { if (err instanceof TraceStop) throw err; next.push(null); }
        }
        return next;
      });
    }
    return results;
  };
  const workflow = async (ref: unknown) => {
    const name = typeof ref === "string" ? ref : (ref as any)?.scriptPath ? path.basename(String((ref as any).scriptPath)).replace(/\.[cm]?js$/, "") : "workflow";
    record({ kind: "workflow", prompt: "", label: name, phase: currentPhase, schema: null, flow: name });
    return null;
  };
  const sandbox = {
    agent, parallel, pipeline, workflow,
    phase: (title: unknown) => { currentPhase = String(title ?? ""); },
    log: () => {},
    args: args ?? {},
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    __meta: {} as ScriptTrace["meta"],
  };
  const body = source.replace(/^\s*export\s+const\s+meta\s*=/m, "__meta =");
  let stopped: string | null = null;
  try {
    const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    const run = new vm.Script(`(async () => {\n${body}\n})()`, { filename: "workflow.js" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new TraceStop("the script was still running after 10s with placeholder answers")), 10_000); });
    try { await Promise.race([run.runInContext(ctx, { timeout: 5000 }), late]); } finally { clearTimeout(timer); }
  } catch (err) {
    stopped = err instanceof TraceStop ? err.message : `the script stopped in the sandbox: ${err instanceof Error ? err.message : String(err)}`;
  }
  return { meta: (sandbox as any).__meta ?? {}, calls, stopped };
}

// ── shaping the trace ────────────────────────────────────────────────────────

/** A station's key: its label (or its prompt's head) with round numbers taken out, so round 2 is round 1 again. */
export function stationKey(c: Pick<TracedCall, "label" | "prompt" | "phase">): string {
  const base = c.label ?? `${c.phase ?? "step"} ${c.prompt.trim().split(/\s+/).slice(0, 6).join(" ")}`;
  return base.toLowerCase().replace(ROUND, "").replace(/\d+/g, "#").replace(/[\s:_-]+$/g, "").replace(/\s+/g, " ").trim();
}

/** A round number in a label ("critique:r2", "review round 3"): the step runs in a loop the script drives. */
const ROUND = /[\s:_-]*\b(round|r|pass|iter|attempt|try)\s*[-:#]?\s*\d+\b/g;
export const inRounds = (label: string | null) => !!label && new RegExp(ROUND.source).test(label.toLowerCase());

const idFrom = (key: string) => key.replace(/#/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "step";
const labelFrom = (key: string) => key.replace(/#/g, "").replace(/[:_-]+/g, " ").replace(/\s+/g, " ").trim().replace(/^\w/, (ch) => ch.toUpperCase());

export type ShapedStation = { id: string; label: string; key: string; phase: string | null; prompt: string; schema: unknown; flow?: string; visits: number; /** Its label carried a round number: the script runs it in rounds. */ rounds: boolean };
export type ShapedStep = { stations: string[] };
export type ShapedFlow = { stations: Map<string, ShapedStation>; steps: ShapedStep[]; loops: Array<{ from: number; to: number; rounds: number }> };

/** The trace as steps in order (one station, or several side by side) and the loops the rounds made. */
export function shapeTrace(trace: ScriptTrace): ShapedFlow {
  const stations = new Map<string, ShapedStation>();
  const byKey = new Map<string, string>();
  const ids = new Set<string>();
  const stationFor = (c: TracedCall) => {
    const key = stationKey(c);
    let id = byKey.get(key);
    if (id) {
      stations.get(id)!.visits++;
      return id;
    }
    id = idFrom(key);
    for (let n = 2; ids.has(id); n++) id = `${idFrom(key)}_${n}`;
    ids.add(id);
    byKey.set(key, id);
    stations.set(id, { id, label: labelFrom(key), key, phase: c.phase, prompt: c.prompt, schema: c.schema, ...(c.flow ? { flow: c.flow } : {}), visits: 1, rounds: inRounds(c.label) });
    return id;
  };
  // Consecutive calls of one group are one step.
  const raw: string[][] = [];
  let last: number | null | undefined;
  for (const c of trace.calls) {
    const id = stationFor(c);
    if (c.group !== null && c.group === last && raw.length) {
      if (!raw[raw.length - 1].includes(id)) raw[raw.length - 1].push(id);
    } else raw.push([id]);
    last = c.group;
  }
  const steps: ShapedStep[] = [];
  const loops: ShapedFlow["loops"] = [];
  const sig = (s: string[]) => [...s].sort().join("|");
  for (const s of raw) {
    const at = steps.findIndex((x) => sig(x.stations) === sig(s));
    if (at >= 0) {
      // A step seen before: the work went back there. One loop per (from, to), counting rounds.
      const from = steps.length - 1;
      const loop = loops.find((l) => l.to === at);
      if (loop) loop.rounds++;
      else if (from >= at) loops.push({ from, to: at, rounds: 2 });
      continue;
    }
    steps.push({ stations: s });
  }
  // Rounds the placeholder answers ended after one (no issues found, so no second round): a step whose label numbers
  // its round still loops, from the last such step back to the first, as many rounds as the script would allow.
  if (!loops.length) {
    const inLoop = steps.map((s, i) => (s.stations.some((id) => stations.get(id)!.rounds) ? i : -1)).filter((i) => i >= 0);
    if (inLoop.length) loops.push({ from: inLoop[inLoop.length - 1], to: inLoop[0], rounds: 3 });
  }
  return { stations, steps, loops };
}

const dot = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;

/** The longest run of whole lines every prompt opens with, when it is long enough to be worth sharing. */
function sharedOpening(prompts: string[]): string {
  if (prompts.length < 2) return "";
  const lines = prompts.map((p) => p.split("\n"));
  const out: string[] = [];
  for (let i = 0; ; i++) {
    const l = lines[0][i];
    if (l === undefined || !lines.every((ls) => ls[i] === l)) break;
    out.push(l);
  }
  const text = out.join("\n");
  return text.trim().length >= 300 ? text : "";
}

export type ImportedFlow = { slug: string; file: string; prompts: string[]; stations: string[]; source: string; notes: string[] };

/** A traced script as a flow's files: the graph's source and each station's text, at paths relative to `.codecast/flows`. */
export type ScriptFlowFiles = { slug: string; label: string; source: string; files: Array<{ rel: string; text: string; node?: string }>; stations: string[]; notes: string[] };

/** The trace as `<slug>.cast` and a prompt file per station, in memory. */
export function scriptFlowFiles(trace: ScriptTrace, opts: { kind: "line" | "segment"; slug?: string; session?: string | null }): ScriptFlowFiles {
  if (!trace.calls.length) throw new Error(trace.stopped ? `No agent calls recorded: ${trace.stopped}` : "The script makes no agent calls, so there is nothing to make stations of");
  const shaped = shapeTrace(trace);
  const slug = (opts.slug ?? trace.meta.name ?? "imported").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "imported";
  const agents = [...shaped.stations.values()].filter((s) => !s.flow);
  const shared = sharedOpening(agents.map((s) => s.prompt));
  const notes: string[] = [];
  if (trace.stopped) notes.push(`The trace is partial: ${trace.stopped}.`);
  const files: ScriptFlowFiles["files"] = [];
  if (shared) files.push({ rel: `${slug}/_shared.md`, text: shared.trimEnd() + "\n" });
  for (const s of agents) {
    const own = shared && s.prompt.startsWith(shared) ? s.prompt.slice(shared.length).replace(/^\n+/, "") : s.prompt;
    const lastOfLoop = shaped.loops.find((l) => shaped.steps[l.from].stations.includes(s.id));
    const parts = [shared ? "@include _shared.md\n" : "", own.trimEnd()];
    if (s.schema) parts.push(`\nEnd your turn with one JSON object in a fenced json block, shaped like this schema:\n\n\`\`\`json\n${JSON.stringify(s.schema, null, 2)}\n\`\`\``);
    if (lastOfLoop) parts.push(`\nAnother round runs when your JSON says "again": true. Say when, in your own terms, by rewriting this line.`);
    files.push({ rel: `${slug}/${s.id}.md`, text: parts.filter(Boolean).join("\n") + "\n", node: s.id });
  }
  const loopFrom = new Map(shaped.loops.map((l) => [l.from, l]));
  const lines: string[] = [];
  const desc = trace.meta.description ? `, description=${dot(trace.meta.description)}` : "";
  lines.push(`// Imported from a Claude Code workflow (${trace.meta.name ?? slug}) by cast flow import (flows.md FL5).`);
  lines.push(`digraph ${slug.replace(/-/g, "_")} {`);
  // A draft of the session that imported it: its names, description and prompts still carry that run's task.
  const draft = opts.session ? `, draft=${dot(opts.session.slice(0, 7))}` : `, draft="imported"`;
  lines.push(`  graph [kind="${opts.kind}", label=${dot(labelFrom(trace.meta.name ?? slug))}${desc}, takes="task"${draft}${opts.kind === "line" ? `, goal="$task_title", on_failure=stop` : ""}]`);
  lines.push("  rankdir=LR");
  lines.push("  start [shape=Mdiamond]");
  lines.push(`  done [shape=Msquare, label="Done"]`);
  const loopRounds = new Map<string, number>();
  for (const l of shaped.loops) for (let i = l.to; i <= l.from; i++) for (const id of shaped.steps[i].stations) loopRounds.set(id, Math.max(l.rounds, loopRounds.get(id) ?? 0));
  for (const s of shaped.stations.values()) {
    const n = Math.max(s.visits, loopRounds.get(s.id) ?? 0);
    const visits = n > 1 ? `, max_visits=${n}` : "";
    if (s.flow) lines.push(`  ${s.id} [flow=${dot(s.flow)}, label=${dot(s.label)}]`);
    else lines.push(`  ${s.id} [label=${dot(s.label)}, backend=session, agent=claude${visits}, prompt=${dot(`@${slug}/${s.id}.md`)}]`);
  }
  // Each step: one station, or a fan-out to several and a join after them.
  const entryOf: string[] = [];
  const exitOf: string[] = [];
  for (const [i, step] of shaped.steps.entries()) {
    if (step.stations.length === 1) {
      entryOf.push(step.stations[0]);
      exitOf.push(step.stations[0]);
      continue;
    }
    const fan = `fan_${i + 1}`;
    const join = `join_${i + 1}`;
    const phase = shaped.stations.get(step.stations[0])!.phase;
    lines.push(`  ${fan} [shape=component, label=${dot(phase ?? "Side by side")}]`);
    lines.push(`  ${join} [shape=tripleoctagon, label="Join"]`);
    for (const id of step.stations) lines.push(`  ${fan} -> ${id}`, `  ${id} -> ${join}`);
    entryOf.push(fan);
    exitOf.push(join);
  }
  lines.push(`  start -> ${entryOf[0]}`);
  for (let i = 0; i < shaped.steps.length; i++) {
    const next = i + 1 < shaped.steps.length ? entryOf[i + 1] : "done";
    const loop = loopFrom.get(i);
    if (loop) {
      const asker = shaped.steps[i].stations[shaped.steps[i].stations.length - 1];
      lines.push(`  ${exitOf[i]} -> ${entryOf[loop.to]} [condition="${asker}.json.again = true", label="another round"]`);
      lines.push(`  ${exitOf[i]} -> ${next} [condition="${asker}.json.again != true", label="rounds done"]`);
      notes.push(`Rounds: ${labelFrom(shaped.stations.get(asker)!.key)} sends the work back to ${shaped.stations.get(shaped.steps[loop.to].stations[0])!.label} when its JSON says again (the script ran ${loop.rounds} rounds).`);
    } else lines.push(`  ${exitOf[i]} -> ${next}`);
  }
  lines.push("}");
  const source = lines.join("\n") + "\n";
  const label = labelFrom(trace.meta.name ?? slug);
  return { slug, label, source, files, stations: shaped.steps.map((s) => s.stations.map((id) => shaped.stations.get(id)!.label).join(" + ")), notes };
}

/** Write the trace as `.codecast/flows/<slug>.cast` with a prompt file per station. */
export async function importWorkflowScript(script: string, opts: { kind: "line" | "segment"; slug?: string; cwd: string; force?: boolean; args?: unknown; session?: string | null }): Promise<ImportedFlow> {
  const flow = scriptFlowFiles(await traceWorkflowScript(script, opts.args), opts);
  const root = (() => {
    const top = spawnSync("git", ["-C", opts.cwd, "rev-parse", "--show-toplevel"], { encoding: "utf-8" });
    return top.status === 0 ? top.stdout.trim() : opts.cwd;
  })();
  const flowsDir = path.join(root, ".codecast", "flows");
  const file = path.join(flowsDir, `${flow.slug}.cast`);
  if (fs.existsSync(file) && !opts.force) throw new Error(`${path.relative(opts.cwd, file)} exists: pass --force to replace it, or --slug for another name`);
  fs.mkdirSync(path.join(flowsDir, flow.slug), { recursive: true });
  const prompts: string[] = [];
  for (const f of flow.files) {
    const abs = path.join(flowsDir, f.rel);
    fs.writeFileSync(abs, f.text);
    prompts.push(abs);
  }
  fs.writeFileSync(file, flow.source);
  const notes = [...flow.notes];
  const errors = validateWorkflow(parseWorkflowSource(flow.source, flowsDir));
  if (errors.length) notes.push(`The graph needs work: ${errors.join("; ")}`);
  return { slug: flow.slug, file, prompts, stations: flow.stations, source: flow.source, notes };
}

/** Where a traced script's flow sits in a checkout: what a saved copy materializes at (convex session_flows.file). */
const FLOWS_REL = ".codecast/flows";

/**
 * A Claude Code Workflow script as the graph a session ran (convex
 * flowLibrary, "used in sessions"): traced the way `cast flow import` traces
 * it, parsed from memory, with its hash and the push payload's stations and
 * routes. The draft mark is the same for every session, so one script is one
 * graph wherever it ran.
 */
export async function traceScriptGraph(script: string, args?: unknown) {
  const { graphHash, graphNodeHashes } = await import("./parser.js");
  const { graphToPushPayload } = await import("./runner.js");
  const flow = scriptFlowFiles(await traceWorkflowScript(script, args), { kind: "line" });
  const dir = path.join("/", FLOWS_REL);
  const byPath = new Map(flow.files.map((f) => [path.join(dir, f.rel), f.text]));
  const graph = parseWorkflowSource(flow.source, dir, { read: (abs: string) => byPath.get(abs) ?? null });
  const { nodes, edges } = graphToPushPayload(graph);
  return {
    hash: graphHash(graph),
    name: graph.name,
    label: flow.label,
    source: flow.source,
    nodes,
    edges,
    file: `${FLOWS_REL}/${flow.slug}.cast`,
    files: flow.files.filter((f) => f.node).map((f) => ({ node: f.node!, prompt: `${FLOWS_REL}/${f.rel}` })),
    graph_nodes: graphNodeHashes(graph),
    script,
  };
}
