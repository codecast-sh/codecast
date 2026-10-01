import { describe, expect, test } from "bun:test";
import { pairDeliveryAcks } from "./pendingStatus";

describe("pairDeliveryAcks", () => {
  test("pairs the newest common suffix, oldest first", () => {
    expect(pairDeliveryAcks(["p1", "p2", "p3"], ["t1", "t2"])).toEqual([
      { pendingMessageId: "p2", transcriptMessageId: "t1" },
      { pendingMessageId: "p3", transcriptMessageId: "t2" },
    ]);
    expect(pairDeliveryAcks(["p1"], ["t1", "t2"])).toEqual([{ pendingMessageId: "p1", transcriptMessageId: "t2" }]);
  });

  test("pairs nothing when either side is empty", () => {
    expect(pairDeliveryAcks([], ["t1"])).toEqual([]);
    expect(pairDeliveryAcks(["p1"], [])).toEqual([]);
  });
});
