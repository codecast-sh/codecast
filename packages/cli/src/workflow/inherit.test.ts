import { describe, expect, test } from "bun:test";
import { graphDiff, graphHash, parseWorkflowFile, parseWorkflowSource, validateWorkflow } from "./parser";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./templates";
import { planGraphEdit } from "../lineGraphEdit";

// A line written as a base and a variant that names only how it differs
// (parser.ts parseWorkflowSource): files held in memory, read the way a run
// reads them from disk.
const files = (fs: Record<string, string>) => (abs: string) => fs[abs] ?? null;

const BASE = `digraph live {
  graph [goal="Fix $task_title", on_failure=stop]
  start [shape=Mdiamond]
  exit  [shape=Msquare]
  investigate [backend=session, prompt="@live/investigate.md", max_visits=2]
  build [backend=session, prompt="@live/build.md"]
  review [backend=session, prompt="@live/review.md"]
  push [shape=parallelogram, script="git push"]
  start -> investigate -> build -> review
  review -> push [condition="outcome = success"]
  review -> build
  push -> exit
}`;

const SHARED = {
  "/l/live.cast": BASE,
  "/l/live/investigate.md": "Find the cause.",
  "/l/live/build.md": "Build the fix.\n@include ../parts/proof.md\nThen stop.",
  "/l/live/review.md": "Review the branch.",
  "/l/parts/proof.md": "Prove it with the fewest draws.\n",
};

describe("a variant line", () => {
  test("names only its differences: attributes override one by one, base prompts stay the base's", () => {
    const g = parseWorkflowFile("/l/trial.cast", {
      read: files({
        ...SHARED,
        "/l/trial.cast": `digraph trial {
          graph [extends="live.cast", goal="Trial: $task_title"]
          investigate [max_visits=3]
          review [prompt="@trial/review.md"]
          card [shape=hexagon]
          push [removed]
          review -> card [condition="outcome = success"]
          review -> build
          card -> exit
        }`,
        "/l/trial/review.md": "Review, then write the card.",
      }),
    });
    expect(validateWorkflow(g)).toEqual([]);
    expect(g.name).toBe("trial");
    expect(g.goal).toBe("Trial: $task_title");
    expect(g.on_failure).toBe("stop");
    const investigate = g.nodes.get("investigate")!;
    expect([investigate.max_visits, investigate.prompt, investigate.backend]).toEqual([3, "Find the cause.", "session"]);
    expect(g.nodes.get("review")!.prompt).toBe("Review, then write the card.");
    expect(g.nodes.has("push")).toBe(false);
    expect(g.edges.filter((e) => e.from === "review").map((e) => e.to)).toEqual(["card", "build"]);
    expect(g.edges.map((e) => `${e.from}>${e.to}`)).toContain("investigate>build");
    expect(graphDiff(parseWorkflowFile("/l/live.cast", { read: files(SHARED) }), g)).toEqual({ changes: ["investigate", "review"], adds: ["card"], removes: ["push"], routes: ["review"] });
    expect(g.sources).toEqual(["/l/trial.cast", "/l/live.cast", "/l/live/investigate.md", "/l/live/build.md", "/l/parts/proof.md", "/l/trial/review.md"]);
  });

  test("a shared part comes in where @include stands, and an edit to it reaches every line", () => {
    const trial = `digraph trial { graph [extends="live.cast"] }`;
    const before = parseWorkflowFile("/l/trial.cast", { read: files({ ...SHARED, "/l/trial.cast": trial }) });
    expect(before.nodes.get("build")!.prompt).toBe("Build the fix.\nProve it with the fewest draws.\nThen stop.");
    const after = parseWorkflowFile("/l/trial.cast", { read: files({ ...SHARED, "/l/trial.cast": trial, "/l/parts/proof.md": "Prove it twice." }) });
    expect(after.nodes.get("build")!.prompt).toBe("Build the fix.\nProve it twice.\nThen stop.");
    expect(graphHash(after)).not.toBe(graphHash(before));
  });

  test("a variant that changes nothing is its base", () => {
    const read = files({ ...SHARED, "/l/same.cast": `digraph live { graph [extends="live.cast"] }` });
    expect(graphHash(parseWorkflowFile("/l/same.cast", { read }))).toBe(graphHash(parseWorkflowFile("/l/live.cast", { read })));
  });

  test("bases chain: a variant of a variant", () => {
    const g = parseWorkflowFile("/l/c.cast", {
      read: files({ ...SHARED, "/l/b.cast": `digraph b { graph [extends="live.cast"] build [max_visits=4] }`, "/l/c.cast": `digraph c { graph [extends="b.cast"] build [timeout=60] }` }),
    });
    expect([g.nodes.get("build")!.max_visits, g.nodes.get("build")!.timeout]).toEqual([4, 60]);
  });

  test("what would leave a route dangling or loop is refused, naming the fix", () => {
    const parse = (trial: string, more: Record<string, string> = {}) => () => parseWorkflowFile("/l/trial.cast", { read: files({ ...SHARED, ...more, "/l/trial.cast": trial }) });
    expect(parse(`digraph t { graph [extends="live.cast"] push [removed] }`)).toThrow("review goes to push, which this file removes: write review's edges here");
    expect(parse(`digraph t { graph [extends="live.cast"] watch [removed] }`)).toThrow("removes watch, which live.cast does not have");
    expect(parse(`digraph t { graph [extends="live.cast"] push [removed] review -> push }`)).toThrow("the edge review -> push uses push, which this file removes");
    expect(parse(`digraph t { graph [extends="gone.cast"] }`)).toThrow('extends="gone.cast": no graph at /l/gone.cast');
    expect(parse(`digraph t { graph [extends="trial.cast"] }`)).toThrow("comes back to itself");
    expect(parse(`digraph t { graph [extends="live.cast"] }`, { "/l/parts/proof.md": "@include proof.md" })).toThrow("@include proof.md comes back to itself");
    expect(parse(`digraph t { graph [extends="live.cast"] }`, { "/l/live/review.md": "@include ../parts/none.md" })).toThrow("@include ../parts/none.md: no file at /l/parts/none.md");
  });
});

