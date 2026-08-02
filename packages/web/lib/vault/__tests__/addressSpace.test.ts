import { test, expect, describe } from "bun:test";
import { pickAddressSpaceInit } from "../client";

// Declaring the destination address space is what lets a hosted https page
// reach the daemon on 127.0.0.1. The catch is that the accepted VALUE changed:
// Chrome 142+ says "loopback", older Chromium says "local", and a runtime that
// knows the member rejects any value it doesn't recognize — throwing before the
// request is sent. The desktop app runs Chromium 130, which is how one wrong
// string took the whole vault down there while the terminal kept working.
describe("pickAddressSpaceInit", () => {
  test("uses loopback on a runtime that accepts it (Chrome 142+)", () => {
    expect(pickAddressSpaceInit(() => undefined)).toEqual({ targetAddressSpace: "loopback" });
  });

  test("falls back to local when loopback is rejected (Electron 33 / Chromium 130)", () => {
    const chromium130 = (init: RequestInit) => {
      const value = (init as { targetAddressSpace?: string }).targetAddressSpace;
      if (value !== "local") throw new TypeError(`invalid enum value ${value}`);
      return undefined;
    };
    expect(pickAddressSpaceInit(chromium130)).toEqual({ targetAddressSpace: "local" });
  });

  test("sends nothing when the runtime rejects every value", () => {
    const rejectsAll = () => {
      throw new TypeError("unsupported");
    };
    expect(pickAddressSpaceInit(rejectsAll)).toEqual({});
  });
});
