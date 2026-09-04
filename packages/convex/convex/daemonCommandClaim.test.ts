import { describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import {
  CLAIM_GRACE_MS,
  canReleaseCommandClaim,
  commandVisibleToClaimer,
  decideCommandClaim,
  type ClaimableCommand,
} from "./lib/daemonCommandClaim.js";

const NOW = 1_700_000_000_000;

const MAC = "device-mac";
const LINUX = "device-linux";

const on = (bootId: string, deviceId?: string) => ({ bootId, deviceId });

describe("decideCommandClaim", () => {
  test("two daemons race, one wins", () => {
    const row: ClaimableCommand = {};
    expect(decideCommandClaim(row, on("bootA", MAC), NOW)).toBe("grant");

    const held: ClaimableCommand = { claimed_by: "bootA", claimed_at: NOW, claimed_device: MAC };
    expect(decideCommandClaim(held, on("bootB", MAC), NOW + 10)).toBe("held_by_other");
  });

  test("the holder may re-claim its own live hold", () => {
    const held: ClaimableCommand = { claimed_by: "bootA", claimed_at: NOW, claimed_device: MAC };
    expect(decideCommandClaim(held, on("bootA", MAC), NOW + 1_000)).toBe("grant");
  });

  test("an executed command is closed to everyone", () => {
    const done: ClaimableCommand = { executed_at: NOW, claimed_by: "bootA", claimed_at: NOW, claimed_device: MAC };
    expect(decideCommandClaim(done, on("bootA", MAC), NOW + 1)).toBe("already_executed");
    expect(decideCommandClaim(done, on("bootB", MAC), NOW + 1)).toBe("already_executed");
  });

  test("a lapsed lease is claimable again", () => {
    const held: ClaimableCommand = { claimed_by: "bootA", claimed_at: NOW, claimed_device: MAC };
    expect(decideCommandClaim(held, on("bootB", MAC), NOW + CLAIM_GRACE_MS - 1)).toBe("held_by_other");
    expect(decideCommandClaim(held, on("bootB", MAC), NOW + CLAIM_GRACE_MS)).toBe("grant");
  });

  test("the grace window sits between the slowest command and the command TTL", () => {
    expect(CLAIM_GRACE_MS).toBeGreaterThan(60_000);
    expect(CLAIM_GRACE_MS).toBeLessThan(5 * 60_000);
  });

  // The lease must never turn a broadcast into a single delivery. kill_session
  // and the admin restart are inserted with no target device precisely so every
  // machine runs them against its own panes.
  test("a hold on another device is not a hold here", () => {
    const held: ClaimableCommand = { claimed_by: "bootA", claimed_at: NOW, claimed_device: MAC };
    expect(decideCommandClaim(held, on("bootB", LINUX), NOW + 10)).toBe("grant");
    expect(commandVisibleToClaimer(held, "bootB", LINUX, NOW + 10)).toBe(true);
  });

  test("an unknown device on either side still contends", () => {
    // A hold written before the device rode along, and a claimer too old to
    // send one. Both keep the pre-device behaviour rather than freeing a live
    // lease, and both age out inside the grace window.
    const deviceless: ClaimableCommand = { claimed_by: "bootA", claimed_at: NOW };
    expect(decideCommandClaim(deviceless, on("bootB", LINUX), NOW + 10)).toBe("held_by_other");

    const held: ClaimableCommand = { claimed_by: "bootA", claimed_at: NOW, claimed_device: MAC };
    expect(decideCommandClaim(held, on("bootB", undefined), NOW + 10)).toBe("held_by_other");
  });
});

describe("commandVisibleToClaimer", () => {
  test("a daemon too old to claim sees everything", () => {
    const held: ClaimableCommand = { claimed_by: "bootA", claimed_at: NOW, claimed_device: MAC };
    expect(commandVisibleToClaimer(held, undefined, undefined, NOW + 1)).toBe(true);
  });

  test("a held command is hidden from the other daemon on its device", () => {
    const held: ClaimableCommand = { claimed_by: "bootA", claimed_at: NOW, claimed_device: MAC };
    expect(commandVisibleToClaimer(held, "bootB", MAC, NOW + 1)).toBe(false);
    expect(commandVisibleToClaimer(held, "bootA", MAC, NOW + 1)).toBe(true);
  });

  test("a lapsed hold reappears", () => {
    const held: ClaimableCommand = { claimed_by: "bootA", claimed_at: NOW, claimed_device: MAC };
    expect(commandVisibleToClaimer(held, "bootB", MAC, NOW + CLAIM_GRACE_MS)).toBe(true);
  });

  test("an unclaimed command is visible", () => {
    expect(commandVisibleToClaimer({}, "bootB", MAC, NOW)).toBe(true);
  });
});

describe("canReleaseCommandClaim", () => {
  test("only the holder releases", () => {
    const held: ClaimableCommand = { claimed_by: "bootA", claimed_at: NOW, claimed_device: MAC };
    expect(canReleaseCommandClaim(held, on("bootA", MAC))).toBe(true);
    expect(canReleaseCommandClaim(held, on("bootB", MAC))).toBe(false);
  });

  test("an executed or unclaimed command has nothing to release", () => {
    expect(canReleaseCommandClaim({}, on("bootA", MAC))).toBe(false);
    expect(
      canReleaseCommandClaim({ executed_at: NOW, claimed_by: "bootA", claimed_device: MAC }, on("bootA", MAC)),
    ).toBe(false);
  });
});

// The route the daemon actually calls. A hand rolled httpAction here skipped
// the device binding check that cliRoute applies once for every CLI endpoint,
// so a token bound to one machine could claim a command while presenting
// another machine's device_id.
describe("the claim endpoint is a normal CLI route", () => {
  const http = fs.readFileSync(path.join(import.meta.dir, "http.ts"), "utf-8");

  test("it is registered through cliRoute, and forwards the device", () => {
    const at = http.indexOf('cliRoute("/cli/command-claim"');
    expect(at).toBeGreaterThan(-1);
    const block = http.slice(at, at + 600);
    expect(block).toContain("api.users.claimDaemonCommand");
    // The mutation takes the device as a real argument, so the edge must not
    // consume the field after the binding check.
    expect(block).toContain("{ forwardDeviceId: true }");
  });

  test("no hand rolled httpAction answers that path", () => {
    expect(http).not.toContain('path: "/cli/command-claim"');
  });
});
