/**
 * Acting on the page: clicks, typing, keys, scrolling, uploads, screenshots.
 *
 * Everything routes through CDP's Input domain rather than JavaScript, because
 * CDP-dispatched events are TRUSTED — `event.isTrusted === true`, the same as a
 * human's hand. That distinction is not cosmetic: untrusted events cannot open
 * windows, cannot drive file pickers, are rejected outright by some payment and
 * auth widgets, and skip the browser's own focus and scroll side effects. It is
 * the main reason the Claude and Codex extensions reach for `chrome.debugger`
 * instead of a content script, and the reason a page snippet can never be a
 * complete substitute for this driver.
 *
 * Every targeted action follows the same guarded sequence:
 *   resolve ref → scroll into view → measure → hit-test → dispatch
 * The hit test is what turns "the click silently did nothing" into a legible
 * error naming the cookie banner that ate it.
 */

import type { PageSession } from "./instance.js";

export class ElementGone extends Error {
  constructor(ref: number) {
    super(`element #e${ref} is no longer in the page — take a fresh snapshot`);
    this.name = "ElementGone";
  }
}

export class ElementOccluded extends Error {
  constructor(ref: number, by: string) {
    super(`element #e${ref} is covered by ${by} — dismiss it, or scroll, or use --force`);
    this.name = "ElementOccluded";
  }
}

export interface Point {
  x: number;
  y: number;
}

/** Block until the page has stopped scrolling, so a measurement stays true. */
async function settleScroll(page: PageSession, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = Number.NaN;
  let stable = 0;
  while (Date.now() < deadline) {
    let pos: number;
    try {
      const r = await page.conn.send<any>(
        "Runtime.evaluate",
        { expression: `Math.round(scrollY) + ":" + Math.round(scrollX)`, returnByValue: true },
        page.sessionId,
        2000,
      );
      pos = r.result.value;
    } catch {
      return; // mid-navigation; the caller will fail with a clearer error
    }
    if (pos === (last as unknown as number)) {
      if (++stable >= 2) return;
    } else {
      stable = 0;
    }
    last = pos as unknown as number;
    await new Promise((r) => setTimeout(r, 40));
  }
}

/** Centre of an element's first content box, after scrolling it into view. */
export async function locate(page: PageSession, ref: number): Promise<Point> {
  const { conn, sessionId } = page;
  try {
    await conn.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: ref }, sessionId);
  } catch (err) {
    // "Node with given id does not belong to the document" means it is gone.
    throw new ElementGone(ref);
  }
  // Wait for the scroll to finish before measuring.
  //
  // `scrollIntoViewIfNeeded` returns once the scroll has been STARTED, not when
  // it lands — and any page with smooth scrolling keeps moving for a few
  // hundred milliseconds. Measuring immediately captures a position the element
  // is still travelling away from, so the click lands wherever that spot ends
  // up: on Hacker News this opened an unrelated story while cheerfully
  // reporting success, which is the worst way for this to fail.
  await settleScroll(page);

  let quads: number[][];
  try {
    const res = await conn.send<{ quads: number[][] }>("DOM.getContentQuads", { backendNodeId: ref }, sessionId);
    quads = res.quads;
  } catch {
    throw new ElementGone(ref);
  }
  if (!quads?.length) {
    throw new Error(`element #e${ref} has no layout box — it is hidden (display:none, zero size, or collapsed)`);
  }
  const q = quads[0];
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
}

/**
 * Would a click at `pt` reach this element? Returns null when it would, or a
 * description of whatever is on top when it would not.
 */
