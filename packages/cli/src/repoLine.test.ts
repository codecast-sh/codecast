// The repo as the home of a project's line (docs/architecture/line-map.md LX5):
// materialize from the shipped line, station edits checked before they are
// written, the runner's resolution order, and the published shape.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chooseLineSource, findNodeStmt, planStationEdits, publishedRepoLine, repoLineFile, repoLineForRun, setNodeAttr, shippedRepoLineFiles } from "./repoLine";
import { removeLineFile, runLineProfileEdit } from "./lineProfileEdit";
import { publishFacts } from "./lineProfileCommand";
import { loadLineProfile } from "./lineProfile";
import { graphForDaemonRun } from "./workflow/daemonGraph";
import { graphHash, parseWorkflowSource } from "./workflow/parser";
import { BUILTIN_WORKFLOW_TEMPLATES, LINE_TEMPLATE_FILES } from "./workflow/templates";
import { isTrackedLineProfile, fenceTargetOf } from "./configFence";

function checkout(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repo-line-")));
  fs.mkdirSync(path.join(root, ".git"));
  return root;
}

function apply(root: string, writes: Array<{ rel: string; content: string }>) {
  for (const w of writes) {
    const file = path.join(root, w.rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, w.content);
  }
}

const shippedHash = graphHash(parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.line));
const parsedRepo = (root: string) => parseWorkflowSource(fs.readFileSync(repoLineFile(root), "utf8"), path.dirname(repoLineFile(root)));

describe("materialize", () => {
  test("the shipped line as repo files: refs made local, one file per shipped prompt and script", () => {
    const files = shippedRepoLineFiles();
    expect(Object.keys(files).sort()).toEqual(["line.cast", ...Object.keys(LINE_TEMPLATE_FILES).map((f) => f.slice("line/".length))].sort());
    expect(files["line.cast"]).not.toContain('"@line/');
    expect(files["line.cast"]).toContain('prompt="@ground.md"');
  });

  test("written out unchanged, it parses to exactly the shipped graph", () => {
    const root = checkout();
    apply(root, Object.entries(shippedRepoLineFiles()).map(([name, content]) => ({ rel: `.codecast/line/${name}`, content })));
    expect(graphHash(parsedRepo(root))).toBe(shippedHash);
  });

  test("the first station edit writes the whole line out, then changes the one station", () => {
    const root = checkout();
    const plan = planStationEdits(root, [{ op: "set_station", station: "prove", prompt: "Reproduce it.", timeout: 600 }]);
    expect(plan.materialized).toBe(true);
    expect(plan.changed).toBe(true);
    expect(plan.stations).toEqual(["prove"]);
    expect(plan.writes.at(-1)!.rel).toBe(".codecast/line/line.cast");
    apply(root, plan.writes);
    const graph = parsedRepo(root);
    expect(graph.nodes.get("prove")!.prompt).toBe("Reproduce it.");
    expect(graph.nodes.get("prove")!.timeout).toBe(600);
    expect(graph.nodes.get("ground")!.prompt).toBe(LINE_TEMPLATE_FILES["line/ground.md"]);
    expect(graphHash(graph)).toBe(plan.graph_hash);
    expect(plan.graph_hash).not.toBe(shippedHash);
  });
});

