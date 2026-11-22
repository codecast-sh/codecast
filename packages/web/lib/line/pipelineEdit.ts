// One edit to a repo's pipeline, as the page proposes it (docs/architecture/
// pipeline.md PL3, PL5): the five edits `cast flow edit` makes, the exact
// command for each, the words a person reads, the flow with the edit drawn in,
// what it would have run on, and whether the published pipeline already holds
// it. The page never writes a checkout: a session runs the command and ships
// the change through the flow, and until the edit is live the page draws it
// as a proposal. Pure: no store, no React.
import { foldFlow, segmentTopOf, type FlowEdgeIn, type FlowNodeIn } from "@codecast/shared/contracts/flowPool";
import { globMatch } from "@codecast/shared/contracts/deployTargets";
import type { PipelineFlow, PipelineStation } from "./pipelineTypes";

/** What a new station does: runs a command, is an agent with a prompt, or asks a person. */
export type AddDoes = "run" | "agent" | "person";

export type PipelineEdit =
  | { op: "add"; id: string; label: string; at: "after" | "before"; station: string; does: AddDoes; body: string; when?: string }
  | { op: "guide"; station: string; text: string }
  | { op: "prompt"; station: string; text: string }
  | { op: "run"; station: string; command: string }
  /** `globs` "always" runs it on every change again. */
  | { op: "when"; station: string; globs: string }
  | { op: "skip"; station: string };

export type EditOp = PipelineEdit["op"];

/** A shell word: bare when it is plain, else double-quoted with what the shell would expand escaped. */
export function shellWord(s: string): string {
  if (/^[\w@%+=:,./-]+$/.test(s)) return s;
  return `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** The exact `cast flow edit` command the edit is. */
export function editCommand(flow: string, e: PipelineEdit): string {
  const w = shellWord;
  const head = `cast flow edit ${w(flow)}`;
  switch (e.op) {
    case "add": {
      const flag = e.does === "run" ? "--run" : e.does === "agent" ? "--agent" : "--person";
      return `${head} add ${w(e.id)} --${e.at} ${w(e.station)} ${flag} ${w(e.body)} --label ${w(e.label)}${e.when ? ` --when ${w(e.when)}` : ""}`;
    }
    case "guide": return `${head} guide ${w(e.station)} ${w(e.text)}`;
    case "prompt": return `${head} prompt ${w(e.station)} ${w(e.text)}`;
    case "run": return `${head} run ${w(e.station)} ${w(e.command)}`;
    case "when": return `${head} when ${w(e.station)} ${w(e.globs)}`;
    case "skip": return `${head} skip ${w(e.station)}`;
  }
}

/** A command line's words, the shell's quoting undone. */
function shellWords(line: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (const m of line.matchAll(re)) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2] ?? m[3]);
  return out;
}

/** An edit read back from its command, or null for a line that is not one. Undo and unknown ops read as null. */
export function parseEditCommand(line: string): { flow: string; edit: PipelineEdit } | null {
  const w = shellWords(line.trim());
  if (w[0] !== "cast" || w[1] !== "flow" || w[2] !== "edit" || !w[3] || !w[4] || !w[5]) return null;
  const [flow, op, station] = [w[3], w[4], w[5]];
  const rest = w.slice(6);
  const flag = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] ?? "" : null; };
  switch (op) {
    case "add": {
      const at = flag("after") !== null ? "after" : flag("before") !== null ? "before" : null;
      const does: AddDoes | null = flag("run") !== null ? "run" : flag("agent") !== null ? "agent" : flag("person") !== null ? "person" : null;
      if (!at || !does) return null;
      const when = flag("when");
      return { flow, edit: { op, id: station, label: flag("label") || labelOf(station), at, station: flag(at)!, does, body: flag(does)!, ...(when ? { when } : {}) } };
    }
    case "guide": case "prompt": return rest[0] !== undefined ? { flow, edit: { op, station, text: rest[0] } } : null;
    case "run": return rest[0] !== undefined ? { flow, edit: { op, station, command: rest[0] } } : null;
    case "when": return rest[0] !== undefined ? { flow, edit: { op, station, globs: rest[0] } } : null;
    case "skip": return { flow, edit: { op, station } };
    default: return null;
  }
}

/** A station id as a person reads it, for a new station named by id alone. */
export const labelOf = (id: string) => id.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** A station's id from the name a person gave it. */
export const idOf = (label: string) => label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "station";

const DOES_WORDS: Record<AddDoes, string> = { run: "a command", agent: "an agent", person: "asks a person" };

/** The edit in words, a station by its label. */
export function editWords(e: PipelineEdit, label: (id: string) => string): string {
  switch (e.op) {
    case "add": return `Add ${e.label} ${e.at} ${label(e.station)} (${DOES_WORDS[e.does]})${e.when ? `, only when a change touches ${e.when}` : ""}`;
    case "guide": return `Add guidance to ${label(e.station)}'s prompt`;
    case "prompt": return `Replace ${label(e.station)}'s prompt`;
    case "run": return `Change what ${label(e.station)} runs`;
    case "when": return e.globs === "always" ? `Run ${label(e.station)} on every change` : `Run ${label(e.station)} only when a change touches ${e.globs}`;
    case "skip": return `Skip ${label(e.station)}`;
  }
}

