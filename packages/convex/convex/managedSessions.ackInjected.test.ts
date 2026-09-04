import { describe, expect, test } from "bun:test";
import { activeStatusAcksInjected } from "./managedSessions";

// The injected→delivered ack must rest on an OBSERVED processing state. The
// daemon's own post-injection "thinking" is a presumption: taking it as proof
// terminalized a row whose paste never submitted, and the healer that re-pends
// stale "injected" rows had nothing to revive (2026-09-03).
describe("activeStatusAcksInjected", () => {
  test("observed processing states ack injected messages", () => {
    for (const s of ["working", "thinking", "compacting", "permission_blocked"]) {
      expect(activeStatusAcksInjected(s, undefined)).toBe(true);
      expect(activeStatusAcksInjected(s, false)).toBe(true);
    }
  });

  test("a presumed status never acks, whatever it says", () => {
    for (const s of ["working", "thinking", "compacting", "permission_blocked"]) {
      expect(activeStatusAcksInjected(s, true)).toBe(false);
    }
  });

  test("settled states ack nothing", () => {
    for (const s of ["idle", "waiting", "stopped", "connected"]) {
      expect(activeStatusAcksInjected(s, undefined)).toBe(false);
    }
  });
});
