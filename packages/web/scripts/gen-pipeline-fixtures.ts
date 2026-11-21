// Writes lib/line/__tests__/pipelines.fixture.generated.ts: two pipelines in the
// contract's shape, parsed with the CLI's own parser. Codecast's own repo runs
// the shipped `change` as is; an example repo runs a change flow it wrote whole.
// Both release through the shipped line-deploy graph with their deploy targets.
// The model tests read them.
//
//   bun packages/web/scripts/gen-pipeline-fixtures.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseWorkflowFile, parseWorkflowSource } from "../../cli/src/workflow/parser";
import { BUILTIN_WORKFLOW_TEMPLATES } from "../../cli/src/workflow/templates";
import { flowNodeAttrOf, foldFlow, type FlowNodeIn } from "../../shared/contracts/flowPool";
import { readDeployTargets } from "../../cli/src/workspace/deployTargetsFile";
import { shipSpec } from "../../cli/src/land/shipCheckout";
import { deployStepCommand, LINE_DEPLOY_STEPS, type LineDeployProfile, type LineDeployStep } from "../../shared/contracts/lineDeploy";
import type { Pipeline, PipelineFlow, PipelineStation, PipelineWho } from "../lib/line/pipelineTypes";

const ROOT = path.resolve(import.meta.dir, "../../..");
const OUT = path.join(ROOT, "packages/web/lib/line/__tests__/pipelines.fixture.generated.ts");
const NODE_FIELDS = ["id", "label", "shape", "type", "backend", "agent", "segment", "segment_label", "segment_flow", "segment_entry", "segment_exit", "slot", "segment_generated", "stop", "max_visits"] as const;

type Graph = ReturnType<typeof parseWorkflowSource>;

function graphIn(g: Graph) {
  const nodes = [...g.nodes.values()].map((n) => Object.fromEntries(NODE_FIELDS.filter((k) => (n as any)[k] !== undefined).map((k) => [k, (n as any)[k]]))) as FlowNodeIn[];
  const edges = g.edges.map((e) => ({ from: e.from, to: e.to, ...(e.label ? { label: e.label } : {}), ...(e.condition ? { condition: e.condition } : {}) }));
  return { nodes, edges };
}

const SEGMENT_WHO: Record<string, PipelineWho> = { deploy: "deploy", decide: "person", eval: "eval", judge: "eval" };

function flowOf(slug: string, label: string, base: string | null, file: string | null, g: Graph, runsOf: (id: string) => string | null | undefined, source = ""): PipelineFlow {
  const sends = flowNodeAttrOf(source, "send");
  const graph = graphIn(g);
  const folded = foldFlow(graph.nodes, graph.edges);
  const stations: PipelineStation[] = folded.stations.map((s) => {
    const n = g.nodes.get(s.id)!;
    const seg = s.kind === "segment" ? segmentFacts(g, s.id, sends) : {};
    const who: PipelineWho = seg.waits ? "rule" : s.kind === "script" ? "command" : s.kind === "person" ? "person" : s.kind === "join" ? "rule" : s.kind === "segment" ? SEGMENT_WHO[s.flow ?? ""] ?? "agent" : "agent";
    const own = runsOf(s.id);
    const runs = own !== undefined ? own : seg.runs;
    // A segment reads by its one prompted inner station (Review's prompt for the review segment).
    const prompted = s.kind === "segment" ? [...g.nodes.values()].filter((x) => x.id.startsWith(`${s.id}__`) && x.prompt) : [];
    const prompt = n.prompt ?? (prompted.length === 1 ? prompted[0].prompt : undefined);
    return {
      id: s.id,
      label: s.label,
      who,
      // A flow the repo wrote whole is all its own; a library flow run as is, all inherited.
      own: base === null ? "added" : "inherited",
      main: s.main,
      ...(runs !== undefined ? { runs } : {}),
      ...(seg.waits ? { waits: true as const } : {}),
      ...(prompt ? { prompt: prompt.slice(0, 20000) } : {}),
      ...(n.agent ? { agent: n.agent } : {}),
      ...(n.model ? { model: n.model } : {}),
    };
  });
  return { slug, label, base, file, graph, stations, removed: [] };
}

/** A segment's inner commands, one per line; a Deploy with send="" waits for the deploy and sends none. */
function segmentFacts(g: Graph, id: string, sends: Record<string, string>): { runs?: string; waits?: true } {
  const n = g.nodes.get(id) as any;
  const inner = [...g.nodes.values()].filter((x) => x.id.startsWith(`${id}__`) && x.type === "command" && x.script);
  return { ...(inner.length ? { runs: inner.map((x) => x.script).join("\n") } : {}), ...(n?.segment_flow === "deploy" && sends[id] === "" ? { waits: true as const } : {}) };
}

