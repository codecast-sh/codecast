// The confirm after Ship says what the picker's chip says about being asked (both read approvalOf).
import { describe, expect, test } from "bun:test";
import { shipLedgerFor } from "../shipLedger";
import { SHIPPED_FLOWS } from "../../../lib/line/shippedFlows.generated";
import { appPool, pushedFlow } from "../../../lib/line/flowPool";
import { approvalOf, approvalWords } from "../../../lib/ship/approval";

const pool = appPool();
const asked = (flow: (typeof pool)[number]) => {
  const l = shipLedgerFor(flow, "Opt-out repair");
  return { questions: l.figures.find((f) => /questions? for you/.test(f.label))!.value, you: l.rows.filter((r) => r.k === "You").map((r) => r.v), name: l.name, ledger: l };
};

describe("the confirm agrees with the chip", () => {
  test("every shipped line: asked every run, only on a route, or never, in both places", () => {
    for (const f of pool.filter((x) => x.kind === "line" && SHIPPED_FLOWS.some((s) => s.slug === x.slug))) {
      const a = approvalOf(f);
      const { questions, you } = asked(f);
      if (a.kind === "always") {
        expect(Number(questions)).toBeGreaterThan(0);
        expect(you.every((v) => !v.startsWith("Only"))).toBe(true);
      } else if (a.kind === "if") {
        expect(questions).toBe("0–1");
        expect(you).toEqual([a.when ? `Only if ${a.when}` : "On some runs"]);
      } else {
        expect(questions).toBe("0");
        expect(you).toEqual([]);
      }
    }
  });

  test("a side-route card with no asks_if: the chip sometimes asks, and the confirm asks on some runs, never quoting the route", () => {
    const n = (id: string, label: string, type: string, shape: string) => ({ id, label, type, shape });
    const flow = pushedFlow({
      _id: "w1", slug: "change", name: "change", source: 'digraph change { graph [kind="line", label="Change", takes="task,branch"] }',
      nodes: [n("start", "start", "start", "Mdiamond"), n("land", "Land", "conditional", "diamond"), n("land__merge", "Merge", "command", "parallelogram"), n("land__why", "Why a person", "command", "parallelogram"), n("land__card", "Card", "human", "hexagon"), n("land__landed", "Merged", "command", "parallelogram"), n("exit", "Live", "exit", "Msquare")],
      edges: [{ from: "start", to: "land" }, { from: "land", to: "land__merge" }, { from: "land__merge", to: "land__landed", condition: "outcome = success" }, { from: "land__merge", to: "land__why", condition: "merge.exit_code = 6", label: "needs a person" }, { from: "land__why", to: "land__card" }, { from: "land__card", to: "land__merge" }, { from: "land__landed", to: "exit" }],
    });
    expect(approvalWords(approvalOf(flow))).toBe("Sometimes asks you");
    expect(asked(flow)).toMatchObject({ questions: "0–1", you: ["On some runs"] });
  });

  test("the library's Ship asks only if it edits CI, and its confirm says so and ships this change", () => {
    const ship = pool.find((f) => f.slug === "change")!;
    expect(approvalWords(approvalOf(ship))).toBe("Asks you if it edits CI");
    expect(asked(ship)).toMatchObject({ name: "Ship this change", questions: "0–1", you: ["Only if it edits CI"] });
    // Its stages are the ones the picker drew, not the pipeline's stations.
    expect(asked(ship).ledger.rows.find((r) => r.k === "Stages")?.v).toBe("PR → CI + Review → Merge → Deploy");
    // What can stop it is the stages it can stop at, in path order: no end's own name.
    const canStop = asked(ship).ledger.rows.find((r) => r.k === "Can stop")!;
    expect(canStop.v).toBe("PR, CI + Review, Merge, Deploy");
    expect(canStop.list).toBeUndefined();
    expect(asked(ship).ledger.stop).toBe("Stop on its card");
  });

  test("a flow that never asks keeps its name in the title, and asks nothing in both places", () => {
    const n = (id: string, label: string, type: string, shape: string) => ({ id, label, type, shape });
    const hotfix = pushedFlow({
      _id: "w2", slug: "hotfix", name: "hotfix", source: 'digraph hotfix { graph [kind="line", label="Hotfix", takes="task,branch"] }',
      nodes: [n("start", "start", "start", "Mdiamond"), n("merge", "Merge", "command", "parallelogram"), n("landed", "Merged", "command", "parallelogram"), n("exit", "Live", "exit", "Msquare")],
      edges: [{ from: "start", to: "merge" }, { from: "merge", to: "landed", condition: "outcome = success" }, { from: "landed", to: "exit" }],
    });
    expect(approvalWords(approvalOf(hotfix))).toBe("No approval");
    expect(asked(hotfix)).toMatchObject({ name: "Ship through Hotfix", questions: "0", you: [] });
  });
});
