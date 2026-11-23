// A repository's pipeline from its checkout (docs/architecture/pipeline.md
// PL1, PL6; contracts/pipeline.ts): the change flow a session's Ship runs here
// and the release flow a deploy runs here, each as this checkout resolves it,
// with each station's own/inherited mark read from variantChanges against the
// library flow it extends, and the deploy targets a release goes out to.
// `cast flow pipeline` prints it; every deploy targets publish sends it.
import * as fs from "node:fs";
import * as path from "node:path";
import { foldFlow, segmentTopOf } from "@codecast/shared/contracts/flowPool";
import { deployStepCommand, LINE_DEPLOY_GRAPH, LINE_DEPLOY_STEP_LABELS, LINE_DEPLOY_STEPS, type LineDeployProfile, type LineDeployStep } from "@codecast/shared/contracts/lineDeploy";
import { EMPTY_RECENT, ownWords, packRecent, PIPELINE_RECENT_MAX, runsWords, type PipelineRecent, type PipelineFlow, type PipelineOwn, type PipelinePublish, type PipelineStation, type PipelineTarget, type PipelineWho } from "@codecast/shared/contracts/pipeline";
import type { DeployTarget } from "@codecast/shared/contracts/deployTargets";
import type { FlowEditChange } from "@codecast/shared/contracts/flowEdit";
import { targetDeployProfile } from "./lineDeploy.js";
import { spawnSync } from "./proc.js";
import { variantChanges } from "./flowLibrary.js";
import { extendsSlug, poolFlows, repoFlowsDir, type PoolFlow, type PushedPoolRow } from "./workflow/flowPool.js";
import { graphExtends, parseWorkflowSource, resolveFlowSource, type FlowSource } from "./workflow/parser.js";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./workflow/templates.js";
import type { WorkflowGraph, WorkflowNode } from "./workflow/types.js";
import { edgesOf, flowNodeOf } from "./workflow/flowGraphIn.js";

export const CHANGE_FLOW_SLUG = "change";

/** What a pipeline is built from: the checkout and what this machine knows of its team. */
export type PipelineInputs = {
  root: string;
  repository: string;
  deviceId?: string | null;
  /** The team's published flows (/cli/workflows/pool), so a team default resolves here. */
  pushed?: ReadonlyArray<PushedPoolRow>;
  /** The slug the team set as its default flow (teams.default_flow). */
  teamDefault?: string | null;
  /** `[line.deploy]` as the line runs it (lineDeploy withDeclaredTarget): the step commands of a release with no target to send. */
  deploy?: Partial<LineDeployProfile> | null;
  targets?: ReadonlyArray<DeployTarget>;
  /** Where the team's published flows sit on this machine (tests point it at a temp dir). */
  cacheRoot?: string;
  /** The commit the checkout's files are. */
  headSha?: string | null;
  /** The default branch's last commits with their paths (checkoutPipeline reads them from origin). */
  recent?: PipelineRecent;
};


/** The change flow a session's Ship runs in this checkout: the repo's `change`, else the team's default when it takes a session's change, else the shipped `change`. */
export function changeFlowOf(pool: ReadonlyArray<PoolFlow>, teamDefault?: string | null): PoolFlow | null {
  const takesChange = (f: PoolFlow | undefined) => (f && !f.errors.length && f.takes.includes("branch") ? f : null);
  const repo = pool.find((f) => f.slug === CHANGE_FLOW_SLUG && f.where === "repo");
  // A repo `change` shadows every other: one that does not parse is what Ship meets, so it is the answer, said.
  if (repo?.errors.length) throw new Error(`${repo.file ?? CHANGE_FLOW_SLUG} does not parse, so Ship has no flow here: ${repo.errors[0]}`);
  return takesChange(repo) ?? (teamDefault ? takesChange(pool.find((f) => f.slug === teamDefault)) : null) ?? takesChange(pool.find((f) => f.slug === CHANGE_FLOW_SLUG)) ?? null;
}

const inside = (root: string, file: string) => !path.relative(root, file).startsWith("..") && !path.isAbsolute(path.relative(root, file));

/**
 * A repo flow's `extends` chain, walked the way the parser reads it: the library flow it reaches first (codecast's or
 * the team's; null when the chain stays inside the repo, a flow written whole), the last repo file on the way (the
 * one that holds the stations, which an edit opens), and every repo file it passed.
 */
