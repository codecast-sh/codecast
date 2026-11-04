import { describe, expect, test } from "bun:test";
import { foldRepeatNavs, replayShape } from "./index";
import type { ReplayEvent } from "../contracts/replay";

describe("page visits", () => {
  // PostHog takes a full snapshot of an idle tab every couple of seconds; each writes a navigation to the same address.
  const snapshots: ReplayEvent[] = Array.from({ length: 14 }, (_, i) => ({ type: "nav", t: i * 1900, url: "https://x.test/book/54333ea0" }));

  test("repeat snapshots of one page fold into its visit", () => {
    expect(foldRepeatNavs(snapshots)).toHaveLength(1);
    expect(replayShape(snapshots).pages).toBe(1);
  });

  test("a change of address is a visit, and coming back is another", () => {
    const events: ReplayEvent[] = [
      { type: "nav", t: 0, url: "https://x.test/a" },
      { type: "click", t: 100, label: "Next", selector: "button" },
      { type: "nav", t: 200, url: "https://x.test/a" },
      { type: "nav", t: 300, url: "https://x.test/b" },
      { type: "nav", t: 400, url: "https://x.test/a" },
    ];
    expect(foldRepeatNavs(events).map((e) => e.t)).toEqual([0, 100, 300, 400]);
    expect(replayShape(events).pages).toBe(3);
  });

  test("a stream with nothing to fold comes back as it was", () => {
    const events: ReplayEvent[] = [{ type: "nav", t: 0, url: "https://x.test/a" }];
    expect(foldRepeatNavs(events)).toBe(events);
  });
});
