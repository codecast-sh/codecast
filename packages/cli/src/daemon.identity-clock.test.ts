import { describe, expect, it } from "bun:test";
import { describeProcessIdentity } from "./daemon.js";
import { registrationPredatesProcess } from "./sessionProcessMatcher.js";

// The identity verdict dates a process by `ps -o etime=` minus the clock. That
// clock must be the one ps answered against: the hook-claims scan that follows
// walks thousands of registry files and, on a loaded machine, takes long enough
// that a clock read after it dates a live agent AFTER its own hook's claim.
// registrationPredatesProcess then calls it a reused pid, its registry file is
// deleted, and a transcript watcher that can no longer find its pane mints a
// duplicate conversation (2026-09-15, grok session 01a0a5ef).
describe("describeProcessIdentity", () => {
  it("fixes the start time when ps answers, not when the claims scan finishes", async () => {
    const startSec = 1_789_490_314;
    let nowMs = (startSec + 1000) * 1000;
    const identity = await describeProcessIdentity(44401, {
      exec: async () => ({ stdout: "   16:40 grok --permission-mode bypassPermissions\n" }),
      claims: async () => {
        nowMs += 20_000; // the scan takes 20s
        return [{ sessionId: "01a0a5ef-542d-7bc2-8cd1-04c47bd459db", ts: startSec + 6 }];
      },
      now: () => nowMs,
    });
    expect(identity.processStartSec).toBe(startSec);
    expect(identity.claims).toHaveLength(1);
    expect(registrationPredatesProcess(startSec + 6, identity.processStartSec)).toBe(false);
  });

  it("reports no start time when ps fails, so no registration can be convicted", async () => {
    const identity = await describeProcessIdentity(1, {
      exec: async () => { throw new Error("timeout"); },
      claims: async () => [],
      now: () => 1_000_000,
    });
    expect(identity.processStartSec).toBeNull();
    expect(registrationPredatesProcess(5, identity.processStartSec)).toBe(false);
  });
});
