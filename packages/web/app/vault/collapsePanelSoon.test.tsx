import { afterEach, describe, expect, test } from "bun:test";
import type { RefObject } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { collapsePanelSoon } from "./page";

// react-resizable-panels only derives a late-mounted Panel's constraints one
// commit after the Panel mounts, so collapse() throws "Panel constraints not
// found" when called from an effect in the mounting commit — the prod crash
// on /files when a narrow pane widens. collapsePanelSoon retries across
// frames; these tests pin the retry, the give-up, and the abort conditions.

const realRaf = globalThis.requestAnimationFrame;
afterEach(() => {
  globalThis.requestAnimationFrame = realRaf;
});

/** Stub rAF into a queue the test drains one frame at a time. */
function stubFrames() {
  const queue: FrameRequestCallback[] = [];
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    queue.push(cb);
    return queue.length;
  }) as typeof requestAnimationFrame;
  return { next: () => queue.splice(0, queue.length).forEach((cb) => cb(0)), queue };
}

function handle(collapse: () => void): RefObject<PanelImperativeHandle | null> {
  return { current: { collapse } as unknown as PanelImperativeHandle };
}

describe("collapsePanelSoon", () => {
  test("collapses immediately when constraints are registered", () => {
    const frames = stubFrames();
    let calls = 0;
    collapsePanelSoon(
      handle(() => calls++),
      () => true,
    );
    expect(calls).toBe(1);
    expect(frames.queue.length).toBe(0);
  });

  test("retries on the next frame while the panel is unregistered", () => {
    const frames = stubFrames();
    let calls = 0;
    collapsePanelSoon(
      handle(() => {
        calls++;
        if (calls === 1) throw new Error("Panel constraints not found for Panel vault-tree");
      }),
      () => true,
    );
    expect(calls).toBe(1);
    frames.next();
    expect(calls).toBe(2); // second attempt succeeded
    expect(frames.queue.length).toBe(0);
  });

  test("gives up after the frame budget instead of retrying forever", () => {
    const frames = stubFrames();
    let calls = 0;
    collapsePanelSoon(
      handle(() => {
        calls++;
        throw new Error("Panel constraints not found for Panel vault-tree");
      }),
      () => true,
    );
    for (let i = 0; i < 20 && frames.queue.length > 0; i++) frames.next();
    expect(calls).toBe(6); // initial attempt + 5 frame retries
  });

  test("aborts a pending retry once the desired state changes", () => {
    const frames = stubFrames();
    let calls = 0;
    let wanted = true;
    collapsePanelSoon(
      handle(() => {
        calls++;
        throw new Error("Panel constraints not found for Panel vault-tree");
      }),
      () => wanted,
    );
    wanted = false; // user reopened the panel before the retry fired
    frames.next();
    expect(calls).toBe(1);
  });

  test("does nothing when the panel is already gone", () => {
    stubFrames();
    // Never throws — a null ref is simply skipped.
    collapsePanelSoon({ current: null }, () => true);
  });
});
