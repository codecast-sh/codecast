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
import { mediaTypeForFile } from "@codecast/shared/files";
import { pageForRef } from "./oopif.js";

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
 * The page object behind a ref. A node of the document before a navigation
 * can still be scrolled and measured, then fails here ("does not belong to
 * the document"), so every failure means the element is gone.
 */
async function resolveRef(page: PageSession, ref: number): Promise<string> {
  const r = await page.conn
    .send<any>("DOM.resolveNode", { backendNodeId: ref }, page.sessionId)
    .catch(() => null);
  if (!r?.object?.objectId) throw new ElementGone(ref);
  return r.object.objectId;
}

/**
 * Would a click at `pt` reach this element? Returns null when it would, or a
 * description of whatever is on top when it would not.
 */
export async function hitTest(page: PageSession, ref: number, pt: Point): Promise<string | null> {
  const { conn, sessionId } = page;
  const objectId = await resolveRef(page, ref);
  const res = await conn.send<any>(
    "Runtime.callFunctionOn",
    {
      objectId,
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
  await conn.send("Runtime.releaseObject", { objectId }, sessionId).catch(() => {});
  return (res.result?.value as string | null) ?? null;
}

export interface ClickOptions {
  button?: "left" | "right" | "middle";
  clickCount?: number;
  /** Dispatch even when something is on top of the element. */
  force?: boolean;
  modifiers?: number;
}

export class ClickNotDelivered extends Error {
  constructor(where: string) {
    super(`the click never reached the page at ${where}: Chrome dropped it, so nothing was clicked — take a snapshot and try again`);
    this.name = "ClickNotDelivered";
  }
}

export class ClickMissed extends Error {
  constructor(ref: number, landed: string) {
    super(`the click on #e${ref} landed on ${landed} instead — the page moved under it; take a fresh snapshot`);
    this.name = "ClickMissed";
  }
}

export async function click(page: PageSession, ref: number, opts: ClickOptions = {}): Promise<Point> {
  const top = page;
  ({ page, ref } = await pageForRef(page, ref)); // a ref inside a cross-origin frame acts on its session (oopif.ts)
  const pt = await locate(page, ref);
  if (!opts.force) {
    const blocker = await hitTest(page, ref, pt);
    if (blocker) throw new ElementOccluded(ref, blocker);
  }
  await press(page, pt, opts, top, ref);
  return pt;
}

/**
 * Make Chrome draw the tab once.
 *
 * Chrome routes mouse input by hit-testing the tab's last drawn frame, and a
 * background tab draws none: a press is dropped or lands where the page used
 * to be, and a mouseMoved is held unanswered for 5s waiting on a frame. Keys
 * need no hit test, which is why typing works there. Capturing a single pixel
 * makes Chrome produce a frame without showing the tab, raising the window or
 * making the page visible (document.hidden stays true).
 */
async function paint(top: PageSession): Promise<void> {
  await top.conn
    .send("Page.captureScreenshot", { format: "jpeg", quality: 1, clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 } }, top.sessionId, 5000)
    .catch(() => {});
}

async function isHidden(page: PageSession): Promise<boolean> {
  const r = await page.conn
    .send<any>("Runtime.evaluate", { expression: "document.hidden", returnByValue: true }, page.sessionId, 3000)
    .catch(() => null);
  return r?.result?.value === true;
}

/** A mouse event, answered promptly even in a background tab: Chrome holds a
 *  move's or wheel's reply until the tab draws, so draw it while it waits. */
async function sendMouse(page: PageSession, params: Record<string, unknown>, hidden: boolean, top: PageSession = page): Promise<void> {
  const sent = page.conn.send("Input.dispatchMouseEvent", params, page.sessionId, hidden ? 6000 : undefined);
  if (hidden) await paint(top);
  await sent;
}

/** A pointer move. A reply Chrome still held after the tab drew is not a
 *  failure (the move is queued); anything else is. */
async function moveTo(page: PageSession, x: number, y: number, modifiers: number, hidden: boolean, top: PageSession): Promise<void> {
  await sendMouse(page, { type: "mouseMoved", x, y, button: "none", modifiers }, hidden, top).catch((err) => {
    if (!(hidden && /did not answer within/.test(String((err as Error)?.message)))) throw err;
  });
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
async function inputScale(page: PageSession, at: Point, hidden: boolean, top: PageSession): Promise<number> {
  const { conn, sessionId } = page;
  try {
    await moveTo(page, at.x, at.y, 0, hidden, top);
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

/**
 * The in-page half of the delivery check, run with the clicked element as
 * `this` (or none for raw coordinates). A listener on window sees a target
 * inside a shadow root retargeted to its outermost host, so the real target
 * is the first node of the event's composed path, and containment is walked
 * across shadow roots (through each root's host): a button inside a web
 * component is a hit, not a miss.
 */
export const DELIVERY_PROBE = `function(x, y) {
    const el = this instanceof Element ? this : null;
    const under = document.elementFromPoint(x, y);
    const rec = { got: null, frame: !!under && /^(IFRAME|FRAME|EMBED|OBJECT)$/.test(under.tagName) };
    const within = (outer, node) => {
      for (let n = node; n; n = n.parentNode || n.host) if (n === outer) return true;
      return false;
    };
    const on = (e) => {
      if (!e.isTrusted || rec.got) return;
      const path = typeof e.composedPath === "function" ? e.composedPath() : [];
      const t = path[0] && path[0].nodeType === 1 ? path[0] : e.target;
      const name = t && t.tagName ? "<" + t.tagName.toLowerCase() + (t.id ? "#" + t.id : "") + ">" : "the page";
      rec.got = { hit: !el || !t || path.includes(el) || within(el, t) || within(t, el), name };
    };
    const types = ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "auxclick", "contextmenu"];
    for (const ty of types) addEventListener(ty, on, true);
    rec.off = () => { for (const ty of types) removeEventListener(ty, on, true); };
    return rec;
  }`;

/**
 * Listen for the press reaching the page, so a click is never reported done
 * when Chrome dropped it. The record lives in a page object held by id, not on
 * window. Pointer, mouse and click events all count: a page that cancels
 * pointerdown suppresses mousedown, and the click still happens. A press
 * over a frame is delivered inside that frame, out of this listener's sight,
 * so the record notes when the point is over one: delivery is then unknown.
 */
async function armDelivery(page: PageSession, pt: Point, ref?: number): Promise<string | null> {
  const fn = DELIVERY_PROBE;
  try {
    if (ref !== undefined) {
      const objectId = await resolveRef(page, ref);
      const r = await page.conn.send<any>(
        "Runtime.callFunctionOn",
        { objectId, functionDeclaration: fn, arguments: [{ value: pt.x }, { value: pt.y }] },
        page.sessionId,
      );
      await page.conn.send("Runtime.releaseObject", { objectId }, page.sessionId).catch(() => {});
      return r?.result?.objectId ?? null;
    }
    const r = await page.conn.send<any>("Runtime.evaluate", { expression: `(${fn}).call(null, ${Number(pt.x)}, ${Number(pt.y)})` }, page.sessionId);
    return r?.result?.objectId ?? null;
  } catch {
    return null;
  }
}

/** What the armed listener saw. A context torn down by the click's own navigation means it arrived. */
type Delivery = { got: { hit: boolean; name: string } | null; frame: boolean };

async function readDelivery(page: PageSession, probe: string): Promise<Delivery | "navigated"> {
  try {
    const r = await page.conn.send<any>(
      "Runtime.callFunctionOn",
      { objectId: probe, functionDeclaration: "function() { this.off(); return { got: this.got, frame: this.frame }; }", returnByValue: true },
      page.sessionId,
      3000,
    );
    if (r?.exceptionDetails) return "navigated";
    return r?.result?.value ?? { got: null, frame: false };
  } catch {
    return "navigated";
  } finally {
    page.conn.send("Runtime.releaseObject", { objectId: probe }, page.sessionId).catch(() => {});
  }
}

/** Click raw viewport coordinates. The escape hatch when no ref fits. */
export async function clickAt(page: PageSession, pt: Point, opts: ClickOptions = {}): Promise<void> {
  await press(page, pt, opts, page);
}

async function press(page: PageSession, pt: Point, opts: ClickOptions, top: PageSession, ref?: number): Promise<void> {
  const { conn, sessionId } = page;
  const button = opts.button ?? "left";
  const clickCount = opts.clickCount ?? 1;
  const modifiers = opts.modifiers ?? 0;
  const hidden = await isHidden(page);

  // Aim in the space the browser routes input through, which is not always the
  // page's own. Dividing by the measured scale makes the two agree.
  const scale = await inputScale(page, pt, hidden, top);
  const x = pt.x / scale;
  const y = pt.y / scale;

  // The move matters: hover styles, menus and tooltips only appear for a
  // pointer that actually travelled there.
  for (let attempt = 0; ; attempt++) {
    const probe = await armDelivery(page, pt, ref);
    await moveTo(page, x, y, modifiers, hidden, top);
    await conn.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount, modifiers }, sessionId);
    await conn.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount, modifiers }, sessionId);
    if (!probe) return;
    const seen = await readDelivery(page, probe);
    if (seen === "navigated") return;
    const { got } = seen;
    if (got) {
      if (!got.hit && ref !== undefined && !opts.force) throw new ClickMissed(ref, got.name);
      return;
    }
    // Over a frame, the press went into it where this page cannot see:
    // unknown, so never pressed again and never reported as dropped.
    if (seen.frame) return;
    // A visible tab draws, so its press was not dropped for want of a frame;
    // the listener just did not see it (a page that stops events at window
    // capture). Pressing again could act twice, so only a hidden tab, where
    // a dropped press is the known failure, is pressed again.
    if (!hidden) return;
    // Nothing reached the page, so nothing acted and pressing again is safe.
    if (attempt >= 1) throw new ClickNotDelivered(`[${Math.round(pt.x)},${Math.round(pt.y)}]`);
  }
}

export async function hover(page: PageSession, ref: number): Promise<Point> {
  const top = page;
  ({ page, ref } = await pageForRef(page, ref)); // a ref inside a cross-origin frame acts on its session (oopif.ts)
  const pt = await locate(page, ref);
  await moveTo(page, pt.x, pt.y, 0, await isHidden(page), top);
  return pt;
}

/** Focus an element without clicking — safer for inputs inside labels/links. */
export async function focus(page: PageSession, ref: number): Promise<void> {
  ({ page, ref } = await pageForRef(page, ref)); // a ref inside a cross-origin frame acts on its session (oopif.ts)
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
  ({ page, ref } = await pageForRef(page, ref)); // a ref inside a cross-origin frame acts on its session (oopif.ts)
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
 * "ctrl+shift+Tab", "F5", "cmd++". Single characters are allowed too ("/"
 * opens search on many sites).
 */
export async function pressKey(page: PageSession, combo: string): Promise<void> {
  const { conn, sessionId } = page;
  // "+" separates, and is also a key: "+" alone, or last as in "cmd++".
  const plus = combo === "+" || combo.endsWith("++");
  const parts = (plus ? combo.slice(0, -1) : combo).split("+").filter((p, i, all) => !(plus && i === all.length - 1 && p === ""));
  const keyName = plus ? "+" : parts.pop()!;
  if (!keyName) throw new Error(`'${combo}' names no key — use a key name or character, with modifiers before it: Enter, cmd+a, ctrl+shift+Tab`);
  let modifiers = 0;
  for (const m of parts) modifiers |= MODIFIER_BITS[m.toLowerCase()] ?? 0;

  const fn = /^f([1-9]|1[0-2])$/i.exec(keyName);
  const known = fn
    ? { code: `F${fn[1]}`, key: `F${fn[1]}`, vk: 111 + Number(fn[1]) }
    : plus
      ? { code: "Equal", key: "+", vk: 187, text: "+" }
      : KEYS[keyName] ?? KEYS[keyName[0].toUpperCase() + keyName.slice(1)];
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

  const hidden = await isHidden(page);
  const start = await read();
  await sendMouse(page, { type: "mouseWheel", x: start.cx, y: start.cy, deltaX, deltaY }, hidden);

  // Wait for the position to stop changing rather than guessing a delay: a
  // smooth-scrolling page is still moving for a few hundred ms.
  let y = start.y;
  let max = start.max;
  let stable = 0;
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 40));
    if (hidden) await paint(page); // a background tab only advances a scroll when it draws
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
  ({ page, ref } = await pageForRef(page, ref)); // a ref inside a cross-origin frame acts on its session (oopif.ts)
  const { conn, sessionId } = page;
  const objectId = await resolveRef(page, ref);
  const res = await conn.send<any>(
    "Runtime.callFunctionOn",
    {
      objectId,
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
  await conn.send("Runtime.releaseObject", { objectId }, sessionId).catch(() => {});
  const err = res.result?.value as string | null;
  if (err) throw new Error(err);
  return value;
}

/** Largest base64 payload the in-page fallback sends: it travels as one CDP
 *  message, and the bridge host refuses messages over 64MiB
 *  (bridge/host.ts MAX_MESSAGE_BYTES), so this leaves room for the rest. */
const PAGE_UPLOAD_MAX_ENCODED = 60 * 1024 * 1024;

const FILE_ACCESS_HINT =
  "Chrome lets an extension hand files to a page only with its \"Allow access to file URLs\" switch: chrome://extensions → Codecast → Details";

/**
 * Attach files to a file input. Returns how: "native" through Chrome, or
 * "page" when Chrome refused ("Not allowed": the extension driving the human's
 * Chrome lacks file access) and the files were built in the page instead and
 * set on the input with input and change events, which is all an ordinary
 * upload widget reads.
 */
export async function uploadFiles(page: PageSession, ref: number, files: string[]): Promise<"native" | "page"> {
  ({ page, ref } = await pageForRef(page, ref)); // a ref inside a cross-origin frame acts on its session (oopif.ts)
  try {
    await page.conn.send("DOM.setFileInputFiles", { backendNodeId: ref, files }, page.sessionId);
    return "native";
  } catch (err) {
    if (!/not allowed/i.test(String((err as Error)?.message ?? err))) throw err;
  }
  const fs = await import("node:fs");
  const path = await import("node:path");
  const total = files.reduce((n, f) => n + fs.statSync(f).size, 0);
  const encoded = files.reduce((n, f) => n + Math.ceil(fs.statSync(f).size / 3) * 4, 0);
  if (encoded > PAGE_UPLOAD_MAX_ENCODED) throw new Error(`Chrome refused the files (Not allowed), and ${Math.round(total / 1048576)}MB is too large to build in the page. ${FILE_ACCESS_HINT}`);
  const payload = files.map((f) => {
    const type = mediaTypeForFile(f);
    return { name: path.basename(f), type: type === "application/octet-stream" ? "" : type, data: fs.readFileSync(f).toString("base64") };
  });
  const objectId = await resolveRef(page, ref);
  const r = await page.conn.send<any>(
    "Runtime.callFunctionOn",
    {
      objectId,
      functionDeclaration: `function(files) {
        if (!this.isConnected) return "gone";
        if (!(this instanceof HTMLInputElement) || this.type !== "file") return "this is not a file input";
        const dt = new DataTransfer();
        for (const f of files) {
          const bin = atob(f.data);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          dt.items.add(new File([bytes], f.name, { type: f.type, lastModified: Date.now() }));
        }
        this.files = dt.files;
        this.dispatchEvent(new Event("input", { bubbles: true }));
        this.dispatchEvent(new Event("change", { bubbles: true }));
        return this.files.length === files.length ? null : "the input took " + this.files.length + " of " + files.length + " files";
      }`,
      arguments: [{ value: payload }],
      returnByValue: true,
    },
    page.sessionId,
    60_000,
  );
  await page.conn.send("Runtime.releaseObject", { objectId }, page.sessionId).catch(() => {});
  const problem = r?.exceptionDetails?.exception?.description ?? r?.result?.value;
  if (problem === "gone") throw new ElementGone(ref);
  if (problem) throw new Error(`Chrome refused the files (Not allowed), and building them in the page failed: ${problem}. ${FILE_ACCESS_HINT}`);
  return "page";
}

export interface ShotOptions {
  fullPage?: boolean;
  /** Restrict to one element's box. */
  ref?: number;
  format?: "png" | "jpeg";
  quality?: number;
  /** Downscale so the output is at most this many pixels wide. Done in the
   *  browser via a clip scale, so it also neutralises retina DPR — no local
   *  image tooling involved, and it works against a remote Chrome. */
  maxWidth?: number;
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
    // The box model is in viewport coordinates and a clip is in page
    // coordinates: on a scrolled page the two differ by the scroll offset.
    const metrics = await conn.send<any>("Page.getLayoutMetrics", {}, sessionId).catch(() => null);
    const vv = metrics?.cssVisualViewport ?? metrics?.visualViewport;
    params.clip = { x: x1 + (vv?.pageX ?? 0), y: y1 + (vv?.pageY ?? 0), width: x3 - x1, height: y3 - y1, scale: 1 };
  } else if (opts.fullPage) {
    // captureBeyondViewport renders the whole scroll height without the
    // scroll-and-stitch dance, which double-fires lazy loaders.
    params.captureBeyondViewport = true;
  } else if (opts.maxWidth) {
    const [lm, dprRes] = await Promise.all([
      conn.send<any>("Page.getLayoutMetrics", {}, sessionId),
      conn.send<any>("Runtime.evaluate", { expression: "devicePixelRatio", returnByValue: true }, sessionId),
    ]);
    const v = lm.cssLayoutViewport;
    const dpr = Number(dprRes?.result?.value) || 1;
    // The output is clip.width × scale × DPR pixels wide — the clip scale
    // multiplies on top of the device scale, so a retina page needs the DPR
    // folded in or "800 wide" comes out at 1600.
    const scale = opts.maxWidth / (v.clientWidth * dpr);
    if (v && scale < 1) {
      // Clip coordinates are page coordinates, so a scrolled page needs the
      // scroll offset folded in or the capture shows the top of the document.
      params.clip = { x: v.pageX ?? 0, y: v.pageY ?? 0, width: v.clientWidth, height: v.clientHeight, scale };
    }
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
