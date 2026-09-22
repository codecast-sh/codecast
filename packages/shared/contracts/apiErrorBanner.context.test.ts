import { describe, expect, test } from "bun:test";
import { BLOCKED_BANNER_KINDS, CONTEXT_BANNER_PREFIX, CONTINUE_BANNER_KINDS, UNREVIVABLE_BANNER_KINDS, blockedKindsForAgent, classifyApiErrorBanner, codexErrorKind, contextBannerContent } from "./apiErrorBanner";

// What Claude Code writes when a request is rejected for size: an assistant
// row flagged isApiErrorMessage, error "invalid_request", no HTTP status, and
// only these words — the pane shows "Context limit reached · /compact or
// /clear to continue" but the transcript never carries that line.
describe("context overflow banners", () => {
  test("the bare overflow parks the session on the context kind", () => {
    expect(classifyApiErrorBanner("Prompt is too long")).toBe("context");
    expect(classifyApiErrorBanner(CONTEXT_BANNER_PREFIX)).toBe("context");
    expect(classifyApiErrorBanner("Prompt is too long · automatic compaction failed: unknown reason")).toBe("context");
  });

  // 2026-09 JSONL: compaction itself hit the usage window. The window is the
  // real park — once it rolls, the next turn compacts by itself — so the
  // recovery loop must see the limit, not a context park nothing can revive.
  test("a compaction that failed on a recoverable park takes that park's kind", () => {
    const onLimit = "Prompt is too long · automatic compaction failed: You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.";
    expect(classifyApiErrorBanner(onLimit)).toBe("limit");
    expect(classifyApiErrorBanner("Prompt is too long · automatic compaction failed: Login expired · Please run /login")).toBe("auth");
  });

  test("prose that merely mentions the words is not a banner", () => {
    expect(classifyApiErrorBanner("The prompt is too long for this model, so I trimmed it.")).toBeNull();
    expect(classifyApiErrorBanner("Prompt is too long\nHere is what I would do about it.")).toBeNull();
  });

  test("it is blocked, unrevivable, and never a plain continue", () => {
    expect(BLOCKED_BANNER_KINDS.has("context")).toBe(true);
    expect(UNREVIVABLE_BANNER_KINDS.has("context")).toBe(true);
    expect(CONTINUE_BANNER_KINDS).not.toContain("context");
    expect(blockedKindsForAgent("claude_code").has("context")).toBe(true);
    expect(blockedKindsForAgent("codex").has("context")).toBe(true);
  });

  test("codex reports the same condition as a code and its banner reads the same kind", () => {
    expect(codexErrorKind({ codex_error_info: "context_window_exceeded" })).toBe("context");
    expect(codexErrorKind({ codexErrorInfo: "contextWindowExceeded" })).toBe("context");
    expect(classifyApiErrorBanner(contextBannerContent("The conversation is too long."))).toBe("context");
  });
});