/** The station an edit is about, by id (a new station's own id). */
export const editStation = (e: PipelineEdit) => (e.op === "add" ? e.id : e.station);

/** The globs of a `when` string. */
export const globsOf = (when: string) => when.split(",").map((g) => g.trim()).filter(Boolean);

/** How many of the recent changes would have run a station limited to these paths; null when it runs on every change. */
export function wouldRun(when: string | undefined, recent: ReadonlyArray<{ files: readonly string[] }>): { hits: number; total: number } | null {
  if (!when || when === "always") return null;
  const globs = globsOf(when);
  if (!globs.length) return null;
  const hits = recent.filter((c) => c.files.some((f) => globs.some((g) => globMatch(g, f)))).length;
  return { hits, total: recent.length };
}

const NODE_TYPE: Record<AddDoes, string> = { run: "command", agent: "codergen", person: "human" };

/** The flow with the edit drawn in: a new station on the passing path, a changed station's facts, a skipped one marked. */
export function applyEdit(flow: PipelineFlow, e: PipelineEdit): PipelineFlow {
  const stations = flow.stations.map((s) => ({ ...s }));
  const at = (id: string) => stations.find((s) => s.id === id);
  if (e.op === "add") {
    if (stations.some((s) => s.id === e.id) || !at(e.station)) return flow;
    const graph = insertNode(flow.graph, e);
    const folded = foldFlow(graph.nodes, graph.edges);
    const added: PipelineStation = {
      id: e.id, label: e.label, who: e.does === "run" ? "command" : e.does, own: "added", main: folded.stations.find((s) => s.id === e.id)?.main ?? true,
      ...(e.when && e.when !== "always" ? { when: globsOf(e.when) } : {}),
      ...(e.does === "run" ? { runs: e.body } : { prompt: e.body }),
    };
    return { ...flow, graph, stations: [...stations, added] };
  }
  const s = at(e.station);
  if (!s) return flow;
  const changed = (word: string) => ({ own: s.own === "added" ? ("added" as const) : ("changed" as const), changed: [...new Set([...(s.changed ?? []), word])] });
  if (e.op === "guide") Object.assign(s, changed("guide"), { guide: e.text });
  if (e.op === "prompt") Object.assign(s, changed("prompt"), { prompt: e.text });
  if (e.op === "run") Object.assign(s, changed("script"), { runs: e.command });
  if (e.op === "when") { Object.assign(s, changed("when")); if (e.globs === "always") delete s.when; else s.when = globsOf(e.globs); }
  if (e.op === "skip") return { ...flow, stations, removed: [...new Set([...flow.removed, s.label])] };
  return { ...flow, stations };
}

