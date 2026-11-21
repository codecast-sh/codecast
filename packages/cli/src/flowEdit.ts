// `cast flow edit <flow> <op> ...` (docs/architecture/pipeline.md PL5): one
// typed edit to a project's flow, written as the one line that says it in the
// repo's `.codecast/flows/<flow>.cast` (PL3), with a prompt's text in a file
// beside it (`.codecast/flows/<flow>/<station>.md`). The file is created over
// the library flow of that name when the repo has none; a repo flow that
// already extends something (a file path, as Union's does) gets the line
// added. Nothing is written unless the result parses and validates, the same
// edit twice writes nothing, and nothing is committed: the edit ships through
// the pipeline it edits. planFlowEdit is pure over a reader, so tests and the
// command judge the same plan.
import fs from "node:fs";
import path from "node:path";
import { SEGMENT_SEP, foldFlow, flowPathWords } from "@codecast/shared/contracts/flowPool";
import { flowEditWords, whenPaths, type FlowEdit, type FlowEditChange } from "@codecast/shared/contracts/flowEdit";
import { generateUnifiedPatch } from "@codecast/shared/diff";
import { graphExtends, graphHash, parseWorkflowFile, resolveFlowSource, validateWorkflow, type ReadFile } from "./workflow/parser.js";
import type { WorkflowGraph } from "./workflow/types.js";
import { dotQuote } from "./lineGraphEdit.js";
import { dropNodeStmt, findNodeStmt, nodeAttrRaw, nodeStmtIds, upsertNodeAttrs } from "./repoLine.js";

export class FlowEditError extends Error {}

export type FlowEditRequest =
  | { op: "add"; station: string; after?: string; before?: string; run?: string; agent?: string; person?: string; when?: string; label?: string; fix?: string }
  | { op: "guide" | "prompt"; station: string; text: string }
  | { op: "run"; station: string; cmd: string }
  | { op: "skip"; station: string }
  | { op: "when"; station: string; paths: string }
  | { op: "undo"; station: string };

export interface FlowEditPlan {
  /** Files to write (content) or delete (null), absolute. */
  writes: Array<{ file: string; content: string | null }>;
  changed: boolean;
  edit: FlowEdit;
  /** The edit in words, one line each. */
  words: string[];
  /** A unified diff of every file the edit writes, repo-relative. */
  diff: string;
  /** The flow's main path after the edit: "Check → Lint → Review → Land → Deploy". */
  path: string;
  created: boolean;
  /** The edit took the project's flow back to nothing, so the file went (the library's flow runs again). */
  removed: boolean;
}

const readDisk: ReadFile = (abs) => (fs.existsSync(abs) && fs.statSync(abs).isFile() ? fs.readFileSync(abs, "utf8") : null);
const titleOf = (id: string) => id.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const rel = (root: string, abs: string) => path.relative(root, abs).split(path.sep).join("/");

/** The repo's file for a flow, and the source a new one starts from. */
export const repoFlowFile = (root: string, flow: string) => path.join(root, ".codecast", "flows", `${flow}.cast`);
export const newVariantSource = (flow: string) =>
  `// How this project's ${flow} differs from the library's: one line per edit (cast flow edit ${flow} --help).\ndigraph ${flow.replace(/[^\w]/g, "_")} {\n  graph [extends="${flow}"]\n}\n`;

/** The text an argument names: `-` for stdin, `@file` for a file (relative to cwd), else the text itself. */
export function argText(arg: string, cwd: string, stdin: () => string): string {
  if (arg === "-") return stdin();
  if (arg.startsWith("@")) {
    const file = path.resolve(cwd, arg.slice(1));
    if (!fs.existsSync(file)) throw new FlowEditError(`${arg}: no file at ${file}`);
    return fs.readFileSync(file, "utf8");
  }
  return arg;
}

function parse(file: string, read: ReadFile): WorkflowGraph {
  try {
    return parseWorkflowFile(file, { read });
  } catch (err) {
    throw new FlowEditError(err instanceof Error ? err.message.replace(/^\S+\.cast: /, "") : String(err));
  }
}

