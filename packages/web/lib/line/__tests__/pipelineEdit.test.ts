import { describe, expect, test } from "bun:test";
import { PIPELINE_FIXTURES } from "./pipelines.fixture.generated";
import { applyEdit, editCommand, editLive, editSessionMessage, editsOfMessage, editWords, parseEditCommand, shellWord, wouldRun, type PipelineEdit } from "../pipelineEdit";
import { drawnFlow, pendingEdits, pipelineCheckout, pipelineModel } from "../pipelineModel";
import { flowDiagram } from "../flowDiagram";

const codecast = PIPELINE_FIXTURES.find((p) => p.repository === "codecast-sh/codecast")!;
const example = PIPELINE_FIXTURES.find((p) => p.repository === "example-org/example-app")!;
const label = (flow = codecast.change) => (id: string) => flow.stations.find((s) => s.id === id)?.label ?? id;
const path = (flow = codecast.change) => flowDiagram(drawnFlow(flow)).steps.map((s) => s.label);

const EDITS: PipelineEdit[] = [
  { op: "add", id: "lint", label: "Lint", at: "after", station: "check", does: "run", body: "bun run lint --changed", when: "packages/web/**, packages/shared/**" },
  { op: "add", id: "smoke", label: "Smoke test", at: "before", station: "deploy", does: "agent", body: "Open the app and say \"what\" broke; check $HOME" },
  { op: "guide", station: "review", text: "Also check the migrations." },
  { op: "prompt", station: "review", text: "Review it." },
  { op: "run", station: "pr", command: "./scripts/line.sh pr --draft" },
  { op: "when", station: "review", globs: "backend/**" },
  { op: "when", station: "review", globs: "always" },
  { op: "skip", station: "decide" },
];

describe("an edit as its command", () => {
  test("every edit reads back from its own command", () => {
    for (const e of EDITS) expect(parseEditCommand(editCommand("change", e))).toEqual({ flow: "change", edit: e });
  });

  test("the command is the CLI's own syntax, quoted for a shell", () => {
    expect(editCommand("change", EDITS[0])).toBe('cast flow edit change add lint --after check --run "bun run lint --changed" --label Lint --when "packages/web/**, packages/shared/**"');
    expect(editCommand("change", { op: "skip", station: "decide" })).toBe("cast flow edit change skip decide");
    expect(shellWord('say "hi" to $HOME')).toBe('"say \\"hi\\" to \\$HOME"');
  });

  test("a session's first message opens with the commands and asks to ship them through the flow", () => {
    const msg = editSessionMessage({ slug: "change", label: "Change" }, [editCommand("change", EDITS[0]), editCommand("change", EDITS[2])], "Add Lint after Check");
    expect(msg.split("\n")[0]).toStartWith("cast flow edit change add lint");
    expect(msg).toContain("cast flow run change --title");
    expect(editsOfMessage(msg).map((x) => x.edit)).toEqual([EDITS[0], EDITS[2]]);
    expect(editsOfMessage("Please look at the flow")).toEqual([]);
  });
});

