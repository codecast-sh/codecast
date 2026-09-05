import { describe, expect, test } from "bun:test";
import { BLOCKED_BANNER_KINDS, CONTINUE_BANNER_KINDS, SAFETY_BANNER_PREFIX, classifyApiErrorBanner, isCodexSafetyError, withSafetyBlock } from "./apiErrorBanner";

const message = "This request was blocked by our safety systems. Reason: Potentially unintended activity.";

describe("Codex safety stops", () => {
  test.each(["misalignment_policy_violation", "misalignmentPolicyViolation"])("recognizes the structured %s code independently of wording", code => {
    expect(isCodexSafetyError({ codexErrorInfo: code, message: "Different provider wording" })).toBe(true);
    expect(isCodexSafetyError({ codex_error_info: code })).toBe(true);
  });

  test("uses exact legacy wording only when the structured code is absent", () => {
    expect(isCodexSafetyError({ message })).toBe(true);
    expect(isCodexSafetyError({ code: "rate_limit_exceeded", message })).toBe(false);
    expect(isCodexSafetyError({ message: `${message} Here is what it means.` })).toBe(false);
    expect(isCodexSafetyError(undefined)).toBe(false);
  });

  test("renders a safety blocker without misclassifying an HTTP 403 as expired login", () => {
    expect(classifyApiErrorBanner(`${SAFETY_BANNER_PREFIX} misalignment_policy_violation · ${message}`)).toBe("safety");
    expect(classifyApiErrorBanner(message)).toBe("safety");
    expect(classifyApiErrorBanner('API Error: 403 {"error":{"code":"misalignment_policy_violation","message":"Review required"}}')).toBe("safety");
    expect(classifyApiErrorBanner('API Error: 403 {"error":{"code":"invalid_api_key"}}')).toBe("auth");
    expect(classifyApiErrorBanner(`The provider said: ${message}`)).toBeNull();
    expect(BLOCKED_BANNER_KINDS.has("safety")).toBe(true);
    expect(CONTINUE_BANNER_KINDS).not.toContain("safety");
  });

  test("exposes existing session errors without mutating the cached record", () => {
    const legacy = { session_error: message, pending_api_error: false };
    const normalized = withSafetyBlock(legacy);
    expect(normalized).toMatchObject({ pending_api_error: true, pending_api_error_kind: "safety" });
    expect(legacy.pending_api_error).toBe(false);
    expect(withSafetyBlock(normalized)).toBe(normalized);
    const healthy = { session_error: "Connection refused", pending_api_error: false };
    expect(withSafetyBlock(healthy)).toBe(healthy);
  });
});