export function flowChain(src: string, file: string, root: string): { base: { slug: string; graph: WorkflowGraph } | null; file: string; files: string[] } {
  let at: FlowSource = { src, dir: path.dirname(file), file };
  const files = [file];
  for (let hops = 0; hops < 16; hops++) {
    let ext: string | undefined;
    try { ext = graphExtends(at.src); } catch { break; }
    if (!ext) break;
    const dir = at.dir ?? root;
    const asFile = path.resolve(dir, ext);
    let next: FlowSource | null = fs.existsSync(asFile) && fs.statSync(asFile).isFile() ? { src: fs.readFileSync(asFile, "utf-8"), dir: path.dirname(asFile), file: asFile } : resolveFlowSource(ext, dir);
    // A repo `change` extending `change` names the library one, not itself.
    if (next?.file && next.file === at.file) next = resolveFlowSource(ext, undefined);
    if (!next) break;
    if (!next.file || !inside(root, next.file)) {
      try { return { base: { slug: extendsSlug(ext)!, graph: parseWorkflowSource(next.src, next.dir) }, file: at.file!, files }; } catch { break; }
    }
    files.push(next.file);
    at = next;
  }
  return { base: null, file: at.file!, files };
}

/** Which of a step's deploy stations does the work: the send, the rollout and live are the deploy's own; the gate is an eval. */
const STEP_WHO: Record<LineDeployStep, PipelineWho> = { ci: "command", send: "deploy", gate: "eval", rollout: "deploy", live: "deploy", finish: "command" };

const STEP_SCRIPT = /\bcast line deploy step (\w+)\b/;

/** A Deploy segment told to send nothing (`send=""`) waits for the deploy that carries the change. */
const SENDS_NOTHING = /\bcast flow await-deploy\b[^\n]*--send (?:""|'')(?:\s|$)/;

const innerOf = (nodes: WorkflowNode[], id: string) => nodes.filter((x) => x.segment === id && x.id !== id && !x.segment_exit && x.type !== "exit" && x.type !== "start");

function nodeWho(n: WorkflowNode, inner: WorkflowNode[]): PipelineWho {
  if (n.segment_entry || n.slot) {
    if (n.segment_flow === "deploy" || n.segment_flow === LINE_DEPLOY_GRAPH) return "deploy";
    if (n.segment_flow === "eval") return "eval";
    if (inner.some((x) => x.type === "human")) return "person";
    if (inner.some((x) => x.type === "agent" || x.type === "prompt")) return "agent";
    return inner.length ? "command" : "rule";
  }
  if (n.type === "human") return "person";
  if (n.type === "command") return "command";
  if (n.type === "conditional" || n.type === "parallel_fanout" || n.type === "parallel_fanin") return "rule";
  return "agent";
}

/** The word a typed edit (graph.edits, pipeline.md PL3) puts on its station's own mark. */
const EDIT_WORD: Partial<Record<FlowEditChange["op"], string>> = { guide: "guide", when: "when", prompt: "prompt", run: "script" };

/** Station ids whose routes out differ between two graphs, a segment's stations counted as the segment. */
function reroutedIds(base: WorkflowGraph, graph: WorkflowGraph): string[] {
  const routes = (g: WorkflowGraph, id: string) => g.edges.filter((e) => segmentTopOf(e.from) === id && segmentTopOf(e.to) !== id).map((e) => `${segmentTopOf(e.to)}|${e.condition ?? ""}|${e.label ?? ""}`).sort().join("\n");
  const tops = (g: WorkflowGraph) => new Set([...g.nodes.keys()].map(segmentTopOf));
  const b = tops(base);
  return [...tops(graph)].filter((id) => b.has(id) && routes(base, id) !== routes(graph, id));
}

/**
 * Own marks per station id, from variantChanges (the one place a variant's differences are read) and the variant's
 * typed edits, which say what the project wrote (guide, when) where the diff sees only the prompt text and edges they
 * became. Keyed by id only: two stations may share a label.
 */