describe("editing a variant's step from the app", () => {
  const disk = { ...SHARED, "/l/trial.cast": `digraph trial { graph [extends="live.cast"] review [prompt="@trial/review.md"] }`, "/l/trial/review.md": "Review, then write the card." };

  test("an inherited step's text is written in the variant's own file; the base and every flow on it stay", () => {
    const plan = planGraphEdit("/l/trial.cast", { node: "investigate", text: "Find the cause, then the producer." }, { root: "/l", read: files(disk) });
    expect(plan.writes).toEqual([
      { file: "/l/trial/investigate.md", content: "Find the cause, then the producer." },
      { file: "/l/trial.cast", content: `digraph trial { graph [extends="live.cast"] review [prompt="@trial/review.md"]\n  investigate [prompt="@trial/investigate.md"]\n}` },
    ]);
    expect(plan.target).toBe("/l/trial/investigate.md");
  });

  test("on the base itself, the step's text is written in the base's file", () => {
    const plan = planGraphEdit("/l/live.cast", { node: "investigate", text: "Find the cause, then the producer." }, { root: "/l", read: files(disk) });
    expect(plan.writes).toEqual([{ file: "/l/live/investigate.md", content: "Find the cause, then the producer." }]);
  });

  test("a segment's station edited on a variant of the shipped change is the variant's line", () => {
    const flows = { "/r/.codecast/flows/change.cast": `digraph change {\n  graph [extends="change"]\n}\n` };
    const plan = planGraphEdit("/r/.codecast/flows/change.cast", { node: "review__review", text: "Review it hard." }, { root: "/r", read: files(flows) });
    expect(plan.writes).toEqual([
      { file: "/r/.codecast/flows/change/review__review.md", content: "Review it hard." },
      { file: "/r/.codecast/flows/change.cast", content: `digraph change {\n  graph [extends="change"]\n  review__review [prompt="@change/review__review.md"]\n}\n` },
    ]);
  });

  test("a guided step's text is not what it reads, so an edit of it is refused, naming the way", () => {
    const guided = { ...disk, "/l/trial.cast": `digraph trial { graph [extends="live.cast"] build [guide="And test it."] }` };
    expect(() => planGraphEdit("/l/trial.cast", { node: "build", text: "Build it." }, { root: "/l", read: files(guided) })).toThrow("build's prompt is its base's with this project's guidance added (guide=)");
  });

  test("the variant's own step is written in the variant's file", () => {
    const plan = planGraphEdit("/l/trial.cast", { node: "review", text: "Review it." }, { root: "/l", read: files(disk) });
    expect(plan.writes).toEqual([{ file: "/l/trial/review.md", content: "Review it." }]);
  });

  test("a step built from shared parts is refused whole, naming the parts to edit", () => {
    expect(() => planGraphEdit("/l/live.cast", { node: "build", text: "Build it." }, { root: "/l", read: files(disk) })).toThrow("build's prompt is build.md with shared parts (../parts/proof.md); edit those files");
  });
});

