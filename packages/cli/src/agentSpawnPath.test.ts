import { describe, test, expect, afterEach } from "bun:test";
import { agentSpawnPath } from "./agentSpawnPath.js";

const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_HOME = process.env.HOME;

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  process.env.HOME = ORIGINAL_HOME;
});

describe("agentSpawnPath", () => {
  // The regression: launchd hands the daemon this exact PATH, and codex lives in
  // ~/.local/bin. Omitting that entry made a machine WITH codex installed report
  // "Codex is not installed" on every launchd-started daemon.
  test("includes ~/.local/bin under a bare launchd PATH", () => {
    process.env.HOME = "/Users/someone";
    process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
    expect(agentSpawnPath().split(":")).toContain("/Users/someone/.local/bin");
  });

  test("user bins outrank the inherited PATH, so a stale system copy can't win", () => {
    process.env.HOME = "/Users/someone";
    process.env.PATH = "/usr/bin";
    const parts = agentSpawnPath().split(":");
    expect(parts.indexOf("/Users/someone/.local/bin")).toBeLessThan(parts.indexOf("/usr/bin"));
  });

  test("extra prefixes lead (opencode's private bin)", () => {
    process.env.HOME = "/Users/someone";
    expect(agentSpawnPath("/Users/someone/.opencode/bin").split(":")[0]).toBe("/Users/someone/.opencode/bin");
  });

  test("no HOME leaves the system entries intact rather than emitting empties", () => {
    delete process.env.HOME;
    process.env.PATH = "/usr/bin";
    expect(agentSpawnPath().split(":").every((p) => p.length > 0)).toBe(true);
  });

  test("omits an unavailable optional prefix", () => {
    delete process.env.HOME;
    process.env.PATH = "/usr/bin";
    expect(agentSpawnPath(process.env.HOME && `${process.env.HOME}/.opencode/bin`)).not.toContain("undefined/.opencode/bin");
  });
});
