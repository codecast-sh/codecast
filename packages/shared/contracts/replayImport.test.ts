import { describe, expect, test } from "bun:test";
import { VENDOR_CONVERTER_VERSION, needsVendorImport } from "./replay";

describe("needsVendorImport", () => {
  test("a mirrored recording never imported is due", () => {
    expect(needsVendorImport({ provider: "posthog", imported_at: null })).toBe(true);
  });
  test("a copy made by an older converter is due again", () => {
    expect(needsVendorImport({ provider: "posthog", imported_at: 1 })).toBe(true);
    expect(needsVendorImport({ provider: "sentry", imported_at: 1, converter_version: VENDOR_CONVERTER_VERSION - 1 })).toBe(true);
  });
  test("a current copy is not", () => {
    expect(needsVendorImport({ provider: "posthog", imported_at: 1, converter_version: VENDOR_CONVERTER_VERSION })).toBe(false);
  });
  test("our own recordings are never imported", () => {
    expect(needsVendorImport({ provider: "sdk", imported_at: null })).toBe(false);
  });
});
