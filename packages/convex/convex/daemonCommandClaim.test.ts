import { describe, expect, test } from "bun:test";
import {
  CLAIM_GRACE_MS,
  commandVisibleToClaimer,
  decideCommandClaim,
  type ClaimableCommand,
} from "./lib/daemonCommandClaim.js";

const NOW = 1_700_000_000_000;

describe("decideCommandClaim", () => {
  test("two daemons race, one wins", () => {
    const row: ClaimableCommand = {};
    expect(decideCommandClaim(row, "bootA", NOW)).toBe("grant");
    // The winning mutation patched the row before the loser's read.
    const held: ClaimableCommand = { claimed_by: "bootA", claimed_at: NOW };
    expect(decideCommandClaim(held, "bootB", NOW + 10)).toBe("held_by_other");
  });

  test("the holder may re-claim its own live hold", () => {
    const held: ClaimableCommand = { claimed_by: "bootA", claimed_at: NOW };
    expect(decideCommandClaim(held, "bootA", NOW + 1_000)).toBe("grant");
  });

  test("an executed command is claimed by nobody", () => {
    const done: ClaimableCommand = { executed_at: NOW, claimed_by: "bootA", claimed_at: NOW };
    expect(decideCommandClaim(done, "bootA", NOW + 1)).toBe("already_executed");
    expect(decideCommandClaim(done, "bootB", NOW + 1)).toBe("already_executed");
  });

  test("a hold past the grace goes to the next claimer", () => {
    const held: ClaimableCommand = { claimed_by: "bootA", claimed_at: NOW };
    expect(decideCommandClaim(held, "bootB", NOW + CLAIM_GRACE_MS - 1)).toBe("held_by_other");
    expect(decideCommandClaim(held, "bootB", NOW + CLAIM_GRACE_MS)).toBe("grant");
  });

  test("the grace outlives the slowest command and dies inside the 5 minute TTL", () => {
    expect(CLAIM_GRACE_MS).toBeGreaterThan(60_000);
    expect(CLAIM_GRACE_MS).toBeLessThan(5 * 60_000);
  });
});

describe("commandVisibleToClaimer", () => {
  test("a daemon too old to claim still sees everything", () => {
    const held: ClaimableCommand = { claimed_by: "bootA", claimed_at: NOW };
    expect(commandVisibleToClaimer(held, undefined, NOW + 1)).toBe(true);
  });

  test("a fresh hold hides the command from everyone but its holder", () => {
    const held: ClaimableCommand = { claimed_by: "bootA", claimed_at: NOW };
    expect(commandVisibleToClaimer(held, "bootB", NOW + 1)).toBe(false);
    expect(commandVisibleToClaimer(held, "bootA", NOW + 1)).toBe(true);
  });

  test("a lapsed hold is visible again", () => {
    const held: ClaimableCommand = { claimed_by: "bootA", claimed_at: NOW };
    expect(commandVisibleToClaimer(held, "bootB", NOW + CLAIM_GRACE_MS)).toBe(true);
  });

  test("an unclaimed command is visible to anyone", () => {
    expect(commandVisibleToClaimer({}, "bootB", NOW)).toBe(true);
  });
});
