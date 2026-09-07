import { describe, expect, test } from "bun:test";
import { branchSizeOf, originSizeSinceFork } from "../../lib/branchCounts";

// The chip row shows two sizes per fork point: each fork's own messages since
// the fork, and the origin line's messages since the fork. Both derive from
// numbers already on the rows (message_count, fork_copied); no message scan.

describe("branchSizeOf", () => {
  test("a freshly seeded fork stub owns nothing: its whole count is inherited", () => {
    // Regression: the stub used to carry message_count only, so the parent's
    // 834-message prefix rendered as "834 messages in this branch since the fork".
    expect(branchSizeOf({ message_count: 834, fork_copied: 834 })).toBe(0);
  });

  test("own size is the total minus the inherited prefix", () => {
    expect(branchSizeOf({ message_count: 1352, fork_copied: 1321 })).toBe(31);
  });

  test("legacy rows with no cursor fall back to the raw count", () => {
    expect(branchSizeOf({ message_count: 12 })).toBe(12);
  });
});

describe("originSizeSinceFork", () => {
  test("origin total minus the prefix a completed fork copied", () => {
    expect(originSizeSinceFork([{ fork_copied: 1321, fork_status: "complete" }], 1394)).toBe(73);
  });

  test("a copy in flight cannot vouch for the prefix", () => {
    expect(originSizeSinceFork([{ fork_copied: 400, fork_status: "copying" }], 1394)).toBeUndefined();
  });

  test("a client stub cannot vouch: it only knows the history it had loaded", () => {
    expect(originSizeSinceFork([{ fork_copied: 834, optimistic: true }], 1394)).toBeUndefined();
  });

  test("the first row that can vouch wins over stubs and in-flight copies", () => {
    expect(
      originSizeSinceFork(
        [
          { fork_copied: 834, optimistic: true },
          { fork_copied: 400, fork_status: "copying" },
          { fork_copied: 1321, fork_status: "complete" },
        ],
        1394,
      ),
    ).toBe(73);
  });

  test("no origin count known means no number", () => {
    expect(originSizeSinceFork([{ fork_copied: 1321, fork_status: "complete" }], undefined)).toBeUndefined();
  });

  test("never negative when counts race", () => {
    expect(originSizeSinceFork([{ fork_copied: 10, fork_status: "complete" }], 8)).toBe(0);
  });
});
