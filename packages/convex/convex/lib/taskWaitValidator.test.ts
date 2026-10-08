import { describe, expect, test } from "bun:test";
import type { Infer } from "convex/values";
import { WAIT_STATES, type TaskWait, type WaitTarget } from "@codecast/shared/tasks";
import { taskWaitValidator, waitStateValidator, waitTargetValidator } from "./taskWaitValidator";

// The validator and the shared type must accept exactly the same shapes; this
// fails the convex typecheck the moment either side gains or loses a field.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const waitShape: Same<Infer<typeof taskWaitValidator>, TaskWait> = true;
const targetShape: Same<Infer<typeof waitTargetValidator>, WaitTarget> = true;

describe("taskWaitValidator", () => {
  test("matches the shared TaskWait type", () => {
    expect(waitShape && targetShape).toBe(true);
  });

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
