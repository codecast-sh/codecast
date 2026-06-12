import { describe, expect, it } from "bun:test";
import { labelMentionItems } from "../useMentionQuery";
import type { BucketAssignmentItem, BucketItem } from "../../store/inboxStore";

const bucket = (id: string, name: string, extra: Partial<BucketItem> = {}): BucketItem => ({
  _id: id,
  name,
  created_at: 1,
  updated_at: 1,
  ...extra,
});

const assignment = (id: string, conv: string, bucketId: string | null, updated = 1): BucketAssignmentItem => ({
  _id: id,
  conversation_id: conv,
  bucket_id: bucketId,
  updated_at: updated,
});

describe("labelMentionItems", () => {
  it("maps active buckets to label mention items with session counts", () => {
    const items = labelMentionItems({
      buckets: { b1: bucket("b1", "Infra"), b2: bucket("b2", "Old", { archived_at: 5 }) },
      bucketAssignments: {
        a1: assignment("a1", "c1", "b1"),
        a2: assignment("a2", "c2", "b1"),
        a3: assignment("a3", "c3", null),
      },
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "b1",
      type: "label",
      label: "Infra",
      sublabel: "2 sessions",
      shortId: "label:b1",
    });
  });

  it("counts each conversation once when an optimistic stub coexists with the real row", () => {
    const items = labelMentionItems({
      buckets: { b1: bucket("b1", "Infra") },
      bucketAssignments: {
        "bucketassign-stub": assignment("bucketassign-stub", "c1", "b1", 1),
        real: assignment("real", "c1", "b1", 2),
      },
    });
    expect(items[0].sublabel).toBe("1 session");
  });

  it("returns empty for missing collections", () => {
    expect(labelMentionItems({})).toEqual([]);
  });
});
