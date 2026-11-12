/**
 * Input dispatch rules.
 *
 * Keyboard synthesis is where automation quietly goes wrong: a shortcut that
 * also types its own letter, a click that lands on an overlay, a "clear" that
 * frameworks never notice. Each test below pins one of those.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ClickMissed, ClickNotDelivered, DELIVERY_PROBE, ElementGone, click, hover, locate, pressKey, screenshot, scroll, type, uploadFiles } from "./actions.js";
import type { PageSession } from "./instance.js";

interface Call {
  method: string;
  params: any;
}

/** A page that records what was dispatched and answers geometry queries. */
function recorder(opts: {
  quads?: number[][]; hit?: string | null; missing?: boolean; detached?: boolean; scale?: number;
  /** The tab is in the background, not drawn. */
  hidden?: boolean;
  /** What the delivery probe saw, one per press; an Error means the context went (navigation). */
  delivered?: Array<{ hit: boolean; name: string } | null | Error>;
  /** The press point is over a frame, so its events land in another document. */
  frame?: boolean;
} = {}) {
  const calls: Call[] = [];
  let reads = 0;
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
        if (method === "DOM.resolveNode") {
          if (opts.detached) throw new Error("Node with given id does not belong to the document");
          return { object: { objectId: "obj-1" } };
        }
        if (method === "Runtime.callFunctionOn" && String(params.functionDeclaration).includes("rec.off")) return { result: { objectId: "probe" } };
        if (method === "Runtime.callFunctionOn" && String(params.functionDeclaration).includes("this.off()")) {
          const got = opts.delivered && reads < opts.delivered.length ? opts.delivered[reads++] : { hit: true, name: "<a>" };
          if (got instanceof Error) throw got;
          return { result: { value: { got, frame: !!opts.frame } } };
        }
        if (method === "Runtime.callFunctionOn") return { result: { value: opts.hit ?? null } };
        if (method === "Runtime.evaluate" && params.expression === "document.hidden") return { result: { value: !!opts.hidden } };
        // The pointer probe asks where the page saw the cursor. `scale` fakes a
        // page that receives input scaled, as happens under viewport emulation.
        if (method === "Runtime.evaluate" && String(params.expression).includes("__cast")) {
          const last = calls.filter((c) => c.params?.type === "mouseMoved").pop();
          const at = last ? [last.params.x * (opts.scale ?? 1), last.params.y * (opts.scale ?? 1)] : null;
          return { result: { value: JSON.stringify(at) } };
        }
        if (method === "Runtime.evaluate") return { result: { value: JSON.stringify(["complete", 0]) } };
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

  test("a node from before a navigation is gone, not a protocol error, and nothing is clicked", async () => {
    // The old document's node still scrolls and measures; only resolving it fails.
    const { page, of } = recorder({ detached: true });
    await expect(click(page, 5)).rejects.toThrow(/no longer in the page — take a fresh snapshot/);
    expect(of("Input.dispatchMouseEvent")).toHaveLength(0);
  });

  test("explains an element that exists but has no box", async () => {
    const { page } = recorder({ quads: [] });
    expect(locate(page, 5)).rejects.toThrow(/hidden/);
  });
});

