import { describe, expect, test } from "bun:test";
import { CodexAppServer } from "./codexAppServer";
import { parseCodexSessionFile } from "./parser";
import { SAFETY_BANNER_PREFIX, classifyApiErrorBanner, codexErrorKind } from "@codecast/shared/contracts";
import { codexTurnErrorMessage } from "./codexTurnError";

const message = "This request was blocked by our safety systems. Reason: Potentially unintended activity.";
const timestamp = "2026-09-05T15:36:22.260Z";
const jsonl = (entries: object[]) => entries.map(entry => JSON.stringify({ timestamp, ...entry })).join("\n");

describe("Codex failed-turn ingestion", () => {
  test("imports a structured rollout failure as a separate stable banner after partial output", () => {
    const transcript = jsonl([
      { type: "turn_context", payload: { model: "gpt-6-astra" } },
      { type: "response_item", payload: { type: "message", id: "partial", role: "assistant", content: [{ type: "output_text", text: "No. The repository pages are" }] } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn1", error: { message, codex_error_info: "misalignment_policy_violation" } } },
    ]);
    const messages = parseCodexSessionFile(transcript);
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe("No. The repository pages are");
    expect(messages[1]).toMatchObject({ uuid: "codex-turn-error-turn1", timestamp: Date.parse(timestamp), model: "gpt-6-astra", role: "assistant" });
    expect(classifyApiErrorBanner(messages[1].content)).toBe("safety");
    expect(parseCodexSessionFile(transcript)[1].uuid).toBe(messages[1].uuid);
  });

  test.each([false, true])("live app-server emits the same safety banner with partial output=%s", partial => {
    const server = new CodexAppServer({ log: () => {} });
    let result: any[] = [];
    server.on("turnCompleted", (...args) => { result = args; });
    const notify = (method: string, params: object) => (server as any).handleNotification({ method, params: { threadId: "thread1", ...params } });
    notify("turn/started", { turn: { id: "turn1" } });
    if (partial) notify("item/completed", { turnId: "turn1", item: { type: "agentMessage", id: "partial", text: "Partial answer" } });
    const error = { codexErrorInfo: "misalignmentPolicyViolation", message };
    notify("turn/completed", { turn: { id: "turn1", status: "failed", error } });
    const messages = result[2];
    expect(messages).toHaveLength(partial ? 2 : 1);
    expect(messages.at(-1).uuid).toBe("codex-turn-error-turn1");
    expect(classifyApiErrorBanner(messages.at(-1).content)).toBe("safety");
    if (partial) expect(messages[1].timestamp).toBeGreaterThan(messages[0].timestamp);
    expect(result[3]).toBe("failed");
    expect(result[4]).toEqual(error);
  });

  test("completed and interrupted turns do not invent an error", () => {
    expect(parseCodexSessionFile(jsonl([{ type: "event_msg", payload: { type: "task_complete", turn_id: "ok" } }]))).toEqual([]);
    const server = new CodexAppServer({ log: () => {} });
    const results: any[] = [];
    server.on("turnCompleted", (...args) => results.push(args));
    for (const status of ["completed", "interrupted"]) {
      (server as any).handleNotification({ method: "turn/completed", params: { threadId: "thread1", turn: { id: status, status } } });
    }
    expect(results.map(r => r[2])).toEqual([[], []]);
  });
});

// The real wordings codex 0.153.4 ships, read out of the binary's string table
// rather than by spending quota to provoke each one. They are here as a
// REGRESSION on the classifier's independence from them: every line below is
// prose codex may reword next release, and none of it is what decides the kind
// — the structured `codex_error_info` code is. (Checked the other way too: not
// one of these matches LIMIT_BANNER_RE on its own, which is why a codex limit
// park was invisible to the recovery chain before ct-49676.)
const CODEX_LIMIT_WORDINGS = [
  "You've hit your usage limit.",
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits",
  // Observed verbatim on four production conversations that were parked on a
  // real usage limit and stamped kind "error" — invisible to the recovery
  // chain. This exact string is the bug ct-49676 fixes.
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 12th, 2026 9:10 PM.",
  "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits",
  "You've hit your usage limit. To get more access now, send a request to your admin",
  "You've hit your usage limit for the week. Try again at 3:00 PM.",
  "Usage limit reached. You've reached your usage limit. Increase your limits to continue using codex.",
];

describe("Codex limit parks (ct-49676)", () => {
  test("a usage-limit turn error becomes a banner the chain reads as a limit park", () => {
    for (const message of CODEX_LIMIT_WORDINGS) {
      // The prose alone says nothing to the classifier...
      expect(classifyApiErrorBanner(message)).toBeNull();
      // ...the code is what makes it a park.
      const banner = codexTurnErrorMessage("turn1", { message, codex_error_info: "usage_limit_exceeded" }, 1);
      expect(classifyApiErrorBanner(banner.content)).toBe("limit");
      expect(banner.content).toContain(message);
    }
  });

  test("a per-minute rate limit is a throttle, never a limit — switching accounts would reproduce the burst", () => {
    const banner = codexTurnErrorMessage("turn1", { message: "You've hit your usage limit.", codex_error_info: "rate_limit_exceeded" }, 1);
    expect(classifyApiErrorBanner(banner.content)).toBe("throttle");
    // Identical prose, different code, different cure: that is the whole point
    // of classifying on the code.
    expect(codexErrorKind({ message: "You've hit your usage limit.", codex_error_info: "usage_limit_exceeded" })).toBe("limit");
  });

  test("the Rust variant spelling of a code means the same thing as the wire spelling", () => {
    expect(codexErrorKind({ codexErrorInfo: "usageLimitExceeded" })).toBe("limit");
    expect(codexErrorKind({ codexErrorInfo: "usage_limit_exceeded" })).toBe("limit");
  });

  test("codes with no codecast cure keep the old marked client-error banner", () => {
    // context_window_exceeded is a real CodexErrorInfo variant we deliberately
    // do not map: a park the recovery loop cannot act on must not be badged as
    // one it can.
    const banner = codexTurnErrorMessage("turn1", { message: "The conversation is too long.", codex_error_info: "context_window_exceeded" }, 1);
    expect(codexErrorKind({ codex_error_info: "context_window_exceeded" })).toBeNull();
    expect(classifyApiErrorBanner(banner.content)).toBe("error");
  });

  test("a carried code is the whole answer — prose never overrides it", () => {
    // The safety sentence with a NON-safety code must not read as safety.
    const safetyProse = "This request was blocked by our safety systems. Reason: Potentially unintended activity.";
    expect(codexErrorKind({ message: safetyProse, codex_error_info: "usage_limit_exceeded" })).toBe("limit");
    // And with no code at all, the sentence still stands on its own.
    expect(codexErrorKind({ message: safetyProse })).toBe("safety");
  });

  test("the live app-server path stamps the limit park too, not just the rollout file", () => {
    const server = new CodexAppServer({ log: () => {} });
    let result: any[] = [];
    server.on("turnCompleted", (...args) => { result = args; });
    const notify = (method: string, params: object) => (server as any).handleNotification({ method, params: { threadId: "thread1", ...params } });
    notify("turn/started", { turn: { id: "turn1" } });
    notify("turn/completed", { turn: { id: "turn1", status: "failed", error: { codexErrorInfo: "usage_limit_exceeded", message: "You've hit your usage limit." } } });
    expect(classifyApiErrorBanner(result[2].at(-1).content)).toBe("limit");
  });
});

describe("Codex cyber policy stops (ct-49794)", () => {
  // The wording codex 0.153.4 carries for this code, beside the misalignment
  // one in the same string table. Production rows show a LONGER wording for the
  // same code, so the banner must not be built out of either.
  const cyber = "This request has been flagged for possible cybersecurity risk.";

  test("a cyber policy stop parks as safety instead of dropping to a silent error", () => {
    const banner = codexTurnErrorMessage("turn1", { message: cyber, codex_error_info: "cyber_policy" }, 1);
    expect(classifyApiErrorBanner(banner.content)).toBe("safety");
    expect(banner.content).toContain(cyber);
    // Named by the code that actually fired: labelling every safety stop
    // "misalignment_policy_violation" would tell the user the wrong policy.
    expect(banner.content).toBe(`${SAFETY_BANNER_PREFIX} cyber_policy · ${cyber}`);
  });

  test("the wordless prose stop still carries the misalignment label", () => {
    // No code on the wire, so the prose match is all there is — and the code it
    // stands in for is the misalignment one.
    const banner = codexTurnErrorMessage("turn1", { message }, 1);
    expect(banner.content).toBe(`${SAFETY_BANNER_PREFIX} misalignment_policy_violation · ${message}`);
    expect(classifyApiErrorBanner(banner.content)).toBe("safety");
  });

  test("the live app-server path stamps the cyber policy park too", () => {
    const server = new CodexAppServer({ log: () => {} });
    let result: any[] = [];
    server.on("turnCompleted", (...args) => { result = args; });
    const notify = (method: string, params: object) => (server as any).handleNotification({ method, params: { threadId: "thread1", ...params } });
    notify("turn/started", { turn: { id: "turn1" } });
    notify("turn/completed", { turn: { id: "turn1", status: "failed", error: { codexErrorInfo: "cyberPolicy", message: cyber } } });
    expect(classifyApiErrorBanner(result[2].at(-1).content)).toBe("safety");
    expect(codexErrorKind({ codexErrorInfo: "cyberPolicy" })).toBe("safety");
  });
});