function release(profile: Partial<LineDeployProfile>, root: string): Pipeline["release"] {
  const g = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES["line-deploy"]);
  const declared = readDeployTargets(root, shipSpec(root).deploy);
  const stepsOf = (t: (typeof declared)[number]) => Object.fromEntries(LINE_DEPLOY_STEPS.map((k) => [k, k === "send" ? t.command ?? null : typeof (t as any)[k] === "string" ? (t as any)[k] : null])) as Record<LineDeployStep, string | null>;
  const targets = declared.map((t) => ({ name: t.name, policy: t.policy, runs: t.runs, when: t.paths, steps: stepsOf(t) }));
  // A step's command: the one every target sent from the checkout agrees on; [line.deploy]'s when no target is sent from it.
  const sent = targets.filter((t) => t.runs === "here");
  const flow = flowOf("line-deploy", "Release", "line-deploy", null, g, (id) => {
    if (!(LINE_DEPLOY_STEPS as readonly string[]).includes(id)) return undefined;
    const step = id as LineDeployStep;
    if (!sent.length) return deployStepCommand(profile, step);
    const cmds = [...new Set(sent.map((t) => t.steps[step]))];
    return cmds.length === 1 ? cmds[0] : VARIES;
  });
  for (const st of flow.stations) {
    if (!(LINE_DEPLOY_STEPS as readonly string[]).includes(st.id) || !sent.length) continue;
    st.targets = sent.map((t) => ({ name: t.name, runs: t.steps[st.id as LineDeployStep] }));
    if (st.runs === VARIES) { delete st.runs; st.varies = true; }
  }
  return { ...flow, targets };
}
const VARIES = "\u0000varies";

const lineDeployOf = (toml: string) => ((Bun.TOML.parse(toml) as any).line?.deploy ?? {}) as Partial<LineDeployProfile>;

function codecast(): Pipeline {
  const g = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.change);
  const change = flowOf("change", "Change", "change", null, g, (id) => {
    const n = g.nodes.get(id);
    return n?.type === "command" ? n.script ?? null : undefined;
  }, BUILTIN_WORKFLOW_TEMPLATES.change);
  const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf-8");
  return { repository: "codecast-sh/codecast", published_at: 0, head_sha: null, device_id: null, change, release: release(lineDeployOf(read(".codecast/line.toml")), ROOT) };
}

// A repo that wrote its change flow whole, the shape a team's own flow takes (PR, CI and review side by side, a brief
// back to the session, merge, a Deploy that waits for the deploy and sends none), with two deploy targets. Synthetic:
// this repository is public, so no team's own flow text is copied into it.
const EXAMPLE_FLOW = `digraph change {
  graph [kind="line", label="Change", takes="task,branch"]
  start [shape=Mdiamond]
  pr [label="PR", shape=parallelogram, script="./scripts/line.sh pr"]
  checks [label="CI and review", shape=component]
  ci [label="CI", shape=parallelogram, script="./scripts/line.sh ci"]
  review [label="Review", backend=session, agent=claude, reviewer=true, prompt="Review the change against the task."]
  read [label="Read", shape=tripleoctagon]
  brief [label="Brief", shape=parallelogram, script="./scripts/line.sh brief"]
  fix [label="CI and review", backend=subject, prompt="Fix what CI and the review found."]
  merge [label="Merge", shape=parallelogram, script="./scripts/line.sh merge"]
  deploy [flow="deploy", send=""]
  exit [shape=Msquare, label="Live"]
  rejected [shape=Msquare, label="Rejected", stop="The reviewer rejected the change."]
  unmerged [shape=Msquare, label="Not merged", stop="$merge.output"]
  start -> pr
  pr -> checks [condition="outcome = success"]
  checks -> ci
  checks -> review
  ci -> read
  review -> read
  read -> rejected [condition="review.json.verdict = rejected", label="rejected"]
  read -> brief [condition="review.json.verdict = changes or ci.json.green != true", label="findings"]
  read -> merge [condition="ci.json.green = true", label="green, approved"]
  brief -> fix
  fix -> pr
  merge -> deploy [condition="outcome = success"]
  merge -> unmerged
  deploy -> exit
}
`;
const EXAMPLE_DEPLOY_TOML = `[[target]]
name = "production"
when = ["backend/**"]
run = "./deploy.sh --sha $sha --actor $actor"
live = "marker"

[[target]]
name = "dashboard"
runs = "push"
when = ["dashboard/**"]
live = "marker"
`;

function example(): Pipeline {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-example-"));
  fs.mkdirSync(path.join(dir, ".codecast/flows"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".codecast/flows/change.cast"), EXAMPLE_FLOW);
  fs.writeFileSync(path.join(dir, ".codecast/deploy.toml"), EXAMPLE_DEPLOY_TOML);
  const g = parseWorkflowFile(path.join(dir, ".codecast/flows/change.cast"));
  const change = flowOf("change", "Change", null, ".codecast/flows/change.cast", g, (id) => {
    const n = g.nodes.get(id);
    return n?.type === "command" ? n.script ?? null : undefined;
  }, EXAMPLE_FLOW);
  return { repository: "example-org/example-app", published_at: 0, head_sha: null, device_id: null, change, release: release({}, dir) };
}

const fixtures = [example(), codecast()];
fs.writeFileSync(OUT, [
  "// GENERATED by `bun packages/web/scripts/gen-pipeline-fixtures.ts` from the flows each repo runs. Do not edit.",
  'import type { Pipeline } from "../pipelineTypes";',
  "",
  // One line per pipeline: the file stays a handful of lines however large the flows grow.
  "export const PIPELINE_FIXTURES: Pipeline[] = [",
  ...fixtures.map((f) => `  ${JSON.stringify(f)},`),
  "];",
  "",
].join("\n"));
console.log(`wrote ${path.relative(ROOT, OUT)}: ${fixtures.map((p) => `${p.repository} (${p.change.stations.length}+${p.release.stations.length} stations, ${p.release.targets.length} targets)`).join(", ")}`);
