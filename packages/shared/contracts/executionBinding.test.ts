import { describe, expect, it } from "bun:test";
import {
  deliveryMatchesPermit,
  parseStartedDeliveryPermit,
  readyBindingMatchesPermit,
  type Delivery,
  type ReadyBinding,
} from "./executionBinding";

const wirePermit = {
  state: "delivery-started",
  messageId: "message-1",
  deliveryId: "delivery-1",
  conversationSequence: "42",
  attemptId: "attempt-1",
  conversationId: "conversation-1",
  executionEpoch: 3,
  configurationRevision: 7,
  ownerDeviceId: "device-1",
  daemonBootId: "boot-1",
  runtimeId: "runtime-1",
} as const;

describe("parseStartedDeliveryPermit", () => {
  it("brands a complete delivery-started server response", () => {
    expect(parseStartedDeliveryPermit(wirePermit)).toEqual(wirePermit);
  });

  it("rejects a merely claimed permit and malformed fence fields", () => {
    expect(() => parseStartedDeliveryPermit({ ...wirePermit, state: "claimed" })).toThrow();
    expect(() => parseStartedDeliveryPermit({ ...wirePermit, runtimeId: "" })).toThrow();
    expect(() => parseStartedDeliveryPermit({ ...wirePermit, executionEpoch: -1 })).toThrow();
    expect(() => parseStartedDeliveryPermit({ ...wirePermit, executionEpoch: 0 })).toThrow();
    expect(() => parseStartedDeliveryPermit({ ...wirePermit, configurationRevision: 0 })).toThrow();
  });
});

describe("delivery fence matching", () => {
  const binding: ReadyBinding = {
    conversationId: "conversation-1",
    epoch: 3,
    requestedAgent: "codex",
    actualAgent: "codex",
    transport: "app-server",
    handle: "thread-1",
    ownerDeviceId: "device-1",
    daemonBootId: "boot-1",
    runtimeId: "runtime-1",
    operationId: "operation-1",
    appliedConfigurationRevision: 7,
    protocolVersion: 1,
    capabilities: ["delivery-permit-v1"],
  };
  const delivery: Delivery = {
    messageId: "message-1",
    deliveryId: "delivery-1",
    conversationSequence: "42",
    input: [{ type: "text", text: "hello" }],
  };

  it("requires exact binding and logical-delivery identity", () => {
    const permit = parseStartedDeliveryPermit(wirePermit);
    expect(readyBindingMatchesPermit(binding, permit)).toBe(true);
    expect(deliveryMatchesPermit(delivery, permit)).toBe(true);
    expect(readyBindingMatchesPermit({ ...binding, actualAgent: "claude" }, permit)).toBe(false);
    expect(readyBindingMatchesPermit({ ...binding, runtimeId: "runtime-2" }, permit)).toBe(false);
    expect(readyBindingMatchesPermit({ ...binding, daemonBootId: "boot-2" }, permit)).toBe(false);
    expect(deliveryMatchesPermit({ ...delivery, deliveryId: "delivery-2" }, permit)).toBe(false);
  });
});