export async function hitTest(page: PageSession, ref: number, pt: Point): Promise<string | null> {
  const { conn, sessionId } = page;
  const { object } = await conn.send<any>("DOM.resolveNode", { backendNodeId: ref }, sessionId);
  if (!object?.objectId) throw new ElementGone(ref);
  const res = await conn.send<any>(
    "Runtime.callFunctionOn",
    {
      objectId: object.objectId,
      functionDeclaration: `function(x, y) {
        const top = document.elementFromPoint(x, y);
        if (!top) return "nothing at that point";
        if (top === this || this.contains(top) || top.contains(this)) return null;
        const cls = typeof top.className === "string" && top.className ? "." + top.className.trim().split(/\\s+/)[0] : "";
        const id = top.id ? "#" + top.id : "";
        return "<" + top.tagName.toLowerCase() + id + cls + ">";
      }`,
      arguments: [{ value: pt.x }, { value: pt.y }],
      returnByValue: true,
    },
    sessionId,
  );
  await conn.send("Runtime.releaseObject", { objectId: object.objectId }, sessionId).catch(() => {});
  return (res.result?.value as string | null) ?? null;
}

export interface ClickOptions {
  button?: "left" | "right" | "middle";
  clickCount?: number;
  /** Dispatch even when something is on top of the element. */
  force?: boolean;
  modifiers?: number;
}

export async function click(page: PageSession, ref: number, opts: ClickOptions = {}): Promise<Point> {
  const pt = await locate(page, ref);
  if (!opts.force) {
    const blocker = await hitTest(page, ref, pt);
    if (blocker) throw new ElementOccluded(ref, blocker);
  }
  await clickAt(page, pt, opts);
  return pt;
}

/**
 * Where a dispatched coordinate actually lands, as a multiplier.
 *
 * Under viewport emulation Chrome may render scaled, and input coordinates are
 * then mapped through the window rather than the page — so a click aimed at
 * [43,30] can be delivered at [107,75]. That is measurable: move the pointer to
 * a known point and ask the page where it thinks the pointer is. A harmless
 * mousemove costs one round trip and removes the need to reason about window
 * geometry, display scaling and device pixel ratios, none of which are reliably
 * reported together.
 *
 * Returns 1 when the page cannot answer, which is the correct assumption.
 */
async function inputScale(page: PageSession, at: Point): Promise<number> {
  const { conn, sessionId } = page;
  try {
    await conn.send(
      "Input.dispatchMouseEvent",
      { type: "mouseMoved", x: at.x, y: at.y, button: "none" },
      sessionId,
      3000,
    );
    const r = await conn.send<any>(
      "Runtime.evaluate",
      { expression: `JSON.stringify(window.__cast && window.__cast.ptr)`, returnByValue: true },
      sessionId,
      3000,
    );
    const seen = JSON.parse(r.result?.value ?? "null") as [number, number] | null;
    if (!seen || !at.x) return 1;
    const scale = seen[0] / at.x;
    // Only trust a clear, consistent scaling. Anything near 1 is 1, and a wild
    // value means the page moved under us rather than that input is scaled.
    if (!Number.isFinite(scale) || scale < 0.2 || scale > 8) return 1;
    return Math.abs(scale - 1) < 0.02 ? 1 : scale;
  } catch {
    return 1;
  }
}

/** Click raw viewport coordinates. The escape hatch when no ref fits. */
export async function clickAt(page: PageSession, pt: Point, opts: ClickOptions = {}): Promise<void> {
  const { conn, sessionId } = page;
  const button = opts.button ?? "left";
  const clickCount = opts.clickCount ?? 1;
  const modifiers = opts.modifiers ?? 0;

  // Aim in the space the browser routes input through, which is not always the
  // page's own. Dividing by the measured scale makes the two agree.
  const scale = await inputScale(page, pt);
  const x = pt.x / scale;
  const y = pt.y / scale;

  // The move matters: hover styles, menus and tooltips only appear for a
  // pointer that actually travelled there.
  await conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", modifiers }, sessionId);
  await conn.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount, modifiers }, sessionId);
  await conn.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount, modifiers }, sessionId);
}

export async function hover(page: PageSession, ref: number): Promise<Point> {
  const pt = await locate(page, ref);
  await page.conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y, button: "none" }, page.sessionId);
  return pt;
}

/** Focus an element without clicking — safer for inputs inside labels/links. */
export async function focus(page: PageSession, ref: number): Promise<void> {
  await page.conn.send("DOM.focus", { backendNodeId: ref }, page.sessionId).catch(() => {
    throw new ElementGone(ref);
  });
}

