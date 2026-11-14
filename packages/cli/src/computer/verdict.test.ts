import { describe, expect, test } from "bun:test";
import { ComputerError } from "./errors.js";
import { actionVerdict, failedActionVerdict, verdictLine } from "./verdict.js";
import type { ComputerActionResult, ComputerActionVerification, ComputerPixelChange } from "./types.js";

const TREE = 'App=A (pid 1)\nWindow: "W", App: A.\n\n0 window W\n\t1 checkbox Subscribe, Value: 0\n\nNo UI element is currently focused.';

function result(opts: {
  after?: string;
  path?: "accessibility" | "synthetic" | "clipboard";
  verification?: ComputerActionVerification;
  pixelChange?: ComputerPixelChange;
  baseline?: string | null;
}): ComputerActionResult {
  return {
    snapshot: { treeText: opts.after ?? TREE } as ComputerActionResult["snapshot"],
    ...(opts.baseline === null ? {} : { baselineTreeText: opts.baseline ?? TREE }),
    action: { path: opts.path ?? "accessibility", verification: opts.verification },
    ...(opts.pixelChange ? { pixelChange: opts.pixelChange } : {}),
  } as ComputerActionResult;
}

const rect = { x: 1, y: 1, width: 40, height: 20 };

describe("actionVerdict", () => {
  test("a read-back confirms, unless web content could have echoed it", () => {
    expect(actionVerdict(result({ verification: { state: "verified", property: "value" } })).state).toBe("confirmed");
    const echoed = actionVerdict(result({ verification: { state: "unverified", reason: "web_content_echo" }, after: TREE.replace("0\n", "1\n") }));
    // The tree showing the new value is the same echo, so it cannot confirm either.
    expect(echoed.state).toBe("unverifiable");
  });

  test("a changed tree confirms; an unchanged tree and unchanged pixels are a suspected no-op", () => {
    expect(actionVerdict(result({ after: TREE.replace("Value: 0", "Value: 1") })).state).toBe("confirmed");
    expect(actionVerdict(result({ pixelChange: { changed: null, repainting: null } })).state).toBe("suspected_no_op");
    expect(actionVerdict(result({ pixelChange: { changed: rect, repainting: null } })).state).toBe("confirmed");
    expect(actionVerdict(result({ pixelChange: { changed: rect, repainting: rect } })).state).toBe("unverifiable");
  });

  test("without pixels, only an accessibility action that changed nothing is a suspected no-op", () => {
    expect(actionVerdict(result({})).state).toBe("suspected_no_op");
    expect(actionVerdict(result({ path: "synthetic" })).state).toBe("unverifiable");
    expect(actionVerdict(result({ baseline: null })).state).toBe("unverifiable");
  });

  test("a value that reads back different is a suspected no-op", () => {
    expect(actionVerdict(result({ verification: { state: "unverified", reason: "value_mismatch" } })).state).toBe("suspected_no_op");
  });

  test("a failure is refused unless the action was sent and never answered", () => {
    expect(failedActionVerdict(new ComputerError("element_not_found", "stale")).state).toBe("refused");
    const unknown = failedActionVerdict(new ComputerError("action_timeout", "no answer", { outcomeUnknown: true }));
    expect(unknown.state).toBe("outcome_unknown");
    expect(verdictLine(unknown)).toBe("Verdict: outcome unknown, it was sent and never answered.");
  });
});
