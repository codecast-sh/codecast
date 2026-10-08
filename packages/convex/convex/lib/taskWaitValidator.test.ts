import { describe, expect, test } from "bun:test";
import { taskWaitValidator } from "./taskWaitValidator";

describe("taskWaitValidator", () => {
  test("one object per target kind", () => {
    const kinds = taskWaitValidator.members.map((m) => {
      const kind = m.fields.kind as any;
      return kind.kind === "union" ? kind.members.map((x: any) => x.value) : [kind.value];
    });
    expect(kinds).toEqual([["pr_merged", "pr_checks_green"], ["decision"], ["time"]]);
  });
});
