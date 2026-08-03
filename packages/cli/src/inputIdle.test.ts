import { describe, expect, test } from "bun:test";
import { parseHidIdleMs } from "./inputIdle";

describe("parseHidIdleMs", () => {
  test("converts HIDIdleTime nanoseconds to ms", () => {
    const out = `  |   "HIDIdleTime" = 10946469583\n`;
    expect(parseHidIdleMs(out)).toBe(10946);
  });

  test("reads the first entry out of full ioreg output", () => {
    const out = [
      `+-o IOHIDSystem  <class IOHIDSystem, id 0x100000abc>`,
      `    | {`,
      `    |   "HIDIdleTime" = 308007958`,
      `    |   "HIDPointerAcceleration" = 45056`,
      `    | }`,
    ].join("\n");
    expect(parseHidIdleMs(out)).toBe(308);
  });

  test("zero idle (actively typing) is 0, not null", () => {
    expect(parseHidIdleMs(`"HIDIdleTime" = 0`)).toBe(0);
  });

  test("missing key yields null", () => {
    expect(parseHidIdleMs(`"HIDPointerAcceleration" = 45056`)).toBeNull();
  });

  test("empty output yields null", () => {
    expect(parseHidIdleMs("")).toBeNull();
  });
});
