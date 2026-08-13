/**
 * Input dispatch rules.
 *
 * Keyboard synthesis is where automation quietly goes wrong: a shortcut that
 * also types its own letter, a click that lands on an overlay, a "clear" that
 * frameworks never notice. Each test below pins one of those.
 */

import { describe, expect, test } from "bun:test";
import { ElementGone, click, locate, pressKey, type } from "./actions.js";
import type { PageSession } from "./instance.js";

interface Call {
  method: string;
  params: any;
}

/** A page that records what was dispatched and answers geometry queries. */
function recorder(opts: { quads?: number[][]; hit?: string | null; missing?: boolean } = {}) {
  const calls: Call[] = [];
  const page = {
    sessionId: "s1",
    targetId: "t1",
    conn: {
      send: async (method: string, params: any = {}) => {
        calls.push({ method, params });
        if (opts.missing && (method === "DOM.scrollIntoViewIfNeeded" || method === "DOM.getContentQuads")) {
          throw new Error("Node with given id does not belong to the document");
        }
        if (method === "DOM.getContentQuads") return { quads: opts.quads ?? [[10, 20, 30, 20, 30, 40, 10, 40]] };
        if (method === "DOM.resolveNode") return { object: { objectId: "obj-1" } };
        if (method === "Runtime.callFunctionOn") return { result: { value: opts.hit ?? null } };
        return {};
      },
    },
  } as unknown as PageSession;
  return { page, calls, of: (m: string) => calls.filter((c) => c.method === m) };
}

describe("locate", () => {
  test("returns the centre of the element's content box", async () => {
    const { page } = recorder({ quads: [[10, 20, 30, 20, 30, 40, 10, 40]] });
    expect(await locate(page, 5)).toEqual({ x: 20, y: 30 });
  });

  test("scrolls the element into view before measuring it", async () => {
    // Measuring first would give coordinates outside the viewport, and a click
    // dispatched there lands on whatever happens to be at that point instead.
    const { page, calls } = recorder();
    await locate(page, 5);
    const order = calls.map((c) => c.method);
    expect(order.indexOf("DOM.scrollIntoViewIfNeeded")).toBeLessThan(order.indexOf("DOM.getContentQuads"));
  });

  test("reports a vanished element as gone rather than as a protocol error", async () => {
    const { page } = recorder({ missing: true });
    expect(locate(page, 5)).rejects.toThrow(ElementGone);
  });

  test("explains an element that exists but has no box", async () => {
    const { page } = recorder({ quads: [] });
    expect(locate(page, 5)).rejects.toThrow(/hidden/);
  });
});

describe("click", () => {
  test("moves the pointer before pressing", async () => {
    // Hover-only menus never open for a press that arrives with no travel.
    const { page, of } = recorder();
    await click(page, 5);
    expect(of("Input.dispatchMouseEvent").map((c) => c.params.type)).toEqual([
      "mouseMoved", "mousePressed", "mouseReleased",
    ]);
  });

  test("refuses when another element covers the target", async () => {
    const { page } = recorder({ hit: "<div#cookie-banner>" });
    expect(click(page, 5)).rejects.toThrow(/covered by <div#cookie-banner>/);
  });

  test("--force dispatches anyway", async () => {
    const { page, of } = recorder({ hit: "<div#cookie-banner>" });
    await click(page, 5, { force: true });
    expect(of("Input.dispatchMouseEvent")).toHaveLength(3);
  });

  test("skips the hit test entirely when forced", async () => {
    const { page, of } = recorder({ hit: "<div#overlay>" });
    await click(page, 5, { force: true });
    expect(of("Runtime.callFunctionOn")).toHaveLength(0);
  });
});

describe("pressKey", () => {
  const keyEvents = (calls: Call[]) => calls.filter((c) => c.method === "Input.dispatchKeyEvent").map((c) => c.params);

  test("sends a down and an up", async () => {
    const { page, calls } = recorder();
    await pressKey(page, "Enter");
    expect(keyEvents(calls).map((e) => e.type)).toEqual(["keyDown", "keyUp"]);
  });

  test("gives Enter its carriage return so forms submit", async () => {
    const { page, calls } = recorder();
    await pressKey(page, "Enter");
    expect(keyEvents(calls)[0].text).toBe("\r");
    expect(keyEvents(calls)[0].windowsVirtualKeyCode).toBe(13);
  });

  test("does not attach text to a modified key", async () => {
    // With text, cmd+a selects all AND types a literal "a" into the field.
    const { page, calls } = recorder();
    await pressKey(page, "cmd+a");
    const down = keyEvents(calls)[0];
    expect(down.text).toBeUndefined();
    expect(down.type).toBe("rawKeyDown");
    expect(down.modifiers).toBe(4);
  });

  test("keeps text for shift, which is how capitals are typed", async () => {
    const { page, calls } = recorder();
    await pressKey(page, "shift+a");
    expect(keyEvents(calls)[0].text).toBe("a");
    expect(keyEvents(calls)[0].modifiers).toBe(8);
  });

  test("combines modifiers", async () => {
    const { page, calls } = recorder();
    await pressKey(page, "ctrl+shift+Tab");
    expect(keyEvents(calls)[0].modifiers).toBe(2 | 8);
  });

  test("accepts a bare character, as sites that bind / to search expect", async () => {
    const { page, calls } = recorder();
    await pressKey(page, "/");
    expect(keyEvents(calls)[0].text).toBe("/");
  });

  test("treats key names case-insensitively", async () => {
    const { page, calls } = recorder();
    await pressKey(page, "escape");
    expect(keyEvents(calls)[0].windowsVirtualKeyCode).toBe(27);
  });
});

describe("type", () => {
  test("inserts the whole string in one call by default", async () => {
    // Per-character synthesis mangles emoji and composed characters.
    const { page, of } = recorder();
    await type(page, 5, "hello");
    expect(of("Input.insertText")).toHaveLength(1);
    expect(of("Input.insertText")[0].params.text).toBe("hello");
  });

  test("--per-key sends one event pair per character", async () => {
    const { page, of } = recorder();
    await type(page, 5, "abc", { perKey: true });
    expect(of("Input.dispatchKeyEvent")).toHaveLength(6);
    expect(of("Input.insertText")).toHaveLength(0);
  });

  test("clears through select-all and delete, not by assigning value", async () => {
    // Writing .value directly leaves React's state untouched, so the old value
    // reappears on the next render and the typing looks like it never happened.
    const { page, of } = recorder();
    await type(page, 5, "new", { clear: true });
    const keys = of("Input.dispatchKeyEvent").map((c) => c.params);
    expect(keys.some((k) => k.commands?.includes("selectAll"))).toBe(true);
    expect(keys.some((k) => k.windowsVirtualKeyCode === 46)).toBe(true);
  });

  test("focuses the field first", async () => {
    const { page, calls } = recorder();
    await type(page, 5, "x");
    expect(calls[0].method).toBe("DOM.focus");
  });

  test("--submit presses Enter after the text", async () => {
    const { page, calls } = recorder();
    await type(page, 5, "query", { submit: true });
    const order = calls.map((c) => c.method);
    expect(order.indexOf("Input.insertText")).toBeLessThan(order.lastIndexOf("Input.dispatchKeyEvent"));
    expect(calls.at(-1)!.params.windowsVirtualKeyCode).toBe(13);
  });
});
