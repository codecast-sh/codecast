import { describe, expect, test } from "bun:test";
import { handoffParentSessionId, linkPlanHandoffChild, planHandoffTarget } from "./planHandoff.js";

const OWN = "b6f02af8-bae7-476b-8d14-d130da0af41a";
const PARENT = "2e7dee08-e873-4f7e-b68e-e2607999b559";

describe("handoffParentSessionId", () => {
  test("a plan handoff names its parent", () => {
    expect(handoffParentSessionId(`Implement the following plan: …\nread the full transcript at: /Users/x/.claude/projects/-p/${PARENT}.jsonl`, OWN)).toBe(PARENT);
  });

  test("a compaction summary pointing at the session's own transcript names no parent", () => {
    expect(handoffParentSessionId(`If you need specific details from before compaction, read the full transcript at: /home/jason/.claude/projects/-home-jason/${OWN}.jsonl\nContinue`, OWN)).toBe("");
  });

  test("a pointer without a session id names no parent", () => {
    expect(handoffParentSessionId("read the full transcript at: /tmp/notes.jsonl", OWN)).toBe("");
  });

  test("a message without a pointer is not a handoff", () => {
    expect(handoffParentSessionId("what should I read tonight?", OWN)).toBeNull();
  });
});

describe("planHandoffTarget", () => {
  test("no child keeps the message where it was sent", () => {
    expect(planHandoffTarget(new Map(), "a")).toBeUndefined();
  });

  test("a chain delivers to its last session", () => {
    expect(planHandoffTarget(new Map([["a", "b"], ["b", "c"]]), "a")).toBe("c");
  });

  test("a self-link keeps the message where it was sent", () => {
    expect(planHandoffTarget(new Map([["a", "a"]]), "a")).toBeUndefined();
  });

  test("a loop keeps the message where it was sent", () => {
    const children = new Map([["a", "b"], ["b", "a"]]);
    expect(planHandoffTarget(children, "a")).toBeUndefined();
    expect(planHandoffTarget(children, "b")).toBeUndefined();
  });

  test("a chain that runs into a loop keeps the message where it was sent", () => {
    expect(planHandoffTarget(new Map([["a", "b"], ["b", "c"], ["c", "b"]]), "a")).toBeUndefined();
  });
});

describe("linkPlanHandoffChild", () => {
  test("links a parent to a different child", () => {
    const children = new Map<string, string>();
    expect(linkPlanHandoffChild(children, "a", "b")).toBe(true);
    expect(children.get("a")).toBe("b");
  });

  test("a pointer to an older session id of the same conversation leaves its real child alone", () => {
    const cache: Record<string, string> = { [PARENT]: "c", [OWN]: "c" };
    const children = new Map([["c", "real-child"]]);
    const parent = handoffParentSessionId(`read the full transcript at: /x/${PARENT}.jsonl`, OWN)!;
    expect(linkPlanHandoffChild(children, cache[parent], cache[OWN])).toBe(false);
    expect(children.get("c")).toBe("real-child");
  });
});
