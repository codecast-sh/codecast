import { describe, test, expect } from "bun:test";
import { hashPath, projectHash, sessionHash } from "./hash.js";

describe("hashPath", () => {
  test("returns consistent hash for same path", () => {
    const path = "/Users/john/secret-project";
    const hash1 = hashPath(path);
    const hash2 = hashPath(path);
    expect(hash1).toBe(hash2);
  });

  test("returns different hash for different paths", () => {
    const hash1 = hashPath("/Users/john/project1");
    const hash2 = hashPath("/Users/john/project2");
    expect(hash1).not.toBe(hash2);
  });

  test("returns 64 char hex string (sha256)", () => {
    const hash = hashPath("/some/path");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("normalizes paths before hashing", () => {
    const hash1 = hashPath("/Users/john/./project");
    const hash2 = hashPath("/Users/john/project");
    expect(hash1).toBe(hash2);
  });

  test("does not leak original path in hash", () => {
    const sensitiveDir = "/Users/john/super-secret-work";
    const hash = hashPath(sensitiveDir);
    expect(hash).not.toContain("john");
    expect(hash).not.toContain("secret");
    expect(hash).not.toContain("super");
    expect(hash).not.toContain("work");
    expect(hash).not.toContain("Users");
  });
});

describe("projectHash", () => {
  test("returns 12 char truncated hash", () => {
    const hash = projectHash("/some/path");
    expect(hash).toHaveLength(12);
    expect(hash).toMatch(/^[a-f0-9]{12}$/);
  });

  test("returns consistent hash for same path", () => {
    const path = "/Users/john/secret-project";
    const hash1 = projectHash(path);
    const hash2 = projectHash(path);
    expect(hash1).toBe(hash2);
  });
});

describe("sessionHash", () => {
  test("returns consistent hash for same session ID", () => {
    const sessionId = "abc123-def456";
    const hash1 = sessionHash(sessionId);
    const hash2 = sessionHash(sessionId);
    expect(hash1).toBe(hash2);
  });

  test("returns 64 char hex string", () => {
    const hash = sessionHash("some-session");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
