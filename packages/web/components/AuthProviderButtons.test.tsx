import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import path from "path";

const src = readFileSync(
  path.join(import.meta.dir, "AuthProviderButtons.tsx"),
  "utf8",
);

describe("AuthProviderButtons", () => {
  test("OAuth buttons are type=button so Chrome password-manager forms cannot submit them to /", () => {
    expect(src).toContain('type="button"');
    expect(src).toContain("markOAuthStarted");
  });
});
