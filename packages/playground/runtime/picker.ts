// Point and talk, inside the app: while the shell has picking on, hovering
// highlights the element under the pointer and a click reports it instead of
// reaching the app. The highlight lives in a shadow root on <html>, so the
// app's CSS cannot restyle it and the app's DOM queries cannot see it.
import type { ElementFields } from "../convex/lib/room";
import { ELEMENT_FIELD_MAX } from "../convex/lib/limits";
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

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Clip to `max` characters, marking the cut. */
export function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function describeElement(el: Element): ElementFields {
  const text = oneLine((el as HTMLElement).innerText ?? el.textContent ?? "");
  return {
    selector: clip(selectorFor(el), ELEMENT_FIELD_MAX.selector),
    tag: el.tagName.toLowerCase(),
    ...(text ? { text: clip(text, ELEMENT_FIELD_MAX.text) } : {}),
    snippet: clip(oneLine(el.outerHTML), ELEMENT_FIELD_MAX.snippet),
  };
}

const DEFAULT_THEME: PickTheme = { accent: "#ffd84a", ink: "#1d1631", font: "ui-monospace, monospace" };

function overlayCss(t: PickTheme): string {
  return `
    :host { all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; }
    .box { position: fixed; display: none; }
    .box svg { position: absolute; inset: -4px; width: calc(100% + 8px); height: calc(100% + 8px); overflow: visible; }
    .box rect { x: 1.5px; y: 1.5px; width: calc(100% - 3px); height: calc(100% - 3px); rx: 6px; fill: none; stroke: ${t.accent}; stroke-width: 3; stroke-dasharray: 8 6; animation: march 0.6s linear infinite; }
    .tag {
      position: absolute; left: -4px; bottom: calc(100% + 8px); max-width: 280px;
      padding: 2px 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      font: 700 11px/1.4 ${t.font}; color: ${t.ink}; background: ${t.accent};
      border: 2px solid ${t.ink}; border-radius: 6px;
    }
    .box.below .tag { bottom: auto; top: calc(100% + 8px); }
    @keyframes march { to { stroke-dashoffset: -14; } }
    @media (prefers-reduced-motion: reduce) { .box rect { animation: none; } }
  `;
}

export type PickerEvents = { picked(element: ElementFields): void; cancelled(): void };

/** Turn picking on; returns the function that turns it off. */
export function startPicking(theme: PickTheme | undefined, on: PickerEvents): () => void {
  const host = document.createElement("clayground-picker");
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>${overlayCss(theme ?? DEFAULT_THEME)}</style>
    <div class="box"><svg><rect/></svg><div class="tag"></div></div>`;
  document.documentElement.append(host);
  const box = root.querySelector<HTMLElement>(".box")!;
  const tag = root.querySelector<HTMLElement>(".tag")!;
  const cursor = document.createElement("style");
  cursor.textContent = "* { cursor: crosshair !important; }";
  document.head.append(cursor);

  const show = (el: Element) => {
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: "block", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    box.classList.toggle("below", r.top < 32);
    const { tag: name, text } = describeElement(el);
    tag.textContent = text ? `${name} · ${text}` : name;
  };
  const target = (e: Event) => (e.target instanceof Element && e.target !== host ? e.target : null);

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
    host.remove();
    cursor.remove();
  }
  return stop;
}
