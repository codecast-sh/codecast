import { test, expect } from "bun:test";
import { isBlockedConversation } from "../packages/convex/convex/ccAccountsShared";
import { CONTINUE_BANNER_KINDS, classifyApiErrorBanner } from "../packages/shared/contracts";

// The REAL production row for the session in the screenshot, after restamp.
const prodRow = {
  pending_api_error: true,
  pending_api_error_kind: "fatal",
  agent_type: "claude_code",
} as const;

test("the screenshot's parked 400 session is now in the blocked set", () => {
  expect(isBlockedConversation(prodRow)).toBe(true);
});

test("and a plain continue is an offered remedy for it", () => {
  expect(CONTINUE_BANNER_KINDS.includes(prodRow.pending_api_error_kind)).toBe(true);
});

test("the exact banner text from the screenshot classifies as fatal", () => {
  expect(classifyApiErrorBanner("API Error: 400 API request failed")).toBe("fatal");
});

test("a self-retrying 529 still stays OUT of the blocked set", () => {
  expect(isBlockedConversation({ ...prodRow, pending_api_error_kind: "error" })).toBe(false);
});