describe("station edits", () => {
  // A repo holding the shipped line written out, as the first edit writes it.
  const materialized = () => {
    const root = checkout();
    apply(root, Object.entries(shippedRepoLineFiles()).map(([name, content]) => ({ rel: path.posix.join(".codecast/line", name), content })));
    return root;
  };
  const remove = (root: string, rels: string[]) => { for (const rel of rels) fs.rmSync(path.join(root, rel)); };

  test("an edit of a station whose prompt is a file rewrites that file only", () => {
    const root = materialized();
    const plan = planStationEdits(root, [{ op: "set_station", station: "review", prompt: "Review it hard." }]);
    expect(plan.materialized).toBe(false);
    expect(plan.writes.map((w) => w.rel)).toEqual([".codecast/line/review.md"]);
  });

  test("an inline value moves into its own file the first time it changes", () => {
    const root = materialized();
    const plan = planStationEdits(root, [{ op: "set_station", station: "verify", script: "bun test" }]);
    apply(root, plan.writes);
    const src = fs.readFileSync(repoLineFile(root), "utf8");
    expect(findNodeStmt(src, "verify")!.attrs.find((a) => a.key === "script")!.raw).toBe('"@verify.sh"');
    expect(fs.readFileSync(path.join(root, ".codecast/line/verify.sh"), "utf8")).toBe("bun test");
    expect(parsedRepo(root).nodes.get("verify")!.script).toBe("bun test");
  });

  test("reset puts a station's values back as shipped while another station still differs", () => {
    const root = materialized();
    apply(root, planStationEdits(root, [{ op: "set_station", station: "verify", script: "bun test", timeout: 60 }, { op: "set_station", station: "prove", prompt: "x" }]).writes);
    const plan = planStationEdits(root, [{ op: "reset_station", station: "verify" }]);
    expect(plan.removes).toEqual([]);
    apply(root, plan.writes);
    const verify = parsedRepo(root).nodes.get("verify")!;
    const shippedVerify = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.line).nodes.get("verify")!;
    expect([verify.script, verify.timeout]).toEqual([shippedVerify.script, shippedVerify.timeout]);
  });

  test("a reset that leaves the whole line as shipped removes the repo's copy, line.cast first", () => {
    const root = checkout();
    apply(root, planStationEdits(root, [{ op: "set_station", station: "prove", prompt: "x" }]).writes);
    const plan = planStationEdits(root, [{ op: "reset_station", station: "prove" }]);
    expect(plan).toMatchObject({ changed: true, writes: [], stations: ["prove"], graph_hash: shippedHash });
    expect(plan.removes[0]).toBe(".codecast/line/line.cast");
    remove(root, plan.removes);
    expect(fs.readdirSync(path.join(root, ".codecast/line"))).toEqual([]);
    expect(publishedRepoLine(root)).toBeNull();
  });

  test("a reset on a repo with no line of its own writes nothing", () => {
    const root = checkout();
    expect(planStationEdits(root, [{ op: "reset_station", station: "prove" }])).toMatchObject({ changed: false, writes: [], removes: [] });
    expect(fs.existsSync(path.join(root, ".codecast/line"))).toBe(false);
  });

  test("a no-op edit writes nothing and names no station", () => {
    const root = materialized();
    const plan = planStationEdits(root, [{ op: "set_station", station: "ground", prompt: LINE_TEMPLATE_FILES["line/ground.md"] }]);
    expect(plan).toMatchObject({ changed: false, writes: [], stations: [] });
  });

  test("refused before anything is written: an unknown station, a command station left without a script", () => {
    const root = checkout();
    expect(() => planStationEdits(root, [{ op: "set_station", station: "nope", prompt: "x" }])).toThrow(/no station "nope"/);
    expect(() => planStationEdits(root, [{ op: "set_station", station: "red", script: "" }])).toThrow(/Command node 'red' has no script/);
    expect(fs.existsSync(repoLineFile(root))).toBe(false);
  });

  test("attribute edits keep the rest of the statement as written", () => {
    const src = 'digraph x {\n  a [label="A", shape=parallelogram,\n    timeout=5, script="echo \\"]\\""]\n}\n';
    expect(setNodeAttr(src, "a", "timeout", null)).toBe('digraph x {\n  a [label="A", shape=parallelogram, script="echo \\"]\\""]\n}\n');
    expect(setNodeAttr(src, "a", "timeout", "9")).toContain("timeout=9,");
    expect(setNodeAttr(src, "a", "prompt", '"@a.md"')).toContain('script="echo \\"]\\"", prompt="@a.md"]');
  });
});

describe("the edit command (line_profile_edit)", () => {
  test("a station op writes through the fence, then republishes once", async () => {
    const root = checkout();
    const written: string[] = [];
    let published = 0;
    const reply = await runLineProfileEdit({ root, edits: [{ op: "set_station", station: "prove", timeout: 120 }] }, {
      admit: async (file) => file,
      write: (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); written.push(path.relative(root, file)); },
      publish: () => { published++; return { ok: true }; },
    });
    expect(reply.changed).toBe(true);
    expect(reply.line).toMatchObject({ changed: true, materialized: true, stations: ["prove"] });
    expect(written.at(-1)).toBe(".codecast/line/line.cast");
    expect(written).not.toContain(".codecast/line.toml");
    expect(published).toBe(1);
  });

  test("a reset back to shipped removes .codecast/line/ through the fence, then republishes", async () => {
    const root = checkout();
    const write = (file: string, content: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
    await runLineProfileEdit({ root, edits: [{ op: "set_station", station: "prove", timeout: 120 }] }, { admit: async (f) => f, write });
    let published = 0;
    const reply = await runLineProfileEdit({ root, edits: [{ op: "reset_station", station: "prove" }] }, {
      admit: async (f) => f, write, remove: removeLineFile, publish: () => { published++; return { ok: true }; },
    });
    expect(reply.line).toMatchObject({ changed: true, removed: true, materialized: false, stations: ["prove"] });
    expect(fs.existsSync(path.join(root, ".codecast/line"))).toBe(false);
    expect(published).toBe(1);
  });

  test("a file the fence refuses stops the edit before any write", async () => {
    const root = checkout();
    let writes = 0;
    await expect(runLineProfileEdit({ root, edits: [{ op: "set_station", station: "prove", timeout: 120 }] }, {
      admit: async (file) => (file.endsWith("line.toml") ? file : null),
      write: () => { writes++; },
    })).rejects.toThrow(/not a line file/);
    expect(writes).toBe(0);
  });

  test("the fence admits plain files in .codecast/line/ under a tracked root, and nothing deeper", () => {
    const root = checkout();
    const target = (rel: string) => fenceTargetOf(path.join(root, rel))!;
    expect(isTrackedLineProfile(target(".codecast/line/line.cast"), [root])).toBe(true);
    expect(isTrackedLineProfile(target(".codecast/line/prove.md"), [root])).toBe(true);
    expect(isTrackedLineProfile(target(".codecast/line/x/prove.md"), [root])).toBe(false);
    expect(isTrackedLineProfile(target(".codecast/line/run.exe"), [root])).toBe(false);
    expect(isTrackedLineProfile(target(".codecast/line/prove.md"), ["/elsewhere"])).toBe(false);
  });
});