// A variant's edits (pipeline.md PL3): each one desugars into the edges a
// person would write by hand, so the graph it builds hashes the same.
describe("variant edits: after=, before=, skip, when=, guide=", () => {
  const read = (variant: string, more: Record<string, string> = {}) => files({ ...SHARED, ...more, "/l/v.cast": variant });
  const parse = (variant: string, more: Record<string, string> = {}) => parseWorkflowFile("/l/v.cast", { read: read(variant, more) });
  const hand = (src: string) => parseWorkflowFile("/l/hand.cast", { read: files({ ...SHARED, "/l/hand.cast": src }) });
  const liveAs = (name: string, edit: (s: string) => string) => edit(BASE.replace("digraph live", `digraph ${name}`));

  test("after= takes the anchor's passing route and hashes as the same graph written out", () => {
    const g = parse(`digraph v { graph [extends="live.cast"] lint [after="build", shape=parallelogram, script="bun lint"] }`);
    expect(validateWorkflow(g)).toEqual([]);
    const written = hand(liveAs("v", (s) => s
      .replace("push [shape", `lint [shape=parallelogram, script="bun lint"]\n  push [shape`)
      .replace("start -> investigate -> build -> review", "start -> investigate -> build -> lint")
      .replace("push -> exit", `push -> exit\n  lint -> review [condition="outcome = success"]`)));
    expect(graphHash(g)).toBe(graphHash(written));
    expect(g.edits).toEqual([{ op: "add", station: "lint", label: "lint", after: "build" }]);
  });

  test("a failed inserted station goes the way its anchor goes back; fix= overrides it", () => {
    const g = parse(`digraph v { graph [extends="live.cast"] lint [after="review", shape=parallelogram, script="bun lint"] }`);
    // review passes to push (outcome = success) and goes back to build otherwise: lint fails back to build too.
    expect(g.edges.filter((e) => e.from === "lint")).toEqual([
      { from: "lint", to: "push", condition: "outcome = success" },
      { from: "lint", to: "build", condition: "outcome = failure", label: "lint failed" },
    ]);
    const f = parse(`digraph v { graph [extends="live.cast"] lint [after="review", fix="investigate", shape=parallelogram, script="bun lint"] }`);
    expect(f.edges.filter((e) => e.from === "lint")).toEqual([
      { from: "lint", to: "push", condition: "outcome = success" },
      { from: "lint", to: "investigate", condition: "outcome = failure", label: "lint failed" },
    ]);
    const none = parse(`digraph v { graph [extends="live.cast"] lint [after="investigate", shape=parallelogram, script="bun lint"] }`);
    expect(none.edges.filter((e) => e.from === "lint")).toEqual([{ from: "lint", to: "build", condition: "outcome = success" }]);
    expect(f.edges.filter((e) => e.from === "review").map((e) => [e.to, e.condition])).toEqual([["lint", "outcome = success"], ["build", undefined]]);
  });

  test("two stations after the same one run in the order written; before= takes the edges into its anchor", () => {
    const g = parse(`digraph v { graph [extends="live.cast"]
      a [after="build", shape=parallelogram, script="a"]
      b [after="build", shape=parallelogram, script="b"]
      c [before="push", shape=parallelogram, script="c"] }`);
    const next = (id: string) => g.edges.filter((e) => e.from === id && !e.condition?.includes("failure")).map((e) => e.to);
    expect([next("build"), next("a"), next("b")]).toEqual([["a"], ["b"], ["review"]]);
    expect(g.edges.filter((e) => e.to === "c").map((e) => [e.from, e.condition])).toEqual([["review", "outcome = success"]]);
    expect(next("c")).toEqual(["push"]);
  });

  test("skip joins a station's neighbours and drops what nothing reaches after it", () => {
    const g = parse(`digraph v { graph [extends="live.cast"] investigate [skip=true] }`);
    expect(validateWorkflow(g)).toEqual([]);
    const written = hand(liveAs("v", (s) => s.replace(/  investigate \[.*\]\n/, "").replace("start -> investigate -> build", "start -> build")));
    expect(graphHash(g)).toBe(graphHash(written));
    expect(g.pruned).toEqual(["investigate"]);
  });

  test("when= runs a station only when the change touches its paths, and goes past it otherwise", () => {
    const g = parse(`digraph v { graph [extends="live.cast"] lint [after="build", when="web/**, docs/", shape=parallelogram, script="bun lint"] }`);
    expect(validateWorkflow(g)).toEqual([]);
    const t = 'change_files touches \\"web/**, docs/\\"';
    const written = hand(liveAs("v", (s) => s
      .replace("push [shape", `lint [shape=parallelogram, script="bun lint"]\n  push [shape`)
      .replace("start -> investigate -> build -> review", `start -> investigate -> build\n  build -> lint [condition="${t}"]\n  build -> review [condition="not ${t}"]`)
      .replace("push -> exit", `push -> exit\n  lint -> review [condition="outcome = success"]`)));
    expect(graphHash(g)).toBe(graphHash(written));
    expect(g.edits?.find((e) => e.op === "when")).toEqual({ op: "when", station: "lint", paths: ["web/**", "docs/"] });
  });

  test("guide= adds to the inherited prompt, so the base keeps improving underneath", () => {
    const g = parse(`digraph v { graph [extends="live.cast"] review [guide="@v/review.md"] }`, { "/l/v/review.md": "Also check the migrations.\n" });
    expect(g.nodes.get("review")!.prompt).toBe("Review the branch.\n\nAlso check the migrations.");
    expect(g.sources).toContain("/l/v/review.md");
    const better = parseWorkflowFile("/l/v.cast", { read: read(`digraph v { graph [extends="live.cast"] review [guide="Also X."] }`, { "/l/live/review.md": "Review the branch twice." }) });
    expect(better.nodes.get("review")!.prompt).toBe("Review the branch twice.\n\nAlso X.");
    expect(graphHash(parse(`digraph v { graph [extends="live.cast"] review [guide="Also X."] }`))).toBe(graphHash(parse(`digraph v { graph [extends="live.cast"] review [prompt="Review the branch.\\n\\nAlso X."] }`)));
  });

  test("a wrong edit is refused with the station, what is wrong and what to write", () => {
    const bad = (variant: string) => () => parse(`digraph v { graph [extends="live.cast"] ${variant} }`);
    expect(bad(`lint [after="chek"]`)).toThrow('lint [after="chek"]: live has no station chek; its stations: investigate, build, review, push');
    expect(bad(`build [after="review"]`)).toThrow("live already has a station build; after= adds a new one, so give it a new id");
    expect(bad(`lint [after="exit"]`)).toThrow('exit ends the flow; place lint before="exit"');
    expect(bad(`gone [skip=true]`)).toThrow("live has no station gone to skip; its stations:");
    expect(bad(`lint [fix="build"]`)).toThrow("place lint with after= or before=");
    expect(bad(`review [skip=true] lint [after="review"]`)).toThrow("this file skips review; place lint next to a station that stays");
    expect(bad(`review [skip=true] review__x [model="opus"]`)).toThrow('review [skip="true"]: this file also changes review__x; a skipped station runs nothing, so drop those lines or the skip');
    expect(bad(`push [guide="x"]`)).toThrow("push [guide=...] adds to a prompt, and push has none; write prompt= instead");
    expect(() => parseWorkflowFile("/l/v.cast", { read: read(`digraph v { lint [after="build"] }`) })).toThrow('lint [after=...] edits the flow this one extends, and this file extends none: add graph [extends="<flow>"]');
  });

  test("a skip that leaves a station naming a pruned one fails validation, naming both", () => {
    const g = parse(`digraph v { graph [extends="live.cast"] investigate [skip=true] build [retry_target="investigate"] }`);
    expect(validateWorkflow(g)).toEqual(['build [retry_target="investigate"] names investigate, and this flow skips investigate: point retry_target at a station that stays, or stop skipping investigate']);
    const r = parse(`digraph v { graph [extends="live.cast"] investigate [skip=true] build [prompt="Fix what $investigate.output found"] }`);
    expect(validateWorkflow(r)).toEqual(["build's prompt reads investigate, and this flow skips investigate: change build's prompt, or stop skipping investigate"]);
  });
});

