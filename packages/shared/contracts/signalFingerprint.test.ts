import { describe, expect, test } from "bun:test";
import { evalsSignalFingerprint, insightSignalFingerprint } from "./signalFingerprint";

describe("evalsSignalFingerprint", () => {
  test("names the surface and the check or freeze", () => {
    expect(evalsSignalFingerprint("title", "json")).toBe("evals:title:json");
    expect(evalsSignalFingerprint(" title ", " abc123 ")).toBe("evals:title:abc123");
  });
});

describe("insightSignalFingerprint", () => {
  test("is stable and shaped insight:<session>:<8 hex>", () => {
    const fp = insightSignalFingerprint("jx7c6zk", "Convex deploy fails on the schema check");
    expect(fp).toMatch(/^insight:jx7c6zk:[0-9a-f]{8}$/);
    expect(insightSignalFingerprint("jx7c6zk", "Convex deploy fails on the schema check")).toBe(fp);
  });

  test("case, spacing and end punctuation restate the same blocker", () => {
    const fp = insightSignalFingerprint("jx7c6zk", "Convex deploy fails on the schema check");
    expect(insightSignalFingerprint("jx7c6zk", "  convex deploy  fails on the\nschema check.")).toBe(fp);
  });

  test("a different blocker or session is a different fingerprint", () => {
    const fp = insightSignalFingerprint("jx7c6zk", "Convex deploy fails on the schema check");
    expect(insightSignalFingerprint("jx7c6zk", "Tests time out under load")).not.toBe(fp);
    expect(insightSignalFingerprint("jx7aaaa", "Convex deploy fails on the schema check")).not.toBe(fp);
  });
});