describe("which line a run runs", () => {
  const withLine = () => {
    const root = checkout();
    apply(root, planStationEdits(root, [{ op: "set_station", station: "prove", timeout: 77 }]).writes);
    return root;
  };

  test("a task-bound run takes the repo's line ahead of the role's and the shipped one", () => {
    const root = withLine();
    const sub = path.join(root, "packages", "x");
    fs.mkdirSync(sub, { recursive: true });
    expect(chooseLineSource({ taskBound: true, cwd: sub, roleSlug: "line-custom" })).toMatchObject({ kind: "repo", resolved: { label: repoLineFile(root) } });
    expect(chooseLineSource({ taskBound: false, cwd: root, roleSlug: "line-custom" })).toEqual({ kind: "role", name: "line-custom" });
    expect(chooseLineSource({ taskBound: false, cwd: root })).toEqual({ kind: "shipped", name: "line" });
    expect(chooseLineSource({ file: "feature", taskBound: true, cwd: root })).toEqual({ kind: "file", name: "feature" });
    expect(chooseLineSource({ taskBound: true, cwd: checkout(), roleSlug: "line-custom" })).toEqual({ kind: "role", name: "line-custom" });
  });

  test("the daemon runs the repo's line for a task-bound line run, over the role's pushed row", () => {
    const root = withLine();
    const pushed = { slug: "line", name: "line", nodes: [{ id: "start", type: "start", shape: "Mdiamond", label: "S" }], edges: [] };
    const graph = graphForDaemonRun({ workflow_name: "line", task_short_id: "ct-1", goal_override: "Fix it" }, pushed, root)!;
    expect(graph.nodes.get("prove")!.timeout).toBe(77);
    expect(graph.goal).toBe("Fix it");
    expect(repoLineForRun({ workflow_name: "feature", task_short_id: "ct-1" }, { slug: "feature" }, root)).toBeNull();
    expect(repoLineForRun({ workflow_name: "line" }, null, root)).toBeNull();
    expect(graphForDaemonRun({ workflow_name: "line" }, pushed, root)!.nodes.size).toBe(1);
  });
});

describe("publish", () => {
  test("no repo line publishes no line", () => {
    const root = checkout();
    expect(publishedRepoLine(root)).toBeNull();
    expect("line" in publishFacts(loadLineProfile(root))).toBe(false);
  });

  test("the repo line rides the profile: source, stations as text, files and the hash a run records", () => {
    const root = checkout();
    const plan = planStationEdits(root, [{ op: "set_station", station: "prove", prompt: "Reproduce it." }]);
    apply(root, plan.writes);
    const line = publishFacts(loadLineProfile(root)).line!;
    expect(line.file).toBe(".codecast/line/line.cast");
    expect(line.graph_hash).toBe(plan.graph_hash);
    expect(line.source).toBe(fs.readFileSync(repoLineFile(root), "utf8"));
    expect(line.nodes.find((n) => n.id === "prove")!.prompt).toBe("Reproduce it.");
    expect(line.files.prove).toEqual({ prompt: ".codecast/line/prove.md" });
    expect(line.files.red).toEqual({ script: ".codecast/line/red.sh" });
    expect(line.edges.length).toBeGreaterThan(0);
  });

  test("a line that would not run refuses to publish, saying why", () => {
    const root = checkout();
    apply(root, planStationEdits(root, [{ op: "set_station", station: "prove", prompt: "x" }]).writes);
    fs.rmSync(path.join(root, ".codecast/line/red.sh"));
    expect(() => publishedRepoLine(root)).toThrow(/names red.sh/);
  });
});
