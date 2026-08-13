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

/** Centre of an element's first content box, after scrolling it into view. */
export async function locate(page: PageSession, ref: number): Promise<Point> {
  const { conn, sessionId } = page;
  try {
    await conn.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: ref }, sessionId);
  } catch (err) {
    // "Node with given id does not belong to the document" means it is gone.
    throw new ElementGone(ref);
  }
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

/** Click raw viewport coordinates. The escape hatch when no ref fits. */
export async function clickAt(page: PageSession, pt: Point, opts: ClickOptions = {}): Promise<void> {
  const { conn, sessionId } = page;
  const button = opts.button ?? "left";
  const clickCount = opts.clickCount ?? 1;
  const modifiers = opts.modifiers ?? 0;
  // The move matters: hover styles, menus and tooltips only appear for a
  // pointer that actually travelled there.
  await conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y, button: "none", modifiers }, sessionId);
  await conn.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pt.x, y: pt.y, button, clickCount, modifiers }, sessionId);
  await conn.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pt.x, y: pt.y, button, clickCount, modifiers }, sessionId);
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