describe("click", () => {
  test("moves the pointer before pressing", async () => {
    // Hover-only menus never open for a press that arrives with no travel. The
    // first move is the scale probe; the second is the real approach.
    const { page, of } = recorder();
    await click(page, 5);
    expect(of("Input.dispatchMouseEvent").map((c) => c.params.type)).toEqual([
      "mouseMoved", "mouseMoved", "mousePressed", "mouseReleased",
    ]);
  });

  test("aims at the measured point when input is not scaled", async () => {
    const { page, of } = recorder();
    await click(page, 5);
    const press = of("Input.dispatchMouseEvent").find((c) => c.params.type === "mousePressed")!;
    expect([press.params.x, press.params.y]).toEqual([20, 30]);
  });

  test("corrects the aim when the page receives input scaled", async () => {
    // Under viewport emulation Chrome can deliver a click at 2.5x the
    // coordinate it was given. Measured on Hacker News, that sent a click meant
    // for the "new" link into an unrelated story while reporting success.
    const { page, of } = recorder({ scale: 2.5 });
    await click(page, 5);
    const press = of("Input.dispatchMouseEvent").find((c) => c.params.type === "mousePressed")!;
    expect([press.params.x, press.params.y]).toEqual([8, 12]);
  });

  test("refuses when another element covers the target", async () => {
    const { page } = recorder({ hit: "<div#cookie-banner>" });
    expect(click(page, 5)).rejects.toThrow(/covered by <div#cookie-banner>/);
  });

  test("--force dispatches anyway", async () => {
    const { page, of } = recorder({ hit: "<div#cookie-banner>" });
    await click(page, 5, { force: true });
    // probe move + approach move + press + release
    expect(of("Input.dispatchMouseEvent")).toHaveLength(4);
  });

  test("skips the hit test entirely when forced", async () => {
    const { page, of } = recorder({ hit: "<div#overlay>" });
    await click(page, 5, { force: true });
    expect(of("Runtime.callFunctionOn").filter((c) => String(c.params.functionDeclaration).includes("nothing at that point"))).toHaveLength(0);
  });

  test("a background tab is drawn before the press, so Chrome hit-tests the page as it is", async () => {
    // Chrome routes a mouse press through the tab's last drawn frame. A
    // background tab draws none, and the press was dropped while the click
    // reported success (example.com "Learn more", 0 of 3 landed).
    const { page, calls } = recorder({ hidden: true });
    await click(page, 5);
    const order = calls.map((c) => c.params?.type ?? c.method);
    const press = order.indexOf("mousePressed");
    expect(order.lastIndexOf("Page.captureScreenshot", press)).toBeGreaterThan(order.lastIndexOf("mouseMoved", press));
  });

  test("a visible tab is not captured", async () => {
    const { page, of } = recorder();
    await click(page, 5);
    expect(of("Page.captureScreenshot")).toHaveLength(0);
  });

  test("a press a background tab dropped is drawn and pressed once more", async () => {
    const { page, of } = recorder({ hidden: true, delivered: [null, { hit: true, name: "<a>" }] });
    await click(page, 5);
    expect(of("Input.dispatchMouseEvent").filter((c) => c.params.type === "mousePressed")).toHaveLength(2);
  });

  test("a visible tab is never pressed twice, even when the listener saw nothing", async () => {
    // A visible tab draws, so the press was not dropped: a page that stops
    // events at window capture hid it. A second press could act twice.
    const { page, of } = recorder({ delivered: [null, null] });
    await click(page, 5);
    expect(of("Input.dispatchMouseEvent").filter((c) => c.params.type === "mousePressed")).toHaveLength(1);
  });

  test("hover on a dead session fails instead of reporting success", async () => {
    const { page } = recorder();
    const send = page.conn.send.bind(page.conn);
    (page.conn as any).send = async (method: string, params: any = {}, ...rest: unknown[]) => {
      if (method === "Input.dispatchMouseEvent") throw new Error("Session with given id not found");
      return send(method, params, ...(rest as []));
    };
    await expect(hover(page, 5)).rejects.toThrow(/Session with given id not found/);
  });

  test("a click that never arrives fails instead of reporting success", async () => {
    const { page, of } = recorder({ hidden: true, delivered: [null, null] });
    await expect(click(page, 5)).rejects.toThrow(ClickNotDelivered);
    expect(of("Input.dispatchMouseEvent").filter((c) => c.params.type === "mousePressed")).toHaveLength(2);
  });

  test("a click that lands on something else says where it landed", async () => {
    const { page } = recorder({ delivered: [{ hit: false, name: "<div#modal>" }] });
    await expect(click(page, 5)).rejects.toThrow(ClickMissed);
    await expect(click(recorder({ delivered: [{ hit: false, name: "<div#modal>" }] }).page, 5)).rejects.toThrow(/landed on <div#modal>/);
  });

  test("a press over a frame is pressed once and not called dropped", async () => {
    // The press is delivered inside the iframe (a payment field, a captcha),
    // where the outer page's listener never sees it. Pressing again would act
    // twice on a third-party page, and "nothing was clicked" would be false.
    const { page, of } = recorder({ frame: true, delivered: [null] });
    await click(page, 5);
    expect(of("Input.dispatchMouseEvent").filter((c) => c.params.type === "mousePressed")).toHaveLength(1);
  });

  test("the probe asks what is under the press point", async () => {
    const { page, of } = recorder();
    await click(page, 5);
    const arm = of("Runtime.callFunctionOn").find((c) => String(c.params.functionDeclaration).includes("rec.off"))!;
    expect(arm.params.arguments).toEqual([{ value: 20 }, { value: 30 }]);
  });

  test("a click whose navigation took the page away counts as delivered", async () => {
    const { page, of } = recorder({ delivered: [new Error("Cannot find context with specified id")] });
    await click(page, 5);
    expect(of("Input.dispatchMouseEvent").filter((c) => c.params.type === "mousePressed")).toHaveLength(1);
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

  test("plus is a key as well as the separator", async () => {
    const { page, calls } = recorder();
    await pressKey(page, "+");
    expect(keyEvents(calls)[0]).toMatchObject({ key: "+", text: "+", modifiers: 0 });
    await pressKey(page, "cmd++");
    expect(keyEvents(calls)[2]).toMatchObject({ key: "+", modifiers: 4, type: "rawKeyDown" });
    await expect(pressKey(page, "cmd+")).rejects.toThrow(/names no key/);
  });

  test("function keys are themselves, not the letter F", async () => {
    const { page, calls } = recorder();
    await pressKey(page, "F5");
    expect(keyEvents(calls)[0]).toMatchObject({ key: "F5", code: "F5", windowsVirtualKeyCode: 116 });
    expect(keyEvents(calls)[0].text).toBeUndefined();
    await pressKey(page, "shift+f12");
    expect(keyEvents(calls)[2]).toMatchObject({ key: "F12", windowsVirtualKeyCode: 123, modifiers: 8 });
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

describe("scroll", () => {
  /** A page that moves by `step` on each wheel event, up to `limit`. */
  function scrollable(step: number, limit: number) {
    let y = 0;
    const page = {
      sessionId: "s1",
      targetId: "t1",
      conn: {
        send: async (method: string, params: any = {}) => {
          if (method === "Runtime.evaluate") {
            return { result: { value: JSON.stringify([y, limit, 400, 300]) } };
          }
          if (method === "Input.dispatchMouseEvent" && params.type === "mouseWheel") {
            y = Math.max(0, Math.min(limit, y + Math.sign(params.deltaY) * step));
          }
          return {};
        },
      },
    } as unknown as PageSession;
    return page;
  }

  test("a background tab is drawn while it scrolls, or Chrome holds the wheel forever", async () => {
    // A hidden tab answers a wheel event only when it draws, and applies the
    // scroll only then: `cast browser scroll` hung 30s and timed out.
    const page = scrollable(300, 2000);
    const send = page.conn.send.bind(page.conn);
    const sent: string[] = [];
    (page.conn as any).send = async (method: string, params: any = {}, ...rest: unknown[]) => {
      sent.push(method);
      if (method === "Runtime.evaluate" && params.expression === "document.hidden") return { result: { value: true } };
      return send(method, params, ...(rest as []));
    };
    const r = await scroll(page, 900);
    expect(r.moved).toBe(true);
    expect(sent.indexOf("Page.captureScreenshot")).toBeGreaterThan(sent.indexOf("Input.dispatchMouseEvent"));
  });

  test("reports the position AFTER the scroll, not before", async () => {
    // Reading scrollY straight after dispatching returns the old offset — a
    // wheel event is handled asynchronously — which made the first scroll of
    // every page report "at 0".
    const r = await scroll(scrollable(300, 2000), 900);
    expect(r.y).toBe(300);
    expect(r.moved).toBe(true);
  });

  test("reports the furthest the page can go", async () => {
    const r = await scroll(scrollable(300, 2000), 900);
    expect(r.max).toBe(2000);
  });

  test("says when the page did not move", async () => {
    // Distinguishes "already at the bottom" from a successful scroll, so an
    // agent paging through content knows to stop.
    const r = await scroll(scrollable(300, 0), 900);
    expect(r.moved).toBe(false);
    expect(r.y).toBe(0);
  });

  test("a negative amount scrolls up", async () => {
    const page = scrollable(300, 2000);
    await scroll(page, 900);
    const r = await scroll(page, -900);
    expect(r.y).toBe(0);
  });
});

describe("screenshot --ref", () => {
  test("the clip is the element's box in page coordinates, so a scrolled page captures the element", async () => {
    const calls: Call[] = [];
    const page = {
      sessionId: "s1",
      targetId: "t1",
      conn: {
        send: async (method: string, params: any = {}) => {
          calls.push({ method, params });
          if (method === "DOM.getBoxModel") return { model: { border: [10, 20, 110, 20, 110, 70, 10, 70] } };
          if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 1500 } };
          if (method === "Page.captureScreenshot") return { data: Buffer.from("png").toString("base64") };
          return {};
        },
      },
    } as any;
    await screenshot(page, { ref: 7 });
    expect(calls.find((c) => c.method === "Page.captureScreenshot")!.params.clip).toEqual({ x: 10, y: 1520, width: 100, height: 50, scale: 1 });
  });
});

describe("upload", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cast-upload-")), "mandate.csv");
  fs.writeFileSync(file, "a,b\n1,2\n");

  function chrome(opts: { refuse?: boolean; page?: string | null }) {
    const calls: Call[] = [];
    const page = {
      sessionId: "s1",
      targetId: "t1",
      conn: {
        send: async (method: string, params: any = {}) => {
          calls.push({ method, params });
          if (method === "DOM.setFileInputFiles" && opts.refuse) throw new Error('DOM.setFileInputFiles: {"code":-32000,"message":"Not allowed"}');
          if (method === "DOM.resolveNode") return { object: { objectId: "obj-1" } };
          if (method === "Runtime.callFunctionOn") return { result: { value: opts.page ?? null } };
          return {};
        },
      },
    } as unknown as PageSession;
    return { page, calls };
  }

  test("hands the paths to Chrome when it allows it", async () => {
    const { page, calls } = chrome({});
    expect(await uploadFiles(page, 5, [file])).toBe("native");
    expect(calls.some((c) => c.method === "Runtime.callFunctionOn")).toBe(false);
  });

  test("builds the files in the page when the extension has no file access", async () => {
    // The store build of the extension is refused DOM.setFileInputFiles until
    // the human turns on "Allow access to file URLs", which blocked every
    // marketplace listing that needs a photo or a document.
    const { page, calls } = chrome({ refuse: true });
    expect(await uploadFiles(page, 5, [file])).toBe("page");
    const sent = calls.find((c) => c.method === "Runtime.callFunctionOn")!.params.arguments[0].value;
    expect(sent).toEqual([{ name: "mandate.csv", type: "text/csv", data: Buffer.from("a,b\n1,2\n").toString("base64") }]);
  });

  test("an input gone from the page is gone, not a file-access problem", async () => {
    const { page } = chrome({ refuse: true, page: "gone" });
    await expect(uploadFiles(page, 5, [file])).rejects.toThrow(ElementGone);
  });

  test("refuses up front a payload too large for the bridge, counting it as sent (base64)", async () => {
    // 50MB of raw bytes is about 67MB of base64, past the bridge's 64MB
    // message limit, which failed the socket with no explanation.
    const big = path.join(path.dirname(file), "big.bin");
    fs.writeFileSync(big, "");
    fs.truncateSync(big, 50 * 1024 * 1024);
    const { page, calls } = chrome({ refuse: true });
    await expect(uploadFiles(page, 5, [big])).rejects.toThrow(/too large to build in the page/);
    expect(calls.some((c) => c.method === "Runtime.callFunctionOn")).toBe(false);
    fs.rmSync(big);
  });

  test("names the switch when the page cannot take the files either", async () => {
    const { page } = chrome({ refuse: true, page: "this is not a file input" });
    await expect(uploadFiles(page, 5, [file])).rejects.toThrow(/Allow access to file URLs/);
  });
});

describe("delivery probe (the in-page half)", () => {
  /** Enough of a DOM to run the probe: nodes with parents, shadow roots with hosts. */
  class FakeElement {
    nodeType = 1;
    parentNode: any = null;
    constructor(public tagName: string, public id = "") {}
  }
  const el = (tag: string, parent: any, id = "") => Object.assign(new FakeElement(tag, id), { parentNode: parent });
  const root = (host: any) => ({ nodeType: 11, parentNode: null, host });

  function run(target: any, clicked: any, eventTarget = target) {
    const listeners: Record<string, (e: any) => void> = {};
    const probe = new Function("Element", "document", "addEventListener", "removeEventListener", `return (${DELIVERY_PROBE})`)(
      FakeElement,
      { elementFromPoint: () => target },
      (ty: string, fn: (e: any) => void) => (listeners[ty] = fn),
      () => {},
    );
    const rec = probe.call(clicked, 0, 0);
    const path: any[] = [];
    for (let n = target; n; n = n.parentNode || n.host) path.push(n);
    listeners.pointerdown({ isTrusted: true, target: eventTarget, composedPath: () => path });
    return rec.got;
  }

  test("a button inside a web component is a hit, though window sees only the host", () => {
    // Reddit, YouTube and Salesforce build buttons this way. Window-level
    // listeners get e.target retargeted to the outermost host, and contains()
    // stops at a shadow root, so this was reported missed after it clicked.
    const body = el("BODY", null);
    const host = el("DIV", body, "host");
    const button = el("BUTTON", root(host), "inner");
    expect(run(button, button, host)).toEqual({ hit: true, name: "<button#inner>" });
  });

  test("a press inside the clicked element's own shadow tree is a hit", () => {
    const host = el("MY-BUTTON", el("BODY", null), "vote");
    const label = el("SPAN", root(host));
    expect(run(label, host, host).hit).toBe(true);
  });

  test("a press on something else is still a miss, named by what it hit", () => {
    const body = el("BODY", null);
    const modal = el("DIV", body, "modal");
    const target = el("BUTTON", el("DIV", body));
    expect(run(modal, target)).toEqual({ hit: false, name: "<div#modal>" });
  });
});
