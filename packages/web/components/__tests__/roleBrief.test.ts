// A role's brief (the prompt that seats or re-seats a standing agent) is the
// session's context written by a machine: it classifies as its own kind, which
// renders folded to one row, and fold mode keeps that row in place.
import { describe, expect, test } from "bun:test";
import { classifyUserMessage, FOLD_KEPT_USER_KINDS } from "../conversation/classify";

const kindOf = (content: string) => classifyUserMessage({ _id: "m", role: "user", content, timestamp: 1 } as any).kind;

describe("a role's brief", () => {
  test("the seating prompt and a restart's re-brief are both role_brief", () => {
    expect(kindOf("You are **Calling lead**, the standing agent for the **Calling lead** role (@calling) in Union.")).toBe("role_brief");
    expect(kindOf("You are the **Calling lead** (@calling) in Union.\n\nYour charter follows.")).toBe("role_brief");
  });

  test("a person's line that starts the same way stays theirs", () => {
    expect(kindOf("You are **not** a bootstrap: this is a person talking.")).toBe("normal");
  });

  test("fold mode keeps the brief, folded, where it sits", () => {
    expect(FOLD_KEPT_USER_KINDS.has("role_brief")).toBe(true);
  });
});