/** The plan for one edit of `flow` in the checkout at `root`. */
export function planFlowEdit(root: string, flow: string, req: FlowEditRequest, read: ReadFile = readDisk): FlowEditPlan {
  if (!/^[\w-]+$/.test(flow)) throw new FlowEditError(`"${flow}" is not a flow's name: name one from cast flow ls (change, quick-change, ...)`);
  const file = repoFlowFile(root, flow);
  const dir = path.dirname(file);
  const existing = read(file);
  let before = existing;
  if (before === null) {
    if (!resolveFlowSource(flow, dir, (abs) => (abs === file ? null : read(abs)))) throw new FlowEditError(`there is no flow ${flow} to extend: cast flow ls lists the library's flows`);
    before = newVariantSource(flow);
  }
  const base = graphExtends(before);
  if (base === undefined) {
    throw new FlowEditError(`${rel(root, file)} is a whole flow, not a variant of one: edit its stations and edges in it directly, or start it with graph [extends="<flow>"] and keep only what differs`);
  }
  const overlay = new Map<string, string | null>();
  const reader: ReadFile = (abs) => (overlay.has(abs) ? overlay.get(abs)! : abs === file ? before : read(abs));
  const now = parse(file, reader);
  const tops = [...now.nodes.values()].filter((n) => !n.id.includes(SEGMENT_SEP) && n.type !== "start" && n.type !== "exit");
  const folded = foldFlow([...now.nodes.values()], now.edges).stations;
  const stationList = () => [...folded.filter((x) => x.main), ...folded.filter((x) => !x.main)].map((x) => x.id).join(", ");
  const label = (id: string) => now.nodes.get(id.split(SEGMENT_SEP)[0])?.label ?? id;
  /** A station named by id or label; a segment's station by its qualified id. */
  const station = (name: string): string => {
    if (now.nodes.has(name)) return name;
    const byLabel = tops.find((n) => n.label.toLowerCase() === name.toLowerCase());
    if (byLabel) return byLabel.id;
    throw new FlowEditError(`${flow} has no station "${name}"; its stations: ${stationList()}`);
  };
  const ownDecl = (id: string) => !!findNodeStmt(before!, id);
  const ownAdded = (id: string) => ownDecl(id) && (nodeAttrRaw(before!, id, "after") !== null || nodeAttrRaw(before!, id, "before") !== null);
  // A prompt and the guidance on top of it live in their own files, so writing one never overwrites the other.
  const promptRef = (id: string, kind: "prompt" | "guide" = "prompt") => `${flow}/${id}${kind === "guide" ? ".guide" : ""}.md`;
  const writeText = (id: string, text: string, kind: "prompt" | "guide" = "prompt") => {
    if (!text.trim()) throw new FlowEditError(`the text for ${id} is empty`);
    overlay.set(path.join(dir, promptRef(id, kind)), text.endsWith("\n") ? text : `${text}\n`);
    return dotQuote(`@${promptRef(id, kind)}`);
  };
  let src = before;
  const set = (id: string, attrs: Record<string, string | null>) => { src = upsertNodeAttrs(src, id, attrs); };
  /** Takes a station's lines out of the file (its own, and its segment stations'), with the text files only they named. */
  const dropStation = (s: string): boolean => {
    const ids = nodeStmtIds(src).filter((x) => x === s || x.startsWith(`${s}${SEGMENT_SEP}`));
    for (const x of ids) {
      for (const kind of ["prompt", "guide"] as const) {
        const m = /^"@([^"]+)"$/.exec(nodeAttrRaw(src, x, kind) ?? "");
        if (m && m[1] === promptRef(x, kind) && read(path.join(dir, m[1])) !== null) overlay.set(path.join(dir, m[1]), null);
      }
      src = dropNodeStmt(src, x);
    }
    return ids.length > 0;
  };
  const changes: FlowEditChange[] = [];
  const id = req.station;

  switch (req.op) {
    case "add": {
      if (!/^[A-Za-z_][\w]*$/.test(id)) throw new FlowEditError(`"${id}" cannot name a station: use letters, digits and _ (lint, e2e, type_check)`);
      if (now.nodes.has(id) && !ownAdded(id)) throw new FlowEditError(`${flow} already has a station ${id}: change it with run, prompt or when, or add one with another id`);
      const kinds = (["run", "agent", "person"] as const).filter((k) => req[k] !== undefined);
      if (kinds.length !== 1) throw new FlowEditError(`say what ${id} does with one of --run "<command>", --agent "<prompt|@file>" or --person "<question>"`);
      if (!!req.after === !!req.before) throw new FlowEditError(`say where ${id} goes with --after <station> or --before <station>`);
      const anchor = station((req.after ?? req.before)!);
      if (req.fix) station(req.fix);
      const what: Record<string, string | null> =
        req.run !== undefined ? { shape: "parallelogram", script: dotQuote(req.run), prompt: null }
        : req.agent !== undefined ? { shape: null, script: null, prompt: writeText(id, req.agent) }
        : { shape: "hexagon", script: null, prompt: dotQuote(req.person!) };
      set(id, {
        [req.after ? "after" : "before"]: dotQuote(anchor),
        [req.after ? "before" : "after"]: null,
        label: dotQuote(req.label ?? (ownDecl(id) ? JSON.parse(nodeAttrRaw(before, id, "label") ?? `"${titleOf(id)}"`) : titleOf(id))),
        ...what,
        ...(req.when !== undefined ? { when: req.when === "always" ? null : dotQuote(whenPaths(req.when).join(", ")) } : {}),
        fix: req.fix ? dotQuote(station(req.fix)) : null,
      });
      changes.push({ op: "add", station: id, label: req.label ?? titleOf(id), [req.after ? "after" : "before"]: anchor, ...(req.fix ? { fix: req.fix } : {}) });
      if (req.when !== undefined && req.when !== "always") changes.push({ op: "when", station: id, paths: whenPaths(req.when) });
      break;
    }
    case "guide":
    case "prompt": {
      const s = station(id);
      if (req.op === "guide" && ownAdded(s)) throw new FlowEditError(`${s} is this project's own station, so there is no inherited prompt to add to: change it with cast flow edit ${flow} prompt ${s} "<text>"`);
      const n = now.nodes.get(s)!;
      if (n.type === "command") throw new FlowEditError(`${label(s)} runs a command, not a prompt: change it with cast flow edit ${flow} run ${s} "<command>"`);
      const asks = n.type === "human" || (n.segment_entry && [...now.nodes.values()].some((x) => x.id.startsWith(`${s}${SEGMENT_SEP}`) && x.type === "human"));
      if (asks && req.op === "guide") throw new FlowEditError(`${label(s)} is a person's question, not an agent's prompt: change the question with cast flow edit ${flow} prompt ${s} "<text>"`);
      set(s, req.op === "guide" ? { guide: writeText(s, req.text, "guide") } : { prompt: writeText(s, req.text) });
      changes.push({ op: req.op, station: s });
      break;
    }
    case "run": {
      const s = station(id);
      const n = now.nodes.get(s)!;
      let target = s;
      if (n.segment_entry) {
        const steps = [...now.nodes.values()].filter((x) => x.id.startsWith(`${s}${SEGMENT_SEP}`) && x.type === "command" && !x.segment_exit);
        if (steps.length > 1) throw new FlowEditError(`${label(s)} runs ${steps.length} commands (${steps.map((x) => x.id).join(", ")}): name one, cast flow edit ${flow} run ${steps[0].id} "<command>"`);
        if (!steps.length) throw new FlowEditError(`${label(s)} is an agent, not a command: change what it reads with cast flow edit ${flow} prompt ${s} "<text>"`);
        target = steps[0].id;
      } else if (n.type !== "command") {
        throw new FlowEditError(`${label(s)} is ${n.type === "human" ? "a person's question" : "an agent"}, not a command: change what it reads with cast flow edit ${flow} prompt ${s} "<text>"`);
      }
      set(target, { script: dotQuote(req.cmd), ...(target === s ? { shape: "parallelogram" } : {}) });
      // A command that replaces one the backbone wrote (Deploy's wait, Check's command) says what it replaces.
      const old = ownAdded(target) ? null : now.nodes.get(target)?.script;
      // Named by the command it ends in (`cd "$wt" && cast flow await-deploy ...` is cast flow await-deploy).
      const was = old && old !== req.cmd ? old.split(/&&|;|\n/).map((p) => p.trim()).filter(Boolean).pop()!.split(/\s+/).slice(0, 3).join(" ") : null;
      changes.push({ op: "run", station: target, ...(was ? { replaces: was } : {}) });
      break;
    }
    case "skip": {
      const s = station(id);
      if (ownAdded(s)) {
        dropStation(s);
        changes.push({ op: "undo", station: s, added: true });
      } else {
        // A skipped station runs nothing: what this file says about it goes with the skip.
        for (const x of nodeStmtIds(src).filter((x) => x.startsWith(`${s}${SEGMENT_SEP}`))) src = dropNodeStmt(src, x);
        set(s, { skip: "true", guide: null, prompt: null, when: null });
        changes.push({ op: "skip", station: s });
      }
      break;
    }
    case "when": {
      const s = station(id);
      const always = req.paths.trim() === "always";
      if (!always && !whenPaths(req.paths).length) throw new FlowEditError(`name the paths the change must touch for ${s} to run ("src/**, docs/*.md"), or always`);
      set(s, { when: always ? null : dotQuote(whenPaths(req.paths).join(", ")) });
      changes.push({ op: "when", station: s, paths: always ? [] : whenPaths(req.paths) });
      break;
    }
    case "undo": {
      const added = ownAdded(id);
      if (dropStation(id)) changes.push({ op: "undo", station: id, ...(added ? { added: true as const } : {}) });
      break;
    }
  }

  overlay.set(file, src);
  const after = parse(file, reader);
  const errors = validateWorkflow(after);
  if (errors.length) throw new FlowEditError(`the flow would not run: ${errors.join("; ")}`);
  // A file this tool made that is back to saying nothing goes, so it no longer shadows the library's flow.
  if (src === newVariantSource(flow)) overlay.set(file, null);
  // The engine knows what the placed station does on a failure (its anchor's way back, or the end of the run).
  for (const c of changes) {
    const made = c.op === "add" ? after.edits?.find((e) => e.op === "add" && e.station === c.station) : undefined;
    if (made?.ends_on_failure) c.ends_on_failure = true;
  }

  const writes: FlowEditPlan["writes"] = [];
  let diff = "";
  for (const [abs, content] of overlay) {
    const was = abs === file ? existing : read(abs);
    if (was === content) continue;
    writes.push({ file: abs, content });
    diff += generateUnifiedPatch(rel(root, abs), was ?? "", content ?? "");
  }
  const by = changes.map((c) => ({ ...c, by: "command" as const }));
  const labelAfter = (x: string) => after.nodes.get(x.split(SEGMENT_SEP)[0])?.label ?? now.nodes.get(x.split(SEGMENT_SEP)[0])?.label ?? x;
  return {
    writes,
    changed: writes.length > 0,
    edit: { flow, file: rel(root, file), graph_hash: graphHash(after), base, changes: by },
    words: changes.map((c) => flowEditWords(c, labelAfter)),
    diff,
    path: flowPathWords(foldFlow([...after.nodes.values()], after.edges)).path,
    created: existing === null && writes.some((w) => w.file === file),
    removed: existing !== null && writes.some((w) => w.file === file && w.content === null),
  };
}

/** Writes a plan's files (a null content deletes the file, and the directories that leaves empty up to `.codecast`). */
export function applyFlowEdit(plan: FlowEditPlan): void {
  for (const w of plan.writes) {
    if (w.content === null) {
      if (fs.existsSync(w.file)) fs.rmSync(w.file);
      for (let d = path.dirname(w.file); path.basename(d) !== "" && fs.existsSync(d) && !fs.readdirSync(d).length; d = path.dirname(d)) {
        fs.rmdirSync(d);
        if (path.basename(d) === ".codecast") break;
      }
      continue;
    }
    fs.mkdirSync(path.dirname(w.file), { recursive: true });
    const tmp = `${w.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, w.content);
    fs.renameSync(tmp, w.file);
  }
}