/** The graph with a new station put on the passing path next to another: it takes the passing route out of the station
 *  before it, and fails the way that station fails. */
function insertNode(graph: PipelineFlow["graph"], e: Extract<PipelineEdit, { op: "add" }>): PipelineFlow["graph"] {
  const folded = foldFlow(graph.nodes, graph.edges);
  const main = folded.stations.filter((s) => s.main && s.kind !== "join");
  // The station before a fan-out's next step is its join: that is where its passing route and its ways back leave from.
  const joinOf = (id: string | null) => {
    const st = folded.stations.find((x) => x.id === id);
    if (st?.kind !== "parallel") return id;
    const branches = new Set(st.next.map((n) => n.toId));
    return folded.stations.find((x) => x.kind === "join" && folded.stations.some((b) => branches.has(b.id) && b.next.some((n) => n.toId === x.id)))?.id ?? id;
  };
  const branchOf = new Set(folded.stations.filter((x) => x.kind === "parallel").flatMap((x) => x.next.map((n) => n.toId)));
  const path = main.filter((x) => !branchOf.has(x.id));
  const j = path.findIndex((x) => x.id === e.station);
  const before = joinOf(e.at === "after" ? e.station : path[j - 1]?.id ?? null);
  const after = e.at === "after" ? path[j + 1]?.id ?? null : e.station;
  const node: FlowNodeIn = { id: e.id, label: e.label, type: NODE_TYPE[e.does], ...(e.does === "run" ? { shape: "parallelogram" } : {}) };
  const top = (id: string) => segmentTopOf(id);
  const passing = (x: FlowEdgeIn) => before !== null && after !== null && top(x.from) === before && top(x.to) === after;
  const edges: FlowEdgeIn[] = [];
  for (const x of graph.edges) {
    if (passing(x)) edges.push({ ...x, to: e.id });
    else if (before === null && top(x.to) === after && graph.nodes.find((n) => n.id === x.from)?.type === "start") edges.push({ ...x, to: e.id });
    else edges.push(x);
  }
  if (after) edges.push({ from: e.id, to: graph.nodes.some((n) => n.id === after) ? after : graph.edges.find((x) => top(x.to) === after)?.to ?? after, condition: "outcome = success" });
  // It fails the way the station before it fails: the same ways back, from the new station.
  if (before) for (const x of graph.edges) if (top(x.from) === before && top(x.to) !== after && top(x.to) !== before) edges.push({ from: e.id, to: x.to, ...(x.label ? { label: x.label } : {}), ...(x.condition ? { condition: x.condition.replace(new RegExp(`\\b${before}\\b`, "g"), e.id) } : {}) });
  return { nodes: [...graph.nodes, node], edges: dedupeEdges(edges) };
}