function ownMarks(base: WorkflowGraph | null, graph: WorkflowGraph, sameFlow: boolean): { mark: (id: string) => { own: PipelineOwn; changed?: string[] }; removed: string[] } {
  if (!base) return { mark: () => ({ own: "added" }), removed: [] };
  if (sameFlow) return { mark: () => ({ own: "inherited" }), removed: [] };
  const c = variantChanges(base, graph);
  const baseTops = new Set([...base.nodes.keys()].map(segmentTopOf));
  const added = new Set(c.ids.added);
  const fields = new Map<string, Set<string>>();
  const add = (id: string, words: string[]) => { const s = fields.get(id) ?? new Set<string>(); for (const w of words) s.add(w); fields.set(id, s); };
  for (const ch of c.changed) add(ch.id, ch.fields);
  for (const id of reroutedIds(base, graph)) add(id, ["routes"]);
  for (const e of graph.edits ?? []) if (EDIT_WORD[e.op]) add(segmentTopOf(e.station), [EDIT_WORD[e.op]!]);
  return {
    mark: (id) => {
      if (added.has(id) || !baseTops.has(id)) return { own: "added" };
      const words = new Set(fields.get(id) ?? []);
      if (words.has("guide")) words.delete("prompt");
      if (words.has("when")) words.delete("routes");
      return words.size ? { own: "changed", changed: [...words] } : { own: "inherited" };
    },
    // variantChanges leaves a skip's stations out of its removed list; graph.pruned holds them down the whole extends
    // chain (the skipped station and what only it led to), the ends left out.
    removed: [...new Set([...c.removed, ...(graph.pruned ?? []).map((id) => base.nodes.get(id)).filter((n) => n && n.type !== "exit").map((n) => n!.label)])],
  };
}

const PROMPT_MAX = 20_000;
const capped = (s: string) => (s.length > PROMPT_MAX ? `${s.slice(0, PROMPT_MAX - 1)}…` : s);

/** A prompted station's words: the inherited prompt and the project's `guide=` apart, its agent and model. */
function promptOf(n: WorkflowNode, guideText: string | null): Pick<PipelineStation, "prompt" | "guide" | "agent" | "model"> {
  const guide = guideText?.trim() || null;
  let prompt = n.prompt?.trimEnd() ?? null;
  // The parser appends guide= to the prompt it inherits ("\n\n" + text); the panel shows them apart.
  if (prompt && guide && prompt.endsWith(guide)) prompt = prompt.slice(0, -guide.length).trimEnd();
  return {
    prompt: prompt ? capped(prompt) : null,
    ...(guide ? { guide: capped(guide) } : {}),
    ...(n.agent ? { agent: n.agent } : {}),
    ...(n.model ? { model: n.model } : {}),
  };
}

/** What a release sends a step through: its targets' step commands (DP13), else `[line.deploy]` for a line's deploy with no target. */
export type ReleaseSteps = { targets: ReadonlyArray<PipelineTarget>; line?: Partial<LineDeployProfile> | null };

/**
 * A release step's command. Each target the release sends from a checkout runs its own (targetDeployProfile), so the
 * step reads one command when they agree and `varies` when they do not, with every target's listed. A repository
 * with no such target deploys through its line's `[line.deploy]`.
 */
function releaseStep(step: LineDeployStep, r: ReleaseSteps | undefined): Pick<PipelineStation, "runs" | "varies" | "targets"> {
  const sent = (r?.targets ?? []).filter((t) => t.runs === "here");
  if (!sent.length) return { runs: deployStepCommand(r?.line, step) };
  const targets = sent.map((t) => ({ name: t.name, runs: t.steps[step] ?? null }));
  return new Set(targets.map((t) => t.runs)).size === 1 ? { runs: targets[0].runs, targets } : { varies: true, targets };
}

