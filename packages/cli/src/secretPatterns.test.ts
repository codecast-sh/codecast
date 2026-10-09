import { describe, expect, test } from "bun:test";
import { isCredentialFilePath, liveVendorToken } from "./secretPatterns.js";

describe("liveVendorToken", () => {
  test("a random-looking token is live; hand-written test tokens are not", () => {
    expect(liveVendorToken('key = "sk-ant-api03-Qm7xR2pLk9VwN4tZb8YcHj3sDf6Ga1Ue5Ko0"')).toContain("sk-ant-api03-Qm7x");
    expect(liveVendorToken('"sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"')).toBeNull();
    expect(liveVendorToken("SECRET=sk-ant-REDACTEDREDACTEDREDACTEDREDACTED")).toBeNull();
    expect(liveVendorToken("ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")).toBeNull();
    expect(liveVendorToken("AKIAIOSFODNN7EXAMPLE")).toBeNull();
    expect(liveVendorToken("nothing here")).toBeNull();
  });
  test("credential files are named as such", () => {
    expect(isCredentialFilePath("packages/playground/.env.production")).toBe(true);
    expect(isCredentialFilePath("certs/server.pem")).toBe(true);
    expect(isCredentialFilePath("src/env.ts")).toBe(false);
  });
});
