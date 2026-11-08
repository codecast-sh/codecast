import { describe, expect, test } from "bun:test";
import { isOlderBackendRefusal } from "./castApi.js";

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
