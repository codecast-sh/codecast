import { afterEach, describe, expect, test } from "bun:test";
import {
  recordShadowComparison,
  resetShadowValidationForTests,
  shadowValidationSummary,
} from "../shadowValidation";
import { comparableComment } from "../../../hooks/useConversationComments";

afterEach(resetShadowValidationForTests);

describe("shadow validation", () => {
  test("equal feeds record an equal latest entry", async () => {
    const rows = [
      { key: "bucket:b1", value: { _id: "b1", name: "api" } },
      { key: "assignment:a1", value: { _id: "a1", bucket_id: "b1" } },
    ];
    const comparison = await recordShadowComparison({
      contractId: "buckets.principal/v2",
      viewKey: "buckets:principal",
      authoritative: rows,
      materialized: [...rows].reverse(),
    });
    expect(comparison.equal).toBe(true);
    const summary = shadowValidationSummary();
    expect(summary.mismatchedViews).toBe(0);
    expect(summary.totalSamples).toBe(1);
  });

  test("a differing row is a mismatch, and a later equal state clears the verdict", async () => {
    const base = { key: "comment:c1", value: { _id: "c1", content: "hi" } };
    const first = await recordShadowComparison({
      contractId: "comments.byConversation/v2",
      viewKey: "comments:conversation:x",
      authoritative: [base],
      materialized: [{ key: "comment:c1", value: { _id: "c1", content: "HI EDITED" } }],
    });
    expect(first.equal).toBe(false);
    expect(shadowValidationSummary().mismatchedViews).toBe(1);

    await recordShadowComparison({
      contractId: "comments.byConversation/v2",
      viewKey: "comments:conversation:x",
      authoritative: [base],
      materialized: [base],
    });
    const summary = shadowValidationSummary();
    expect(summary.mismatchedViews).toBe(0);
    expect(summary.totalMismatches).toBe(1);
    expect(summary.totalSamples).toBe(2);
  });

  test("a missing or extra row changes the digest", async () => {
    const rows = [
      { key: "comment:c1", value: { _id: "c1" } },
      { key: "comment:c2", value: { _id: "c2" } },
    ];
    const comparison = await recordShadowComparison({
      contractId: "comments.byConversation/v2",
      viewKey: "comments:conversation:y",
      authoritative: rows,
      materialized: rows.slice(0, 1),
    });
    expect(comparison.equal).toBe(false);
    expect(comparison.authoritativeRowCount).toBe(2);
    expect(comparison.materializedRowCount).toBe(1);
  });

  test("comparableComment projects both feeds onto the v1 field set", () => {
    const v2Row = {
      _id: "c1",
      content: "hello",
      created_at: 5,
      user: {
        _id: "u1",
        name: "Sam",
        github_username: "sam",
        github_avatar_url: "https://a",
        image: "https://only-in-v2",
      },
    };
    const v1Row = {
      _id: "c1",
      content: "hello",
      created_at: 5,
      user: { _id: "u1", name: "Sam", github_username: "sam", github_avatar_url: "https://a" },
    };
    expect(comparableComment(v2Row)).toEqual(comparableComment(v1Row));
  });
});
