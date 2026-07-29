import { describe, expect, test } from "bun:test";
import { compareShadowRows, digestShadowRows } from "../shadowDigest";

describe("payload-free shadow digests", () => {
  test("is stable across row and object-key ordering", async () => {
    const first = await digestShadowRows({
      contractId: "example/v2",
      viewKey: "example:one",
      rows: [
        { key: "b", value: { z: 2, a: 1 } },
        { key: "a", value: [3, 4] },
      ],
    });
    const second = await digestShadowRows({
      contractId: "example/v2",
      viewKey: "example:one",
      rows: [
        { key: "a", value: [3, 4] },
        { key: "b", value: { a: 1, z: 2 } },
      ],
    });
    expect(second).toEqual(first);
    expect(first.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("reports only counts and digests for divergent protected values", async () => {
    const comparison = await compareShadowRows({
      contractId: "example/v2",
      viewKey: "example:one",
      authoritative: [{ key: "one", value: { secret: "HIGHLY-SENSITIVE-A" } }],
      materialized: [{ key: "one", value: { secret: "HIGHLY-SENSITIVE-B" } }],
    });
    expect(comparison.equal).toBe(false);
    expect(comparison.authoritativeRowCount).toBe(1);
    expect(comparison.materializedRowCount).toBe(1);
    expect(JSON.stringify(comparison)).not.toContain("HIGHLY-SENSITIVE-A");
    expect(JSON.stringify(comparison)).not.toContain("HIGHLY-SENSITIVE-B");
  });

  test("rejects duplicate identities instead of hiding normalization bugs", async () => {
    await expect(digestShadowRows({
      contractId: "example/v2",
      viewKey: "example:one",
      rows: [
        { key: "same", value: 1 },
        { key: "same", value: 2 },
      ],
    })).rejects.toThrow("Duplicate shadow row key");
  });
});
