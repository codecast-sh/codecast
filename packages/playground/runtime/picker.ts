// Point and talk, inside the app: while the shell has picking on, hovering
// highlights the element under the pointer and a click reports it instead of
// reaching the app. The highlight lives in a shadow root on <html>, so the
// app's CSS cannot restyle it and the app's DOM queries cannot see it.
import type { ElementFields } from "../convex/lib/room";
import { ELEMENT_FIELD_MAX } from "../convex/lib/limits";
import { clipLine, clipText, oneLine } from "../convex/lib/text";
import type { PickTheme } from "./protocol";

/** The slice of an Element the selector needs, so it can be tested without a DOM. */
export type SelectorNode = {
  tagName: string;
  id: string;
  parentElement: SelectorNode | null;
  children: ArrayLike<{ tagName: string }>;
};

const SIMPLE_ID = /^[A-Za-z][\w-]*$/;

/** A CSS selector for `el`: from the nearest ancestor with a usable id (or
 *  from html), each step its tag, with :nth-of-type only where a sibling
 *  shares the tag. Stable across renders that keep the structure. */
export function selectorFor(el: SelectorNode): string {
  const steps: string[] = [];
  for (let node: SelectorNode | null = el; node; node = node.parentElement) {
    if (SIMPLE_ID.test(node.id)) {
      steps.unshift(`#${node.id}`);
      break;
    }
    const tag = node.tagName.toLowerCase();
    const parent: SelectorNode | null = node.parentElement;
    if (!parent) {
      steps.unshift(tag);
      break;
    }
    const same = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
    steps.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag);
  }
  return steps.join(" > ");
}

export function describeElement(el: Element): ElementFields {
  const text = oneLine((el as HTMLElement).innerText ?? el.textContent ?? "");
  return {
    selector: clipText(selectorFor(el), ELEMENT_FIELD_MAX.selector),
    tag: el.tagName.toLowerCase(),
    ...(text ? { text: clipText(text, ELEMENT_FIELD_MAX.text) } : {}),
    snippet: clipLine(el.outerHTML, ELEMENT_FIELD_MAX.snippet),
  };
}

const DEFAULT_THEME: PickTheme = { accent: "#c4491f", ink: "#2b2520", font: "ui-monospace, monospace" };

/** A ring around an element, drawn from a shadow root on <html> so the app's
 *  CSS cannot restyle it and its DOM queries cannot see it: a 2px outline 3px
 *  out with a soft halo. The picker's hover highlight and the landing
 *  spotlight both draw with it; `css` and `inner` add their own parts. */
export function ringLayer(color: string, css = "", inner = "") {
  const host = document.createElement("clayground-ring");
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>
    :host { all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; }
    .box { position: fixed; display: none; }
    .ring {
      position: absolute; inset: -5px; border-radius: 6px; border: 2px solid ${color};
      box-shadow: 0 0 0 6px color-mix(in srgb, ${color} 12%, transparent);
    }
    ${css}
  </style><div class="box"><div class="ring"></div>${inner}</div>`;
  document.documentElement.append(host);
  const box = root.querySelector<HTMLElement>(".box")!;
  return {
    host,
    root,
    box,
    place(el: Element) {
      const r = el.getBoundingClientRect();
      Object.assign(box.style, { display: "block", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    },
    remove: () => host.remove(),
  };
}

/** The picker's tag above the ring (DESIGN 6.3), an ink label reading `tag · text`. */
function tagCss(t: PickTheme): string {
  return `
    .tag {
      position: absolute; left: -5px; bottom: calc(100% + 10px); max-width: 280px;
      padding: 2px 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      font: 500 11.5px/1.4 ${t.font};
      color: #fffdf9; background: ${t.ink}; border-radius: 5px;
    }
    .box.below .tag { bottom: auto; top: calc(100% + 10px); }
  `;
}

export type PickerEvents = { picked(element: ElementFields): void; cancelled(): void };

/** Turn picking on; returns the function that turns it off. */
export function startPicking(theme: PickTheme | undefined, on: PickerEvents): () => void {
  const t = theme ?? DEFAULT_THEME;
  const layer = ringLayer(t.accent, tagCss(t), `<div class="tag"></div>`);
  const tag = layer.root.querySelector<HTMLElement>(".tag")!;
  const cursor = document.createElement("style");
  cursor.textContent = "* { cursor: crosshair !important; }";
  document.head.append(cursor);

  const show = (el: Element) => {
    layer.place(el);
    layer.box.classList.toggle("below", el.getBoundingClientRect().top < 32);
    const { tag: name, text } = describeElement(el);
    tag.textContent = text ? `${name} · ${text}` : name;
  };
  const target = (e: Event) => (e.target instanceof Element && e.target !== layer.host ? e.target : null);

  const onMove = (e: Event) => {
    const el = target(e);
    if (el) show(el);
  };
  const swallow = (e: Event) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const onClick = (e: MouseEvent) => {
    const el = target(e);
    swallow(e);
    if (!el) return;
    stop();
    on.picked(describeElement(el));
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    swallow(e);
    stop();
    on.cancelled();
  };

  const listeners: [string, (e: never) => void][] = [
    ["pointerover", onMove],
    ["pointermove", onMove],
    ["pointerdown", swallow],
    ["pointerup", swallow],
    ["mousedown", swallow],
    ["mouseup", swallow],
    ["click", onClick],
    ["keydown", onKey],
  ];
  for (const [type, fn] of listeners) window.addEventListener(type, fn as EventListener, true);

  let stopped = false;
  function stop() {
    if (stopped) return;
    stopped = true;
    for (const [type, fn] of listeners) window.removeEventListener(type, fn as EventListener, true);
    layer.remove();
    cursor.remove();
  }
  return stop;
}
