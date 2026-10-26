import { describe, expect, test } from "bun:test";
import { formatDeliveryFailedNotice, parseDeliveryFailedNotice } from "./deliveryFailed";

describe("the delivery failed notice", () => {
  test("reads back the whole message and whether it was submitted", () => {
    const message = '<scheduled-task title="Sweep" trigger="tr-3237">Check plans.\n\n</delivery-failed> is just text here</scheduled-task>';
    for (const submitted of [false, true]) {
      const content = formatDeliveryFailedNotice({ writes: 3, submitted, message });
      expect(parseDeliveryFailedNotice(content)).toEqual({ writes: 3, submitted, message, complete: true });
    }
  });

  test("says plainly when the agent never had it", () => {
    expect(formatDeliveryFailedNotice({ writes: 3, submitted: false, message: "go" })).toStartWith("This message never reached the agent");
    expect(formatDeliveryFailedNotice({ writes: 3, submitted: true, message: "go" })).toContain("may have run it");
  });

  test("reads the prose rows written before the format", () => {
    // jx7d8av msg 17823, 2026-10-26.
    const legacy = 'A message to this session was written into its terminal 3 times and its transcript never echoed it exactly, so delivery stopped and the message was cancelled. The agent may have taken it each time. Message: <scheduled-task title="Check plans" task-id="rx7d4" trigger="tr-3237">Check plans pl-932…';
    expect(parseDeliveryFailedNotice(legacy)).toEqual({ writes: 3, submitted: null, message: '<scheduled-task title="Check plans" task-id="rx7d4" trigger="tr-3237">Check plans pl-932', complete: false });
    expect(parseDeliveryFailedNotice(legacy.replace("…", ""))?.complete).toBe(true);
    expect(parseDeliveryFailedNotice("Some other system line")).toBeNull();
  });
});