export interface TypeOptions {
  /** Clear the field first. */
  clear?: boolean;
  /** Send one key event per character. Slower, but the only thing that drives
   *  autocompletes and key-filtered inputs correctly. */
  perKey?: boolean;
  /** Press Enter afterwards. */
  submit?: boolean;
  delayMs?: number;
}

export async function type(page: PageSession, ref: number, text: string, opts: TypeOptions = {}): Promise<void> {
  const { conn, sessionId } = page;
  await focus(page, ref);

  if (opts.clear) {
    // Select-all then delete goes through the editing pipeline, so frameworks
    // observe the change. Setting .value directly does not notify React.
    await conn.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 4, key: "a", code: "KeyA", windowsVirtualKeyCode: 65, commands: ["selectAll"] }, sessionId);
    await conn.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 4, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 }, sessionId);
    await pressKey(page, "Delete");
  }

  if (opts.perKey) {
    for (const ch of text) {
      await conn.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch }, sessionId);
      await conn.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch }, sessionId);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    }
  } else {
    // insertText is one round trip for the whole string and handles emoji and
    // IME text correctly, where synthesising per-character events does not.
    await conn.send("Input.insertText", { text }, sessionId);
  }

  if (opts.submit) await pressKey(page, "Enter");
}

// Keys an agent actually reaches for. `text` is what the page receives as
// input; keys that produce no character omit it.
const KEYS: Record<string, { code: string; key: string; vk: number; text?: string }> = {
  Enter: { code: "Enter", key: "Enter", vk: 13, text: "\r" },
  Tab: { code: "Tab", key: "Tab", vk: 9, text: "\t" },
  Escape: { code: "Escape", key: "Escape", vk: 27 },
  Backspace: { code: "Backspace", key: "Backspace", vk: 8 },
  Delete: { code: "Delete", key: "Delete", vk: 46 },
  ArrowUp: { code: "ArrowUp", key: "ArrowUp", vk: 38 },
  ArrowDown: { code: "ArrowDown", key: "ArrowDown", vk: 40 },
  ArrowLeft: { code: "ArrowLeft", key: "ArrowLeft", vk: 37 },
  ArrowRight: { code: "ArrowRight", key: "ArrowRight", vk: 39 },
  Home: { code: "Home", key: "Home", vk: 36 },
  End: { code: "End", key: "End", vk: 35 },
  PageUp: { code: "PageUp", key: "PageUp", vk: 33 },
  PageDown: { code: "PageDown", key: "PageDown", vk: 34 },
  Space: { code: "Space", key: " ", vk: 32, text: " " },
};

const MODIFIER_BITS: Record<string, number> = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

/**
 * Press a key, optionally with modifiers: "Enter", "Escape", "cmd+a",
 * "ctrl+shift+Tab". Single characters are allowed too ("/" opens search on
 * many sites).
 */
export async function pressKey(page: PageSession, combo: string): Promise<void> {
  const { conn, sessionId } = page;
  const parts = combo.split("+");
  const keyName = parts.pop()!;
  let modifiers = 0;
  for (const m of parts) modifiers |= MODIFIER_BITS[m.toLowerCase()] ?? 0;

  const known = KEYS[keyName] ?? KEYS[keyName[0].toUpperCase() + keyName.slice(1)];
  const spec = known ?? {
    code: `Key${keyName.toUpperCase()}`,
    key: keyName,
    vk: keyName.toUpperCase().charCodeAt(0),
    text: keyName.length === 1 ? keyName : undefined,
  };

  // A modified key must NOT carry text, or the page receives the character as
  // well as the shortcut (cmd+a typing a literal "a" into the field).
  const text = modifiers === 0 || modifiers === 8 ? spec.text : undefined;
  await conn.send(
    "Input.dispatchKeyEvent",
    { type: text ? "keyDown" : "rawKeyDown", modifiers, windowsVirtualKeyCode: spec.vk, code: spec.code, key: spec.key, ...(text ? { text } : {}) },
    sessionId,
  );
  await conn.send(
    "Input.dispatchKeyEvent",
    { type: "keyUp", modifiers, windowsVirtualKeyCode: spec.vk, code: spec.code, key: spec.key },
    sessionId,
  );
}