/** One flow of the pipeline from its parsed graph. */
export function pipelineFlow(opts: { slug: string; graph: WorkflowGraph; file: string | null; root: string; base: { slug: string; graph: WorkflowGraph } | null; library: boolean; release?: ReleaseSteps }): PipelineFlow {
  const { graph } = opts;
  const nodes = [...graph.nodes.values()];
  const folded = foldFlow(nodes.map(flowNodeOf), graph.edges);
  const edits = graph.edits ?? [];
  const { mark, removed } = ownMarks(opts.library ? graph : opts.base?.graph ?? null, graph, opts.library);
  const stations: PipelineStation[] = folded.stations.map((s) => {
    const n = graph.nodes.get(s.id)!;
    const inner = innerOf(nodes, s.id);
    const step = n.script?.match(STEP_SCRIPT)?.[1] as LineDeployStep | undefined;
    const isStep = !!step && (LINE_DEPLOY_STEPS as readonly string[]).includes(step);
    const codecastOwn = /\bcast line deploy (watch|return)\b/.test(n.script ?? "");
    const commands = n.segment_entry ? inner.filter((x) => x.type === "command" && x.script).map((x) => x.script!) : n.type === "command" && n.script ? [n.script] : [];
    const waits = n.segment_flow === "deploy" && commands.some((c) => SENDS_NOTHING.test(c));
    const who: PipelineWho = isStep ? STEP_WHO[step!] : codecastOwn || waits ? "rule" : nodeWho(n, inner);
    // graph.gated holds every when= the graph runs by, a base's own included; a variant's edit names the rest.
    const when = graph.gated?.[s.id] ?? Object.entries(graph.gated ?? {}).find(([id]) => segmentTopOf(id) === s.id)?.[1] ?? edits.find((e) => e.op === "when" && segmentTopOf(e.station) === s.id)?.paths;
    const guided = edits.find((e) => e.op === "guide" && segmentTopOf(e.station) === s.id);
    const asks = (guided?.node ? graph.nodes.get(guided.node) : null) ?? (n.type === "command" ? null : n.prompt ? n : inner.find((x) => x.prompt && x.type !== "command") ?? null);
    return {
      id: s.id,
      label: isStep ? LINE_DEPLOY_STEP_LABELS[step!] : s.label,
      who,
      main: s.main,
      ...mark(s.id),
      ...(when?.length ? { when } : {}),
      ...(isStep ? releaseStep(step!, opts.release) : commands.length ? { runs: commands.join("\n") } : {}),
      ...(waits ? { waits: true as const } : {}),
      ...(asks ? promptOf(asks, guided?.text ?? null) : {}),
    };
  });
  return {
    slug: opts.slug,
    label: graph.label ?? (opts.slug === CHANGE_FLOW_SLUG ? "Change" : opts.slug === LINE_DEPLOY_GRAPH ? "Release" : opts.slug),
    base: opts.library ? opts.slug : opts.base?.slug ?? null,
    file: opts.file && inside(opts.root, opts.file) ? path.relative(opts.root, opts.file) : null,
    graph: { nodes: nodes.map(flowNodeOf), edges: edgesOf(graph) },
    stations,
    removed,
  };
}

/** A flow by its source, parsed where it sits, with the repo files it reads (its extends chain, its prompts and scripts). */
function flowFrom(slug: string, src: FlowSource, root: string, release?: ReleaseSteps): { flow: PipelineFlow; files: string[] } {
  const graph = parseWorkflowSource(src.src, src.dir, {}, src.file);
  const repoFile = !!src.file && inside(root, src.file);
  const chain = repoFile ? flowChain(src.src, src.file!, root) : null;
  const flow = pipelineFlow({ slug, graph, file: chain?.file ?? null, root, base: chain?.base ?? null, library: !repoFile, release });
  const files = [...(chain?.files ?? []), ...(graph.sources ?? [])].filter((f) => inside(root, f));
  return { flow, files };
}

const NO_STEPS = Object.fromEntries(LINE_DEPLOY_STEPS.map((s) => [s, null])) as Record<LineDeployStep, string | null>;

/** A target as the pipeline shows it, with what a deploy of it runs at each step (DP13). */
export const pipelineTarget = (t: DeployTarget): PipelineTarget => {
  const profile = targetDeployProfile(t, "deploy");
  return { name: t.name, policy: t.policy, runs: t.runs, when: t.paths, steps: { ...NO_STEPS, ...Object.fromEntries(LINE_DEPLOY_STEPS.map((s) => [s, deployStepCommand(profile, s)])) } };
};

