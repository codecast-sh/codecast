import { describe, expect, test } from "bun:test";
import { formatReplayTime } from "./events";

describe("formatReplayTime", () => {
  test("rounds before splitting, so a second never reads 60", () => {
    expect(formatReplayTime(59_950)).toBe("1:00.0");
    expect(formatReplayTime(299_970)).toBe("5:00.0");
    expect(formatReplayTime(3_599_960)).toBe("1:00:00");
  });
  test("reads m:ss.s under an hour and h:mm:ss past it", () => {
    expect(formatReplayTime(0)).toBe("0:00.0");
    expect(formatReplayTime(35_074)).toBe("0:35.1");
    expect(formatReplayTime(868_500)).toBe("14:28.5");
    expect(formatReplayTime(10_030_000)).toBe("2:47:10");
    expect(formatReplayTime(-5)).toBe("0:00.0");
  });
});
