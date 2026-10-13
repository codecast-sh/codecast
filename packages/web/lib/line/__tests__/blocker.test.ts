import { describe, expect, test } from "bun:test";
import { blockerCause, blockerClause, blockerFile, fixTaskFor } from "../blocker";
import { failCauseOf } from "../stepWork";

const REASON = "Miss reproduced on base (Anthony, Grayson and Adam each 0 of 5), but prove cannot finish: freeze.ts --json output gets cut off when piped (process.exit before stdout drains), so the fix must land on main first.";

describe("blocker", () => {
  test("names the file a station is blocked on, in whole words", () => {
    expect(blockerFile(REASON)).toBe("freeze.ts");
    expect(blockerCause("prove", REASON)).toEqual({ key: "blocked:prove:freeze.ts", label: "Blocked by a tooling bug in freeze.ts", file: "freeze.ts" });
    expect(blockerClause(REASON, "freeze.ts")).toBe("freeze.ts --json output gets cut off when piped (process.exit before stdout drains)");
  });

  test("a blocker with no file is its own words", () => {
    expect(blockerFile("Waiting on the Stripe key from Cam")).toBeNull();
    expect(blockerCause("prove", "Waiting on the Stripe key from Cam").label).toBe("Blocked: Waiting on the Stripe key from Cam");
  });

  test("the fix is the newest open task naming the file, never the blocked problem", () => {
    const tasks = [
      { _id: "a", short_id: "ct-9", title: "freeze.ts old", status: "done" },
      { _id: "b", short_id: "ct-57662", title: "line prove crashes", description: "have freeze.ts --json emit one marked line", status: "open" },
      { _id: "c", short_id: "ct-59509", title: "blocked by freeze.ts", status: "open" },
      { _id: "d", short_id: "ct-60000", title: "unfreeze.tsx cleanup", status: "open" },
    ];
    expect(fixTaskFor("freeze.ts", tasks, new Set(["c"]))?.short_id).toBe("ct-57662");
  });

  test("a failed visit whose run pinned blocked groups by the blocker", () => {
    const d = { id: "r1:prove", runId: "r1", decided: { words: REASON.slice(0, 120) + "…" }, received: { sessionId: "s" } } as never;
    const causes = new Map([["r1", { key: "deadend-failed-blocked:prove", label: "Prove blocked: …", blocked: REASON }]]);
    expect(failCauseOf(d, causes, "agent")).toMatchObject({ key: "blocked:prove:freeze.ts", label: "Blocked by a tooling bug in freeze.ts" });
  });
});