function dedupeEdges(edges: FlowEdgeIn[]): FlowEdgeIn[] {
  const seen = new Set<string>();
  return edges.filter((x) => { const k = `${x.from}>${x.to}|${x.condition ?? ""}|${x.label ?? ""}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Whether the published flow already holds the edit: it is live, and nothing is pending. */
export function editLive(flow: PipelineFlow, e: PipelineEdit): boolean {
  const s = flow.stations.find((x) => x.id === editStation(e));
  switch (e.op) {
    case "add": return !!s;
    case "guide": return !!s?.guide && s.guide.trim() === e.text.trim();
    case "prompt": return !!s?.prompt && s.prompt.trim() === e.text.trim();
    case "run": return s?.runs === e.command;
    case "when": return e.globs === "always" ? !s?.when?.length : (s?.when ?? []).join(",") === globsOf(e.globs).join(",");
    case "skip": return !s || flow.removed.includes(s.label);
  }
}

/** The first message of the session that makes the edits: the exact commands, then the ask to ship them through the flow. */
export function editSessionMessage(flow: { slug: string; label: string }, commands: readonly string[], words: string): string {
  return [
    ...commands,
    "",
    `Run the command${commands.length > 1 ? "s" : ""} above in this checkout: ${words.replace(/\.$/, "")}. Check the diff it prints, then ship it through the flow: \`cast flow run ${flow.slug} --title ${shellWord(`Pipeline: ${words}`)}\`. When it ends, tell me where it stopped or that it passed.`,
  ].join("\n");
}

/** The edits a session's first message proposes, in order; none for a message that does not open with them. */
export function editsOfMessage(content: string | null | undefined): Array<{ flow: string; edit: PipelineEdit }> {
  const out: Array<{ flow: string; edit: PipelineEdit }> = [];
  for (const line of (content ?? "").split("\n")) {
    if (!line.trim()) break;
    const parsed = parseEditCommand(line);
    if (!parsed) break;
    out.push(parsed);
  }
  return out;
}

/** Which edits a station takes: guidance and a prompt where it has one, a command where it runs one. A branch of a
 *  side-by-side group takes no skip or when (the engine refuses them inside the group), and a station is added after
 *  the group, not beside a branch. */
export function opsFor(s: Pick<PipelineStation, "prompt" | "runs" | "who"> | null | undefined, inGroup = false): Set<EditOp> {
  const ops = new Set<EditOp>(inGroup ? [] : ["add", "when", "skip"]);
  if (s?.prompt) { ops.add("guide"); ops.add("prompt"); }
  if (s?.runs !== undefined || s?.who === "command") ops.add("run");
  return ops;
}

/** The fan-out (side-by-side group) each branch station sits in, by branch id: an edit placed at a branch lands on the
 *  group ("after CI and review"). */
export function groupsOf(flow: PipelineFlow): Map<string, string> {
  const folded = foldFlow(flow.graph.nodes, flow.graph.edges);
  const out = new Map<string, string>();
  for (const s of folded.stations) if (s.kind === "parallel") for (const n of s.next) out.set(n.toId, s.id);
  return out;
}

/** Whether an edit changes anything: a prompt, command or guidance edit whose text equals what the station has now is
 *  no edit. */
export function editChanges(flow: PipelineFlow, e: PipelineEdit): boolean {
  if (e.op === "add" || e.op === "skip") return true;
  return !editLive(flow, e);
}

/** Two texts line by line: each line kept, removed or added, in order (a small LCS; prompts are short). */
export function lineDiff(before: string, after: string): Array<{ kind: "same" | "del" | "add"; text: string }> {
  const a = before.split("\n"), b = after.split("\n");
  const n = a.length, m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: Array<{ kind: "same" | "del" | "add"; text: string }> = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: "same", text: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ kind: "del", text: a[i++] });
    else out.push({ kind: "add", text: b[j++] });
  }
  while (i < n) out.push({ kind: "del", text: a[i++] });
  while (j < m) out.push({ kind: "add", text: b[j++] });
  return out;
}

/** A station's script as a person reads it: the command that matters, the checkout boilerplate around it left out
 *  (`wt="$(cast ws path $worktree)"; [ -n "$wt" ] && cd "$wt" && …`). The whole script when there is none. */
export function meaningfulCommand(script: string): string {
  const s = script.trim()
    .replace(/^wt="\$\(cast ws path \$worktree\)";\s*/, "")
    .replace(/^\[ -n "\$wt" \] \|\| \{[^}]*\};\s*/, "")
    .replace(/^\[ -n "\$wt" \] && cd "\$wt"( && | \|\| exit 1;\s*)/, "")
    .replace(/^cd "\$wt" && /, "");
  // A script of several statements reads as the last program it runs (`…; fi; bun scripts/line.ts merge …`).
  const last = s.match(/(?:^|;\s*|&&\s*|\|\|\s*)((?:bun|node|npx|npm|pnpm|yarn|cast|python3?|bash|\.\/)[^;&|]*)\s*$/);
  return (last?.[1] ?? s).trim() || script.trim();
}
