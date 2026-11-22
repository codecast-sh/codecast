import { describe, expect, test } from "bun:test";
import { landOnLiveEnd, type LiveEndDeps } from "./landOnLiveEnd";

function run(over: Partial<LiveEndDeps>) {
  const calls: string[] = [];
  const deps: LiveEndDeps = {
    hasMoreBelow: false,
    jumpingToEnd: false,
    jumpToLiveEnd: () => calls.push("jumpToLiveEnd"),
    scrollToLoadedEnd: () => calls.push("scrollToLoadedEnd"),
    resumeFollow: () => calls.push("resumeFollow"),
    ...over,
  };
  return { landed: landOnLiveEnd(deps), calls };
}

describe("landOnLiveEnd (ct-97968)", () => {
  test("paged window (newer pages unloaded): jumps to the live end, not the loaded end", () => {
    const { landed, calls } = run({ hasMoreBelow: true });
    expect(landed).toBe("live");
    expect(calls).toEqual(["resumeFollow", "jumpToLiveEnd"]);
  });

  test("unpaged transcript: resumes following and scrolls to the loaded end, never leaving the window", () => {
    const { landed, calls } = run({ hasMoreBelow: false });
    expect(landed).toBe("loaded");
    expect(calls).toEqual(["resumeFollow", "scrollToLoadedEnd"]);
  });

  test("a second send while the jump is still loading does not start another jump", () => {
    const { landed, calls } = run({ hasMoreBelow: true, jumpingToEnd: true });
    expect(landed).toBe("live");
    expect(calls).toEqual(["resumeFollow"]);
  });

  test("a view with no paged window to leave scrolls to the loaded end", () => {
    const { landed, calls } = run({ hasMoreBelow: true, jumpToLiveEnd: undefined });
    expect(landed).toBe("loaded");
    expect(calls).toEqual(["resumeFollow", "scrollToLoadedEnd"]);
  });
});
