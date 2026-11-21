import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { checkoutPipeline, pipelineLines, pipelineTarget, publishRefusal } from "./pipeline.js";
import { targetDeployProfile } from "./lineDeploy.js";
import type { PipelineFlow } from "@codecast/shared/contracts/pipeline";

// A repository's pipeline from its checkout (pipeline.md PL6). Synthetic repositories only: a bare one (shipped
// flows), a variant of the shipped change written with the PL3 edits, and acme/widgets (a flow written whole behind
// an extends shim, a fan-out, a Deploy that only waits, targets whose steps differ).

const ACME = path.join(import.meta.dir, "__fixtures__", "pipeline-acme");
const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const station = (f: PipelineFlow, id: string) => {
  const s = f.stations.find((x) => x.id === id);
  if (!s) throw new Error(`no station ${id} in ${f.stations.map((x) => x.id).join(", ")}`);
  return s;
};
const build = async (root: string, extra: { teamDefault?: string } = {}) =>
  (await checkoutPipeline(root, { repository: "Acme/Widgets", cacheRoot: tmp("pipeline-cache-"), ...extra })).pipeline;

describe("a checkout with no flows of its own runs the shipped change and line-deploy", async () => {
  const p = await build(tmp("pipeline-bare-"));

  test("the change lane is the library's change, every station inherited", () => {
    expect(p.repository).toBe("acme/widgets");
    expect(p.head_sha).toBeNull();
    expect(p.change).toMatchObject({ slug: "change", label: "Change", base: "change", file: null, removed: [] });
    expect(p.change.stations.filter((s) => s.main).map((s) => s.label)).toEqual(["Check", "Review", "Decide", "Land", "Deploy"]);
    expect(new Set(p.change.stations.map((s) => s.own))).toEqual(new Set(["inherited"]));
    expect(station(p.change, "review").who).toBe("agent");
    expect(station(p.change, "review").prompt).toBeTruthy();
    expect(station(p.change, "decide").who).toBe("person");
    expect(station(p.change, "fix_check")).toMatchObject({ who: "agent", main: false });
  });

  test("a segment that runs commands says what it runs; a Deploy that sends is a deploy", () => {
    expect(station(p.change, "check")).toMatchObject({ who: "command" });
    expect(station(p.change, "check").runs).toBeTruthy();
    expect(station(p.change, "ship").runs).toBeTruthy();
    expect(station(p.change, "deploy")).toMatchObject({ who: "deploy" });
    expect(station(p.change, "deploy").waits).toBeUndefined();
    expect(station(p.change, "deploy").runs).toContain('--send "release"');
  });

  test("the graph is the expanded one foldFlow reads", () => {
    expect(p.change.graph.nodes.some((n) => n.id === "review__review")).toBe(true);
    expect(p.change.graph.nodes.find((n) => n.id === "review")?.segment_entry).toBe(true);
  });

  test("with no targets and no [line.deploy], every release step passes with a note; Watch is codecast's own", () => {
    expect(p.release).toMatchObject({ slug: "line-deploy", base: "line-deploy", file: null, targets: [] });
    for (const id of ["ci", "send", "gate", "rollout", "live", "finish"]) expect(station(p.release, id)).toMatchObject({ runs: null });
    expect(station(p.release, "send")).toMatchObject({ label: "Send", who: "deploy", own: "inherited", main: true });
    expect(station(p.release, "gate").who).toBe("eval");
    expect(station(p.release, "watch")).toMatchObject({ who: "rule", runs: "cast line deploy watch $goal" });
    expect(station(p.release, "returned")).toMatchObject({ main: false, who: "rule" });
    expect(pipelineLines(p).join("\n")).toContain("no command: passes");
  });
});