/** The pipeline of a checkout, as `cast flow pipeline` prints it and a publish sends it, with the repo files it was read from. */
export function buildPipeline(i: PipelineInputs): { pipeline: PipelinePublish; files: string[] } {
  const pool = poolFlows(i.root, null, i.pushed ?? [], i.cacheRoot);
  const change = changeFlowOf(pool, i.teamDefault);
  if (!change) throw new Error(`No change flow resolves in ${i.root}: neither .codecast/flows/change.cast, the team's default, nor the shipped change parses`);
  const changeSrc: FlowSource = change.file ? { src: fs.readFileSync(change.file, "utf-8"), dir: path.dirname(change.file), file: change.file } : { src: BUILTIN_WORKFLOW_TEMPLATES[change.slug] };
  const flowsDir = repoFlowsDir(i.root) ?? path.join(i.root, ".codecast", "flows");
  const releaseSrc = resolveFlowSource(LINE_DEPLOY_GRAPH, flowsDir);
  if (!releaseSrc) throw new Error(`No ${LINE_DEPLOY_GRAPH} flow resolves in ${i.root}`);
  const targets = (i.targets ?? []).map(pipelineTarget);
  const c = flowFrom(change.slug, changeSrc, i.root);
  const r = flowFrom(LINE_DEPLOY_GRAPH, releaseSrc, i.root, { targets, line: i.deploy });
  return {
    pipeline: { repository: i.repository.toLowerCase(), device_id: i.deviceId ?? null, head_sha: i.headSha ?? null, root: i.root, recent: i.recent ?? EMPTY_RECENT, change: c.flow, release: { ...r.flow, targets } },
    files: [...new Set([...c.files, ...r.files])],
  };
}

/** The pipeline in words: both lanes, each station's who, own mark, when and command. How agents read it. */
export function pipelineLines(p: PipelinePublish): string[] {
  const clip = (s: string) => (s.length > 160 ? `${s.slice(0, 159)}…` : s);
  const flowLines = (title: string, f: PipelineFlow) => {
    const from = f.file ?? (f.base === f.slug ? "the library's, as it stands" : "the library's");
    const lines = [`${title}: ${f.label} (${f.slug})  ${from}${f.base && f.base !== f.slug ? `, extends ${f.base}` : f.base ? "" : ", written whole here"}`];
    const width = Math.max(...f.stations.map((s) => s.label.length), 4);
    for (const s of f.stations) {
      lines.push(`  ${s.main ? "●" : "○"} ${s.label.padEnd(width)}  ${s.who.padEnd(7)}  ${ownWords(s)}${s.waits ? "  waits for the deploy" : ""}${s.when ? `  when ${s.when.join(", ")}` : ""}`);
      const runs = runsWords(s);
      if (runs) for (const [k, line] of runs.split("\n").entries()) lines.push(`      ${k ? "      " : "runs: "}${clip(line)}`);
      if (s.varies) for (const t of s.targets ?? []) lines.push(`        ${t.name}: ${clip(runsWords({ runs: t.runs })!)}`);
    }
    if (f.removed.length) lines.push(`  skipped from ${f.base}: ${f.removed.join(", ")}`);
    return lines;
  };
  const targets = p.release.targets.length
    ? p.release.targets.map((t) => `  ${t.name}  ${t.policy}, ${t.runs === "push" ? "deploys itself on push" : "sent from the publishing checkout"}${t.when.length ? `  when ${t.when.join(", ")}` : "  every path"}`)
    : ["  none declared (.codecast/deploy.toml [[target]])"];
  return [
    `Pipeline of ${p.repository}${p.head_sha ? ` at ${p.head_sha.slice(0, 10)}` : ""}`,
    "",
    ...flowLines("Each change", p.change),
    "",
    "Then main.",
    "",
    ...flowLines("Each release", p.release),
    "",
    "Release targets:",
    ...targets,
    "",
    "● on the passing path  ○ a way back or an end",
  ];
}

const git = (root: string, args: string[]) => {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf-8" });
  return { ok: r.status === 0, out: String(r.stdout ?? "").trim() };
};

/** The commit a checkout's files are, and when it was made; null outside a repository. */
export function headOf(root: string): { sha: string; at: number } | null {
  const r = git(root, ["show", "-s", "--format=%H %ct", "HEAD"]);
  if (!r.ok || !r.out) return null;
  const [sha, ct] = r.out.split(" ");
  return { sha, at: Number(ct) * 1000 };
}

/**
 * Whether this checkout's pipeline is the repository's (pipeline.md PL5: never an uncommitted write on one machine):
 * HEAD is on the default branch as origin has it (equal to it or behind it), and `.codecast` and every flow file the
 * pipeline read are clean. Else why not.
 */
