// The confirm after Ship says what the picker's chip says about being asked (both read approvalOf).
import { describe, expect, test } from "bun:test";
import { shipLedgerFor } from "../shipLedger";
import { SHIPPED_FLOWS } from "../../../lib/line/shippedFlows.generated";
import { appPool } from "../../../lib/line/flowPool";
import { approvalOf, approvalWords } from "../../../lib/ship/journey";

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
        expect(you).toEqual([a.when ? `Only if ${a.when}` : "Only on some runs"]);
      } else {
        expect(questions).toBe("0");
        expect(you).toEqual([]);
      }
    }
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
    // Another flow keeps its name in the title.
    expect(asked(pool.find((f) => f.slug === "quick-change")!).name).toBe("Ship through Quick");
  });
});