describe("a variant of change written with the PL3 edits", async () => {
  const root = tmp("pipeline-variant-");
  fs.mkdirSync(path.join(root, ".codecast", "flows"), { recursive: true });
  fs.writeFileSync(path.join(root, ".codecast", "flows", "change.cast"), `digraph change {
  graph [extends="change"]
  lint   [after="check", label="Lint", when="web/**, docs/", shape=parallelogram, script="bun run lint"]
  review [guide="House rule: name the migration a schema change needs."]
  fix_review [prompt="Address the review, then say what you changed."]
}`);
  const p = await build(root);

  test("own, changed and inherited stations, by id", () => {
    expect(p.change).toMatchObject({ slug: "change", base: "change", file: ".codecast/flows/change.cast" });
    expect(station(p.change, "lint")).toMatchObject({ own: "added", who: "command", runs: "bun run lint", main: true, when: ["web/**", "docs/"] });
    expect(station(p.change, "fix_review")).toMatchObject({ own: "changed", changed: ["prompt"], prompt: "Address the review, then say what you changed." });
    expect(station(p.change, "decide").own).toBe("inherited");
    expect(station(p.change, "deploy").own).toBe("inherited");
  });

  test("guide= reads as guidance, apart from the prompt it inherits", () => {
    const review = station(p.change, "review");
    expect(review).toMatchObject({ own: "changed", changed: ["guide"], guide: "House rule: name the migration a schema change needs." });
    expect(review.prompt).toBeTruthy();
    expect(review.prompt).not.toContain("House rule");
  });

  test("what an earlier file in the chain gates or skips still reads on the pipeline", async () => {
    const root = tmp("pipeline-chain-");
    fs.mkdirSync(path.join(root, ".codecast", "flows"), { recursive: true });
    fs.writeFileSync(path.join(root, ".codecast", "flows", "house.cast"), `digraph house { graph [extends="change"] e2e [after="check", label="E2E", when="{api,web}/src/**, docs/", shape=parallelogram, script="bun run e2e"] decide [skip=true] }`);
    fs.writeFileSync(path.join(root, ".codecast", "flows", "outer.cast"), `digraph outer { graph [extends="house.cast"] e2e [script="bun run e2e --ci"] }`);
    const q = await build(root, { teamDefault: "outer" });
    expect(q.change).toMatchObject({ slug: "outer", base: "change", file: ".codecast/flows/house.cast" });
    expect(station(q.change, "e2e")).toMatchObject({ own: "added", when: ["{api,web}/src/**", "docs/"], runs: "bun run e2e --ci" });
    expect(q.change.stations.some((s) => s.id === "decide")).toBe(false);
    expect(q.change.removed).toContain("Decide");
  });

  test("the team's default flow is Ship's when the repo has no change of its own", async () => {
    const alt = tmp("pipeline-default-");
    fs.mkdirSync(path.join(alt, ".codecast", "flows"), { recursive: true });
    fs.writeFileSync(path.join(alt, ".codecast", "flows", "house.cast"), `digraph house { graph [extends="change"] decide [skip=true] }`);
    const q = await build(alt, { teamDefault: "house" });
    expect(q.change).toMatchObject({ slug: "house", base: "change", file: ".codecast/flows/house.cast", removed: ["Decide", "Revise"] });
    expect(q.change.stations.some((s) => s.id === "decide")).toBe(false);
  });
});

test("a repo change that does not parse is what Ship meets, said", async () => {
  const root = tmp("pipeline-broken-");
  fs.mkdirSync(path.join(root, ".codecast", "flows"), { recursive: true });
  fs.writeFileSync(path.join(root, ".codecast", "flows", "change.cast"), 'digraph change { graph [extends="nowhere"] }');
  await expect(build(root)).rejects.toThrow("does not parse, so Ship has no flow here");
});