// The shipped `change` (templates/change.cast) with the four edits a project makes most.
describe("variant edits on the shipped change flow", () => {
  const ROOT = "/r/.codecast/flows";
  const variantOf = (body: string, more: Record<string, string> = {}) => parseWorkflowFile(`${ROOT}/change.cast`, { read: files({ ...more, [`${ROOT}/change.cast`]: `digraph change {\n  graph [extends="change"]\n${body}\n}` }) });
  const shipped = BUILTIN_WORKFLOW_TEMPLATES.change;
  const handWritten = (edit: (s: string) => string) => parseWorkflowSource(edit(shipped));
  const swap = (s: string, from: string, to: string) => { expect(s).toContain(from); return s.replace(from, to); };

  test("a repo change.cast that extends change reads the shipped flow, and an empty one is it", () => {
    expect(graphHash(variantOf(""))).toBe(graphHash(parseWorkflowSource(shipped)));
  });

  test("lint after check, guide on review, skip decide, e2e when landing/** changes: the same graph as written by hand", () => {
    const g = variantOf(`  lint   [after="check", label="Lint", shape=parallelogram, script="bun run lint"]
  review [guide="Also check X."]
  e2e    [after="check", label="E2E", when="landing/**, backend/src/routes/**", shape=parallelogram, script="bun run e2e"]
  decide [skip=true]`);
    expect(validateWorkflow(g)).toEqual([]);
    const reviewPrompt = parseWorkflowSource(shipped).nodes.get("review__review")!.prompt!;
    expect(g.nodes.get("review__review")!.prompt).toBe(`${reviewPrompt.replace(/\s+$/, "")}\n\nAlso check X.`);
    const t = 'change_files touches \\"landing/**, backend/src/routes/**\\"';
    const written = handWritten((s) => {
      s = swap(s, `  decide [flow="decide", answerer="review__review"]\n`, `  lint [label="Lint", shape=parallelogram, script="bun run lint"]\n  e2e [label="E2E", shape=parallelogram, script="bun run e2e"]\n`);
      s = swap(s, `  revise [label="Revise", backend=subject, max_visits=3,\n    prompt=`, `  revise_gone [label="Revise", backend=subject, max_visits=3,\n    prompt=`);
      s = s.replace(/  revise_gone \[[^\]]*\]\n/, "");
      s = swap(s, `  dropped   [shape=Msquare, label="Dropped", stop="$stop_reason"]\n`, "");
      s = swap(s, "  check -> review\n", "  check -> lint\n");
      s = swap(s, "  review -> decide\n", "  review -> ship\n");
      s = s.replace(/  decide -> .*\n/g, "");
      s = swap(s, "  revise -> check\n", "");
      s = swap(s, "  fix_conflict -> check\n", `  fix_conflict -> check
  lint -> e2e [condition="(outcome = success) and ${t}"]
  lint -> review [condition="(outcome = success) and not ${t}"]
  lint -> fix_check [condition="outcome = failure", label="lint failed"]
  e2e -> review [condition="outcome = success"]
  e2e -> fix_check [condition="outcome = failure", label="e2e failed"]
`);
      return s;
    });
    // By hand, Review's prompt is its segment's text with the guidance after it.
    expect(graphHash(g)).toBe(graphHash(withStationPrompt(written, "review__review", `${reviewPrompt.replace(/\s+$/, "")}\n\nAlso check X.`)));
    expect(g.nodes.has("decide")).toBe(false);
    expect(g.pruned).toEqual(["decide", "revise", "dropped"]);
    expect(g.edits).toEqual([
      { op: "guide", station: "review", node: "review__review", text: "Also check X." },
      { op: "skip", station: "decide" },
      { op: "add", station: "lint", label: "Lint", after: "check" },
      { op: "add", station: "e2e", label: "E2E", after: "check" },
      { op: "when", station: "e2e", paths: ["landing/**", "backend/src/routes/**"] },
    ]);
  });

  test("a station of a segment is changed by its qualified id, and a missing one is named", () => {
    const g = variantOf(`  review__review [model="opus"]`);
    expect(g.nodes.get("review__review")!.model).toBe("opus");
    expect(() => variantOf(`  review__reviewer [model="opus"]`)).toThrow("review__reviewer [...] changes a station of the review segment, which has no reviewer; its stations: review__review");
    expect(() => variantOf(`  check [guide="x"]`)).toThrow("check [guide=...]: no station of check reads a prompt (its steps: check__verify); guide= changes an agent's prompt");
  });

  test("skipping review leaves decide's answerer dangling, and validation says so", () => {
    const g = variantOf(`  review [skip=true]`);
    expect(validateWorkflow(g)).toContain('decide__decide [answerer="review__review"] names review__review, and this flow skips review: point answerer at a station that stays, or stop skipping review');
  });
});

