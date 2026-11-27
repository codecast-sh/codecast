import { describe, expect, test } from "bun:test";
import { parseWaitingOnRef, prOfWaitingRef, prWaitingRef } from "./waitingOn";

describe("parseWaitingOnRef", () => {
  test("each kind, in its stored form", () => {
    expect(parseWaitingOnRef("jx7C6zk")).toEqual({ ok: true, kind: "session", ref: "jx7c6zk" });
    expect(parseWaitingOnRef(" ct-012 ")).toEqual({ ok: true, kind: "task", ref: "ct-12" });
    expect(parseWaitingOnRef("#42")).toEqual({ ok: true, kind: "pr", pr_number: 42 });
    expect(parseWaitingOnRef("Codecast-SH/codecast#42")).toEqual({ ok: true, kind: "pr", repository: "codecast-sh/codecast", pr_number: 42 });
    expect(parseWaitingOnRef("https://github.com/codecast-sh/codecast/pull/42")).toEqual({ ok: true, kind: "pr", repository: "codecast-sh/codecast", pr_number: 42 });
    expect(parseWaitingOnRef("@Ashot")).toEqual({ ok: true, kind: "person", ref: "@ashot" });
  });

  test("what is not a wait is refused with the way to wait on it", () => {
    for (const [ref, says] of [["", "--on names"], ["#42:checks", "pr_checks_green"], ["sd-4", "no --on needed"], ["2h", "--in"], ["42", "is not something"], ["nonsense words", "is not something"]] as const) {
      const r = parseWaitingOnRef(ref);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(says);
    }
  });

  test("a PR's stored ref round-trips", () => {
    expect(prWaitingRef("Codecast-SH/codecast", 7)).toBe("codecast-sh/codecast#7");
    expect(prOfWaitingRef("codecast-sh/codecast#7")).toEqual({ repository: "codecast-sh/codecast", pr_number: 7 });
    expect(prOfWaitingRef("ct-7")).toBeNull();
  });
});
