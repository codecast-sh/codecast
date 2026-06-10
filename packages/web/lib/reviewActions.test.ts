import { test, expect, describe, beforeEach } from "bun:test";
import { useInboxStore } from "../store/inboxStore";
import { takeReviewBatch, attachReviewToMessage } from "./reviewActions";
import type { PendingComment } from "./quoteFormat";

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
