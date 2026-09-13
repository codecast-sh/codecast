import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";
import {
  HYDRATION_CRITICAL_KEYS,
  META_STORE_KEYS,
  REPLICATION_CLASSIFICATION,
  isPersistedClientStoreKey,
} from "../clientSyncRegistry";

// Regression: inline-review quotes and their notes lived in memory-only store
// state (raw set()), so a reload dropped every note the user had written. They
// now persist to IDB exactly like composer drafts — a note is a draft of the
// user's next message and must never be lost.

const CONV = "conv-1";
const mk = (id: string, body = "") => ({ id, messageId: "m1", blockIndex: 0, quote: "q", body, createdAt: 1 });

describe("review comments persistence contract", () => {
  it("is a persisted, per-window meta key hydrated in the critical pass — like drafts", () => {
    expect(isPersistedClientStoreKey("reviewComments")).toBe(true);
    expect(META_STORE_KEYS).toContain("reviewComments");
    expect(HYDRATION_CRITICAL_KEYS).toContain("reviewComments");
    expect(REPLICATION_CLASSIFICATION.reviewComments).toBe("local");
  });
});

describe("review comments store API", () => {
  beforeEach(() => {
    useInboxStore.setState({ reviewComments: {}, reviewMessageId: null, reviewEditingId: null } as any);
  });

  it("writes go through the draft (persisting) path and round-trip by conversation", () => {
    const s = useInboxStore.getState();
    // A subscriber sees each write as a new top-level ref: that is the shape
    // writePatchesToIDB keys its meta put on.
    const seen: unknown[] = [];
    const unsub = useInboxStore.subscribe((st) => seen.push(st.reviewComments));
    s.addReviewComment(CONV, mk("a"));
    s.commitReviewComment(CONV, "a", "typed while editing");
    unsub();
    expect(seen.length).toBe(2);
    expect(useInboxStore.getState().getReviewComments(CONV)).toEqual([mk("a", "typed while editing")]);
    expect(useInboxStore.getState().getReviewComments("other")).toEqual([]);
  });

  it("committing an unchanged body is a no-op (no persist churn per keystroke flush)", () => {
    const s = useInboxStore.getState();
    s.addReviewComment(CONV, mk("a", "same"));
    const before = useInboxStore.getState().reviewComments;
    s.commitReviewComment(CONV, "a", "same");
    expect(useInboxStore.getState().reviewComments).toBe(before);
  });

  it("removing the last quote drops the entry and closes its editor + target", () => {
    const s = useInboxStore.getState();
    s.addReviewComment(CONV, mk("a"));
    useInboxStore.setState({ reviewMessageId: "m1", reviewEditingId: "a" } as any);
    s.removeReviewComment(CONV, "a");
    const st = useInboxStore.getState();
    expect(st.reviewComments).not.toHaveProperty(CONV);
    expect(st.reviewEditingId).toBeNull();
    expect(st.reviewMessageId).toBeNull();
  });

  it("follows a compose stub when it is rekeyed to its real conversation id", () => {
    const s = useInboxStore.getState();
    s.addReviewComment("stub-1", mk("a", "note on a stub"));
    s._rekeySession("stub-1", "real-1");
    const st = useInboxStore.getState();
    expect(st.reviewComments).not.toHaveProperty("stub-1");
    expect(st.getReviewComments("real-1")).toEqual([mk("a", "note on a stub")]);
  });
});