/** The graph with one station's prompt set: what a qualified override written by hand amounts to once segments are expanded. */
function withStationPrompt(g: ReturnType<typeof parseWorkflowSource>, id: string, prompt: string) {
  g.nodes.set(id, { ...g.nodes.get(id)!, prompt });
  return g;
}

test("a repo change.cast read from its text and directory alone still extends the shipped change, once", () => {
  const src = `digraph change {\n  graph [extends="change"]\n  lint [after="check", shape=parallelogram, script="true"]\n}`;
  const g = parseWorkflowSource(src, "/r/.codecast/flows", { read: files({ "/r/.codecast/flows/change.cast": src }) });
  expect(validateWorkflow(g)).toEqual([]);
  expect(g.nodes.has("lint")).toBe(true);
});

test("a variant that skips a station its base guided drops the guidance with it", () => {
  const read = files({
    "/r/.codecast/flows/team.cast": `digraph team {\n  graph [extends="change"]\n  decide [guide="Ask about X."]\n}`,
    "/r/.codecast/flows/mine.cast": `digraph mine {\n  graph [extends="team.cast"]\n  decide [skip=true]\n}`,
  });
  const g = parseWorkflowFile("/r/.codecast/flows/mine.cast", { read });
  expect(validateWorkflow(g)).toEqual([]);
  expect(g.nodes.has("decide__decide")).toBe(false);
});