export interface ScrollResult {
  y: number;
  max: number;
  /** False when the page did not move — already at the end, or it traps wheel. */
  moved: boolean;
}

/**
 * Scroll the page and report where it ended up.
 *
 * The position has to be read AFTER the scroll has actually applied. A wheel
 * event is handled asynchronously, and pages with `scroll-behavior: smooth`
 * animate over several hundred milliseconds, so reading `scrollY` straight
 * after dispatching returns the OLD position — which made every scroll report
 * the offset it started from and the first one always say "at 0".
 */
export async function scroll(page: PageSession, deltaY: number, deltaX = 0): Promise<ScrollResult> {
  const { conn, sessionId } = page;
  /**
   * Where the thing under the cursor is scrolled to.
   *
   * Reading `window.scrollY` alone is wrong for most applications: the page
   * itself often does not scroll at all, and the content sits in an inner pane
   * with its own overflow — a chat log, a sidebar, a modal body. A wheel event
   * scrolls whichever of those is under the pointer, so watching only the
   * document would report "did not move" on a pane that moved perfectly well,
   * and an agent paging through a list would conclude it had hit the end on the
   * first try. So find the nearest scrollable ancestor of the element at the
   * cursor and measure THAT, falling back to the document.
   */
  const read = async (): Promise<{ y: number; max: number; cx: number; cy: number }> => {
    const r = await conn.send<any>(
      "Runtime.evaluate",
      {
        expression: `(() => {
          const cx = Math.round(innerWidth / 2), cy = Math.round(innerHeight / 2);
          const docMax = Math.max(0, document.documentElement.scrollHeight - innerHeight);
          let el = document.elementFromPoint(cx, cy);
          while (el && el !== document.body && el !== document.documentElement) {
            const st = getComputedStyle(el);
            if (/auto|scroll|overlay/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 4) {
              return JSON.stringify([Math.round(el.scrollTop),
                                     Math.round(el.scrollHeight - el.clientHeight), cx, cy]);
            }
            el = el.parentElement;
          }
          return JSON.stringify([Math.round(scrollY), Math.round(docMax), cx, cy]);
        })()`,
        returnByValue: true,
      },
      sessionId,
      5_000,
    );
    const [y, max, cx, cy] = JSON.parse(r.result.value) as number[];
    return { y, max, cx, cy };
  };

  const start = await read();
  await conn.send(
    "Input.dispatchMouseEvent",
    { type: "mouseWheel", x: start.cx, y: start.cy, deltaX, deltaY },
    sessionId,
  );

  // Wait for the position to stop changing rather than guessing a delay: a
  // smooth-scrolling page is still moving for a few hundred ms.
  let y = start.y;
  let max = start.max;
  let stable = 0;
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 40));
    const cur = await read();
    max = cur.max;
    if (cur.y === y) {
      if (++stable >= 2) break;
    } else {
      stable = 0;
    }
    y = cur.y;
  }
  return { y, max, moved: y !== start.y };
}

/**
 * Choose an option in a native <select>. The native popup is drawn by the OS
 * and has no DOM, so a click can never reach it; setting the value and firing
 * the events the page listens for is the only path that works.
 */