describe("the flow with the edit drawn in", () => {
  test("a station added after Check sits on the passing path between Check and Review", () => {
    expect(path()).toEqual(["Check", "Review", "Decide", "Land", "Deploy"]);
    const after = applyEdit(codecast.change, EDITS[0]);
    expect(path(after)).toEqual(["Check", "Lint", "Review", "Decide", "Land", "Deploy"]);
    expect(after.stations.find((s) => s.id === "lint")).toMatchObject({ own: "added", runs: "bun run lint --changed", when: ["packages/web/**", "packages/shared/**"] });
  });

  test("a station added before a step on a repo's own flow, and one before the first step", () => {
    const smoke = applyEdit(example.change, { op: "add", id: "smoke", label: "Smoke", at: "before", station: "deploy", does: "run", body: "x" });
    expect(path(smoke)).toEqual(["PR", "CI and review", "Merge", "Smoke", "Deploy"]);
    // After a fan-out: past its join, not into its branches.
    const lint = applyEdit(example.change, { op: "add", id: "lint", label: "Lint", at: "after", station: "checks", does: "run", body: "x" });
    expect(path(lint)).toEqual(["PR", "CI and review", "Lint", "Merge", "Deploy"]);
    expect(path(applyEdit(example.change, { op: "add", id: "lint", label: "Lint", at: "before", station: "merge", does: "run", body: "x" }))).toEqual(["PR", "CI and review", "Lint", "Merge", "Deploy"]);
    const first = applyEdit(example.change, { op: "add", id: "plan", label: "Plan", at: "before", station: "pr", does: "person", body: "Is this the right change?" });
    expect(path(first)[0]).toBe("Plan");
  });

  test("a changed station says what changed; a skipped one is named as skipped", () => {
    const guided = applyEdit(codecast.change, EDITS[2]);
    expect(guided.stations.find((s) => s.id === "review")).toMatchObject({ own: "changed", changed: ["guide"], guide: "Also check the migrations." });
    expect(applyEdit(codecast.change, EDITS[7]).removed).toContain("Decide");
    expect(editWords(EDITS[0], label())).toBe("Add Lint after Check (runs), only when a change touches packages/web/**, packages/shared/**");
  });

  test("an edit is live once the published flow holds it", () => {
    for (const e of EDITS.filter((x) => x.station !== "pr")) {
      expect(editLive(codecast.change, e)).toBe(e.op === "when" && e.globs === "always");
      expect(editLive(applyEdit(codecast.change, e), e)).toBe(true);
    }
  });
});

describe("what it would have run on", () => {
  test("the when globs against the recent changes' files", () => {
    const recent = [{ files: ["packages/web/app.tsx"] }, { files: ["packages/cli/x.ts"] }, { files: ["packages/shared/a.ts", "README.md"] }, { files: [] }];
    expect(wouldRun("packages/web/**, packages/shared/**", recent)).toEqual({ hits: 2, total: 4 });
    expect(wouldRun(undefined, recent)).toBeNull();
    expect(wouldRun("always", recent)).toBeNull();
  });
});

describe("a proposed edit drawn as a ghost until it is live", () => {
  test("a session in the repo whose first message opens with the edit puts a ghost station on its lane", () => {
    const msg = editSessionMessage({ slug: "change", label: "Change" }, [editCommand("change", EDITS[0])], "Add Lint after Check");
    const sessions = [
      { id: "s1", title: "Add a lint check", project_path: "/w/codecast" },
      { id: "s2", title: "Elsewhere", project_path: "/w/union-mobile" },
      { id: "s3", title: "Gave up", project_path: "/w/codecast", ended: true },
    ];
    const pending = pendingEdits("codecast-sh/codecast", sessions, () => msg);
    expect(pending.map((x) => x.session.id)).toEqual(["s1"]);
    const m = pipelineModel(codecast, [], [], [], 0, pending);
    expect(m.change.diagram.steps.map((s) => s.label)).toContain("Lint");
    expect(m.change.marks.lint).toMatchObject({ own: "added", proposed: "proposed · Add a lint check" });
    expect(m.change.proposals).toHaveLength(1);
    // Once the published flow holds it, it is no proposal.
    const live = { ...codecast, change: applyEdit(codecast.change, EDITS[0]) };
    expect(pipelineModel(live, [], [], [], 0, pending).change.marks.lint.proposed).toBeUndefined();
  });

  test("a proposed skip marks the step skipped", () => {
    const msg = editCommand("change", { op: "skip", station: "decide" });
    const m = pipelineModel(codecast, [], [], [], 0, pendingEdits("codecast-sh/codecast", [{ id: "s", title: "Skip it", project_path: "/w/codecast" }], () => msg));
    expect(m.change.marks.decide).toMatchObject({ skipped: true, proposed: "proposed · Skip it" });
  });
});

describe("the checkout an edit starts in", () => {
  test("recent changes read through the published path table; a row without them reads none", () => {
    const withRecent = { ...codecast, root: "/w/codecast", recent: { paths: ["packages/web/a.tsx", "packages/cli/b.ts"], commits: [{ sha: "a", subject: "x", at: 1, files: [0] }, { sha: "b", subject: "y", at: 2, files: [1] }], dropped: 0 } };
    const c = pipelineCheckout(withRecent);
    expect(c.root).toBe("/w/codecast");
    expect(wouldRun("packages/web/**", c.recent!)).toEqual({ hits: 1, total: 2 });
    expect(pipelineCheckout(codecast).recent).toBeNull();
  });
});
