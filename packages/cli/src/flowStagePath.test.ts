// The stages `cast flow run` names when a run starts are the ones the web's picker and run card show beside the flow:
// the same planner (shared contracts/flowStagePlan.ts) over the graph the web reads (shippedFlows.ts flowSnapshot).
import { describe, expect, test } from "bun:test";
import { stagePathWords } from "@codecast/shared/contracts/flowStagePlan";
import { flowStagePath } from "./flowStagePath";
import { describeFlow } from "./workflow/flowPool";
import { shippedFlowsSnapshot } from "./workflow/shippedFlows";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./workflow/templates";

const shipped = (slug: string) => {
  const source = BUILTIN_WORKFLOW_TEMPLATES[slug];
  return { ...describeFlow(slug, source, "shipped", null), source };
};

describe("flowStagePath", () => {
  test("the library change flow reads as its stages, not every station its segments expand into", () => {
    expect(flowStagePath(shipped("change"))).toBe("PR → CI + Review → Merge → Deploy → Live");
  });

  test("the personal Ship folds its opening round into its first stage", () => {
    expect(flowStagePath(shipped("personal"))).toBe("Check + Review → Land → Deploy → Live");
  });

  test("every shipped flow reads as the web's picker reads its snapshot", () => {
    for (const snap of shippedFlowsSnapshot()) {
      const web = stagePathWords(snap as unknown as Parameters<typeof stagePathWords>[0], { personal: "own_results" in snap && snap.own_results === true });
      expect(`${snap.slug}: ${flowStagePath(shipped(snap.slug))}`).toBe(`${snap.slug}: ${web}`);
    }
  });

  test("a flow that does not parse names no stages", () => {
    const source = `digraph broken { graph [kind="line"] start [shape=Mdiamond] start -> nowhere }`;
    expect(flowStagePath({ ...describeFlow("broken", source, "repo", null), source })).toBeNull();
  });
});