export function publishRefusal(root: string, files: ReadonlyArray<string>): string | null {
  const ref = git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const branch = ref.ok ? ref.out.replace(/^origin\//, "") : "main";
  if (!git(root, ["rev-parse", "--verify", "--quiet", `origin/${branch}`]).ok) return `no origin/${branch} here to compare with`;
  if (!git(root, ["merge-base", "--is-ancestor", "HEAD", `origin/${branch}`]).ok) return `HEAD is not on origin/${branch}: publish from a checkout of the default branch`;
  const paths = [".codecast", ...files.map((f) => path.relative(root, f))];
  const dirty = git(root, ["status", "--porcelain", "--", ...paths]);
  if (!dirty.ok) return "git status could not read the flow files";
  if (dirty.out) return `uncommitted flow files: ${dirty.out.split("\n").map((l) => l.replace(/^\s*\S+\s+/, "")).slice(0, 5).join(", ")}`;
  return null;
}

/** The default branch's last commits on origin, newest first, with the paths each changed (mainCommitsOf), packed. */
export async function recentCommits(root: string): Promise<PipelineRecent> {
  const main = (await import("./lineProfileCommand.js")).mainCommitsOf(root, PIPELINE_RECENT_MAX);
  return packRecent((main?.commits ?? []).reverse().map((c) => ({ sha: c.sha, subject: c.message, at: c.at, files: c.files })));
}

/** A checkout's pipeline from its own files: its targets and release step commands read the way a deploy reads them. */
export async function checkoutPipeline(root: string, i: Omit<PipelineInputs, "root" | "deploy" | "targets" | "repository" | "headSha"> & { repository?: string }): Promise<{ pipeline: PipelinePublish; files: string[]; head: { sha: string; at: number } | null }> {
  const { checkoutTargets, loadLineDeployProfile } = await import("./lineDeploy.js");
  const repository = i.repository ?? (await import("./prCommand.js")).readLocalGitContext(root).repository;
  if (!repository) throw new Error(`${root} has no GitHub origin, so its pipeline names no repository`);
  let deploy: Partial<LineDeployProfile> | null = null;
  try { deploy = (await loadLineDeployProfile(root)).profile.deploy ?? null; } catch {
    // An unreadable line.toml leaves a target-less release without step commands; `cast line profile` says why.
  }
  const head = headOf(root);
  return { ...buildPipeline({ ...i, root, repository, deploy, targets: await checkoutTargets(root), headSha: head?.sha ?? null, recent: await recentCommits(root) }), head };
}

type Post = (urlPath: string, body: Record<string, unknown>) => Promise<any>;

/** What this machine knows of a team's flows: its published pool and its default flow. Unreadable reads as none. */
export async function teamFlowFacts(post: Post, teamId: string | null | undefined): Promise<{ pushed: PushedPoolRow[]; teamDefault: string | null }> {
  if (!teamId) return { pushed: [], teamDefault: null };
  const [pool, teams] = await Promise.all([post("/cli/workflows/pool", { team_id: teamId }).catch(() => null), post("/cli/teams", {}).catch(() => null)]);
  const team = (teams?.teams ?? []).find((t: any) => String(t?._id) === String(teamId));
  return { pushed: pool?.flows ?? [], teamDefault: team?.default_flow ?? null };
}

export type PipelinePublishReply = { team_id: string; repository: string; changed: boolean; refused?: string } | { skipped: string };

/**
 * Publish a checkout's pipeline into its repository's team (pipelines.publish; the team given, else the
 * repository's), only from a checkout whose files are the default branch's (publishRefusal); else skipped, saying why.
 * The server keeps the newest commit's and refuses an older one.
 */
export async function publishPipeline(post: Post, root: string, opts: { teamId?: string | null; repository?: string; deviceId?: string | null }): Promise<PipelinePublishReply> {
  const facts = await teamFlowFacts(post, opts.teamId);
  const { pipeline, files, head } = await checkoutPipeline(root, { ...facts, ...(opts.repository ? { repository: opts.repository } : {}), deviceId: opts.deviceId ?? null });
  const refusal = head ? publishRefusal(root, files) : "not a git checkout";
  if (refusal) return { skipped: refusal };
  return post("/cli/pipelines/publish", { ...pipeline, head_at: head!.at, ...(opts.teamId ? { team_id: opts.teamId } : {}) });
}
