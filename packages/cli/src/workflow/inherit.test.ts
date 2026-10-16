import { describe, expect, test } from "bun:test";
import { graphDiff, graphHash, parseWorkflowFile, validateWorkflow } from "./parser";
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

  test("an inherited step's text is written in the base's file, which every line on that base reads", () => {
    const plan = planGraphEdit("/l/trial.cast", { node: "investigate", text: "Find the cause, then the producer." }, { root: "/l", read: files(disk) });
    expect(plan.writes).toEqual([{ file: "/l/live/investigate.md", content: "Find the cause, then the producer." }]);
  });

  test("the variant's own step is written in the variant's file", () => {
    const plan = planGraphEdit("/l/trial.cast", { node: "review", text: "Review it." }, { root: "/l", read: files(disk) });
    expect(plan.writes).toEqual([{ file: "/l/trial/review.md", content: "Review it." }]);
  });

  test("a step built from shared parts is refused whole, naming the parts to edit", () => {
    expect(() => planGraphEdit("/l/trial.cast", { node: "build", text: "Build it." }, { root: "/l", read: files(disk) })).toThrow("build's prompt is build.md with shared parts (../parts/proof.md); edit those files");
  });
});