export async function selectOption(page: PageSession, ref: number, value: string): Promise<string> {
  const { conn, sessionId } = page;
  const { object } = await conn.send<any>("DOM.resolveNode", { backendNodeId: ref }, sessionId);
  if (!object?.objectId) throw new ElementGone(ref);
  const res = await conn.send<any>(
    "Runtime.callFunctionOn",
    {
      objectId: object.objectId,
      functionDeclaration: `function(want) {
        // Most modern UIs render a fake dropdown from divs. Those cannot be
        // driven by setting a value; they need the clicks a user would make,
        // so say that rather than just refusing.
        if (this.tagName !== "SELECT") {
          const role = this.getAttribute("role") || this.tagName.toLowerCase();
          return "this is a " + role + ", not a native <select> — it is a custom dropdown. " +
                 "Click it to open, snapshot, then click the option you want.";
        }
        const opts = [...this.options];
        const hit = opts.find(o => o.value === want) || opts.find(o => o.label === want)
                 || opts.find(o => o.text.trim() === want)
                 || opts.find(o => o.text.trim().toLowerCase().includes(want.toLowerCase()));
        if (!hit) return "no option matching " + JSON.stringify(want) + "; have: " + opts.map(o => o.text.trim()).slice(0, 20).join(" | ");
        this.value = hit.value;
        this.dispatchEvent(new Event("input", { bubbles: true }));
        this.dispatchEvent(new Event("change", { bubbles: true }));
        return null;
      }`,
      arguments: [{ value }],
      returnByValue: true,
    },
    sessionId,
  );
  await conn.send("Runtime.releaseObject", { objectId: object.objectId }, sessionId).catch(() => {});
  const err = res.result?.value as string | null;
  if (err) throw new Error(err);
  return value;
}

/** Attach files to an <input type=file> without touching the OS picker. */
export async function uploadFiles(page: PageSession, ref: number, files: string[]): Promise<void> {
  await page.conn.send("DOM.setFileInputFiles", { backendNodeId: ref, files }, page.sessionId);
}

export interface ShotOptions {
  fullPage?: boolean;
  /** Restrict to one element's box. */
  ref?: number;
  format?: "png" | "jpeg";
  quality?: number;
}

/** Capture a screenshot, returned as raw bytes. */
export async function screenshot(page: PageSession, opts: ShotOptions = {}): Promise<Buffer> {
  const { conn, sessionId } = page;
  const format = opts.format ?? "png";
  const params: Record<string, unknown> = {
    format,
    ...(format === "jpeg" ? { quality: opts.quality ?? 80 } : {}),
  };

  if (opts.ref !== undefined) {
    await conn.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: opts.ref }, sessionId).catch(() => {
      throw new ElementGone(opts.ref!);
    });
    const { model } = await conn.send<any>("DOM.getBoxModel", { backendNodeId: opts.ref }, sessionId);
    const [x1, y1, , , x3, y3] = model.border;
    params.clip = { x: x1, y: y1, width: x3 - x1, height: y3 - y1, scale: 1 };
  } else if (opts.fullPage) {
    // captureBeyondViewport renders the whole scroll height without the
    // scroll-and-stitch dance, which double-fires lazy loaders.
    params.captureBeyondViewport = true;
  }

  const res = await conn.send<{ data: string }>("Page.captureScreenshot", params, sessionId);
  return Buffer.from(res.data, "base64");
}

/** Run JavaScript in the page and return its value. */
export async function evaluate(page: PageSession, expression: string): Promise<unknown> {
  const res = await page.conn.send<any>(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true, userGesture: true },
    page.sessionId,
  );
  if (res.exceptionDetails) {
    const e = res.exceptionDetails;
    throw new Error(e.exception?.description ?? e.text ?? "evaluation failed");
  }
  return res.result?.value;
}

/** A device preset: viewport, pixel density, touch, and user agent. */
export interface DeviceProfile {
  width: number;
  height: number;
  scale: number;
  mobile: boolean;
  userAgent?: string;
}

