import { describe, expect, test } from "bun:test";
import { isOlderBackendRefusal, parseApiAnswer } from "./castApi.js";

describe("isOlderBackendRefusal", () => {
  test("reads the validator's refusal of a field this backend does not know", () => {
    const extra = new Error("Object contains extra field `slim` that is not in the validator.");
    expect(isOlderBackendRefusal(extra)).toBe(true);
    expect(isOlderBackendRefusal(extra, "slim")).toBe(true);
    expect(isOlderBackendRefusal(extra, "id")).toBe(false);
  });

  test("names a field the backend types differently by its path", () => {
    const typed = new Error('Found ID "k57" from table `sessions`, which does not match the table name in validator `v.id("conversations")`. Path: .conversation_id');
    expect(isOlderBackendRefusal(typed, "conversation_id")).toBe(true);
  });

  test("leaves every other failure alone", () => {
    expect(isOlderBackendRefusal(new Error("Task ct-9 not found"))).toBe(false);
    expect(isOlderBackendRefusal(new Error("API error (500): conversation_id missing"), "conversation_id")).toBe(false);
  });
});

describe("parseApiAnswer", () => {
  test("a success with no body is an empty answer, not a failure", () => {
    expect(parseApiAnswer("/cli/workflow-runs/progress", { ok: true, status: 200 }, "")).toEqual({ result: null });
    expect(parseApiAnswer("/cli/x", { ok: true, status: 200 }, "  \n")).toEqual({ result: null });
  });
  test("JSON reads as JSON", () => {
    expect(parseApiAnswer("/cli/x", { ok: true, status: 200 }, '{"ok":true}')).toEqual({ result: { ok: true } });
  });
  test("a failure or a non-JSON success still fails, with the route", () => {
    expect(parseApiAnswer("/cli/x", { ok: false, status: 502 }, "")).toHaveProperty("failure");
    expect((parseApiAnswer("/cli/x", { ok: true, status: 200 }, "<html>") as { failure: string }).failure).toContain("API error (200)");
  });
});
