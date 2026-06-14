import { test, expect, describe, beforeEach } from "bun:test";
import { useInboxStore } from "../store/inboxStore";
import { takeReviewBatch, attachReviewToMessage } from "./reviewActions";
import { formatPlanFeedback, type PendingComment } from "./quoteFormat";

const CONV = "conv-test";

const mk = (id: string, blockIndex: number, quote: string, body: string): PendingComment => ({
  id,
  messageId: "m1",
  blockIndex,
  quote,
  body,
  createdAt: blockIndex,
});

function seed(comments: PendingComment[]) {
  useInboxStore.setState({
    reviewComments: comments.length ? { [CONV]: comments } : {},
    reviewMessageId: "m1",
    reviewEditingId: "edit-1",
  } as any);
}

beforeEach(() => {
  useInboxStore.setState({ reviewComments: {}, reviewMessageId: null, reviewEditingId: null } as any);
});

describe("takeReviewBatch", () => {
  test("compiles quotes + notes into markdown and clears the batch + review state", () => {
    seed([mk("1", 0, "q1", "n1"), mk("2", 1, "q2", "")]);
    expect(takeReviewBatch(CONV)).toBe("> q1\n\nn1\n\n> q2");
    const s = useInboxStore.getState();
    expect(s.reviewComments[CONV]).toBeUndefined();
    expect(s.reviewMessageId).toBeNull();
    expect(s.reviewEditingId).toBeNull();
  });

  test("returns empty string when nothing meaningful is pending", () => {
    seed([]);
    expect(takeReviewBatch(CONV)).toBe("");
  });

  test("scoped to a messageId takes only those comments and clears just them (plan review)", () => {
    // Plan comments live under a namespaced key; an unrelated body comment must survive.
    seed([
      { id: "p1", messageId: "m1#plan", blockIndex: 0, quote: "plan line", body: "wrong", createdAt: 0 },
      { id: "b1", messageId: "m1", blockIndex: 0, quote: "body line", body: "", createdAt: 1 },
    ]);
    expect(takeReviewBatch(CONV, "m1#plan")).toBe("> plan line\n\nwrong");
    const s = useInboxStore.getState();
    expect(s.reviewComments[CONV]?.map((c) => c.id)).toEqual(["b1"]); // body comment untouched
  });
});

describe("formatPlanFeedback", () => {
  test("wraps the annotation batch in directive rejection framing", () => {
    const out = formatPlanFeedback("> bad section\n\nfix this");
    expect(out).toContain("The plan was NOT approved");
    expect(out).toContain("Do not re-present the same plan unchanged");
    expect(out.endsWith("> bad section\n\nfix this")).toBe(true);
  });

  test("falls back to a generic request when the batch is empty", () => {
    expect(formatPlanFeedback("")).toContain("Plan changes requested.");
  });
});

describe("attachReviewToMessage", () => {
  test("prepends the batch to the typed reply", () => {
    seed([mk("1", 0, "q1", "")]);
    expect(attachReviewToMessage(CONV, "my reply")).toBe("> q1\n\nmy reply");
    expect(useInboxStore.getState().reviewComments[CONV]).toBeUndefined(); // consumed
  });

  test("sends the batch alone when nothing was typed", () => {
    seed([mk("1", 0, "q1", "note")]);
    expect(attachReviewToMessage(CONV, "")).toBe("> q1\n\nnote");
  });

  test("leaves the typed message untouched when no quotes are pending", () => {
    expect(attachReviewToMessage(CONV, "just text")).toBe("just text");
  });
});

describe("removeReviewComment clears the review target (no lingering highlight)", () => {
  const remove = (id: string) => useInboxStore.getState().removeReviewComment(CONV, id);

  test("removing the last quote drops reviewMessageId so the overlay stops painting", () => {
    seed([mk("1", 0, "q1", "")]);
    remove("1");
    const s = useInboxStore.getState();
    expect(s.reviewComments[CONV]).toBeUndefined();
    expect(s.reviewMessageId).toBeNull();
    expect(s.reviewActiveBlock).toBe(0);
    expect(s.reviewEditingId).toBeNull();
  });

  test("removing the last quote ON the target message clears the target even if other messages keep quotes", () => {
    // m1 = target (one quote), m2 = another message with its own quote.
    seed([mk("1", 0, "q1", ""), { id: "2", messageId: "m2", blockIndex: 0, quote: "q2", body: "", createdAt: 2 }]);
    remove("1");
    const s = useInboxStore.getState();
    expect(s.reviewComments[CONV]?.map((c) => c.id)).toEqual(["2"]); // m2's quote survives
    expect(s.reviewMessageId).toBeNull(); // target m1 had its last quote removed
  });

  test("removing a non-target quote keeps the target intact", () => {
    seed([mk("1", 0, "q1", ""), mk("2", 1, "q2", "")]); // both on m1
    remove("2");
    const s = useInboxStore.getState();
    expect(s.reviewComments[CONV]?.map((c) => c.id)).toEqual(["1"]);
    expect(s.reviewMessageId).toBe("m1"); // m1 still has quote "1"
  });
});
