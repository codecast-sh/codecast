import { describe, expect, test } from "bun:test";
import { WAIT_STATES } from "@codecast/shared/tasks";
import { taskWaitValidator, waitStateValidator } from "./taskWaitValidator";

describe("taskWaitValidator", () => {
  test("states derive from the shared list", () => {
    const literals = (waitStateValidator.members as { value: string }[]).map((m) => m.value);
    expect(literals).toEqual([...WAIT_STATES]);
  });

  test("one object per target kind", () => {
    const kinds = taskWaitValidator.members.map((m) => {
      const kind = m.fields.kind as any;
      return kind.kind === "union" ? kind.members.map((x: any) => x.value) : [kind.value];
    });
    expect(kinds).toEqual([["pr_merged", "pr_checks_green"], ["decision"], ["time"]]);
  });
});