// Enough to cover the breakpoints frontend work actually targets. Names are
// what a developer would say out loud rather than model numbers.
export const DEVICES: Record<string, DeviceProfile> = {
  desktop: { width: 1440, height: 900, scale: 1, mobile: false },
  laptop: { width: 1280, height: 800, scale: 2, mobile: false },
  wide: { width: 1920, height: 1080, scale: 1, mobile: false },
  tablet: {
    width: 820, height: 1180, scale: 2, mobile: true,
    userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
  mobile: {
    width: 390, height: 844, scale: 3, mobile: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
  "mobile-small": {
    width: 320, height: 568, scale: 2, mobile: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
};

/**
 * Resize the viewport, optionally emulating a device.
 *
 * This overrides the metrics the PAGE sees rather than resizing the OS window,
 * so it works headless, it is exact (a real window carries chrome and is
 * subject to the display size), and it can emulate a density and a touch
 * screen that the machine does not have. That is what makes it useful for
 * checking a layout at a breakpoint: media queries, `innerWidth` and
 * `devicePixelRatio` all report the emulated values.
 */
export async function setViewport(page: PageSession, d: DeviceProfile): Promise<void> {
  const { conn, sessionId } = page;

  // The window's CONTENT area must be at least as wide as the viewport we are
  // emulating, or Chrome scales the rendering to fit and input stops following.
  //
  // When the emulated width exceeds the content area, `elementFromPoint`
  // answers in emulated space while `Input.dispatchMouseEvent` is routed
  // through window space. The occlusion check passes and the click still lands
  // somewhere else. Measured on Hacker News: a click aimed at [43,30] was
  // delivered at [107,75] — 2.5x out, exactly the ratio of the 390px emulated
  // width to the 156px content area — and opened an unrelated story while
  // reporting success.
  //
  // The content width has to be MEASURED, not derived from the window bounds:
  // those are in display units, and with any display scaling a 1440-wide
  // window can have a 156px content area. So clear any override, read the real
  // width, and grow until it fits. Only ever grow — shrinking to match a small
  // device is what caused the bug in the first place.
  try {
    const realWidth = async (): Promise<number> => {
      const r = await conn.send<any>(
        "Runtime.evaluate",
        { expression: "innerWidth", returnByValue: true },
        sessionId,
        2000,
      );
      return Number(r.result?.value) || 0;
    };
    await conn.send("Emulation.clearDeviceMetricsOverride", {}, sessionId);
    for (let attempt = 0; attempt < 3; attempt++) {
      const have = await realWidth();
      if (have >= d.width) break;
      const { windowId, bounds } = await conn.send<any>("Browser.getWindowForTarget", { targetId: page.targetId });
      if (!windowId || bounds?.windowState === "minimized") break;
      // Scale the window by the shortfall rather than setting an absolute size,
      // which is the only way to be right without knowing the display scaling.
      const grown = Math.ceil((bounds.width || d.width) * (d.width / Math.max(have, 1)) * 1.05);
      await conn.send("Browser.setWindowBounds", {
        windowId,
        bounds: { width: Math.min(grown, 4000), height: Math.max(bounds.height || 0, 900) },
      });
      await new Promise((r) => setTimeout(r, 250));
    }
  } catch {
    // Headless has no window; there the emulated size IS the rendering size.
  }

  await conn.send(
    "Emulation.setDeviceMetricsOverride",
    {
      width: d.width,
      height: d.height,
      deviceScaleFactor: d.scale,
      mobile: d.mobile,
      screenWidth: d.width,
      screenHeight: d.height,
    },
    sessionId,
  );
  // Touch changes real behaviour: hover-only menus never open, and libraries
  // branch on it. Emulating the size without it gives a misleading picture.
  await conn
    .send("Emulation.setTouchEmulationEnabled", { enabled: d.mobile, maxTouchPoints: d.mobile ? 5 : 0 }, sessionId)
    .catch(() => {});
  if (d.userAgent) {
    await conn.send("Emulation.setUserAgentOverride", { userAgent: d.userAgent }, sessionId).catch(() => {});
  }
}

/** Drop every emulation override, back to the real window. */
export async function clearViewport(page: PageSession): Promise<void> {
  const { conn, sessionId } = page;
  await conn.send("Emulation.clearDeviceMetricsOverride", {}, sessionId).catch(() => {});
  await conn.send("Emulation.setTouchEmulationEnabled", { enabled: false }, sessionId).catch(() => {});
  await conn.send("Emulation.setUserAgentOverride", { userAgent: "" }, sessionId).catch(() => {});
}
