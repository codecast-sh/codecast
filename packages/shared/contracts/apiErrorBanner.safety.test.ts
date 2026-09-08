import { describe, expect, test } from "bun:test";
import { BLOCKED_BANNER_KINDS, CONTINUE_BANNER_KINDS, SAFETY_BANNER_PREFIX, blockedKindsForAgent, classifyApiErrorBanner, codexErrorKind, isCodexSafetyError, withSafetyBlock } from "./apiErrorBanner";

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

// CyberPolicy and MisalignmentPolicyViolation are neighbours in CodexErrorInfo,
// and the binary carries their sentences side by side too. Both wordings below
// are real: the first out of the app-server binary's string table, the second
// off the two production rows that filed this bug. They describe ONE code, and
// they do not match each other — which is the whole argument for reading the
// code instead of the prose.
const CYBER_POLICY_WORDINGS = [
  "This request has been flagged for possible cybersecurity risk.",
  "Turn stopped: This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request.",
];

describe("Codex cyber policy stops", () => {
  test.each(["cyber_policy", "cyberPolicy"])("the %s code is a safety stop whatever the wording", code => {
    for (const message of CYBER_POLICY_WORDINGS) {
      expect(codexErrorKind({ codex_error_info: code, message })).toBe("safety");
      expect(isCodexSafetyError({ codexErrorInfo: code, message })).toBe(true);
      // The prose alone says nothing to the classifier. Only the code does.
      expect(classifyApiErrorBanner(message)).toBeNull();
    }
  });

  test("it parks the session but is never read as a limit or a throttle", () => {
    const kind = codexErrorKind({ codex_error_info: "cyber_policy" });
    expect(kind).toBe("safety");
    // Blocked, so the row earns the badge and the hint...
    expect(blockedKindsForAgent("codex").has(kind!)).toBe(true);
    // ...but no continue and no account switch is offered, because neither
    // clears a policy stop.
    expect(CONTINUE_BANNER_KINDS).not.toContain(kind);
  });
});
