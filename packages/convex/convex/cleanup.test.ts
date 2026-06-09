import { describe, expect, test } from "bun:test";
import { isGcableEmptyConversation, hasLiveDraft } from "./cleanup";

// Row-level qualification for the abandoned empty-conversation GC. Anything
// signaling user intent or attached work must disqualify — these rows get
// HARD-DELETED, so the predicate errs closed.
describe("isGcableEmptyConversation", () => {
  test("a plain abandoned blank row qualifies", () => {
    expect(isGcableEmptyConversation({ message_count: 0 })).toBe(true);
    expect(isGcableEmptyConversation({})).toBe(true);
  });

  test("anything with messages or pending sends is kept", () => {
    expect(isGcableEmptyConversation({ message_count: 1 })).toBe(false);
    expect(isGcableEmptyConversation({ message_count: 0, has_pending_messages: true })).toBe(false);
  });

  test("user intent keeps the row: drafts, pins, favorites, custom titles, shares", () => {
    expect(isGcableEmptyConversation({ draft_message: "half-typed thought" })).toBe(false);
    expect(isGcableEmptyConversation({ draft_message: "   " })).toBe(true); // whitespace ≠ intent
    expect(isGcableEmptyConversation({ inbox_pinned_at: 123 })).toBe(false);
    expect(isGcableEmptyConversation({ is_favorite: true })).toBe(false);
    expect(isGcableEmptyConversation({ title_is_custom: true })).toBe(false);
    expect(isGcableEmptyConversation({ share_token: "tok" })).toBe(false);
  });

  test("attached work keeps the row: tasks, plans, workflows, forks, subagents", () => {
    expect(isGcableEmptyConversation({ active_task_id: "t" })).toBe(false);
    expect(isGcableEmptyConversation({ active_plan_id: "p" })).toBe(false);
    expect(isGcableEmptyConversation({ plan_ids: ["p"] })).toBe(false);
    expect(isGcableEmptyConversation({ workflow_run_id: "w" })).toBe(false);
    expect(isGcableEmptyConversation({ is_workflow_primary: true })).toBe(false);
    expect(isGcableEmptyConversation({ forked_from: "c" })).toBe(false);
    // A fork mid-copy legitimately has 0 messages — never sweep it.
    expect(isGcableEmptyConversation({ fork_status: "copying" })).toBe(false);
    expect(isGcableEmptyConversation({ is_subagent: true })).toBe(false);
    expect(isGcableEmptyConversation({ parent_conversation_id: "c" })).toBe(false);
  });
});

describe("hasLiveDraft", () => {
  test("non-empty text or attachments count as a live draft", () => {
    expect(hasLiveDraft({ draft_message: "wip" })).toBe(true);
    expect(hasLiveDraft({ draft_message: "", draft_images: ["s1"] })).toBe(true);
  });

  test("cleared or empty entries do not", () => {
    expect(hasLiveDraft(null)).toBe(false);
    expect(hasLiveDraft(undefined)).toBe(false);
    expect(hasLiveDraft({ draft_message: "" })).toBe(false);
    expect(hasLiveDraft({ draft_message: "   " })).toBe(false);
    expect(hasLiveDraft({})).toBe(false);
  });
});
