import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BRANCH, T, setup } from "./mergeStation.testkit";
import { GENERATED_FILE, generatorsFor, readGenerators } from "./generatedFiles";

// The Merge station and generated files (generatedFiles.ts): a rebase that
// conflicts only in files .codecast/generated.toml lists is resolved by the
// station, which takes main's side and runs their generator; any other
// conflict still goes to the change's session.

/** A repository whose gen/out.txt is every src/*.txt, written by its generator. */
function generatedWorld() {
  const s = setup();
  s.onMain({
    [GENERATED_FILE]: `[[generated]]\npaths = ["gen/*.txt"]\nrun = "cat src/*.txt > gen/out.txt"\n`,
    "src/a.txt": "a\n",
    "gen/out.txt": "a\n",
  });
  /** The change: one commit of `files`, pushed. */
  const change = (files: Record<string, string>) => {
    s.git(s.work, "checkout", "-q", "-b", BRANCH);
    for (const [f, t] of Object.entries(files)) { s.write(s.work, f, t); s.git(s.work, "add", f); }
    s.git(s.work, "commit", "-q", "-m", "change");
    s.git(s.work, "push", "-q", "origin", BRANCH);
    s.git(s.work, "checkout", "-q", "main");
    return s.git(s.work, "rev-parse", BRANCH);
  };
  const onOrigin = (file: string) => s.git(s.root, "--git-dir", s.origin, "show", `refs/heads/main:${file}`);
  return { ...s, change, onOrigin };
}

describe("cast flow merge: generated files", () => {
  test("a conflict only in generated files is resolved: main's side, regenerated, pushed and merged without a model or the subject", async () => {
    const s = generatedWorld();
    try {
      const head = s.change({ "src/b.txt": "b\n", "gen/out.txt": "a\nb\n" });
      s.ci(head);
      s.advanceMain("src/c.txt", "c\n");
      s.advanceMain("gen/out.txt", "a\nc\n");
      const r = await s.run();
      expect(r.code).toBe(0);
      expect(s.onOrigin("gen/out.txt")).toBe("a\nb\nc");
      expect(s.onOrigin("src/b.txt")).toBe("b");
      expect(s.logged.some((l) => l.startsWith(`${BRANCH} conflicts with main only in generated files (gen/out.txt): took main's side; regenerating with cat src/*.txt > gen/out.txt`))).toBe(true);
      // GitHub merged the tree the station resolved, not the head that still conflicts.
      const merge = s.gh().calls.find((c) => c[1] === "merge")!;
      const merged = merge[merge.indexOf("--match-head-commit") + 1];
      expect(merged).not.toBe(head);
      expect(s.git(s.work, "show", `${merged}:gen/out.txt`)).toBe("a\nb\nc");
      // Main changed gen/out.txt since CI, but a regenerated file is not an overlap a model is asked about.
      expect(s.posts.map((p) => p.path)).not.toContain("/cli/model/call");
    } finally { s.done(); }
  }, T);

  test("a conflict in a generated file and any other file goes to the change's session (exit 1), merging nothing", async () => {
    const s = generatedWorld();
    try {
      const head = s.change({ "a.txt": "mine\n", "src/b.txt": "b\n", "gen/out.txt": "a\nb\n" });
      s.ci(head);
      s.advanceMain("a.txt", "theirs\n");
      s.advanceMain("gen/out.txt", "a\nc\n");
      const r = await s.run();
      expect(r.code).toBe(1);
      expect(r.line).toStartWith(`${BRANCH} conflicts with main in a.txt, gen/out.txt;`);
      expect(s.merged()).toBe(false);
      expect(s.originBranch()).toBe(head);
    } finally { s.done(); }
  }, T);

  test("a generator that fails on the rebased tree sends the conflict to the change's session (exit 1)", async () => {
    const s = generatedWorld();
    try {
      s.onMain({ [GENERATED_FILE]: `[[generated]]\npaths = ["gen/*.txt"]\nrun = "echo no generator here >&2; exit 4"\n` });
      const head = s.change({ "src/b.txt": "b\n", "gen/out.txt": "a\nb\n" });
      s.ci(head);
      s.advanceMain("gen/out.txt", "a\nc\n");
      const r = await s.run();
      expect(r.code).toBe(1);
      expect(r.line).toBe(`${BRANCH} conflicts with main in gen/out.txt, and their generator failed on the rebased tree (echo no generator here >&2; exit 4, exit 4): no generator here`);
      expect(s.merged()).toBe(false);
      expect(s.originBranch()).toBe(head);
    } finally { s.done(); }
  }, T);
});

describe("this repository's generated files", () => {
  const root = join(import.meta.dir, "../../../..");
  const text = readFileSync(join(root, GENERATED_FILE), "utf-8");
  const { generators, error } = readGenerators(() => ({ status: 0, stdout: text, stderr: "" }), root, "HEAD");

  test("the list reads, and each entry's paths name tracked files and its generator script exists", () => {
    expect(error).toBeUndefined();
    expect(generators.length).toBeGreaterThan(0);
    const tracked = Bun.spawnSync(["git", "ls-files"], { cwd: root }).stdout.toString().split("\n");
    for (const g of generators) {
      for (const p of g.paths) expect(tracked.some((f) => new Bun.Glob(p).match(f))).toBe(true);
      const script = g.run.split(/\s+/)[1];
      expect(tracked).toContain(script);
    }
  });

  test("covers the shipped flows, the change-graph fixture and the render gallery pipeline, and nothing hand-written", () => {
    expect(generatorsFor(generators, [
      "packages/web/lib/line/shippedFlows.generated.ts",
      "packages/web/lib/line/shippedFlowStations.generated.ts",
      "packages/web/lib/ship/__tests__/changeGraph.fixture.json",
      "packages/web/lib/renderGalleryPipeline.generated.ts",
    ])).not.toBeNull();
    expect(generatorsFor(generators, ["packages/web/lib/renderGallery.ts"])).toBeNull();
  });
});
