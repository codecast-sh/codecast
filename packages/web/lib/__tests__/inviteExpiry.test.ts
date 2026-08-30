import { describe, expect, test } from "bun:test";
import { formatInviteExpiry } from "../team/inviteExpiry";

const HOUR = 1000 * 60 * 60;
const DAY = 24 * HOUR;

describe("formatInviteExpiry", () => {
  test("a fresh 7 day link reads 7 days, not 6", () => {
    // Regression: floor turned 7 days minus a few seconds into "6 days",
    // contradicting the regenerate note that promises 7.
    expect(formatInviteExpiry(Date.now() + 7 * DAY - 5000)).toBe("Expires in 7 days");
  });

  test("rounds to the nearest day past one day", () => {
    expect(formatInviteExpiry(Date.now() + 1.4 * DAY)).toBe("Expires in 1 day");
    expect(formatInviteExpiry(Date.now() + 2.6 * DAY)).toBe("Expires in 3 days");
  });

  test("under a day it speaks in hours", () => {
    expect(formatInviteExpiry(Date.now() + 23.7 * HOUR)).toBe("Expires in 24 hours");
    expect(formatInviteExpiry(Date.now() + 1.2 * HOUR)).toBe("Expires in 1 hour");
  });

  test("under an hour, expired, and unset", () => {
    expect(formatInviteExpiry(Date.now() + 20 * 60 * 1000)).toBe("Expires soon");
    expect(formatInviteExpiry(Date.now() - 1000)).toBe("Expired");
    expect(formatInviteExpiry(undefined)).toBe("No expiry set");
  });
});