describe("acme/widgets: a flow written whole behind an extends shim, targets whose steps differ", async () => {
  const p = await build(ACME);

  test("the change lane is the repo's own, opened at the file that holds its stations", () => {
    expect(p.change).toMatchObject({ slug: "change", label: "Change", base: null, file: "tools/flow/change.cast", removed: [] });
    expect(new Set(p.change.stations.map((s) => s.own))).toEqual(new Set(["added"]));
    expect(p.change.stations.filter((s) => s.main).map((s) => s.id)).toEqual(["open", "checks", "tests", "review", "read", "merge", "deploy"]);
    expect(station(p.change, "open")).toMatchObject({ who: "command", runs: "./tools/flow/open.sh $branch" });
    expect(station(p.change, "checks").who).toBe("rule");
    expect(station(p.change, "read").who).toBe("rule");
    expect(station(p.change, "review")).toMatchObject({ who: "agent", agent: "claude", prompt: "Review the change for correctness. (synthetic)" });
    expect(station(p.change, "fix")).toMatchObject({ who: "agent", main: false });
  });

  test('a Deploy with send="" waits for the deploy; it sends none', () => {
    expect(station(p.change, "deploy")).toMatchObject({ who: "rule", waits: true });
    expect(station(p.change, "deploy").runs).toContain('--send ""');
    expect(pipelineLines(p).join("\n")).toContain("waits for the deploy");
  });

  test("each target's step commands are what a deploy of it runs (targetDeployProfile)", () => {
    const steps = Object.fromEntries(p.release.targets.map((t) => [t.name, t.steps]));
    expect(p.release.targets.map((t) => [t.name, t.policy, t.runs])).toEqual([["api", "press", "here"], ["worker", "release", "here"], ["site", "press", "push"]]);
    expect(steps.api).toEqual({ ci: "./tools/ci-verdict.sh $sha", send: "./tools/deploy-api.sh --sha $sha", gate: null, rollout: null, live: "cast line deploy await-live $deploy", finish: null });
    expect(steps.worker).toMatchObject({ ci: null, send: "./tools/deploy-worker.sh $sha", live: null });
    expect(p.release.targets.find((t) => t.name === "site")?.when).toEqual(["site/**"]);
  });

  test("a target's own gate and rollout show at those steps; a rollback runs none of its steps", () => {
    const t = { name: "production", command: "./deploy.sh --sha $sha --no-watch", runs: "here" as const, live: { kind: "marker" as const }, policy: "press" as const, paths: [], ci: "cast line deploy follow --jobs ci-verdict", gate: "cast line deploy follow --jobs gate,evals", rollout: "cast line deploy follow --jobs deploy" };
    expect(pipelineTarget(t).steps).toEqual({ ci: "cast line deploy follow --jobs ci-verdict", send: "./deploy.sh --sha $sha --no-watch", gate: "cast line deploy follow --jobs gate,evals", rollout: "cast line deploy follow --jobs deploy", live: null, finish: null });
    expect(targetDeployProfile({ ...t, rollback: "./deploy.sh --rollback" }, "rollback")).toEqual({ command: "./deploy.sh --rollback", target: "production", trigger: "person" });
  });

  test("a release step reads one command where the targets agree and varies where they differ", () => {
    expect(station(p.release, "live")).toMatchObject({ varies: true, targets: [{ name: "api", runs: "cast line deploy await-live $deploy" }, { name: "worker", runs: null }] });
    expect(station(p.release, "live").runs).toBeUndefined();
    expect(station(p.release, "send")).toMatchObject({ varies: true, targets: [{ name: "api", runs: "./tools/deploy-api.sh --sha $sha" }, { name: "worker", runs: "./tools/deploy-worker.sh $sha" }] });
    expect(station(p.release, "gate")).toMatchObject({ runs: null, targets: [{ name: "api", runs: null }, { name: "worker", runs: null }] });
    expect(station(p.release, "gate").varies).toBeUndefined();
    const text = pipelineLines(p).join("\n");
    expect(text).toContain("runs: varies by target");
    expect(text).toContain("api: cast line deploy await-live $deploy");
    expect(text).toContain("worker: no command: passes");
  });
});

describe("a pipeline publishes only from the default branch with its flow files clean", () => {
  const sh = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const repo = () => {
    const origin = tmp("pipeline-origin-");
    sh(origin, "init", "-q", "--bare", "-b", "main");
    const root = tmp("pipeline-clone-");
    fs.cpSync(ACME, root, { recursive: true });
    sh(root, "init", "-q", "-b", "main");
    sh(root, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "add", ".");
    sh(root, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "-m", "init");
    sh(root, "remote", "add", "origin", origin);
    sh(root, "push", "-q", "origin", "main");
    sh(root, "fetch", "-q", "origin");
    sh(root, "remote", "set-head", "origin", "main");
    return root;
  };

  test("a clean checkout of origin's main publishes, at its commit", async () => {
    const root = repo();
    const { pipeline, files, head } = await checkoutPipeline(root, { repository: "acme/widgets", cacheRoot: tmp("pipeline-cache-") });
    expect(head?.sha).toBe(sh(root, "rev-parse", "HEAD"));
    expect(pipeline.head_sha).toBe(head!.sha);
    expect(files.map((f) => path.relative(fs.realpathSync(root), fs.realpathSync(f))).sort()).toEqual([".codecast/flows/change.cast", "tools/flow/change.cast", "tools/flow/change/fix.md", "tools/flow/change/review.md"]);
    expect(publishRefusal(root, files)).toBeNull();
  });

  test("an uncommitted flow file or prompt, or a commit origin's main lacks, is refused with why", async () => {
    const root = repo();
    const { files } = await checkoutPipeline(root, { repository: "acme/widgets", cacheRoot: tmp("pipeline-cache-") });
    fs.appendFileSync(path.join(root, "tools", "flow", "change", "review.md"), "More.\n");
    expect(publishRefusal(root, files)).toContain("uncommitted flow files: tools/flow/change/review.md");
    sh(root, "checkout", "-q", "--", ".");
    fs.writeFileSync(path.join(root, ".codecast", "notes.txt"), "x");
    expect(publishRefusal(root, files)).toContain(".codecast/notes.txt");
    fs.rmSync(path.join(root, ".codecast", "notes.txt"));
    fs.writeFileSync(path.join(root, "unrelated.txt"), "x");
    expect(publishRefusal(root, files)).toBeNull();
    sh(root, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "ahead");
    expect(publishRefusal(root, files)).toContain("HEAD is not on origin/main");
  });
});
